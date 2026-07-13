"""Port of app/api/exports/[id]/download/route.ts.

NOTE: exports/generate (app/api/exports/generate/route.ts) is NOT ported here.
It's a large feature (golden .docx template filling, section-builder AI
generation, PDF rendering) that needs its own diff-test gate per the design
spec ("Export diff test before phase 2 cutover: generated .docx content
matches") before a safe port — it's deliberately out of scope for this pass.
The TS route remains authoritative for generation; only the read-only
download endpoint is ported here.
"""

from fastapi import APIRouter, Depends, HTTPException, Response

from ..deps import GuestContext, require_guest
from ..supabase_rest import try_service_client, user_client

router = APIRouter(prefix="/api/pipeline/exports", tags=["exports"])

_CONTENT_TYPES = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pdf": "application/pdf",
}


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
