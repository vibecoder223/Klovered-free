"""Port of app/api/cron/cleanup/route.ts."""

from __future__ import annotations

import time

from fastapi import APIRouter, Header, HTTPException

from ..config import get_settings
from ..supabase_rest import SupabaseRest, service_client

router = APIRouter(prefix="/api/pipeline/cron", tags=["cron"])

# 48h expiry for anonymous guest data. A scheduler POSTs this hourly with the
# shared CRON_SECRET. It purges guest orgs older than the window whose members
# are ALL still anonymous — any org where a member upgraded to Google
# (is_anonymous=false) is exempt and kept.
#
# Order per org: storage first (no FK cascade covers Storage), then the org row
# (every child table FKs to organizations with ON DELETE CASCADE — verified
# against migrations 0001/0002/0006/0010/0016), then the anonymous auth.users.
WINDOW_MS = 48 * 60 * 60 * 1000


def _iso_ms_ago(ms: float) -> str:
    t = time.time() - ms / 1000
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int((t % 1) * 1000):03d}Z"


def _empty_bucket_folder(db: SupabaseRest, bucket: str, prefix: str) -> int:
    objects = db.list_storage(bucket, prefix)
    if not objects:
        return 0
    paths = [f"{prefix}/{o['name']}" for o in objects]
    db.remove_storage(bucket, paths)
    return len(paths)


@router.post("/cleanup")
async def cleanup(x_cron_secret: str = Header(default="")) -> dict:
    secret = get_settings().cron_secret
    if not secret or x_cron_secret != secret:
        raise HTTPException(status_code=403, detail="Forbidden")

    db = service_client()
    cutoff = _iso_ms_ago(WINDOW_MS)

    orgs = db.get(
        "organizations",
        {"select": "id,slug,created_at", "slug": "like.guest-%", "created_at": f"lt.{cutoff}"},
    ) or []

    purged = 0
    skipped_upgraded = 0
    files_removed = 0
    errors: list[str] = []

    for org in orgs:
        try:
            members = db.get("team_members", {"select": "user_id", "org_id": f"eq.{org['id']}"}) or []

            # Exempt: any member upgraded to a permanent (Google) account.
            all_anonymous = True
            for m in members:
                user = db.get_auth_user(m["user_id"])
                if user and user.get("is_anonymous") is False:
                    all_anonymous = False
                    break
            if not all_anonymous:
                skipped_upgraded += 1
                continue

            # Storage: knowledge/<org_id>/* and documents/<deal_id>/* (RFP + exports).
            files_removed += _empty_bucket_folder(db, "knowledge", org["id"])
            deals = db.get("deals", {"select": "id", "org_id": f"eq.{org['id']}"}) or []
            for d in deals:
                files_removed += _empty_bucket_folder(db, "documents", d["id"])

            # DB: one delete, FK cascade clears deals, documents, chunks, questions,
            # responses, citations, knowledge_documents, jobs, exports, org_settings,
            # team_members, invites, templates.
            db.delete("organizations", {"id": f"eq.{org['id']}"})

            # Auth users last (not covered by the org cascade).
            for m in members:
                try:
                    db.delete_auth_user(m["user_id"])
                except Exception:  # noqa: BLE001 — mirror TS .catch(() => {})
                    pass
            purged += 1
        except Exception as e:  # noqa: BLE001 — one bad org must not abort the sweep
            errors.append(f"{org.get('slug')}: {e}")

    result = {
        "ok": True,
        "scanned": len(orgs),
        "purged": purged,
        "skippedUpgraded": skipped_upgraded,
        "filesRemoved": files_removed,
    }
    if errors:
        result["errors"] = errors
    return result
