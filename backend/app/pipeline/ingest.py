"""Knowledge-base ingestion: download -> parse -> chunk -> embed -> store
(port of lib/ingest.ts). Returns a summary dict; raises on failure. `db` is a
service-role SupabaseRest.

Deviation: the TS wraps parse in a 60s Promise.race timeout to guard against
mammoth hangs. parse_document here is synchronous, so a hard timeout would need a
worker thread; it's omitted (PyMuPDF/mammoth-python are the parsers and haven't
shown the hang the TS comment guards against). Everything else is 1:1.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from .chunk import chunk_blocks
from .embeddings import embed_texts, has_embeddings
from .parse import parse_document


@dataclass
class KDoc:
    id: str
    org_id: str
    filename: str
    file_path: str
    mime_type: str | None = None


async def ingest_knowledge_document(db, doc: KDoc) -> dict:
    def set_stage(stage: str) -> None:
        # Stage is written to error_message with a "STAGE:" prefix so the UI can
        # poll progress without a schema change. Final success clears it.
        db.update(
            "knowledge_documents",
            {"id": f"eq.{doc.id}"},
            {"ingestion_status": "processing", "error_message": f"STAGE:{stage}"},
        )

    set_stage("downloading")

    # 1. Download
    buf = db.download_storage("knowledge", doc.file_path)

    # 2. Parse
    set_stage("parsing")
    parsed = parse_document(buf, doc.mime_type, doc.filename)
    if not parsed.blocks:
        raise ValueError("No content extracted from document.")

    # 3. Hash for dedup
    text_hash = hashlib.sha256(parsed.raw_text.encode("utf-8")).hexdigest()

    existing = db.get(
        "knowledge_documents",
        {
            "select": "id,ingestion_status",
            "org_id": f"eq.{doc.org_id}",
            "text_hash": f"eq.{text_hash}",
            "id": f"neq.{doc.id}",
            "limit": "1",
        },
    )
    if existing and existing[0].get("ingestion_status") == "ready":
        # A prior identical-text doc already holds the (org_id, text_hash) unique
        # row — mark this one ready WITHOUT writing text_hash, skip re-chunking.
        db.update(
            "knowledge_documents",
            {"id": f"eq.{doc.id}"},
            {
                "ingestion_status": "ready",
                "page_count": parsed.page_count,
                "error_message": "Deduplicated against a previously ingested document with identical text.",
            },
        )
        return {"chunk_count": 0, "page_count": parsed.page_count, "dedup": True}

    # 4. Chunk
    set_stage("chunking")
    chunks = chunk_blocks(blocks=parsed.blocks, filename=doc.filename)
    if not chunks:
        raise ValueError("Chunker produced 0 chunks (document may be empty).")

    # 5. Embed
    set_stage("embedding")
    embeddings = (
        await embed_texts([c.text_for_embedding for c in chunks], "document")
        if has_embeddings()
        else []
    )

    # 6. Persist — wipe prior chunks for idempotent re-ingest
    set_stage("storing")
    db.delete("document_chunks", {"knowledge_document_id": f"eq.{doc.id}"})

    rows = [
        {
            "knowledge_document_id": doc.id,
            "org_id": doc.org_id,
            "chunk_index": i,
            "section_title": c.section_path,
            "section_path": c.section_path,
            "page_start": c.page_start,
            "page_end": c.page_end,
            "raw_text": c.text,
            "cleaned_text": c.text,
            "text_for_embedding": c.text_for_embedding,
            "embedding": embeddings[i] if has_embeddings() else None,
            "sparse_terms": c.sparse_terms,
        }
        for i, c in enumerate(chunks)
    ]
    for i in range(0, len(rows), 50):
        db.insert("document_chunks", rows[i : i + 50])

    db.update(
        "knowledge_documents",
        {"id": f"eq.{doc.id}"},
        {
            "ingestion_status": "ready",
            "page_count": parsed.page_count,
            "text_hash": text_hash,
            "error_message": None
            if has_embeddings()
            else "Stored without embeddings — set MISTRAL_API_KEY in .env.local and re-ingest to enable retrieval.",
        },
    )

    return {"chunk_count": len(chunks), "page_count": parsed.page_count, "dedup": False}
