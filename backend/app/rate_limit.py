"""Minimal in-process sliding-window rate limiter (port of lib/rate-limit.ts).

Best-effort within a single process, which is enough to stop burst abuse of
upload endpoints. Move to a shared store (Postgres/Redis) if hard guarantees
are ever needed across multiple workers.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

MAX_BUCKETS = 10_000


@dataclass
class _Window:
    count: int
    reset_at: float


_buckets: dict[str, _Window] = {}


def rate_limit(key: str, limit: int, window_ms: int) -> bool:
    now = time.time() * 1000
    w = _buckets.get(key)

    if not w or now >= w.reset_at:
        # Opportunistic cleanup so the dict can't grow unbounded.
        if len(_buckets) >= MAX_BUCKETS:
            for k, v in list(_buckets.items()):
                if now >= v.reset_at:
                    del _buckets[k]
        _buckets[key] = _Window(count=1, reset_at=now + window_ms)
        return True

    if w.count >= limit:
        return False
    w.count += 1
    return True
