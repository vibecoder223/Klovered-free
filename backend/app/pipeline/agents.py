"""Agent pipeline (port of lib/agents.ts).

RFP-side pipeline: ingestion -> chunking (page-aware) -> requirement extraction
(validated) -> structuring (compliance matrix + questions). Response generation
lives in rag.py. Each stage persists to Supabase and records an `agent_runs`
entry with token usage + estimated cost.

The stages run as trusted workers: they take a service-role `SupabaseRest` (`db`)
and bypass RLS, exactly like the TS admin-client path. `db` only needs the
methods used here (get/insert/update/delete/download_storage), so tests pass a
fake.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

from ..mistral import MODEL, call_mistral_json, estimate_cost
from .chunk import ProducedChunk, chunk_blocks
from .embeddings import embed_texts, has_embeddings
from .parse import ParsedDoc, parse_document


@dataclass
class Doc:
    id: str
    deal_id: str
    filename: str
    file_path: str
    mime_type: str | None = None
    extracted_text: str | None = None


@dataclass
class ExtractedRequirement:
    requirement_id: str
    text: str
    classification: str  # must | should | info
    topic: str  # security | legal | pricing | technical | commercial
    section: str | None = None
    source_page: int | None = None


def _iso(ms: float) -> str:
    import datetime as _dt

    return _dt.datetime.fromtimestamp(ms / 1000, tz=_dt.timezone.utc).isoformat()


def record_run(
    db,
    *,
    document_id: str,
    agent_type: str,
    status: str,
    started_at: float,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    error_message: str | None = None,
    result: object | None = None,
) -> None:
    cost = (
        estimate_cost(input_tokens, output_tokens)
        if input_tokens is not None and output_tokens is not None
        else None
    )
    db.insert(
        "agent_runs",
        {
            "document_id": document_id,
            "agent_type": agent_type,
            "status": status,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost": cost,
            "error_message": error_message,
            "result": result,
            "started_at": _iso(started_at),
            "completed_at": _iso(time.time() * 1000),
        },
    )


def _set_status(db, document_id: str, status: str, error_message: str | None = None) -> None:
    db.update(
        "documents",
        {"id": f"eq.{document_id}"},
        {"processing_status": status, "error_message": error_message},
    )


# ── Agent 1: Ingestion ──────────────────────────────────────────────────────
async def run_ingestion_agent(db, doc: Doc) -> ParsedDoc:
    started_at = time.time() * 1000
    _set_status(db, doc.id, "extracting")
    try:
        buf = db.download_storage("documents", doc.file_path)
        parsed = parse_document(buf, doc.mime_type, doc.filename)
        if not parsed.blocks:
            raise ValueError("No content extracted from this document.")
        db.update("documents", {"id": f"eq.{doc.id}"}, {"extracted_text": parsed.raw_text})
        record_run(
            db,
            document_id=doc.id,
            agent_type="ingestion",
            status="completed",
            result={
                "chars": len(parsed.raw_text),
                "pages": parsed.page_count,
                "blocks": len(parsed.blocks),
            },
            started_at=started_at,
        )
        return parsed
    except Exception as e:  # noqa: BLE001 — record then re-raise, mirroring TS
        record_run(
            db,
            document_id=doc.id,
            agent_type="ingestion",
            status="failed",
            error_message=str(e),
            started_at=started_at,
        )
        raise


# ── Agent 2: Chunking (+ embed + persist chunks) ────────────────────────────
async def run_chunking_agent(db, doc: Doc, parsed: ParsedDoc) -> list[ProducedChunk]:
    started_at = time.time() * 1000
    _set_status(db, doc.id, "chunked")
    try:
        chunks = chunk_blocks(blocks=parsed.blocks, filename=doc.filename)

        deal = db.get("deals", {"select": "org_id", "id": f"eq.{doc.deal_id}", "limit": "1"})
        org_id = deal[0]["org_id"] if deal else None

        embeddings: list[list[float]] = (
            await embed_texts([c.text_for_embedding for c in chunks], "document")
            if has_embeddings()
            else []
        )

        db.delete("document_chunks", {"document_id": f"eq.{doc.id}"})
        if chunks:
            rows = [
                {
                    "document_id": doc.id,
                    "org_id": org_id,
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

        record_run(
            db,
            document_id=doc.id,
            agent_type="chunking",
            status="completed",
            result={"chunk_count": len(chunks)},
            started_at=started_at,
        )
        return chunks
    except Exception as e:  # noqa: BLE001
        record_run(
            db,
            document_id=doc.id,
            agent_type="chunking",
            status="failed",
            error_message=str(e),
            started_at=started_at,
        )
        raise


# ── Agent 3: Requirement extraction (LLM, validated, with retry) ────────────
_EXTRACTION_SYS = """You are an expert RFP analyst. Extract every distinct requirement, question, or compliance item from ALL sections provided. Be exhaustive but de-duplicate within the batch.

Return a JSON array. Each item:
{
  "requirement_id": "Q2.3" | "R-4.1" | "REQ-N",
  "section": "4.2" | "Section 4.2 Security",
  "text": "<the full requirement text, paraphrased if needed>",
  "classification": "must" | "should" | "info",
  "topic": "security" | "legal" | "pricing" | "technical" | "commercial",
  "source_page": <integer page number, or null>
}

Return ONLY the JSON array. No prose, no markdown fences."""

_EXTRACTION_BATCH = 12


def _norm_classification(v) -> str:
    if not isinstance(v, str):
        return "must"
    s = v.lower()
    if s in ("must", "must-have", "mandatory", "required", "high"):
        return "must"
    if s in ("should", "should-have", "desired", "medium"):
        return "should"
    if s in ("info", "informational", "optional", "low"):
        return "info"
    return "must"


def _norm_topic(v) -> str:
    if not isinstance(v, str):
        return "technical"
    s = v.lower()
    if s in ("security", "legal", "pricing", "technical", "commercial"):
        return s
    if "secur" in s:
        return "security"
    if "legal" in s or "compli" in s:
        return "legal"
    if "price" in s or "cost" in s:
        return "pricing"
    if "tech" in s:
        return "technical"
    return "technical"


def _norm_page(v) -> int | None:
    if v is None or v == "":
        return None
    try:
        n = int(v) if not isinstance(v, float) else int(v)
        return n
    except (ValueError, TypeError):
        return None


def _validate_requirement(raw: dict) -> ExtractedRequirement | None:
    # Mirrors the zod schema: requirement_id + text required (non-empty),
    # classification/topic normalized with defaults, section/source_page coerced.
    rid = raw.get("requirement_id")
    text = raw.get("text")
    if rid is None or text is None:
        return None
    rid = str(rid)
    text = str(text)
    if not rid or not text:
        return None
    section = raw.get("section")
    section = None if section is None else str(section)
    return ExtractedRequirement(
        requirement_id=rid,
        text=text,
        classification=_norm_classification(raw.get("classification")),
        topic=_norm_topic(raw.get("topic")),
        section=section,
        source_page=_norm_page(raw.get("source_page")),
    )


_RATE_ERR_MARKERS = ("rate limit", "rate-limit", "429", "timeout", "abort", "llm ")


async def run_extraction_agent(db, doc: Doc, chunks: list[ProducedChunk]) -> list[ExtractedRequirement]:
    started_at = time.time() * 1000
    _set_status(db, doc.id, "analyzing")
    total_in = 0
    total_out = 0

    batches = [chunks[i : i + _EXTRACTION_BATCH] for i in range(0, len(chunks), _EXTRACTION_BATCH)]

    async def run_batch(batch: list[ProducedChunk]) -> tuple[list[ExtractedRequirement], int, int]:
        user = "\n\n".join(
            f"--- Section {idx + 1}: {c.section_path or 'Body'} "
            f"(page {c.page_start}{f'–{c.page_end}' if c.page_end != c.page_start else ''}) ---\n{c.text}"
            for idx, c in enumerate(batch)
        )
        parsed: list[ExtractedRequirement] | None = None
        last_err: str | None = None
        in_tok = 0
        out_tok = 0
        for attempt in range(3):
            try:
                res = await call_mistral_json(
                    system=_EXTRACTION_SYS,
                    user=user if attempt == 0
                    else f"{user}\n\n[Previous attempt failed: {last_err}. Return ONLY a JSON array.]",
                    max_tokens=8192,
                    model=MODEL,
                    mode="text",
                )
                in_tok += res["usage"].input_tokens
                out_tok += res["usage"].output_tokens
                data = res["data"]
                if isinstance(data, list):
                    validated = [r for r in (_validate_requirement(x) for x in data if isinstance(x, dict)) if r]
                    parsed = validated
                    break
                last_err = "expected a JSON array"
            except Exception as e:  # noqa: BLE001
                last_err = str(e)
        if parsed is None:
            if last_err and any(m in last_err.lower() for m in _RATE_ERR_MARKERS):
                raise RuntimeError(f"Extraction batch failed: {last_err}")
            return [], in_tok, out_tok
        for r in parsed:
            if r.source_page is None:
                r.source_page = batch[0].page_start
        return parsed, in_tok, out_tok

    try:
        results = await asyncio.gather(*(run_batch(b) for b in batches))
        all_reqs: list[ExtractedRequirement] = []
        for reqs, in_tok, out_tok in results:
            total_in += in_tok
            total_out += out_tok
            all_reqs.extend(reqs)

        seen: set[str] = set()
        deduped: list[ExtractedRequirement] = []
        for r in all_reqs:
            k = f"{r.requirement_id}::{r.text[:100]}"
            if k in seen:
                continue
            seen.add(k)
            deduped.append(r)

        db.delete("extracted_requirements", {"document_id": f"eq.{doc.id}"})
        if deduped:
            db.insert(
                "extracted_requirements",
                [
                    {
                        "document_id": doc.id,
                        "requirement_id": r.requirement_id,
                        "title": r.text[:120],
                        "description": r.text,
                        "category": r.topic,
                        "priority": "high" if r.classification == "must" else "medium" if r.classification == "should" else "low",
                        "is_mandatory": r.classification == "must",
                        "section": r.section,
                        "source_page": r.source_page,
                        "classification": r.classification,
                        "topic": r.topic,
                    }
                    for r in deduped
                ],
            )

        record_run(
            db,
            document_id=doc.id,
            agent_type="extraction",
            status="completed",
            input_tokens=total_in,
            output_tokens=total_out,
            result={"count": len(deduped)},
            started_at=started_at,
        )
        return deduped
    except Exception as e:  # noqa: BLE001
        record_run(
            db,
            document_id=doc.id,
            agent_type="extraction",
            status="failed",
            input_tokens=total_in,
            output_tokens=total_out,
            error_message=str(e),
            started_at=started_at,
        )
        raise


# ── Agent 4: Structuring (compliance matrix + questions) ────────────────────
async def run_structuring_agent(db, doc: Doc, reqs: list[ExtractedRequirement]) -> None:
    started_at = time.time() * 1000
    _set_status(db, doc.id, "structured")
    try:
        db.delete("compliance_matrix", {"document_id": f"eq.{doc.id}"})
        db.delete("questions", {"document_id": f"eq.{doc.id}"})

        if reqs:
            db.insert(
                "compliance_matrix",
                [
                    {
                        "document_id": doc.id,
                        "requirement_id": r.requirement_id,
                        "our_capability": None,
                        "compliance_status": "pending",
                    }
                    for r in reqs
                ],
            )
            db.insert(
                "questions",
                [
                    {
                        "document_id": doc.id,
                        "requirement_id": r.requirement_id,
                        "question_text": r.text,
                        "category": r.topic,
                        "priority": "high" if r.classification == "must" else "medium" if r.classification == "should" else "low",
                        "status": "todo",
                    }
                    for r in reqs
                ],
            )

        record_run(
            db,
            document_id=doc.id,
            agent_type="structuring",
            status="completed",
            result={"count": len(reqs)},
            started_at=started_at,
        )
    except Exception as e:  # noqa: BLE001
        record_run(
            db,
            document_id=doc.id,
            agent_type="structuring",
            status="failed",
            error_message=str(e),
            started_at=started_at,
        )
        raise
