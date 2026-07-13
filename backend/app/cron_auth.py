"""Shared auth for the cron-triggered endpoints (drain, cleanup).

Accepts two credential styles so the same endpoints work for every driver:

* ``X-Cron-Secret: <secret>`` — used by an external scheduler or ``npm run
  drain`` locally (the original contract).
* ``Authorization: Bearer <secret>`` — sent automatically by Vercel Cron when
  ``CRON_SECRET`` is set as a project env var. Vercel Cron only issues GET
  requests, which is why the endpoints allow GET as well as POST.

Both resolve to the same shared ``CRON_SECRET``.
"""

from fastapi import Depends, Header, HTTPException

from .config import Settings, get_settings


def verify_cron_request(
    x_cron_secret: str = Header(default=""),
    authorization: str = Header(default=""),
    settings: Settings = Depends(get_settings),
) -> None:
    secret = settings.cron_secret
    if not secret:
        raise HTTPException(status_code=503, detail="CRON_SECRET not configured")
    presented = x_cron_secret or authorization.removeprefix("Bearer ").strip()
    if presented != secret:
        raise HTTPException(status_code=403, detail="Forbidden")
