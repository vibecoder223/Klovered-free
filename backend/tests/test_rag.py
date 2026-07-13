import asyncio
from types import SimpleNamespace

from app.pipeline import rag
from app.pipeline.answer_library import AnswerMatch
from app.pipeline.rag import (
    _extract_citations,
    _strip_markers,
    generate_and_persist_answer,
)
from app.pipeline.retrieval import Candidate, RetrievalResult, Usage


class FakeDb:
    """get() returns [] (no existing response / no voice examples); records writes."""

    def __init__(self):
        self.inserts = []
        self.updates = []
        self.deletes = []

    def get(self, table, params):
        return []

    def insert(self, table, rows):
        self.inserts.append((table, rows))
        return [{"id": "resp-1"}]

    def update(self, table, params, patch):
        self.updates.append((table, params, patch))
        return []

    def delete(self, table, params):
        self.deletes.append((table, params))

    def response_payload(self):
        for t, rows in self.inserts:
            if t == "responses":
                return rows
        return None


def _candidate(cid="c1", text="Data is encrypted at rest with AES-256.", page=12):
    return Candidate(
        chunk_id=cid, text=text, section_path="Security", page_start=page,
        page_end=page, document_filename="security.pdf", score=0.82,
    )


def _usage():
    return SimpleNamespace(input_tokens=5, output_tokens=3)


def test_citation_extraction_and_strip():
    sources = [_candidate("cA"), _candidate("cB", "TLS 1.3 in transit.")]
    text = "We encrypt at rest [c:1]. We use TLS in transit [c:2]."
    cites = _extract_citations(text, sources)
    assert [c.chunk_id for c in cites] == ["cA", "cB"]
    assert _strip_markers(text) == "We encrypt at rest . We use TLS in transit ."


def test_library_reuse_skips_llm(monkeypatch):
    async def fake_suggest(db, *, org_id, question_text, limit=1):
        return [AnswerMatch(
            id="lib-1", question_text="q", response_text="Reused approved answer.",
            usage_count=1, last_used_at=None, source_question_id="other-q", similarity=0.95,
        )]

    reused = {}
    monkeypatch.setattr(rag, "suggest_answers", fake_suggest)
    monkeypatch.setattr(rag, "record_reuse", lambda db, i: reused.setdefault("id", i))

    # If the LLM or retrieval were called, these would raise.
    async def boom(*a, **k):
        raise AssertionError("should not be called on reuse path")

    monkeypatch.setattr(rag, "retrieve_for_query", boom)
    monkeypatch.setattr(rag, "call_mistral_text", boom)

    db = FakeDb()
    asyncio.run(generate_and_persist_answer(
        db, question_id="q1", question_text="Do you support SSO?", org_id="org-1", org_name="Acme",
    ))
    payload = db.response_payload()
    assert payload["confidence"] == 0.95
    assert payload["draft_text"] == "Reused approved answer."
    assert reused["id"] == "lib-1"


def test_gap_gate_marks_no_source(monkeypatch):
    async def no_lib(db, *, org_id, question_text, limit=1):
        return []

    async def empty_retrieval(db, *, org_id, query, top_k=6):
        return RetrievalResult(candidates=[], top_score=0.0, query_expansion=None, usage=Usage(1, 0))

    monkeypatch.setattr(rag, "suggest_answers", no_lib)
    monkeypatch.setattr(rag, "retrieve_for_query", empty_retrieval)

    db = FakeDb()
    asyncio.run(generate_and_persist_answer(
        db, question_id="q1", question_text="Obscure thing?", org_id="org-1", org_name="Acme",
    ))
    payload = db.response_payload()
    assert payload["gap_flag"] == "no_source"
    assert payload["draft_text"] == ""


def test_happy_path_grounded_answer(monkeypatch):
    async def no_lib(db, *, org_id, question_text, limit=1):
        return []

    async def good_retrieval(db, *, org_id, query, top_k=6):
        return RetrievalResult(
            candidates=[_candidate("cX")], top_score=0.82, query_expansion=None, usage=Usage(4, 2),
        )

    async def fake_llm(*, system, user, max_tokens, model):
        return {"text": "All data is encrypted at rest with AES-256 [c:1].", "usage": _usage()}

    monkeypatch.setattr(rag, "suggest_answers", no_lib)
    monkeypatch.setattr(rag, "retrieve_for_query", good_retrieval)
    monkeypatch.setattr(rag, "has_llm_key", lambda: True)
    monkeypatch.setattr(rag, "call_mistral_text", fake_llm)

    db = FakeDb()
    asyncio.run(generate_and_persist_answer(
        db, question_id="q1", question_text="Encryption at rest?", org_id="org-1", org_name="Acme",
    ))
    payload = db.response_payload()
    assert "encrypted at rest" in payload["draft_text"]
    assert "[c:1]" not in payload["draft_text"]  # markers stripped from clean draft
    assert payload["gap_flag"] in ("ok", "partial")
    # a citation row was written for the resolved chunk
    assert any(t == "citations" for t, _ in db.inserts)
