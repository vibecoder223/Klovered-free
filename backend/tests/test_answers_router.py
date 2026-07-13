import pytest
from fastapi.testclient import TestClient

from app import deps
from app.main import app
from app.routers import answers as answers_router

client = TestClient(app, raise_server_exceptions=False)

AUTH = {"Authorization": "Bearer guest-jwt"}


class FakeDb:
    def __init__(self, docs=None, questions=None):
        self.docs = docs if docs is not None else []
        self.questions = questions if questions is not None else []

    def get(self, table, params):
        if table == "documents":
            return self.docs
        if table == "questions":
            return self.questions
        return []


@pytest.fixture
def stub_auth(monkeypatch):
    monkeypatch.setattr(deps, "verify_jwt", lambda token: {"sub": "guest-abc", "is_anonymous": True})
    monkeypatch.setattr(deps, "resolve_org", lambda token, uid: "org-9")


def test_requires_deal_id(stub_auth):
    r = client.get("/api/pipeline/answers", headers=AUTH)
    assert r.status_code == 400


def test_no_documents_returns_empty(stub_auth, monkeypatch):
    monkeypatch.setattr(answers_router, "user_client", lambda token: FakeDb(docs=[]))
    r = client.get("/api/pipeline/answers?deal_id=deal-1", headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {"questions": []}


def test_maps_response_and_citations_list_shape(stub_auth, monkeypatch):
    db = FakeDb(
        docs=[{"id": "doc-1"}],
        questions=[
            {
                "id": "q1",
                "question_text": "Do you encrypt data at rest?",
                "status": "answered",
                "responses": [
                    {
                        "id": "r1",
                        "draft_text": "Yes, AES-256.",
                        "confidence": 0.9,
                        "gap_flag": "ok",
                        "citations": [
                            {"chunk_id": "c1", "document_filename": "sec.pdf", "page": 4}
                        ],
                    }
                ],
            },
            {"id": "q2", "question_text": "Unanswered?", "status": "pending", "responses": []},
        ],
    )
    monkeypatch.setattr(answers_router, "user_client", lambda token: db)
    r = client.get("/api/pipeline/answers?deal_id=deal-1", headers=AUTH)
    assert r.status_code == 200
    body = r.json()["questions"]
    assert body[0]["response"] == {
        "answer_text": "Yes, AES-256.",
        "confidence": 0.9,
        "gap_flag": "ok",
        "citations": [{"chunk_id": "c1", "filename": "sec.pdf", "page_start": 4}],
    }
    assert body[1]["response"] is None


def test_maps_response_single_object_shape(stub_auth, monkeypatch):
    # PostgREST can embed a to-one relationship as a bare object rather than
    # a list, depending on cardinality detection — must handle both.
    db = FakeDb(
        docs=[{"id": "doc-1"}],
        questions=[
            {
                "id": "q1",
                "question_text": "Q?",
                "status": "answered",
                "responses": {
                    "id": "r1", "draft_text": "A.", "confidence": 0.5,
                    "gap_flag": "ok", "citations": [],
                },
            }
        ],
    )
    monkeypatch.setattr(answers_router, "user_client", lambda token: db)
    r = client.get("/api/pipeline/answers?deal_id=deal-1", headers=AUTH)
    assert r.json()["questions"][0]["response"]["answer_text"] == "A."
