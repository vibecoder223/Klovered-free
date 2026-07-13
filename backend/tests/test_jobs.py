import asyncio

import httpx
import pytest

from app.pipeline import jobs
from app.pipeline.jobs import (
    Job,
    derive_doc_status,
    enqueue_job,
    enqueue_successors,
    mark_failed,
    run_job,
)
from app.pipeline.rag import GenerationUsage


class FakeDb:
    def __init__(self, gets=None, insert_error=None):
        self.gets = gets or {}  # table -> list[rows]
        self.insert_error = insert_error
        self.inserts = []
        self.updates = []
        self.rpcs = []

    def get(self, table, params):
        val = self.gets.get(table, [])
        return val(params) if callable(val) else val

    def insert(self, table, rows):
        self.inserts.append((table, rows))
        if self.insert_error:
            raise self.insert_error
        return [{"id": "new"}]

    def update(self, table, params, patch):
        self.updates.append((table, params, patch))
        return []

    def delete(self, table, params):
        pass

    def rpc(self, fn, args=None):
        self.rpcs.append((fn, args))
        return []


def _http_error(code):
    req = httpx.Request("POST", "https://x/rest/v1/jobs")
    resp = httpx.Response(409, json={"code": code, "message": "dup"}, request=req)
    return httpx.HTTPStatusError("conflict", request=req, response=resp)


def _job(stage="ingest", **kw):
    base = dict(
        id="j1", document_id="d1", org_id="org1", stage=stage,
        target_id=None, status="claimed", attempts=1, max_attempts=3,
    )
    base.update(kw)
    return Job(**base)


# ---------- enqueue ----------

def test_enqueue_swallows_unique_violation():
    db = FakeDb(insert_error=_http_error("23505"))
    enqueue_job(db, document_id="d1", org_id="o1", stage="ingest")  # no raise
    assert db.inserts[0][1]["stage"] == "ingest"


def test_enqueue_reraises_other_pg_errors():
    db = FakeDb(insert_error=_http_error("23503"))
    with pytest.raises(RuntimeError):
        enqueue_job(db, document_id="d1", org_id="o1", stage="ingest")


def test_enqueue_successors_maps_stages():
    for stage, nxt in [("ingest", "extract"), ("extract", "structure"), ("structure", "generate")]:
        db = FakeDb()
        enqueue_successors(db, _job(stage=stage))
        assert db.inserts[0][1]["stage"] == nxt
    db = FakeDb()
    enqueue_successors(db, _job(stage="generate"))
    assert db.inserts == []  # terminal


# ---------- retry / backoff ----------

def test_mark_failed_retries_with_backoff():
    db = FakeDb()
    mark_failed(db, _job(attempts=1, max_attempts=3), "boom")
    patch = db.updates[0][2]
    assert patch["status"] == "pending" and patch["error"] == "boom"


def test_mark_failed_buries_when_exhausted():
    db = FakeDb()
    mark_failed(db, _job(attempts=3, max_attempts=3), "boom")
    assert db.updates[0][2]["status"] == "dead"


# ---------- dispatch ----------

def _doc_rows():
    return [{
        "id": "d1", "deal_id": "deal1", "filename": "f.pdf",
        "file_path": "p", "mime_type": None, "extracted_text": None,
    }]


def test_run_job_ingest_calls_ingestion_then_chunking(monkeypatch):
    calls = []

    async def fake_ingest(db, doc):
        calls.append("ingest")
        return "parsed"

    async def fake_chunk(db, doc, parsed):
        calls.append(("chunk", parsed))

    monkeypatch.setattr(jobs, "run_ingestion_agent", fake_ingest)
    monkeypatch.setattr(jobs, "run_chunking_agent", fake_chunk)
    db = FakeDb(gets={"documents": _doc_rows()})
    asyncio.run(run_job(db, _job(stage="ingest")))
    assert calls == ["ingest", ("chunk", "parsed")]


def test_run_job_generate_batched_answers_pending(monkeypatch):
    q_rows = [
        {"id": "q1", "question_text": "A?", "category": "security",
         "documents": {"deals": {"organizations": {"name": "Acme"}}}},
        {"id": "q2", "question_text": "B?", "category": "security", "documents": None},
    ]

    def gets(table):
        if table == "documents":
            return _doc_rows()
        if table == "questions":
            return q_rows
        if table == "responses":
            # first call (already-answered filter) → none; later → both answered
            return gets_state["responses"]
        return []

    gets_state = {"responses": []}
    seen = {}

    async def fake_batch(db, *, org_id, org_name, tone, questions):
        seen["org_name"] = org_name
        seen["ids"] = [q.question_id for q in questions]
        gets_state["responses"] = [{"question_id": "q1"}, {"question_id": "q2"}]
        return GenerationUsage(input_tokens=10, output_tokens=20)

    monkeypatch.setattr(jobs, "generate_batch_answers", fake_batch)
    db = FakeDb(gets={t: (lambda p, t=t: gets(t)) for t in ["documents", "questions", "responses"]})
    asyncio.run(run_job(db, _job(stage="generate", target_id=None)))

    assert seen["org_name"] == "Acme"
    assert set(seen["ids"]) == {"q1", "q2"}
    run_rows = [r for t, r in db.inserts if t == "agent_runs"]
    assert run_rows and run_rows[0]["status"] == "completed"
    assert run_rows[0]["result"]["answered"] == 2


def test_run_job_generate_batched_fails_when_zero_answers(monkeypatch):
    q_rows = [{"id": "q1", "question_text": "A?", "category": None, "documents": None}]

    def gets(table):
        return {"documents": _doc_rows(), "questions": q_rows}.get(table, [])

    async def fake_batch(db, **kw):
        raise RuntimeError("mistral down")

    monkeypatch.setattr(jobs, "generate_batch_answers", fake_batch)
    db = FakeDb(gets={t: (lambda p, t=t: gets(t)) for t in ["documents", "questions", "responses"]})
    with pytest.raises(RuntimeError, match="produced no answers"):
        asyncio.run(run_job(db, _job(stage="generate", target_id=None)))
    run_rows = [r for t, r in db.inserts if t == "agent_runs"]
    assert run_rows[-1]["status"] == "failed"


# ---------- derived status ----------

def test_derive_doc_status_active_uses_earliest_stage():
    db = FakeDb(gets={"jobs": [
        {"stage": "extract", "status": "claimed"},
        {"stage": "generate", "status": "pending"},
    ]})
    derive_doc_status(db, "d1")
    assert db.updates[0][2]["processing_status"] == "analyzing"


def test_derive_doc_status_blocking_dead_fails():
    db = FakeDb(gets={"jobs": [{"stage": "extract", "status": "dead"}]})
    derive_doc_status(db, "d1")
    assert db.updates[0][2]["processing_status"] == "extraction_failed"


def test_derive_doc_status_partial_generate_completes():
    db = FakeDb(gets={"jobs": [
        {"stage": "generate", "status": "done"},
        {"stage": "generate", "status": "dead"},
    ]})
    derive_doc_status(db, "d1")
    assert db.updates[0][2]["processing_status"] == "completed"


def test_derive_doc_status_no_jobs_noop():
    db = FakeDb(gets={"jobs": []})
    derive_doc_status(db, "d1")
    assert db.updates == []
