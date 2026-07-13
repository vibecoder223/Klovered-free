from fastapi import APIRouter, Depends

from ..cron_auth import verify_cron_request
from ..pipeline.jobs import run_drain
from ..supabase_rest import service_client

router = APIRouter(prefix="/api/pipeline/jobs", tags=["jobs"])


# Heartbeat endpoint. A driver (pg_cron, a scheduler, Vercel Cron, or `npm run
# drain`) calls this on an interval. Each call recovers stuck claims, then
# loops: claim a small batch, run it concurrently, enqueue successors, repeat —
# until the queue is empty or the time budget is spent. The interval driver
# remains the recovery net for crashes and long-running queues.
#
# GET and POST are both allowed: external callers POST; Vercel Cron issues GET.
# Auth (X-Cron-Secret or Bearer) is enforced by verify_cron_request.
@router.api_route("/drain", methods=["GET", "POST"], dependencies=[Depends(verify_cron_request)])
async def drain() -> dict:
    return await run_drain(service_client())
