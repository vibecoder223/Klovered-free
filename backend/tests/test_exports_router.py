import pytest
from fastapi.testclient import TestClient

from app import deps
from app.main import app
from app.routers import exports as exports_router

client = TestClient(app, raise_server_exceptions=False)

AUTH = {"Authorization": "Bearer guest-jwt"}


class FakeDb:
    def __init__(self, rows=None, download_data=b"pdf-bytes", download_error=None):
        self.rows = rows if rows is not None else []
        self.download_data = download_data
        self.download_error = download_error

    def get(self, table, params):
        return self.rows

    def download_storage(self, bucket, path):
        if self.download_error:
            raise self.download_error
        return self.download_data


@pytest.fixture
def stub_auth(monkeypatch):
    monkeypatch.setattr(deps, "verify_jwt", lambda token: {"sub": "guest-abc", "is_anonymous": True})
    monkeypatch.setattr(deps, "resolve_org", lambda token, uid: "org-9")


def test_download_not_found(stub_auth, monkeypatch):
    monkeypatch.setattr(exports_router, "user_client", lambda token: FakeDb(rows=[]))
    r = client.get("/api/pipeline/exports/exp-1/download", headers=AUTH)
    assert r.status_code == 404


def test_download_returns_docx_bytes_with_headers(stub_auth, monkeypatch):
    db = FakeDb(
        rows=[{"file_path": "deal-1/export-123.docx", "deal_id": "deal-1", "format": "docx"}],
        download_data=b"docx-bytes",
    )
    monkeypatch.setattr(exports_router, "user_client", lambda token: db)
    monkeypatch.setattr(exports_router, "try_service_client", lambda: None)

    r = client.get("/api/pipeline/exports/exp-1/download", headers=AUTH)
    assert r.status_code == 200
    assert r.content == b"docx-bytes"
    assert r.headers["content-type"].startswith("application/vnd.openxmlformats")
    assert 'filename="export-123.docx"' in r.headers["content-disposition"]


def test_download_defaults_to_pdf_content_type(stub_auth, monkeypatch):
    db = FakeDb(rows=[{"file_path": "deal-1/export-1.pdf", "deal_id": "deal-1", "format": "pdf"}])
    monkeypatch.setattr(exports_router, "user_client", lambda token: db)
    monkeypatch.setattr(exports_router, "try_service_client", lambda: None)

    r = client.get("/api/pipeline/exports/exp-1/download", headers=AUTH)
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"


def test_download_storage_failure_is_500(stub_auth, monkeypatch):
    db = FakeDb(
        rows=[{"file_path": "deal-1/export-1.pdf", "deal_id": "deal-1", "format": "pdf"}],
        download_error=RuntimeError("object not found"),
    )
    monkeypatch.setattr(exports_router, "user_client", lambda token: db)
    monkeypatch.setattr(exports_router, "try_service_client", lambda: None)

    r = client.get("/api/pipeline/exports/exp-1/download", headers=AUTH)
    assert r.status_code == 500
