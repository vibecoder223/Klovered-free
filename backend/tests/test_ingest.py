import asyncio

from app.pipeline import ingest
from app.pipeline.chunk import ProducedChunk
from app.pipeline.ingest import KDoc, ingest_knowledge_document
from app.pipeline.parse import Block, ParsedDoc


class FakeDb:
    """Records writes; get() is scripted per-test for the dedup lookup."""

    def __init__(self, existing=None):
        self.existing = existing or []
        self.inserts = []
        self.updates = []
        self.deletes = []
        self.downloads = []

    def download_storage(self, bucket, path):
        self.downloads.append((bucket, path))
        return b"raw-bytes"

    def get(self, table, params):
        return self.existing

    def insert(self, table, rows):
        self.inserts.append((table, rows))
        return [{"id": "x"}]

    def update(self, table, params, patch):
        self.updates.append((table, params, patch))
        return []

    def delete(self, table, params):
        self.deletes.append((table, params))

    def stages(self):
        return [
            p["error_message"].removeprefix("STAGE:")
            for _, _, p in self.updates
            if isinstance(p.get("error_message"), str)
            and p["error_message"].startswith("STAGE:")
        ]


def _doc():
    return KDoc(id="d1", org_id="org1", filename="policy.pdf", file_path="org1/policy.pdf")


def _patch_pipeline(monkeypatch, *, blocks=None, chunks=None, embeddings=None, has=True):
    parsed = ParsedDoc(
        blocks=blocks if blocks is not None else [Block(type="paragraph", text="hello", page=1)],
        page_count=3,
        raw_text="hello world",
    )
    monkeypatch.setattr(ingest, "parse_document", lambda *a, **k: parsed)
    produced = chunks if chunks is not None else [
        ProducedChunk(
            text="hello", text_for_embedding="[policy.pdf > Body, p.1]\nhello",
            section_path="Body", page_start=1, page_end=1, sparse_terms=["hello"],
        )
    ]
    monkeypatch.setattr(ingest, "chunk_blocks", lambda **k: produced)
    monkeypatch.setattr(ingest, "has_embeddings", lambda: has)

    async def fake_embed(texts, kind):
        return embeddings if embeddings is not None else [[0.1, 0.2, 0.3] for _ in texts]

    monkeypatch.setattr(ingest, "embed_texts", fake_embed)
    return parsed, produced


def test_happy_path_stores_chunks_and_marks_ready(monkeypatch):
    _patch_pipeline(monkeypatch)
    db = FakeDb(existing=[])
    result = asyncio.run(ingest_knowledge_document(db, _doc()))

    assert result == {"chunk_count": 1, "page_count": 3, "dedup": False}
    assert db.stages() == ["downloading", "parsing", "chunking", "embedding", "storing"]
    assert db.downloads == [("knowledge", "org1/policy.pdf")]
    # old chunks wiped before insert
    assert db.deletes == [("document_chunks", {"knowledge_document_id": "eq.d1"})]
    inserted = [rows for t, rows in db.inserts if t == "document_chunks"]
    assert inserted and inserted[0][0]["embedding"] == [0.1, 0.2, 0.3]
    assert inserted[0][0]["raw_text"] == "hello"
    final = db.updates[-1][2]
    assert final["ingestion_status"] == "ready"
    assert final["text_hash"] and final["error_message"] is None
    assert final["page_count"] == 3


def test_dedup_skips_chunking(monkeypatch):
    _patch_pipeline(monkeypatch)
    db = FakeDb(existing=[{"id": "other", "ingestion_status": "ready"}])
    result = asyncio.run(ingest_knowledge_document(db, _doc()))

    assert result == {"chunk_count": 0, "page_count": 3, "dedup": True}
    assert db.inserts == []
    assert db.deletes == []
    final = db.updates[-1][2]
    assert final["ingestion_status"] == "ready"
    assert "text_hash" not in final  # must not rewrite the unique hash
    assert "Deduplicated" in final["error_message"]


def test_no_embeddings_stores_null_and_hint(monkeypatch):
    _patch_pipeline(monkeypatch, has=False)
    db = FakeDb(existing=[])
    result = asyncio.run(ingest_knowledge_document(db, _doc()))

    assert result["chunk_count"] == 1
    inserted = [rows for t, rows in db.inserts if t == "document_chunks"][0]
    assert inserted[0]["embedding"] is None
    final = db.updates[-1][2]
    assert final["ingestion_status"] == "ready"
    assert "MISTRAL_API_KEY" in final["error_message"]


def test_empty_parse_raises(monkeypatch):
    _patch_pipeline(monkeypatch, blocks=[])
    db = FakeDb(existing=[])
    try:
        asyncio.run(ingest_knowledge_document(db, _doc()))
        assert False, "expected ValueError"
    except ValueError as e:
        assert "No content" in str(e)
    assert db.inserts == []
