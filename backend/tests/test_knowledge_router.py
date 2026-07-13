import pytest
from fastapi.testclient import TestClient

from app import deps
from app.main import app
from app.rate_limit import _buckets
from app.routers import knowledge as knowledge_router

client = TestClient(app, raise_server_exceptions=False)


class FakeDb:
    def __init__(self, docs=None, insert_error=None, delete_error=None):
        self.docs = docs if docs is not None else []
        self.inserts = []
        self.updates = []
        self.uploads = []
        self.removed = []
        self.deletes = []
        self.insert_error = insert_error
        self.delete_error = delete_error

    def get(self, table, params):
        return self.docs

    def insert(self, table, rows):
        self.inserts.append((table, rows))
        if self.insert_error:
            raise self.insert_error
        return [{**rows, "id": "kd-1"}]

    def update(self, table, params, patch):
        self.updates.append((table, params, patch))
        return []

    def delete(self, table, params):
        self.deletes.append((table, params))
        if self.delete_error:
            raise self.delete_error

    def upload_storage(self, bucket, path, data, content_type):
        self.uploads.append((bucket, path, len(data), content_type))

    def remove_storage(self, bucket, paths):
        self.removed.append((bucket, paths))


@pytest.fixture
def stub_auth(monkeypatch):
    monkeypatch.setattr(deps, "verify_jwt", lambda token: {"sub": "guest-abc", "is_anonymous": True})
    monkeypatch.setattr(deps, "resolve_org", lambda token, uid: "org-9")


@pytest.fixture(autouse=True)
def _clear_rate_limit_buckets():
    _buckets.clear()
    yield
    _buckets.clear()


AUTH = {"Authorization": "Bearer guest-jwt"}


def _post(db, filename="policy.pdf", content=b"hello world", doc_type="policy"):
    return client.post(
        "/api/pipeline/knowledge/upload",
        headers=AUTH,
        files={"file": (filename, content, "application/pdf")},
        data={"doc_type": doc_type},
    )


def test_upload_without_auth_is_401():
    r = _post(FakeDb())
    assert r.status_code == 401


def test_upload_rate_limited(stub_auth, monkeypatch):
    monkeypatch.setattr(knowledge_router, "user_client", lambda token: FakeDb())
    monkeypatch.setattr(knowledge_router, "rate_limit", lambda *a, **k: False)
    r = _post(FakeDb())
    assert r.status_code == 429


def test_upload_doc_limit_reached(stub_auth, monkeypatch):
    docs = [{"id": f"d{i}", "page_count": 1} for i in range(10)]
    monkeypatch.setattr(knowledge_router, "user_client", lambda token: FakeDb(docs=docs))
    r = _post(FakeDb())
    assert r.status_code == 403
    assert "10 documents" in r.json()["error"]


def test_upload_page_limit_reached(stub_auth, monkeypatch):
    docs = [{"id": "d1", "page_count": 200}]
    monkeypatch.setattr(knowledge_router, "user_client", lambda token: FakeDb(docs=docs))
    r = _post(FakeDb())
    assert r.status_code == 403
    assert "200 pages" in r.json()["error"]


def test_upload_happy_path_ingests_and_logs(stub_auth, monkeypatch):
    db = FakeDb()
    monkeypatch.setattr(knowledge_router, "user_client", lambda token: db)
    monkeypatch.setattr(knowledge_router, "try_service_client", lambda: None)

    ingest_calls = []

    async def fake_ingest(writer, doc):
        ingest_calls.append((writer, doc))
        return {"chunk_count": 3, "page_count": 1, "dedup": False}

    monkeypatch.setattr(knowledge_router, "ingest_knowledge_document", fake_ingest)
    log_calls = []
    monkeypatch.setattr(
        knowledge_router,
        "log_activity",
        lambda db, **kw: log_calls.append(kw),
    )

    r = _post(db, filename="a b/c*.pdf", doc_type="policy")
    assert r.status_code == 200
    body = r.json()["knowledge_document"]
    assert body["id"] == "kd-1"
    assert body["org_id"] == "org-9"
    assert body["doc_type"] == "policy"

    assert db.uploads[0][0] == "knowledge"
    assert db.uploads[0][1].startswith("org-9/")
    assert "a_b_c_.pdf" in db.uploads[0][1]  # unsafe chars sanitized

    assert ingest_calls and ingest_calls[0][1].id == "kd-1"
    assert log_calls[0]["entity_id"] == "kd-1"
    assert log_calls[0]["metadata"]["chunk_count"] == 3


def test_upload_bad_doc_type_normalizes_to_other(stub_auth, monkeypatch):
    db = FakeDb()
    monkeypatch.setattr(knowledge_router, "user_client", lambda token: db)
    monkeypatch.setattr(knowledge_router, "try_service_client", lambda: None)

    async def fake_ingest(writer, doc):
        return {"chunk_count": 0, "page_count": 1, "dedup": False}

    monkeypatch.setattr(knowledge_router, "ingest_knowledge_document", fake_ingest)
    monkeypatch.setattr(knowledge_router, "log_activity", lambda db, **kw: None)

    r = _post(db, doc_type="not_a_real_type")
    assert r.status_code == 200
    assert r.json()["knowledge_document"]["doc_type"] == "other"


def test_upload_insert_failure_rolls_back_storage(stub_auth, monkeypatch):
    db = FakeDb(insert_error=RuntimeError("db down"))
    monkeypatch.setattr(knowledge_router, "user_client", lambda token: db)
    monkeypatch.setattr(knowledge_router, "try_service_client", lambda: None)

    r = _post(db)
    assert r.status_code == 500
    assert db.removed and db.removed[0][0] == "knowledge"


def test_upload_ingest_failure_marks_document_failed(stub_auth, monkeypatch):
    db = FakeDb()
    monkeypatch.setattr(knowledge_router, "user_client", lambda token: db)
    monkeypatch.setattr(knowledge_router, "try_service_client", lambda: None)

    async def failing_ingest(writer, doc):
        raise ValueError("parse blew up")

    monkeypatch.setattr(knowledge_router, "ingest_knowledge_document", failing_ingest)

    r = _post(db)
    assert r.status_code == 200  # upload UX shouldn't hard-fail
    assert db.updates[-1][2]["ingestion_status"] == "failed"
    assert "parse blew up" in db.updates[-1][2]["error_message"]


# ---------- list / get / delete ----------


def test_list_knowledge_returns_items(stub_auth, monkeypatch):
    rows = [{"id": "kd-1", "filename": "a.pdf"}]
    monkeypatch.setattr(knowledge_router, "user_client", lambda token: FakeDb(docs=rows))
    r = client.get("/api/pipeline/knowledge", headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {"items": rows}


def test_get_knowledge_not_found(stub_auth, monkeypatch):
    monkeypatch.setattr(knowledge_router, "user_client", lambda token: FakeDb(docs=[]))
    r = client.get("/api/pipeline/knowledge/kd-1", headers=AUTH)
    assert r.status_code == 404


def test_get_knowledge_extracts_stage_from_error_message(stub_auth, monkeypatch):
    db = FakeDb(docs=[{
        "id": "kd-1", "ingestion_status": "processing",
        "error_message": "STAGE:embedding", "page_count": 3,
    }])
    monkeypatch.setattr(knowledge_router, "user_client", lambda token: db)
    r = client.get("/api/pipeline/knowledge/kd-1", headers=AUTH)
    assert r.status_code == 200
    body = r.json()["knowledge_document"]
    assert body == {
        "id": "kd-1", "ingestion_status": "processing",
        "stage": "embedding", "error_message": None, "page_count": 3,
    }


def test_get_knowledge_passes_through_real_error(stub_auth, monkeypatch):
    db = FakeDb(docs=[{
        "id": "kd-1", "ingestion_status": "failed",
        "error_message": "No content extracted from document.", "page_count": None,
    }])
    monkeypatch.setattr(knowledge_router, "user_client", lambda token: db)
    r = client.get("/api/pipeline/knowledge/kd-1", headers=AUTH)
    body = r.json()["knowledge_document"]
    assert body["stage"] is None
    assert body["error_message"] == "No content extracted from document."


def test_delete_knowledge_not_found(stub_auth, monkeypatch):
    monkeypatch.setattr(knowledge_router, "user_client", lambda token: FakeDb(docs=[]))
    r = client.delete("/api/pipeline/knowledge/kd-1", headers=AUTH)
    assert r.status_code == 404


def test_delete_knowledge_removes_row_then_storage(stub_auth, monkeypatch):
    db = FakeDb(docs=[{"id": "kd-1", "file_path": "org-9/f.pdf"}])
    monkeypatch.setattr(knowledge_router, "user_client", lambda token: db)
    monkeypatch.setattr(knowledge_router, "try_service_client", lambda: None)

    r = client.delete("/api/pipeline/knowledge/kd-1", headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert db.deletes == [("knowledge_documents", {"id": "eq.kd-1"})]
    assert db.removed == [("knowledge", ["org-9/f.pdf"])]


def test_delete_knowledge_db_failure_is_500(stub_auth, monkeypatch):
    db = FakeDb(docs=[{"id": "kd-1", "file_path": "org-9/f.pdf"}], delete_error=RuntimeError("db down"))
    monkeypatch.setattr(knowledge_router, "user_client", lambda token: db)
    monkeypatch.setattr(knowledge_router, "try_service_client", lambda: None)

    r = client.delete("/api/pipeline/knowledge/kd-1", headers=AUTH)
    assert r.status_code == 500
    assert db.removed == []  # storage untouched — row delete failed first
