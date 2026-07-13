import asyncio

from app.pipeline import answer_library
from app.pipeline.answer_library import record_reuse, suggest_answers


class FakeDb:
    def __init__(self, rpc_rows=None, get_rows=None):
        self._rpc_rows = rpc_rows or []
        self._get_rows = get_rows or []
        self.updates = []

    def rpc(self, fn, args):
        self.last_rpc = (fn, args)
        return self._rpc_rows

    def get(self, table, params):
        return self._get_rows

    def update(self, table, params, patch):
        self.updates.append((table, params, patch))


def test_suggest_answers_maps_rpc_rows(monkeypatch):
    async def fake_embed(texts, input_type):
        assert input_type == "query"
        return [[0.1, 0.2, 0.3]]

    monkeypatch.setattr(answer_library, "embed_texts", fake_embed)
    monkeypatch.setattr(answer_library, "has_embeddings", lambda: True)

    db = FakeDb(rpc_rows=[{"id": "a1", "response_text": "Yes.", "similarity": 0.93, "source_question_id": "q9"}])
    out = asyncio.run(suggest_answers(db, org_id="org-1", question_text="Do you support SSO?", limit=1))

    assert len(out) == 1
    assert out[0].id == "a1"
    assert out[0].similarity == 0.93
    assert db.last_rpc[0] == "match_answers"
    assert db.last_rpc[1]["p_org_id"] == "org-1"


def test_suggest_answers_empty_without_embeddings(monkeypatch):
    monkeypatch.setattr(answer_library, "has_embeddings", lambda: False)
    db = FakeDb()
    out = asyncio.run(suggest_answers(db, org_id="org-1", question_text="x"))
    assert out == []


def test_record_reuse_bumps_usage_count():
    db = FakeDb(get_rows=[{"usage_count": 4}])
    record_reuse(db, "a1")
    assert db.updates
    _, params, patch = db.updates[0]
    assert params == {"id": "eq.a1"}
    assert patch["usage_count"] == 5
    assert "last_used_at" in patch
