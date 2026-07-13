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
