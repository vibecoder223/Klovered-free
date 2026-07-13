import re
import time

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from ..activity import log_activity
from ..deps import GuestContext, require_guest
from ..pipeline.ingest import KDoc, ingest_knowledge_document
from ..rate_limit import rate_limit
from ..supabase_rest import try_service_client, user_client

router = APIRouter(prefix="/api/pipeline/knowledge", tags=["knowledge"])

MAX_DOCS = 10
MAX_TOTAL_PAGES = 200
DOC_TYPES = {"past_proposal", "security_doc", "policy", "other"}
_UNSAFE_CHARS = re.compile(r"[^a-zA-Z0-9._-]")


@router.post("/upload")
async def upload(
    file: UploadFile = File(...),
    doc_type: str = Form(default="other"),
    ctx: GuestContext = Depends(require_guest),
) -> dict:
    if not rate_limit(f"upload:{ctx.org_id}", 20, 60 * 60 * 1000):
        raise HTTPException(status_code=429, detail="Rate limit — try again later")

    db = user_client(ctx.token)
    docs = db.get(
        "knowledge_documents", {"select": "id,page_count", "org_id": f"eq.{ctx.org_id}"}
    ) or []
    if len(docs) >= MAX_DOCS:
        raise HTTPException(
            status_code=403, detail=f"Free limit: {MAX_DOCS} documents. Sign in to add more."
        )
    total_pages = sum(d.get("page_count") or 0 for d in docs)
    if total_pages >= MAX_TOTAL_PAGES:
        raise HTTPException(
            status_code=403,
            detail=f"Free limit: {MAX_TOTAL_PAGES} pages total. Sign in for more.",
        )

    filename = file.filename or "upload"
    safe = _UNSAFE_CHARS.sub("_", filename)
    object_path = f"{ctx.org_id}/{int(time.time() * 1000)}-{safe}"
    content_type = file.content_type or "application/octet-stream"
    data = await file.read()

    storage = try_service_client() or db
    storage.upload_storage("knowledge", object_path, data, content_type)

    writer = try_service_client() or db
    normalized_type = doc_type if doc_type in DOC_TYPES else "other"
    try:
        rows = writer.insert(
            "knowledge_documents",
            {
                "org_id": ctx.org_id,
                "filename": filename,
                "file_path": object_path,
                "file_size": len(data),
                "mime_type": content_type,
                "doc_type": normalized_type,
                "ingestion_status": "pending",
                "uploaded_by": ctx.user_id,
            },
        )
    except Exception as e:  # noqa: BLE001 — mirror TS: roll back the upload on insert failure
        storage.remove_storage("knowledge", [object_path])
        raise HTTPException(status_code=500, detail=str(e)) from e
    row = rows[0]

    # Await ingestion inside the request. Fire-and-forget was found to leave
    # documents permanently stuck on STAGE:parsing under some hosts (see
    # ingest.ts history). The client already shows an upload progress UI, so a
    # few extra seconds for the response is acceptable.
    try:
        result = await ingest_knowledge_document(
            writer,
            KDoc(
                id=row["id"],
                org_id=row["org_id"],
                filename=row["filename"],
                file_path=row["file_path"],
                mime_type=row.get("mime_type"),
            ),
        )
        log_activity(
            db,
            org_id=ctx.org_id,
            user_id=ctx.user_id,
            action="ingested",
            entity_type="knowledge_document",
            entity_id=row["id"],
            metadata={"filename": filename, **result},
        )
    except Exception as e:  # noqa: BLE001 — mirror TS: mark failed, still return 200
        writer.update(
            "knowledge_documents",
            {"id": f"eq.{row['id']}"},
            {"ingestion_status": "failed", "error_message": str(e)},
        )

    return {"knowledge_document": row}
