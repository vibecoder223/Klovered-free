import asyncio
import math

import httpx
import pytest
import respx

from app import mistral
from app.config import get_settings


@pytest.fixture(autouse=True)
def _llm_key(monkeypatch):
    # Ensure a key is configured for every test in this module, and clear the
    # cached Settings singleton so env overrides in individual tests take
    # effect.
    monkeypatch.setenv("LLM_API_KEY", "test-key")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_estimate_tokens_math():
    system = "s" * 40
    user = "u" * 20
    max_tokens = 100
    assert mistral.estimate_tokens(system, user, max_tokens) == math.ceil(60 / 4) + 100


def test_estimate_cost_math():
    cost = mistral.estimate_cost(1_000_000, 1_000_000)
    assert cost == pytest.approx(0.50 + 1.50)

    cost2 = mistral.estimate_cost(500_000, 0)
    assert cost2 == pytest.approx(0.25)


def test_gate_config_for_model_defaults(monkeypatch):
    for var in (
        "LLM_RPM", "LLM_TPM", "LLM_MAX_CONCURRENCY", "LLM_MIN_INTERVAL_MS",
        "LLM_RPM_FAST", "LLM_TPM_FAST", "LLM_MAX_CONCURRENCY_FAST", "LLM_MIN_INTERVAL_MS_FAST",
    ):
        monkeypatch.delenv(var, raising=False)

    cfg = mistral.gate_config_for(mistral.MODEL)
    assert cfg.rpm == 15
    assert cfg.tpm == 400_000
    assert cfg.max_concurrency == 8
    assert cfg.min_interval_ms == 0


def test_gate_config_for_model_fast_defaults(monkeypatch):
    for var in (
        "LLM_RPM", "LLM_TPM", "LLM_MAX_CONCURRENCY", "LLM_MIN_INTERVAL_MS",
        "LLM_RPM_FAST", "LLM_TPM_FAST", "LLM_MAX_CONCURRENCY_FAST", "LLM_MIN_INTERVAL_MS_FAST",
    ):
        monkeypatch.delenv(var, raising=False)

    cfg = mistral.gate_config_for(mistral.MODEL_FAST)
    assert cfg.rpm == 100
    assert cfg.tpm == 100_000
    assert cfg.max_concurrency == 8
    assert cfg.min_interval_ms == 600


def test_gate_config_env_overrides(monkeypatch):
    monkeypatch.setenv("LLM_RPM", "5")
    monkeypatch.setenv("LLM_TPM", "1234")
    monkeypatch.setenv("LLM_MAX_CONCURRENCY", "2")
    monkeypatch.setenv("LLM_MIN_INTERVAL_MS", "50")
    monkeypatch.setenv("LLM_RPM_FAST", "10")
    monkeypatch.setenv("LLM_TPM_FAST", "5678")
    monkeypatch.setenv("LLM_MAX_CONCURRENCY_FAST", "3")
    monkeypatch.setenv("LLM_MIN_INTERVAL_MS_FAST", "10")

    cfg = mistral.gate_config_for(mistral.MODEL)
    assert cfg.rpm == 5
    assert cfg.tpm == 1234
    assert cfg.max_concurrency == 2
    assert cfg.min_interval_ms == 50

    cfg_fast = mistral.gate_config_for(mistral.MODEL_FAST)
    assert cfg_fast.rpm == 10
    assert cfg_fast.tpm == 5678
    assert cfg_fast.max_concurrency == 3
    assert cfg_fast.min_interval_ms == 10


def _completion_response(content: str, prompt_tokens=10, completion_tokens=20):
    return httpx.Response(
        200,
        json={
            "choices": [{"message": {"content": content}}],
            "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens},
        },
    )


@respx.mock
def test_call_mistral_text_returns_content_and_usage(monkeypatch):
    # Disable the rate gate for this test so it runs instantly.
    monkeypatch.setenv("LLM_RPM", "0")
    monkeypatch.setenv("LLM_TPM", "0")
    monkeypatch.setenv("LLM_MAX_CONCURRENCY", "0")
    monkeypatch.setenv("LLM_MIN_INTERVAL_MS", "0")

    route = respx.post("https://api.mistral.ai/v1/chat/completions").mock(
        return_value=_completion_response("  hello world  ")
    )

    result = asyncio.run(
        mistral.call_mistral_text(system="sys", user="usr", max_tokens=50)
    )

    assert route.called
    assert result["text"] == "hello world"
    assert result["usage"].input_tokens == 10
    assert result["usage"].output_tokens == 20


@respx.mock
def test_call_retries_on_429_then_succeeds(monkeypatch):
    monkeypatch.setenv("LLM_RPM", "0")
    monkeypatch.setenv("LLM_TPM", "0")
    monkeypatch.setenv("LLM_MAX_CONCURRENCY", "0")
    monkeypatch.setenv("LLM_MIN_INTERVAL_MS", "0")

    # Keep the retry sleep itself fast without touching the gate's own sleep
    # calls (the gate is disabled above, so this only affects the 429 backoff).
    sleep_calls = []

    async def _fast_sleep(seconds):
        sleep_calls.append(seconds)

    monkeypatch.setattr(mistral.asyncio, "sleep", _fast_sleep)

    route = respx.post("https://api.mistral.ai/v1/chat/completions").mock(
        side_effect=[
            httpx.Response(429, headers={"retry-after": "0"}, json={"error": "rate limited"}),
            _completion_response("recovered"),
        ]
    )

    result = asyncio.run(
        mistral.call_mistral_text(system="sys", user="usr", max_tokens=50)
    )

    assert route.call_count == 2
    assert result["text"] == "recovered"
    assert len(sleep_calls) == 1


@respx.mock
def test_call_mistral_json_salvages_truncated_array(monkeypatch):
    monkeypatch.setenv("LLM_RPM", "0")
    monkeypatch.setenv("LLM_TPM", "0")
    monkeypatch.setenv("LLM_MAX_CONCURRENCY", "0")
    monkeypatch.setenv("LLM_MIN_INTERVAL_MS", "0")

    truncated = '[{"id": 1, "name": "first"}, {"id": 2, "name": "second"}, {"id": 3, "nam'
    respx.post("https://api.mistral.ai/v1/chat/completions").mock(
        return_value=_completion_response(truncated)
    )

    result = asyncio.run(
        mistral.call_mistral_json(system="sys", user="usr", mode="text")
    )

    assert result["data"] == [
        {"id": 1, "name": "first"},
        {"id": 2, "name": "second"},
    ]


@respx.mock
def test_call_mistral_json_unwraps_single_array_object(monkeypatch):
    monkeypatch.setenv("LLM_RPM", "0")
    monkeypatch.setenv("LLM_TPM", "0")
    monkeypatch.setenv("LLM_MAX_CONCURRENCY", "0")
    monkeypatch.setenv("LLM_MIN_INTERVAL_MS", "0")

    body = '{"requirements": [{"id": "REQ-1"}, {"id": "REQ-2"}]}'
    respx.post("https://api.mistral.ai/v1/chat/completions").mock(
        return_value=_completion_response(body)
    )

    result = asyncio.run(
        mistral.call_mistral_json(system="sys", user="usr")
    )

    assert result["data"] == [{"id": "REQ-1"}, {"id": "REQ-2"}]


def test_has_llm_key_true_when_configured():
    assert mistral.has_llm_key() is True


def test_has_llm_key_false_when_unset(monkeypatch):
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
    get_settings.cache_clear()
    assert mistral.has_llm_key() is False
