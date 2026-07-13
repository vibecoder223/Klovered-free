"""Answer Library — suggest reuse of approved answers for new questions
(port of the read path of lib/answer-library.ts).

Matching is question -> question: an incoming RFP question is compared against
stored questions via the org-scoped `match_answers` RPC. Only the read/reuse
functions the generator needs are ported; `captureApprovedAnswer` belongs to the
human approval flow, which the free tool does not have.

`db` is a service-role SupabaseRest (rpc/get/update); calls are best-effort and
never raise, so a library miss never blocks generation.
"""

from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass

from .embeddings import embed_texts, has_embeddings

# Show a Reuse suggestion at/above this question similarity.
LIBRARY_SUGGEST_MIN = 0.78
# On capture, update an existing row instead of inserting at/above this.
LIBRARY_DEDUPE_MIN = 0.92
# At/above this the generator drafts the stored answer verbatim, skipping the LLM.
LIBRARY_REUSE_MIN = 0.9


@dataclass
class AnswerMatch:
    id: str
    question_text: str | None
    response_text: str
    usage_count: int
    last_used_at: str | None
    source_question_id: str | None
    similarity: float


def _to_match(row: dict) -> AnswerMatch:
    return AnswerMatch(
        id=row.get("id"),
        question_text=row.get("question_text"),
        response_text=row.get("response_text") or "",
        usage_count=row.get("usage_count") or 0,
        last_used_at=row.get("last_used_at"),
        source_question_id=row.get("source_question_id"),
        similarity=float(row.get("similarity") or 0.0),
    )


async def suggest_answers(db, *, org_id: str, question_text: str, limit: int = 3) -> list[AnswerMatch]:
    q = (question_text or "").strip()
    if not q or not has_embeddings():
        return []
    try:
        emb = (await embed_texts([q], "query"))[0]
        rows = db.rpc(
            "match_answers", {"p_org_id": org_id, "p_embedding": emb, "p_match_count": limit}
        )
        return [_to_match(r) for r in (rows or [])]
    except Exception:  # noqa: BLE001 — best-effort, never block generation
        return []


async def suggest_answers_by_embeddings(
    db, *, org_id: str, embeddings: list[list[float] | None]
) -> list[AnswerMatch | None]:
    out: list[AnswerMatch | None] = []
    for emb in embeddings:
        if not emb:
            out.append(None)
            continue
        try:
            rows = db.rpc(
                "match_answers", {"p_org_id": org_id, "p_embedding": emb, "p_match_count": 1}
            )
            out.append(_to_match(rows[0]) if rows else None)
        except Exception:  # noqa: BLE001
            out.append(None)
    return out


def record_reuse(db, library_id: str) -> None:
    try:
        rows = db.get(
            "response_library",
            {"select": "usage_count", "id": f"eq.{library_id}", "limit": "1"},
        )
        current = (rows[0].get("usage_count") if rows else 0) or 0
        db.update(
            "response_library",
            {"id": f"eq.{library_id}"},
            {
                "usage_count": current + 1,
                "last_used_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            },
        )
    except Exception:  # noqa: BLE001
        pass
