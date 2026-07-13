"""Embeddings -- mistral-embed @ 1024 dims (native, symmetric: same embedding
for queries and passages). Matches the DB pgvector(1024) column and
match_chunks(p_embedding vector(1024)) RPC. No reranker -- ranking is by
cosine similarity from match_chunks directly.

Python port of ``lib/embeddings.ts``. Calls are paced through a small
concurrency gate (EMBED_MAX_CONCURRENCY, default 1) before hitting the
network. Mistral's tier enforces a per-second cap -- firing embedding calls
for a whole batch of questions concurrently previously burst past that limit
and exhausted the in-call 429 retry budget. On a 429 we still honour
``retry-after`` with exponential backoff before surfacing a hard failure.
"""

from __future__ import annotations

import asyncio
import os
import random
import time
from typing import Any, Literal

import httpx

from app.config import get_settings

MISTRAL_EMBED_URL = "https://api.mistral.ai/v1/embeddings"


def _embed_model() -> str:
    return os.environ.get("MISTRAL_EMBED_MODEL") or "mistral-embed"


EMBED_DIMS = 1024

EMBED_BATCH_SIZE = 128  # max inputs per embed call
MAX_RETRY_WAIT_MS = 30_000
MAX_RETRIES = 4

InputType = Literal["document", "query"]


def _has_mistral_key() -> bool:
    return bool(get_settings().mistral_api_key)


def has_embeddings() -> bool:
    """True if an embedding provider is available."""
    return _has_mistral_key()


# ---- Serialized rate gate ---------------------------------------------------
# mistral-embed is capped per-minute -- bursting past it via unbounded
# concurrency previously produced 429 storms (and the occasional
# generation_failed when a batch's retrieval retries were exhausted).
# Concurrency 1 + a minimum interval keeps every embed call strictly under the
# ceiling so 429s effectively never happen, no matter how many parallel
# callers (library lookup + retrieval across all sub-batches) hit the
# endpoint at once.


def _embed_max_concurrency() -> int:
    return int(os.environ.get("EMBED_MAX_CONCURRENCY", 1))


def _embed_min_interval_ms() -> float:
    return float(os.environ.get("EMBED_MIN_INTERVAL_MS", 1050))


_embed_in_flight = 0
_embed_waiters: list[asyncio.Future] = []
_last_embed_at = 0.0
_gate_lock = asyncio.Lock()


def _now_ms() -> float:
    return time.monotonic() * 1000.0


async def _acquire_embed_slot() -> None:
    global _embed_in_flight, _last_embed_at
    max_concurrency = _embed_max_concurrency()
    loop = asyncio.get_event_loop()
    fut: asyncio.Future | None = None
    async with _gate_lock:
        if _embed_in_flight < max_concurrency:
            _embed_in_flight += 1
        else:
            fut = loop.create_future()
            _embed_waiters.append(fut)
    if fut is not None:
        await fut

    wait = _embed_min_interval_ms() - (_now_ms() - _last_embed_at)
    if wait > 0:
        await asyncio.sleep(wait / 1000.0)
    _last_embed_at = _now_ms()


async def _release_embed_slot() -> None:
    global _embed_in_flight
    async with _gate_lock:
        if _embed_waiters:
            nxt = _embed_waiters.pop(0)
            if not nxt.done():
                nxt.set_result(None)
            # transfer slot, in_flight unchanged
        else:
            _embed_in_flight -= 1


async def _embed_api_fetch(url: str, body: dict[str, Any], api_key: str) -> httpx.Response:
    await _acquire_embed_slot()
    try:
        return await _embed_api_fetch_inner(url, body, api_key)
    finally:
        await _release_embed_slot()


async def _embed_api_fetch_inner(url: str, body: dict[str, Any], api_key: str) -> httpx.Response:
    attempt = 0
    while True:
        async with httpx.AsyncClient(timeout=90.0) as client:
            res = await client.post(
                url,
                headers={
                    "content-type": "application/json",
                    "authorization": f"Bearer {api_key}",
                },
                json=body,
            )

        if res.status_code == 429:
            retry_after_hdr = res.headers.get("retry-after")
            try:
                retry_after = float(retry_after_hdr) if retry_after_hdr is not None else 5.0
            except ValueError:
                retry_after = 5.0
            base = max(1_000.0, retry_after * 1000.0)
            backoff = min(MAX_RETRY_WAIT_MS, base * (2**attempt))
            if attempt < MAX_RETRIES:
                jitter = backoff * (0.7 + random.random() * 0.6)
                await asyncio.sleep(jitter / 1000.0)
                attempt += 1
                continue
            raise RuntimeError(f"Mistral embed 429 on {url} after {MAX_RETRIES} retries")

        return res


# ---- Embeddings --------------------------------------------------------------


async def _embed_mistral_batch(batch: list[str]) -> list[list[float]]:
    res = await _embed_api_fetch(
        MISTRAL_EMBED_URL,
        {"model": _embed_model(), "input": batch},
        get_settings().mistral_api_key,
    )

    if res.status_code < 200 or res.status_code >= 300:
        text = res.text
        raise RuntimeError(f"Mistral embed failed: {res.status_code} {text[:300]}")

    j = res.json()
    data = j.get("data") or []
    result: list[list[float] | None] = [None] * len(batch)
    for d in sorted(data, key=lambda item: item["index"]):
        result[d["index"]] = d["embedding"]
    return result  # type: ignore[return-value]


async def embed_texts(
    texts: list[str], input_type: InputType = "document"
) -> list[list[float]]:
    """Embed a list of texts.

    Throws if Mistral is not configured or the call fails. Callers must catch
    and mark the document/chunk as failed.

    ``input_type`` is accepted for parity with the TS signature (query vs.
    document) but mistral-embed is symmetric -- it does not change the
    request.
    """
    if len(texts) == 0:
        return []
    if not has_embeddings():
        raise RuntimeError("Embeddings unavailable: set MISTRAL_API_KEY in .env.local.")

    out: list[list[float] | None] = [None] * len(texts)
    batches: list[tuple[int, list[str]]] = []
    for i in range(0, len(texts), EMBED_BATCH_SIZE):
        batches.append((i, texts[i : i + EMBED_BATCH_SIZE]))

    async def _run(start: int, batch: list[str]) -> None:
        embs = await _embed_mistral_batch(batch)
        for i, e in enumerate(embs):
            out[start + i] = e

    await asyncio.gather(*(_run(start, batch) for start, batch in batches))

    return out  # type: ignore[return-value]
