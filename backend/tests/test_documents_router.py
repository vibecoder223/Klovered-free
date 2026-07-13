import pytest
from fastapi.testclient import TestClient

from app import config, deps
from app.main import app
from app.routers import documents as documents_router

client = TestClient(app, raise_server_exceptions=False)


class FakeDb:
    def __init__(self, get_rows=None):
        self.get_rows = get_rows if get_rows is not None else []
        self.updates = []
        self.deletes = []
        self.inserts = []
        self.removed = []

    def get(self, table, params):
        return self.get_rows

    def update(self, table, params, patch):
        self.updates.append((table, params, patch))
        return []

    def delete(self, table, params):
        self.deletes.append((table, params))

    def insert(self, table, rows):
        self.inserts.append((table, rows))
        return [{"id": "x"}]

    def remove_storage(self, bucket, paths):
        self.removed.append((bucket, paths))


@pytest.fixture
def stub_auth(monkeypatch):
    monkeypatch.setattr(deps, "verify_jwt", lambda token: {"sub": "guest-abc", "is_anonymous": True})
    monkeypatch.setattr(deps, "resolve_org", lambda token, uid: "org-9")


AUTH = {"Authorization": "Bearer guest-jwt"}


def test_process_requires_document_id(stub_auth):
    r = client.post("/api/pipeline/documents/process", json={}, headers=AUTH)
    assert r.status_code == 400


def test_process_document_not_found(stub_auth, monkeypatch):
    monkeypatch.setattr(documents_router, "user_client", lambda token: FakeDb(get_rows=[]))
    r = client.post(
        "/api/pipeline/documents/process", json={"document_id": "d1"}, headers=AUTH
    )
    assert r.status_code == 404


def test_process_missing_llm_key_marks_skipped(stub_auth, monkeypatch):
    db = FakeDb(get_rows=[{"id": "d1", "deal_id": "deal1", "deals": {"org_id": "org-9"}}])
    monkeypatch.setattr(documents_router, "user_client", lambda token: db)
    config.get_settings.cache_clear()  # ensure no LLM key from env

    r = client.post(
        "/api/pipeline/documents/process", json={"document_id": "d1"}, headers=AUTH
    )
    assert r.status_code == 200
    assert r.json() == {"ok": True, "skipped": True, "reason": "llm_key_missing"}
    assert db.updates[0][2]["processing_status"] == "uploaded"


def test_process_no_service_role_is_503(stub_auth, monkeypatch):
    db = FakeDb(get_rows=[{"id": "d1", "deal_id": "deal1", "deals": {"org_id": "org-9"}}])
    monkeypatch.setattr(documents_router, "user_client", lambda token: db)
    monkeypatch.setenv("MISTRAL_API_KEY", "key")
    config.get_settings.cache_clear()
    monkeypatch.setattr(documents_router, "try_service_client", lambda: None)

    r = client.post(
        "/api/pipeline/documents/process", json={"document_id": "d1"}, headers=AUTH
    )
    assert r.status_code == 503


def test_process_happy_path_enqueues_and_drains(stub_auth, monkeypatch):
    db = FakeDb(get_rows=[{"id": "d1", "deal_id": "deal1", "deals": {"org_id": "org-9"}}])
    admin = FakeDb()
    monkeypatch.setattr(documents_router, "user_client", lambda token: db)
    monkeypatch.setattr(documents_router, "try_service_client", lambda: admin)
    monkeypatch.setenv("MISTRAL_API_KEY", "key")
    monkeypatch.setenv("CRON_SECRET", "s3cret")
    config.get_settings.cache_clear()

    enqueue_calls = []
    monkeypatch.setattr(
        documents_router,
        "enqueue_ingest",
        lambda db, *, document_id, org_id: enqueue_calls.append((document_id, org_id)),
    )
    drain_calls = []

    async def fake_run_drain(db):
        drain_calls.append(db)
        return {"claimed": 0, "results": []}

    monkeypatch.setattr(documents_router, "run_drain", fake_run_drain)

    r = client.post(
        "/api/pipeline/documents/process", json={"document_id": "d1"}, headers=AUTH
    )
    assert r.status_code == 200
    assert r.json() == {"ok": True, "queued": True}
    assert enqueue_calls == [("d1", "org-9")]
    assert admin.deletes == [("jobs", {"document_id": "eq.d1"})]
    assert admin.updates[0][2]["processing_status"] == "queued"
    assert drain_calls == [admin]


# ---------- upload / get / delete ----------


class TableDb:
    """FakeDb keyed by table name, for tests exercising more than one table."""

    def __init__(self, get_rows=None, insert_error=None):
        self.get_rows = get_rows or {}
        self.insert_error = insert_error
        self.inserts = []
        self.deletes = []
        self.uploads = []
        self.removed = []

    def get(self, table, params):
        return self.get_rows.get(table, [])

    def insert(self, table, rows):
        self.inserts.append((table, rows))
        if self.insert_error:
            raise self.insert_error
        return [{**rows, "id": "doc-1"}]

    def delete(self, table, params):
        self.deletes.append((table, params))

    def upload_storage(self, bucket, path, data, content_type):
        self.uploads.append((bucket, path, len(data), content_type))

    def remove_storage(self, bucket, paths):
        self.removed.append((bucket, paths))


def _post_upload(deal_id="deal-1", filename="rfp.pdf"):
    return client.post(
        "/api/pipeline/documents/upload",
        headers=AUTH,
        files={"file": (filename, b"pdf bytes", "application/pdf")},
        data={"deal_id": deal_id},
    )


def test_upload_deal_not_found(stub_auth, monkeypatch):
    db = TableDb(get_rows={"deals": []})
    monkeypatch.setattr(documents_router, "user_client", lambda token: db)
    r = _post_upload()
    assert r.status_code == 404


def test_upload_free_limit_one_rfp(stub_auth, monkeypatch):
    db = TableDb(get_rows={
        "deals": [{"id": "deal-1", "org_id": "org-9"}],
        "documents": [{"id": "existing"}],
    })
    monkeypatch.setattr(documents_router, "user_client", lambda token: db)
    r = _post_upload()
    assert r.status_code == 403
    assert "one RFP" in r.json()["error"]


def test_upload_happy_path_logs_activity(stub_auth, monkeypatch):
    db = TableDb(get_rows={"deals": [{"id": "deal-1", "org_id": "org-9"}], "documents": []})
    monkeypatch.setattr(documents_router, "user_client", lambda token: db)
    monkeypatch.setattr(documents_router, "try_service_client", lambda: None)
    log_calls = []
    monkeypatch.setattr(
        documents_router, "log_activity", lambda db, **kw: log_calls.append(kw)
    )

    r = _post_upload(filename="a b.pdf")
    assert r.status_code == 200
    doc = r.json()["document"]
    assert doc["deal_id"] == "deal-1"
    assert doc["filename"] == "a b.pdf"
    assert db.uploads[0][0] == "documents"
    assert "a_b.pdf" in db.uploads[0][1]
    assert log_calls[0]["org_id"] == "org-9"
    assert log_calls[0]["entity_id"] == "doc-1"


def test_upload_insert_failure_rolls_back_storage(stub_auth, monkeypatch):
    db = TableDb(
        get_rows={"deals": [{"id": "deal-1", "org_id": "org-9"}], "documents": []},
        insert_error=RuntimeError("db down"),
    )
    monkeypatch.setattr(documents_router, "user_client", lambda token: db)
    monkeypatch.setattr(documents_router, "try_service_client", lambda: None)

    r = _post_upload()
    assert r.status_code == 500
    assert db.removed and db.removed[0][0] == "documents"


def test_get_document_not_found(stub_auth, monkeypatch):
    monkeypatch.setattr(documents_router, "user_client", lambda token: FakeDb(get_rows=[]))
    r = client.get("/api/pipeline/documents/doc-1", headers=AUTH)
    assert r.status_code == 404


def test_get_document_returns_status(stub_auth, monkeypatch):
    db = FakeDb(get_rows=[{"id": "doc-1", "processing_status": "completed", "error_message": None}])
    monkeypatch.setattr(documents_router, "user_client", lambda token: db)
    r = client.get("/api/pipeline/documents/doc-1", headers=AUTH)
    assert r.status_code == 200
    assert r.json()["document"]["processing_status"] == "completed"


def test_delete_document_not_found(stub_auth, monkeypatch):
    monkeypatch.setattr(documents_router, "user_client", lambda token: FakeDb(get_rows=[]))
    r = client.delete("/api/pipeline/documents/doc-1", headers=AUTH)
    assert r.status_code == 404


def test_delete_document_removes_storage_then_row(stub_auth, monkeypatch):
    db = FakeDb(get_rows=[
        {"id": "doc-1", "file_path": "deal-1/f.pdf", "deal_id": "deal-1", "deals": {"org_id": "org-9"}}
    ])
    monkeypatch.setattr(documents_router, "user_client", lambda token: db)
    monkeypatch.setattr(documents_router, "try_service_client", lambda: None)

    r = client.delete("/api/pipeline/documents/doc-1", headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert db.deletes == [("documents", {"id": "eq.doc-1"})]
    assert db.removed == [("documents", ["deal-1/f.pdf"])]
