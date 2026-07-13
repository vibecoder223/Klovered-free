from fastapi import APIRouter, Header, HTTPException

from ..config import get_settings
from ..pipeline.jobs import run_drain
from ..supabase_rest import service_client

router = APIRouter(prefix="/api/pipeline/jobs", tags=["jobs"])


# Heartbeat endpoint. A driver (pg_cron, a scheduler, or `npm run drain`) calls
# this on an interval. Each call recovers stuck claims, then loops: claim a
# small batch, run it concurrently, enqueue successors, repeat — until the
# queue is empty or the time budget is spent. The interval driver remains the
# recovery net for crashes and long-running queues.
@router.post("/drain")
async def drain(x_cron_secret: str = Header(default="")) -> dict:
    secret = get_settings().cron_secret
    if not secret:
        raise HTTPException(status_code=503, detail="CRON_SECRET not configured")
    if x_cron_secret != secret:
        raise HTTPException(status_code=403, detail="Forbidden")

    return await run_drain(service_client())
