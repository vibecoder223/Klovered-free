"""Hybrid retrieval: query expansion -> dense (pgvector, mistral-embed) +
sparse (BM25) -> merge/dedup -> top-6 by score. Returns ranked chunk
candidates with full provenance for citation.

Python port of ``lib/retrieval.ts``.
"""

from __future__ import annotations

import asyncio
import math
import os
import re
from dataclasses import dataclass

from app.mistral import MODEL, call_mistral_json, has_llm_key
from app.pipeline.embeddings import embed_texts, has_embeddings
from app.supabase_rest import SupabaseRest

# Calibrated to mistral-embed cosine similarity: genuinely relevant passages
# on this corpus commonly score 0.65-0.95; unrelated chunks fall below 0.5.
# 0.55 keeps real matches while filtering noise.
NO_SOURCE_THRESHOLD = 0.55


@dataclass
class Candidate:
    chunk_id: str
    text: str
    section_path: str | None
    page_start: int | None
    page_end: int | None
    document_filename: str
    # 0..1 -- cosine similarity (dense) or normalized BM25 score (sparse).
    score: float


@dataclass
class QueryExpansion:
    paraphrases: list[str]
    keywords: list[str]


@dataclass
class Usage:
    input_tokens: int
    output_tokens: int


@dataclass
class RetrievalResult:
    candidates: list[Candidate]
    top_score: float
    query_expansion: QueryExpansion | None
    usage: Usage


def _row_to_dense_candidate(row: dict) -> Candidate:
    return Candidate(
        chunk_id=row["chunk_id"],
        text=row["text"],
        section_path=row.get("section_path"),
        page_start=row.get("page_start"),
        page_end=row.get("page_end"),
        document_filename=row["document_filename"],
        score=row["similarity"],
    )


def _merge_dedup(dense: list[Candidate], sparse: list[Candidate]) -> list[Candidate]:
    merged: dict[str, Candidate] = {}
    for c in [*dense, *sparse]:
        if c.chunk_id not in merged:
            merged[c.chunk_id] = c
    return list(merged.values())


async def retrieve_for_query(
    supabase: SupabaseRest,
    *,
    org_id: str,
    query: str,
    top_k: int = 6,
) -> RetrievalResult:
    usage_in = 0
    usage_out = 0

    # 1. Query expansion. Off by default -- it costs an extra LLM call per
    # question and the recall gain is small. Set RAG_USE_QUERY_EXPANSION=1 to
    # re-enable. Embeddings still capture paraphrase similarity.
    expansion: QueryExpansion | None = None
    if os.environ.get("RAG_USE_QUERY_EXPANSION") == "1" and has_llm_key():
        try:
            result = await call_mistral_json(
                system=(
                    "You expand RFP requirement queries for retrieval.\n"
                    "Return JSON:\n"
                    '{ "paraphrases": [<2 short paraphrases of the requirement>],\n'
                    '  "keywords":    [<5 likely keywords or phrases that would appear in a relevant past document>] }\n'
                    "No prose, no fences."
                ),
                user=query,
                max_tokens=400,
                # Use the quality model -- llama3.1-8b returns {"type":"object"}
                # schema descriptors instead of real data under json_object mode.
                model=MODEL,
            )
            data = result["data"]
            usage = result["usage"]
            if isinstance(data, dict) and isinstance(data.get("paraphrases"), list) and isinstance(
                data.get("keywords"), list
            ):
                expansion = QueryExpansion(
                    paraphrases=list(data["paraphrases"])[:2],
                    keywords=list(data["keywords"])[:5],
                )
            usage_in += usage.input_tokens
            usage_out += usage.output_tokens
        except Exception:
            # Non-fatal -- proceed with the bare query.
            pass

    # 2. Dense retrieval (only if an embedding provider is configured).
    dense: list[Candidate] = []
    if has_embeddings():
        queries = [query, *(expansion.paraphrases if expansion else [])]
        embeds = await embed_texts(queries, "query")
        dense_map: dict[str, Candidate] = {}
        for e in embeds:
            try:
                rows = supabase.rpc(
                    "match_chunks",
                    {"p_org_id": org_id, "p_embedding": e, "p_match_count": 20},
                )
            except Exception:
                continue
            for row in rows or []:
                existing = dense_map.get(row["chunk_id"])
                if existing is None or row["similarity"] > existing.score:
                    dense_map[row["chunk_id"]] = _row_to_dense_candidate(row)
        dense.extend(dense_map.values())

    # 3. Sparse retrieval (BM25) -- implemented in-memory over the workspace
    # because the corpus per workspace is small in v1. For large workspaces
    # we'd materialize a tsvector + GIN; out of scope.
    sparse = _sparse_search(
        supabase,
        org_id=org_id,
        keywords=expansion.keywords if expansion else _extract_keywords(query),
        top_k=20,
    )

    # 4. Merge -> dedup -> rerank
    candidates = _merge_dedup(dense, sparse)
    if not candidates:
        return RetrievalResult(
            candidates=[],
            top_score=0,
            query_expansion=expansion,
            usage=Usage(usage_in, usage_out),
        )

    ranked = sorted(candidates, key=lambda c: c.score, reverse=True)[:top_k]

    return RetrievalResult(
        candidates=ranked,
        top_score=ranked[0].score if ranked else 0,
        query_expansion=expansion,
        usage=Usage(usage_in, usage_out),
    )


async def retrieve_for_queries(
    supabase: SupabaseRest,
    *,
    org_id: str,
    queries: list[str],
    top_k: int = 6,
    embeddings: list[list[float]] | None = None,
) -> list[RetrievalResult]:
    """Batched retrieval for many queries at once. The throughput win: query
    embedding is the ONLY rate-limited step in retrieval (dense match_chunks
    and sparse BM25 are DB-only). Every query is embedded in a single
    embed_texts call (which internally batches + gates), collapsing many
    network calls to ~1. Query expansion is intentionally skipped -- per-query
    LLM expansion would defeat the batching and is off by default anyway.

    Returns results aligned 1:1 with the input ``queries`` order.
    """
    if len(queries) == 0:
        return []

    embeds: list[list[float]] = embeddings or []
    if len(embeds) == 0 and has_embeddings():
        try:
            embeds = await embed_texts(queries, "query")
        except Exception:
            embeds = []

    async def _one(i: int, query: str) -> RetrievalResult:
        dense: list[Candidate] = []
        emb = embeds[i] if i < len(embeds) else None
        if emb:
            try:
                rows = supabase.rpc(
                    "match_chunks",
                    {"p_org_id": org_id, "p_embedding": emb, "p_match_count": 20},
                )
            except Exception:
                rows = None
            if rows:
                for row in rows:
                    dense.append(_row_to_dense_candidate(row))

        sparse = _sparse_search(
            supabase, org_id=org_id, keywords=_extract_keywords(query), top_k=20
        )

        candidates = _merge_dedup(dense, sparse)
        if not candidates:
            return RetrievalResult([], 0, None, Usage(0, 0))

        ranked = sorted(candidates, key=lambda c: c.score, reverse=True)[:top_k]
        return RetrievalResult(ranked, ranked[0].score if ranked else 0, None, Usage(0, 0))

    return list(await asyncio.gather(*(_one(i, q) for i, q in enumerate(queries))))


def is_no_source(top_score: float, candidate_count: int) -> bool:
    return candidate_count == 0 or top_score < NO_SOURCE_THRESHOLD


# ---------- Sparse / BM25 ----------


def _sparse_search(
    supabase: SupabaseRest,
    *,
    org_id: str,
    keywords: list[str],
    top_k: int,
) -> list[Candidate]:
    if len(keywords) == 0:
        return []
    terms: list[str] = []
    for k in keywords:
        for t in re.split(r"\s+", k.lower()):
            cleaned = re.sub(r"[^a-z0-9\-]", "", t)
            if len(cleaned) >= 3:
                terms.append(cleaned)
    if len(terms) == 0:
        return []

    # Pull candidate rows whose sparse_terms overlap with our keywords.
    # GIN-indexed && (ov.) operator is efficient for this.
    params = {
        "select": (
            "id,raw_text,cleaned_text,section_path,page_start,page_end,sparse_terms,"
            "document_id,knowledge_document_id,knowledge_documents(filename),documents(filename)"
        ),
        "org_id": f"eq.{org_id}",
        "knowledge_document_id": "not.is.null",
        "sparse_terms": "ov.{" + ",".join(terms) + "}",
        "limit": "200",
    }
    try:
        rows = supabase.get("document_chunks", params)
    except Exception:
        return []
    if not rows:
        return []

    # BM25 scoring across the retrieved candidate set.
    n = len(rows)
    doc_freq: dict[str, int] = {}
    for r in rows:
        row_terms = set(r.get("sparse_terms") or [])
        for term in terms:
            if term in row_terms:
                doc_freq[term] = doc_freq.get(term, 0) + 1
    avgdl = sum(len(r.get("sparse_terms") or []) for r in rows) / max(1, n)
    k1 = 1.5
    b = 0.75

    scored: list[Candidate] = []
    for r in rows:
        tf: dict[str, int] = {}
        for term in r.get("sparse_terms") or []:
            tf[term] = tf.get(term, 0) + 1
        dl = len(r.get("sparse_terms") or [])
        score = 0.0
        for term in terms:
            f = tf.get(term)
            if not f:
                continue
            df = doc_freq.get(term) or 0.5
            idf = math.log((n - df + 0.5) / (df + 0.5) + 1)
            denom = f + k1 * (1 - b + b * (dl / avgdl if avgdl else 0))
            score += idf * ((f * (k1 + 1)) / denom) if denom else 0
        # Normalize to [0,1] for downstream comparability (rough).
        norm = min(1.0, score / 12)
        kd = r.get("knowledge_documents")
        dd = r.get("documents")
        filename = (
            (kd.get("filename") if isinstance(kd, dict) else None)
            or (dd.get("filename") if isinstance(dd, dict) else None)
            or "(unknown)"
        )
        scored.append(
            Candidate(
                chunk_id=r["id"],
                text=r.get("cleaned_text") or r.get("raw_text") or "",
                section_path=r.get("section_path"),
                page_start=r.get("page_start"),
                page_end=r.get("page_end"),
                document_filename=filename,
                score=norm,
            )
        )

    scored = [s for s in scored if s.score > 0]
    scored.sort(key=lambda s: s.score, reverse=True)
    return scored[:top_k]


def _extract_keywords(q: str) -> list[str]:
    lowered = q.lower()
    cleaned = re.sub(r"[^a-z0-9\s\-]", " ", lowered)
    toks = [t for t in cleaned.split() if len(t) >= 3]
    return toks[:8]
