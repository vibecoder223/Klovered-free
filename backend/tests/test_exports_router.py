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


# ---------- generate ----------


class GenDb:
    """FakeDb keyed by table; captures the storage upload + exports insert."""

    def __init__(self, tables):
        self.tables = tables  # {table: rows}
        self.uploads = []
        self.inserts = []

    def get(self, table, params):
        return self.tables.get(table, [])

    def upload_storage(self, bucket, path, data, content_type):
        self.uploads.append((bucket, path, data, content_type))

    def insert(self, table, rows):
        self.inserts.append((table, rows))
        return [{"id": "exp-new"}]


_DEAL = {"id": "deal-1", "name": "MoH Cloud Security RFP", "client_name": "Ministry of Health",
         "org_id": "org-9", "owner_id": None, "organizations": {"name": "Klovered"}}
_DOCS = [{"id": "doc-1", "filename": "rfp.pdf", "created_at": "2026-01-01"}]
_QUESTIONS = [{
    "document_id": "doc-1", "requirement_id": "REQ-1", "question_text": "Encryption?",
    "created_at": "2026-01-01",
    "responses": [{
        "id": "r1", "final_text": "AES-256 at rest.", "draft_text": None,
        "status": "approved", "gap_flag": "ok",
        "citations": [{"document_filename": "sec.pdf", "page": 3, "section_path": "Security"}],
    }],
}]


def _gen_db(**overrides):
    tables = {"deals": [_DEAL], "documents": _DOCS, "questions": _QUESTIONS}
    tables.update(overrides)
    return GenDb(tables)


def test_generate_requires_deal_and_docs(stub_auth, monkeypatch):
    monkeypatch.setattr(exports_router, "user_client", lambda token: _gen_db(documents=[]))
    r = client.post("/api/pipeline/exports/generate", json={}, headers=AUTH)
    assert r.status_code == 400


def test_generate_nothing_to_export(stub_auth, monkeypatch):
    monkeypatch.setattr(exports_router, "user_client", lambda token: _gen_db(questions=[]))
    r = client.post(
        "/api/pipeline/exports/generate",
        json={"deal_id": "deal-1", "document_ids": ["doc-1"]},
        headers=AUTH,
    )
    assert r.status_code == 400
    assert "Nothing to export" in r.json()["error"]


def test_generate_pdf_uploads_and_inserts(stub_auth, monkeypatch):
    db = _gen_db()
    monkeypatch.setattr(exports_router, "user_client", lambda token: db)
    monkeypatch.setattr(exports_router, "try_service_client", lambda: None)

    r = client.post(
        "/api/pipeline/exports/generate",
        json={"deal_id": "deal-1", "format": "pdf", "citation_style": "inline"},
        headers=AUTH,
    )
    assert r.status_code == 200
    assert r.json() == {"exportId": "exp-new", "format": "pdf"}
    bucket, path, data, ctype = db.uploads[0]
    assert bucket == "documents"
    assert path.startswith("deal-1/export-") and path.endswith(".pdf")
    assert data[:5] == b"%PDF-"  # real rendered PDF
    assert ctype == "application/pdf"
    table, row = db.inserts[0]
    assert table == "exports"
    assert row["format"] == "pdf" and row["document_id"] == "doc-1"


def test_generate_docx_produces_real_docx(stub_auth, monkeypatch):
    db = _gen_db()
    monkeypatch.setattr(exports_router, "user_client", lambda token: db)
    monkeypatch.setattr(exports_router, "try_service_client", lambda: None)

    r = client.post(
        "/api/pipeline/exports/generate",
        json={"deal_id": "deal-1", "format": "docx", "citation_style": "footnote"},
        headers=AUTH,
    )
    assert r.status_code == 200
    assert r.json()["format"] == "docx"
    _, path, data, ctype = db.uploads[0]
    assert path.endswith(".docx")
    assert data[:2] == b"PK"  # docx is a zip
    assert ctype.startswith("application/vnd.openxmlformats")


def test_generate_falls_back_to_min_deal_select_on_error(stub_auth, monkeypatch):
    # First deals get() (full column select) raises; the route must retry with
    # the minimal subset and still succeed.
    class RetryDb(GenDb):
        def __init__(self, tables):
            super().__init__(tables)
            self._deals_calls = 0

        def get(self, table, params):
            if table == "deals":
                self._deals_calls += 1
                if self._deals_calls == 1:
                    raise RuntimeError("column deals.win_probability does not exist")
            return super().get(table, params)

    db = RetryDb({"deals": [_DEAL], "documents": _DOCS, "questions": _QUESTIONS})
    monkeypatch.setattr(exports_router, "user_client", lambda token: db)
    monkeypatch.setattr(exports_router, "try_service_client", lambda: None)

    r = client.post(
        "/api/pipeline/exports/generate",
        json={"deal_id": "deal-1", "document_ids": ["doc-1"]},
        headers=AUTH,
    )
    assert r.status_code == 200
    assert db._deals_calls == 2  # full select failed, min select retried
