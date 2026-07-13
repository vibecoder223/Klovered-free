"""Mistral AI client -- OpenAI-compatible chat completions.

Python port of ``lib/mistral.ts``. Talks to Mistral's OpenAI-compatible
endpoint. Still env-driven, so it can be pointed at any OpenAI-compatible
provider without code changes:

    LLM_BASE_URL    base URL (default: https://api.mistral.ai/v1)
    LLM_API_KEY / MISTRAL_API_KEY   bearer key (via app.config.get_settings().llm_key)
    LLM_MODEL       quality model id  (default: mistral-large-latest)
    LLM_MODEL_FAST  fast/cheap model id (default: mistral-small-2603)
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import random
import re
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.config import get_settings


def _base_url() -> str:
    return (os.environ.get("LLM_BASE_URL") or "https://api.mistral.ai/v1").rstrip("/")


def _chat_url() -> str:
    return f"{_base_url()}/chat/completions"


# Quality model -- response generation, complex extraction.
def _model() -> str:
    return os.environ.get("LLM_MODEL") or "mistral-large-latest"


# Fast/cheap -- extraction batches, query expansion, confidence scoring.
def _model_fast() -> str:
    return os.environ.get("LLM_MODEL_FAST") or "mistral-small-2603"


# Module-level constants mirroring the TS exports. These are evaluated once at
# import time (matching TS module-eval semantics); tests that need to override
# the env should monkeypatch the env *and* reference gate_config_for /
# call-time helpers, which re-read env dynamically where it matters for the
# gate. MODEL / MODEL_FAST themselves are exposed both as live functions and as
# best-effort constants for parity with the TS `export const`.
MODEL = _model()
MODEL_FAST = _model_fast()

# Rough USD/MTok for cost display only (Mistral Large pricing; generation on
# the small model is cheaper, so this over-estimates slightly).
INPUT_PRICE_PER_MTOK = 0.50
OUTPUT_PRICE_PER_MTOK = 1.50


def estimate_cost(input_tokens: float, output_tokens: float) -> float:
    return (input_tokens / 1_000_000) * INPUT_PRICE_PER_MTOK + (
        output_tokens / 1_000_000
    ) * OUTPUT_PRICE_PER_MTOK


@dataclass
class Usage:
    input_tokens: int
    output_tokens: int


class RateLimitError(Exception):
    def __init__(self, message: str, retry_after_ms: float):
        super().__init__(message)
        self.retry_after_ms = retry_after_ms


def _get_key() -> str:
    k = get_settings().llm_key
    if not k:
        raise RuntimeError("No LLM API key set (LLM_API_KEY / MISTRAL_API_KEY).")
    return k


def has_llm_key() -> bool:
    """True if a Mistral API key is configured. Use this for "is the AI
    pipeline enabled" checks instead of testing a single env var."""
    return bool(get_settings().llm_key)


# 429 handling: a couple of in-call retries smooth over transient rate limits
# without bouncing the whole job. Honour the `retry-after` header.
MAX_RETRY_WAIT_MS = 30_000
MAX_RETRIES = 2


# ---- Per-model rate gate -----------------------------------------------------
# Mistral enforces rate limits PER MODEL, not account-wide, and the two models
# this app uses have very different shapes. Defaults below match our current
# paid Mistral tier (override any via env):
#   mistral-large-latest (MODEL, extraction -- few big calls):    15 RPM / 400,000 TPM
#   mistral-small-2603   (MODEL_FAST, generation -- many small):  100 RPM / 100,000 TPM
# A single shared gate tuned for one model starves or over-trusts the other,
# so gate state is keyed by model id and each gets its own rolling window.
#
# The gate is per PROCESS. Tune via env; set any limit to 0 to disable it.
#
#   LLM_RPM / LLM_TPM / LLM_MAX_CONCURRENCY / LLM_MIN_INTERVAL_MS
#     -- apply to MODEL (quality/extraction)
#   LLM_RPM_FAST / LLM_TPM_FAST / LLM_MAX_CONCURRENCY_FAST / LLM_MIN_INTERVAL_MS_FAST
#     -- apply to MODEL_FAST (fast/generation)


@dataclass
class ModelGateConfig:
    rpm: float
    tpm: float
    max_concurrency: int
    min_interval_ms: float


def gate_config_for(model: str) -> ModelGateConfig:
    if model == MODEL_FAST:
        return ModelGateConfig(
            rpm=float(os.environ.get("LLM_RPM_FAST", 100)),
            tpm=float(os.environ.get("LLM_TPM_FAST", 100_000)),
            max_concurrency=int(os.environ.get("LLM_MAX_CONCURRENCY_FAST", 8)),
            min_interval_ms=float(os.environ.get("LLM_MIN_INTERVAL_MS_FAST", 600)),
        )
    # Default bucket covers MODEL and any model not explicitly MODEL_FAST.
    return ModelGateConfig(
        rpm=float(os.environ.get("LLM_RPM", 15)),
        tpm=float(os.environ.get("LLM_TPM", 400_000)),
        max_concurrency=int(os.environ.get("LLM_MAX_CONCURRENCY", 8)),
        min_interval_ms=float(os.environ.get("LLM_MIN_INTERVAL_MS", 0)),
    )


@dataclass
class GateState:
    in_flight: int = 0
    waiters: list[asyncio.Future] = field(default_factory=list)
    token_window: list[tuple[float, float]] = field(default_factory=list)
    request_window: list[float] = field(default_factory=list)
    last_request_at: float = 0.0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


_gate_states: dict[str, GateState] = {}


def _state_for(model: str) -> GateState:
    s = _gate_states.get(model)
    if s is None:
        s = GateState()
        _gate_states[model] = s
    return s


def _now_ms() -> float:
    return time.monotonic() * 1000.0


async def _acquire_concurrency(model: str) -> None:
    cfg = gate_config_for(model)
    s = _state_for(model)
    if not cfg.max_concurrency:
        return
    loop = asyncio.get_event_loop()
    fut: asyncio.Future | None = None
    async with s.lock:
        if s.in_flight < cfg.max_concurrency:
            s.in_flight += 1
            return
        fut = loop.create_future()
        s.waiters.append(fut)
    await fut


async def _release_concurrency(model: str) -> None:
    cfg = gate_config_for(model)
    s = _state_for(model)
    if not cfg.max_concurrency:
        return
    async with s.lock:
        if s.waiters:
            nxt = s.waiters.pop(0)
            if not nxt.done():
                nxt.set_result(None)
            # transfer slot, in_flight unchanged
        else:
            s.in_flight -= 1


def _window_tokens(s: GateState, now: float) -> float:
    s.token_window = [e for e in s.token_window if now - e[0] < 60_000]
    return sum(e[1] for e in s.token_window)


async def _reserve_slot(model: str, est: float) -> None:
    """Block until BOTH the rolling 60s request budget (RPM) and token budget
    (TPM) have room for this call on THIS model's gate, then reserve a slot in
    each."""
    cfg = gate_config_for(model)
    s = _state_for(model)
    if not cfg.rpm and not cfg.tpm and not cfg.min_interval_ms:
        return
    while True:
        now = _now_ms()
        s.request_window = [t for t in s.request_window if now - t < 60_000]
        req_ok = not cfg.rpm or len(s.request_window) < cfg.rpm
        # A single call larger than the whole token budget would deadlock -- exempt.
        tok_ok = not cfg.tpm or est >= cfg.tpm or _window_tokens(s, now) + est <= cfg.tpm
        gap_ok = not cfg.min_interval_ms or (now - s.last_request_at) >= cfg.min_interval_ms

        if req_ok and tok_ok and gap_ok:
            s.request_window.append(now)
            s.last_request_at = now
            if cfg.tpm:
                s.token_window.append((now, est))
            return

        if req_ok and tok_ok and not gap_ok:
            # Only the spacing gate is binding -- short sleep until the gap elapses.
            await asyncio.sleep((cfg.min_interval_ms - (now - s.last_request_at)) / 1000.0)
            continue

        # Sleep until the oldest entry in the binding window ages out of the minute.
        oldest_req = s.request_window[0] if s.request_window else now
        oldest_tok = s.token_window[0][0] if s.token_window else now
        oldest = min(oldest_req, oldest_tok)
        wait = max(250.0, 60_000 - (now - oldest))
        await asyncio.sleep(min(wait, 5_000) / 1000.0)


# ~4 chars/token; count the prompt we send plus the output we've reserved.
def estimate_tokens(system: str, user: str, max_tokens: int) -> int:
    return math.ceil((len(system) + len(user)) / 4) + max_tokens


async def _call(
    *,
    system: str,
    user: str,
    max_tokens: int | None = None,
    json_mode: bool = False,
    model: str | None = None,
) -> tuple[str, Usage]:
    resolved_model = model or _model()
    resolved_max_tokens = max_tokens if max_tokens is not None else 1500
    body: dict[str, Any] = {
        "model": resolved_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": resolved_max_tokens,
        "temperature": 0.2,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    reasoning_effort = os.environ.get("LLM_REASONING_EFFORT")
    if reasoning_effort:
        body["reasoning_effort"] = reasoning_effort

    # Rate gate: cap simultaneous calls, then wait for token budget -- scoped to
    # THIS model's own gate (see gate_config_for). Held for the whole call
    # (including in-call 429 retries) so retries don't re-burst.
    await _acquire_concurrency(resolved_model)
    try:
        await _reserve_slot(
            resolved_model, estimate_tokens(system, user, resolved_max_tokens)
        )
        return await _send_with_retries(body, resolved_model)
    finally:
        await _release_concurrency(resolved_model)


async def _send_with_retries(body: dict[str, Any], model: str) -> tuple[str, Usage]:
    attempt = 0
    while True:
        async with httpx.AsyncClient(timeout=90.0) as client:
            res = await client.post(
                _chat_url(),
                headers={
                    "Authorization": f"Bearer {_get_key()}",
                    "Content-Type": "application/json",
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

            if attempt < MAX_RETRIES and base <= MAX_RETRY_WAIT_MS:
                # Jitter so parallel callers don't all retry on the same tick.
                jitter = base * (0.7 + random.random() * 0.6)
                await asyncio.sleep(jitter / 1000.0)
                attempt += 1
                continue
            raise RateLimitError(
                f"LLM 429 on {model} after {MAX_RETRIES} retries -- last retry-after "
                f"{round(base / 1000)}s",
                base,
            )

        if res.status_code < 200 or res.status_code >= 300:
            txt = res.text
            raise RuntimeError(f"LLM {res.status_code}: {txt[:300]}")

        j = res.json()
        choices = j.get("choices") or []
        msg = choices[0].get("message", {}) if choices else {}
        content = msg.get("content")
        # Fall back to the reasoning field if a reasoning model emitted its
        # answer there with an empty content (happens when reasoning consumes
        # the budget).
        raw = content if (content and content.strip()) else (msg.get("reasoning") or "")
        usage_obj = j.get("usage") or {}
        in_tok = usage_obj.get("prompt_tokens") or 0
        out_tok = usage_obj.get("completion_tokens") or 0

        # Opt-in call metrics for load testing (inert unless LLM_METRICS_FILE set).
        metrics_file = os.environ.get("LLM_METRICS_FILE")
        if metrics_file:
            try:
                with open(metrics_file, "a", encoding="utf-8") as f:
                    f.write(
                        json.dumps(
                            {"t": time.time() * 1000, "model": model, "in": in_tok, "out": out_tok}
                        )
                        + "\n"
                    )
            except Exception:
                pass

        return raw, Usage(input_tokens=in_tok, output_tokens=out_tok)


def _salvage_truncated_array(s: str) -> list[Any] | None:
    """Best-effort recovery for an unterminated JSON array -- walk backwards to
    the last balanced object and close the array. Returns None if nothing
    usable."""
    if not s.startswith("["):
        return None
    depth = 0
    in_str = False
    esc = False
    last_good_end = -1
    for i, c in enumerate(s):
        if esc:
            esc = False
            continue
        if c == "\\":
            esc = True
            continue
        if c == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if c == "{" or c == "[":
            depth += 1
        elif c == "}" or c == "]":
            depth -= 1
            if depth == 1 and c == "}":
                last_good_end = i  # top-level object closed
    if last_good_end < 0:
        return None
    candidate = s[: last_good_end + 1] + "]"
    try:
        v = json.loads(candidate)
        return v if isinstance(v, list) else None
    except (json.JSONDecodeError, ValueError):
        return None


async def call_mistral_json(
    *,
    system: str,
    user: str,
    max_tokens: int | None = None,
    model: str | None = None,
    mode: str = "json_object",
) -> dict[str, Any]:
    """mode: "json_object" | "text". Returns {data, usage, raw}."""
    sys_text = system if re.search(r"json", system, re.IGNORECASE) else f"{system}\n\nReturn valid JSON."

    raw, usage = await _call(
        system=sys_text,
        user=user,
        max_tokens=max_tokens if max_tokens is not None else 4096,
        json_mode=(mode == "json_object"),
        model=model,
    )

    cleaned = raw.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"```\s*$", "", cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.strip()

    try:
        parsed = json.loads(cleaned)
    except (json.JSONDecodeError, ValueError):
        m = re.search(r"[\[{][\s\S]*[\]}]", cleaned)
        if not m:
            raise RuntimeError(f"LLM response not valid JSON: {cleaned[:200]}")
        try:
            parsed = json.loads(m.group(0))
        except (json.JSONDecodeError, ValueError) as e:
            # Truncated-array salvage: trim back to the last well-formed object
            # and close the array. The model sometimes hits max_tokens mid-array.
            salvaged = _salvage_truncated_array(m.group(0))
            if salvaged is not None:
                parsed = salvaged
            else:
                raise RuntimeError(
                    f"LLM response not parseable JSON ({e}): {m.group(0)[:200]}"
                ) from e

    # Unwrap object -> array. Some models return { "type": "object",
    # "requirements": [...] } or similar. Find the first array value and use it.
    if isinstance(parsed, dict):
        array_values = [v for v in parsed.values() if isinstance(v, list)]
        if len(array_values) == 1:
            parsed = array_values[0]

    return {"data": parsed, "usage": usage, "raw": raw}


async def call_mistral_text(
    *,
    system: str,
    user: str,
    max_tokens: int | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    raw, usage = await _call(
        system=system, user=user, max_tokens=max_tokens, model=model
    )
    return {"text": raw.strip(), "usage": usage}
