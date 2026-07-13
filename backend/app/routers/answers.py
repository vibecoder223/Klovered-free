"""Port of app/api/answers/route.ts."""

from fastapi import APIRouter, Depends, HTTPException

from ..deps import GuestContext, require_guest
from ..supabase_rest import user_client

router = APIRouter(prefix="/api/pipeline/answers", tags=["answers"])


def _first_response(responses) -> dict | None:
    # PostgREST's embedded-relationship shape varies (list vs single object
    # depending on cardinality detection) — mirror the TS defensive unwrap.
    if isinstance(responses, list):
        return responses[0] if responses else None
    return responses


@router.get("")
async def list_answers(
    deal_id: str | None = None, ctx: GuestContext = Depends(require_guest)
) -> dict:
    if not deal_id:
        raise HTTPException(status_code=400, detail="deal_id required")

    db = user_client(ctx.token)

    # RLS scopes everything to the guest's org; a foreign deal_id returns [].
    docs = db.get("documents", {"select": "id", "deal_id": f"eq.{deal_id}"}) or []
    doc_ids = [d["id"] for d in docs]
    if not doc_ids:
        return {"questions": []}

    # Schema note: responses.question_id -> questions.id (reverse embed), and
    # citations are denormalized onto the response directly (document_filename,
    # page) rather than joined through document_chunks/knowledge_documents —
    # see migrations/0001_init.sql (responses, questions) and
    # migrations/0002_rag.sql (citations, responses.draft_text/confidence/gap_flag).
    questions = db.get(
        "questions",
        {
            "select": (
                "id,question_text,status,"
                "responses(id,draft_text,confidence,gap_flag,"
                "citations(chunk_id,document_filename,page))"
            ),
            "document_id": f"in.({','.join(doc_ids)})",
            "order": "created_at.asc",
        },
    ) or []

    out = []
    for q in questions:
        r = _first_response(q.get("responses"))
        response = None
        if r:
            response = {
                "answer_text": r.get("draft_text"),
                "confidence": r.get("confidence"),
                "gap_flag": r.get("gap_flag"),
                "citations": [
                    {
                        "chunk_id": c.get("chunk_id"),
                        "filename": c.get("document_filename"),
                        "page_start": c.get("page"),
                    }
                    for c in (r.get("citations") or [])
                ],
            }
        out.append(
            {
                "id": q["id"],
                "question_text": q["question_text"],
                "status": q["status"],
                "response": response,
            }
        )

    return {"questions": out}
