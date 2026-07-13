from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel

from ..config import get_settings
from ..deps import GuestContext, require_guest
from ..pipeline.jobs import enqueue_ingest, run_drain
from ..supabase_rest import try_service_client, user_client

router = APIRouter(prefix="/api/pipeline/documents", tags=["documents"])


class ProcessBody(BaseModel):
    document_id: str | None = None


def _org_id_from_doc(doc: dict) -> str | None:
    deals = doc.get("deals")
    if isinstance(deals, dict):
        return deals.get("org_id")
    if isinstance(deals, list) and deals:
        return deals[0].get("org_id")
    return None


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
