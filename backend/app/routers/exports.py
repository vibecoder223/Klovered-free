"""Port of app/api/exports/generate/route.ts + exports/[id]/download/route.ts.

Generation covers the default from-scratch renderers — a branded, page-numbered
DOCX or PDF built from the deal's questions/answers/citations. This is the path
the free tool actually exercises.

NOT ported (TS route stays authoritative if these are ever wired up in the free
tool): the golden .docx template-fill engine (docxtemplater XML surgery) and the
AI section-builder. Both require a `proposal_templates` row, and this app's
schema has no such table — the TS route already treats template lookups as
fail-soft and renders the default document when none is found, which is exactly
what the free tool does on every export. Porting the fill engine is a large,
separately-gated task per the design spec ("Export diff test before cutover").
"""

import time

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from ..deps import GuestContext, require_guest
from ..pipeline.export_render import (
    DocGroup,
    ExportCitation,
    ExportOptions,
    ExportQuestion,
    render_docx,
    render_pdf,
)
from ..supabase_rest import try_service_client, user_client

router = APIRouter(prefix="/api/pipeline/exports", tags=["exports"])

_CONTENT_TYPES = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pdf": "application/pdf",
}

# Every deal column the export cover/metadata might use, with a core-subset
# fallback for projects that never migrated the extended bid-management columns.
_DEAL_SELECT_FULL = (
    "id,name,client_name,value,due_date,bid_reference,bid_type,sector,region,"
    "contract_type,contract_duration,submission_method,win_probability,"
    "competitors,notes,owner_id,org_id,organizations(name)"
)
_DEAL_SELECT_MIN = "id,name,client_name,due_date,owner_id,org_id,organizations(name)"


class GenerateBody(BaseModel):
    deal_id: str | None = None
    document_id: str | None = None
    document_ids: list[str] | None = None
    merge: bool = False
    format: str = "pdf"  # "pdf" | "docx"
    citation_style: str = "inline"  # "inline" | "footnote"
    template_id: str | None = None


def _embedded_name(deal: dict) -> str | None:
    org = deal.get("organizations")
    if isinstance(org, dict):
        return org.get("name")
    if isinstance(org, list) and org:
        return org[0].get("name")
    return None


def _to_exportable(questions: list[dict]) -> list[ExportQuestion]:
    out: list[ExportQuestion] = []
    for q in questions:
        responses = q.get("responses") or []
        if isinstance(responses, dict):
            responses = [responses]
        approved = next((r for r in responses if r.get("status") == "approved"), None)
        r = approved or (responses[0] if responses else None)
        answer = ""
        gap_flag = None
        citations: list[ExportCitation] = []
        if r:
            answer = r.get("final_text") or r.get("draft_text") or "(no response)"
            gap_flag = r.get("gap_flag")
            citations = [
                ExportCitation(document_filename=c.get("document_filename"), page=c.get("page"))
                for c in (r.get("citations") or [])
            ]
        else:
            answer = "(no response)"
        out.append(
            ExportQuestion(
                requirement_id=q.get("requirement_id"),
                question_text=q.get("question_text"),
                answer=answer,
                citations=citations,
                gap_flag=gap_flag,
            )
        )
    return out


@router.post("/generate")
async def generate(body: GenerateBody, ctx: GuestContext = Depends(require_guest)) -> dict:
    db = user_client(ctx.token)

    doc_ids = body.document_ids or ([body.document_id] if body.document_id else [])

    # Free single-RFP flow: the answers screen sends only deal_id. Derive the
    # document ids from the deal (RLS scopes this to the guest's org).
    if body.deal_id and not doc_ids:
        deal_docs = db.get(
            "documents",
            {"select": "id", "deal_id": f"eq.{body.deal_id}", "order": "created_at.asc"},
        ) or []
        doc_ids = [d["id"] for d in deal_docs]

    merge = bool(body.merge) and len(doc_ids) > 1
    fmt = "docx" if body.format == "docx" else "pdf"
    citation_style = "footnote" if body.citation_style == "footnote" else "inline"

    if not body.deal_id or not doc_ids:
        raise HTTPException(status_code=400, detail="deal_id and document_ids required")

    # Pull every known deal column + org name; fall back to the core subset if
    # the extended bid-management columns weren't migrated.
    try:
        deal_rows = db.get(
            "deals", {"select": _DEAL_SELECT_FULL, "id": f"eq.{body.deal_id}", "limit": "1"}
        )
    except Exception:  # noqa: BLE001 — unknown column -> retry with the safe subset
        deal_rows = db.get(
            "deals", {"select": _DEAL_SELECT_MIN, "id": f"eq.{body.deal_id}", "limit": "1"}
        )
    if not deal_rows:
        raise HTTPException(status_code=404, detail="Not found")
    deal = deal_rows[0]

    docs = db.get(
        "documents",
        {
            "select": "id,filename,created_at",
            "id": f"in.({','.join(doc_ids)})",
            "order": "created_at.asc",
        },
    ) or []

    questions = db.get(
        "questions",
        {
            "select": (
                "document_id,requirement_id,question_text,created_at,"
                "responses(id,final_text,draft_text,status,gap_flag,"
                "citations(document_filename,page,section_path))"
            ),
            "document_id": f"in.({','.join(doc_ids)})",
            "order": "created_at.asc",
        },
    ) or []

    if not questions:
        raise HTTPException(status_code=400, detail="Nothing to export")

    # Group questions by document, in the document order.
    by_doc: dict[str, list[dict]] = {d["id"]: [] for d in docs}
    for q in questions:
        by_doc.setdefault(q["document_id"], []).append(q)

    exportable = [] if merge else _to_exportable(by_doc.get(doc_ids[0], []))
    sections = [
        DocGroup(heading=d["filename"], items=_to_exportable(by_doc.get(d["id"], [])))
        for d in docs
        if by_doc.get(d["id"])
    ]

    org_name = _embedded_name(deal)

    opts = ExportOptions(
        deal_name=deal["name"],
        client_name=deal.get("client_name"),
        org_name=org_name,
        citation_style=citation_style,
        sections=sections if merge else None,
    )

    if fmt == "docx":
        buf = render_docx(exportable, opts)
    else:
        buf = render_pdf(exportable, opts)

    storage = try_service_client() or db
    path = f"{body.deal_id}/export-{int(time.time() * 1000)}.{fmt}"
    try:
        storage.upload_storage("documents", path, buf, _CONTENT_TYPES[fmt])
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)) from e

    rows = db.insert(
        "exports",
        {
            "deal_id": body.deal_id,
            # For merged exports, store the first doc id as a reference point.
            "document_id": doc_ids[0],
            "file_path": path,
            "format": fmt,
            "created_by": ctx.user_id,
        },
    )
    return {"exportId": rows[0]["id"], "format": fmt}


@router.get("/{export_id}/download")
async def download(export_id: str, ctx: GuestContext = Depends(require_guest)) -> Response:
    db = user_client(ctx.token)
    rows = db.get(
        "exports",
        {"select": "file_path,deal_id,format", "id": f"eq.{export_id}", "limit": "1"},
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Not found")
    row = rows[0]

    storage = try_service_client() or db
    try:
        data = storage.download_storage("documents", row["file_path"])
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)) from e

    filename = row["file_path"].rsplit("/", 1)[-1] or f"export.{row.get('format') or 'pdf'}"
    content_type = _CONTENT_TYPES.get(row.get("format"), _CONTENT_TYPES["pdf"])
    return Response(
        content=data,
        media_type=content_type,
        headers={"content-disposition": f'attachment; filename="{filename}"'},
    )
