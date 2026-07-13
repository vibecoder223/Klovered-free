import re
import time

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from ..activity import log_activity
from ..config import get_settings
from ..deps import GuestContext, require_guest
from ..pipeline.jobs import enqueue_ingest, run_drain
from ..supabase_rest import try_service_client, user_client

router = APIRouter(prefix="/api/pipeline/documents", tags=["documents"])

_UNSAFE_CHARS = re.compile(r"[^a-zA-Z0-9._-]")


class ProcessBody(BaseModel):
    document_id: str | None = None


def _org_id_from_doc(doc: dict) -> str | None:
    deals = doc.get("deals")
    if isinstance(deals, dict):
        return deals.get("org_id")
    if isinstance(deals, list) and deals:
        return deals[0].get("org_id")
    return None


@router.post("/upload")
async def upload(
    file: UploadFile = File(...),
    deal_id: str = Form(...),
    ctx: GuestContext = Depends(require_guest),
) -> dict:
    db = user_client(ctx.token)

    deal_rows = db.get(
        "deals", {"select": "id,org_id", "id": f"eq.{deal_id}", "limit": "1"}
    )
    if not deal_rows:
        raise HTTPException(status_code=404, detail="Deal not found")
    deal = deal_rows[0]

    existing = db.get(
        "documents", {"select": "id", "deal_id": f"eq.{deal_id}", "limit": "1"}
    )
    if existing:
        raise HTTPException(
            status_code=403,
            detail="Free limit: one RFP per session. Delete the current one first.",
        )

    filename = file.filename or "upload"
    safe_name = _UNSAFE_CHARS.sub("_", filename)
    object_path = f"{deal_id}/{int(time.time() * 1000)}-{safe_name}"
    content_type = file.content_type or "application/octet-stream"
    data = await file.read()

    # Prefer admin for storage write to avoid edge cases with RLS on
    # storage.objects. Falls back to user-context — the migration has Storage
    # RLS policies for org members.
    storage = try_service_client() or db
    storage.upload_storage("documents", object_path, data, content_type)

    try:
        rows = db.insert(
            "documents",
            {
                "deal_id": deal_id,
                "filename": filename,
                "file_path": object_path,
                "file_size": len(data),
                "mime_type": content_type,
                "processing_status": "uploaded",
            },
        )
    except Exception as e:  # noqa: BLE001 — mirror TS: roll back the upload on insert failure
        storage.remove_storage("documents", [object_path])
        raise HTTPException(status_code=500, detail=str(e)) from e
    doc = rows[0]

    log_activity(
        db,
        org_id=deal["org_id"],
        user_id=ctx.user_id,
        action="uploaded",
        entity_type="document",
        entity_id=doc["id"],
        metadata={"filename": filename, "size": len(data)},
    )

    return {"document": doc}


@router.get("/{document_id}")
async def get_document(
    document_id: str, ctx: GuestContext = Depends(require_guest)
) -> dict:
    db = user_client(ctx.token)
    rows = db.get(
        "documents",
        {
            "select": "id,processing_status,error_message",
            "id": f"eq.{document_id}",
            "limit": "1",
        },
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Not found")
    return {"document": rows[0]}


@router.delete("/{document_id}")
async def delete_document(
    document_id: str, ctx: GuestContext = Depends(require_guest)
) -> dict:
    db = user_client(ctx.token)
    rows = db.get(
        "documents",
        {
            "select": "id,file_path,deal_id,deals(org_id)",
            "id": f"eq.{document_id}",
            "limit": "1",
        },
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Not found")
    doc = rows[0]

    writer = try_service_client() or db

    # Storage cleanup first (best-effort — a stale object is better than a
    # failed delete; mirrors the TS route not checking the remove() result).
    if doc.get("file_path"):
        try:
            writer.remove_storage("documents", [doc["file_path"]])
        except Exception:  # noqa: BLE001
            pass

    # Cascade deletes happen via FK on questions/extracted_requirements/etc.
    try:
        writer.delete("documents", {"id": f"eq.{document_id}"})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)) from e

    return {"ok": True}


# Enqueue-only. The pipeline runs asynchronously: this just queues the first
# stage and returns immediately. The drain loop advances the document through
# ingest -> extract -> structure -> generate. Also serves as "retry": it clears
# prior job rows and re-queues from the top.
@router.post("/process")
async def process(
    body: ProcessBody,
    background_tasks: BackgroundTasks,
    ctx: GuestContext = Depends(require_guest),
) -> dict:
    if not body.document_id:
        raise HTTPException(status_code=400, detail="document_id required")

    db = user_client(ctx.token)
    rows = db.get(
        "documents",
        {"select": "id,deal_id,deals(org_id)", "id": f"eq.{body.document_id}", "limit": "1"},
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Not found")
    org_id = _org_id_from_doc(rows[0])
    if not org_id:
        raise HTTPException(status_code=400, detail="Org not resolved for document")

    settings = get_settings()
    # If the LLM key is missing, mark the document and return success — upload
    # UX shouldn't error out. Must match the key resolution in app/mistral.py
    # (LLM_API_KEY ?? MISTRAL_API_KEY).
    if not settings.llm_key:
        db.update(
            "documents",
            {"id": f"eq.{body.document_id}"},
            {
                "processing_status": "uploaded",
                "error_message": (
                    "No LLM API key configured. The file is stored, but the AI "
                    "pipeline is disabled until LLM_API_KEY or MISTRAL_API_KEY "
                    "is set in .env.local."
                ),
            },
        )
        return {"ok": True, "skipped": True, "reason": "llm_key_missing"}

    admin = try_service_client()
    if admin is None:
        raise HTTPException(
            status_code=503, detail="SUPABASE_SERVICE_ROLE_KEY required to run the pipeline."
        )

    # Clean slate for (re)processing: drop any prior job rows, then queue ingest.
    admin.delete("jobs", {"document_id": f"eq.{body.document_id}"})
    enqueue_ingest(admin, document_id=body.document_id, org_id=org_id)
    admin.update(
        "documents",
        {"id": f"eq.{body.document_id}"},
        {"processing_status": "queued", "error_message": None},
    )

    # Kick the drain immediately (in-process background task) so the pipeline
    # starts now instead of waiting for the next scheduler tick. This is a
    # persistent server, so — unlike the TS fire-and-forget self-fetch — we can
    # just call the drain loop directly. The interval driver stays as recovery.
    if settings.cron_secret:
        background_tasks.add_task(run_drain, admin)

    return {"ok": True, "queued": True}
