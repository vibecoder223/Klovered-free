import asyncio

from app.pipeline import agents
from app.pipeline.agents import (
    Doc,
    ExtractedRequirement,
    run_extraction_agent,
    run_structuring_agent,
)
from app.pipeline.chunk import ProducedChunk


class FakeDb:
    """Records inserts/updates/deletes; returns canned rows for get()."""

    def __init__(self, gets=None):
        self.inserts = []   # list[(table, rows)]
        self.updates = []   # list[(table, params, patch)]
        self.deletes = []   # list[(table, params)]
        self._gets = gets or {}

    def insert(self, table, rows):
        self.inserts.append((table, rows))
        return rows if isinstance(rows, list) else [rows]

    def update(self, table, params, patch):
        self.updates.append((table, params, patch))
        return []

    def delete(self, table, params):
        self.deletes.append((table, params))

    def get(self, table, params):
        return self._gets.get(table, [])

    def download_storage(self, bucket, path):
        return b"data"

    def rows_for(self, table):
        return [rows for (t, rows) in self.inserts if t == table]


def _chunk(text="Vendor must encrypt data at rest.", page=3):
    return ProducedChunk(
        text=text,
        text_for_embedding=text,
        section_path="4.2 Security",
        page_start=page,
        page_end=page,
        sparse_terms=["encrypt", "data"],
    )


def test_extraction_builds_prompt_parses_and_persists(monkeypatch):
    captured = {}

    async def fake_llm(*, system, user, max_tokens, model, mode):
        captured["system"] = system
        captured["user"] = user
        captured["mode"] = mode
        return {
            "data": [
                {
                    "requirement_id": "Q1",
                    "section": "4.2",
                    "text": "Encrypt data at rest.",
                    "classification": "must-have",   # normalizes -> must
                    "topic": "it security",           # normalizes -> security
                    "source_page": "7",               # coerces -> 7
                },
                {"requirement_id": "", "text": "drop me"},  # invalid -> filtered
            ],
            "usage": type("U", (), {"input_tokens": 10, "output_tokens": 5})(),
            "raw": "[]",
        }

    monkeypatch.setattr(agents, "call_mistral_json", fake_llm)

    db = FakeDb()
    doc = Doc(id="d1", deal_id="deal1", filename="rfp.pdf", file_path="p/rfp.pdf")
    reqs = asyncio.run(run_extraction_agent(db, doc, [_chunk()]))

    # Parsed + normalized + invalid filtered
    assert len(reqs) == 1
    r = reqs[0]
    assert r.requirement_id == "Q1"
    assert r.classification == "must"
    assert r.topic == "security"
    assert r.source_page == 7

    # Prompt shape
    assert "expert RFP analyst" in captured["system"]
    assert "4.2 Security" in captured["user"]
    assert captured["mode"] == "text"

    # Persisted to extracted_requirements + agent_runs, and cleared first
    assert ("extracted_requirements", {"document_id": "eq.d1"}) in db.deletes
    er = db.rows_for("extracted_requirements")[0]
    assert er[0]["requirement_id"] == "Q1"
    assert er[0]["priority"] == "high"  # must -> high
    assert er[0]["is_mandatory"] is True
    assert any(t == "agent_runs" for t, _ in db.inserts)


def test_extraction_rate_limit_error_bubbles(monkeypatch):
    async def boom(*, system, user, max_tokens, model, mode):
        raise RuntimeError("LLM 429 on mistral-large after 2 retries")

    monkeypatch.setattr(agents, "call_mistral_json", boom)
    db = FakeDb()
    doc = Doc(id="d1", deal_id="deal1", filename="rfp.pdf", file_path="p/rfp.pdf")

    try:
        asyncio.run(run_extraction_agent(db, doc, [_chunk()]))
        raise AssertionError("expected RuntimeError")
    except RuntimeError as e:
        assert "429" in str(e) or "Extraction batch failed" in str(e)
    # a failed agent_run must still be recorded
    assert any(
        t == "agent_runs" and rows["status"] == "failed"
        for t, rows in db.inserts
        if isinstance(rows, dict)
    )


def test_structuring_writes_questions_and_matrix():
    db = FakeDb()
    doc = Doc(id="d1", deal_id="deal1", filename="rfp.pdf", file_path="p/rfp.pdf")
    reqs = [
        ExtractedRequirement(requirement_id="Q1", text="Encrypt.", classification="must", topic="security"),
        ExtractedRequirement(requirement_id="Q2", text="SLA?", classification="should", topic="commercial"),
    ]
    asyncio.run(run_structuring_agent(db, doc, reqs))

    questions = db.rows_for("questions")[0]
    assert len(questions) == 2
    assert questions[0]["question_text"] == "Encrypt."
    assert questions[0]["priority"] == "high"
    assert questions[1]["priority"] == "medium"
    matrix = db.rows_for("compliance_matrix")[0]
    assert matrix[0]["compliance_status"] == "pending"
    assert ("questions", {"document_id": "eq.d1"}) in db.deletes
