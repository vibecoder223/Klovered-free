import asyncio

import httpx
import pytest
import respx

from app.config import get_settings
from app.pipeline import embeddings


@pytest.fixture(autouse=True)
def _mistral_key(monkeypatch):
    monkeypatch.setenv("MISTRAL_API_KEY", "test-mistral-key")
    monkeypatch.setenv("EMBED_MIN_INTERVAL_MS", "0")
    monkeypatch.delenv("MISTRAL_EMBED_MODEL", raising=False)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _embed_response(vectors: list[list[float]]) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "data": [
                {"embedding": v, "index": i} for i, v in enumerate(vectors)
            ]
        },
    )


def test_has_embeddings_reflects_key(monkeypatch):
    assert embeddings.has_embeddings() is True

    monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
    get_settings.cache_clear()
    assert embeddings.has_embeddings() is False


def test_embed_texts_empty_list_short_circuits():
    result = asyncio.run(embeddings.embed_texts([]))
    assert result == []


def test_embed_texts_no_key_raises(monkeypatch):
    monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
    get_settings.cache_clear()
    with pytest.raises(RuntimeError, match="Embeddings unavailable"):
        asyncio.run(embeddings.embed_texts(["hello"]))


@respx.mock
def test_embed_texts_returns_vectors_for_batch():
    vectors = [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6], [0.7, 0.8, 0.9]]
    route = respx.post("https://api.mistral.ai/v1/embeddings").mock(
        return_value=_embed_response(vectors)
    )

    result = asyncio.run(embeddings.embed_texts(["a", "b", "c"], "document"))

    assert route.call_count == 1
    assert result == vectors


@respx.mock
def test_embed_texts_request_body_and_headers_match_contract():
    vectors = [[0.1] * 4]
    route = respx.post("https://api.mistral.ai/v1/embeddings").mock(
        return_value=_embed_response(vectors)
    )

    asyncio.run(embeddings.embed_texts(["only text"], "query"))

    assert route.call_count == 1
    request = route.calls[0].request
    assert request.headers["authorization"] == "Bearer test-mistral-key"
    assert request.headers["content-type"] == "application/json"
    import json as _json

    body = _json.loads(request.content)
    assert body == {"model": "mistral-embed", "input": ["only text"]}


@respx.mock
def test_embed_texts_reorders_by_response_index():
    # Server returns embeddings out of order; embed_texts must reorder them
    # back to the original batch positions using the `index` field.
    route = respx.post("https://api.mistral.ai/v1/embeddings").mock(
        return_value=httpx.Response(
            200,
            json={
                "data": [
                    {"embedding": [2.0], "index": 1},
                    {"embedding": [1.0], "index": 0},
                ]
            },
        )
    )

    result = asyncio.run(embeddings.embed_texts(["first", "second"]))

    assert route.call_count == 1
    assert result == [[1.0], [2.0]]


@respx.mock
def test_embed_texts_batches_split_across_batch_size():
    # EMBED_BATCH_SIZE is 128; 200 inputs should split into 2 HTTP calls
    # (128 + 72), and results must line up with the original input order.
    n = 200

    def _responder(request: httpx.Request) -> httpx.Response:
        import json as _json

        body = _json.loads(request.content)
        inputs = body["input"]
        return _embed_response([[float(len(text))] for text in inputs])

    route = respx.post("https://api.mistral.ai/v1/embeddings").mock(
        side_effect=_responder
    )

    texts = [f"text-{i}" for i in range(n)]
    result = asyncio.run(embeddings.embed_texts(texts))

    assert route.call_count == 2
    call_sizes = sorted(
        len(__import__("json").loads(c.request.content)["input"]) for c in route.calls
    )
    assert call_sizes == [72, 128]
    assert len(result) == n
    assert result == [[float(len(t))] for t in texts]


@respx.mock
def test_embed_texts_retries_on_429_then_succeeds(monkeypatch):
    async def _fast_sleep(_seconds):
        return None

    monkeypatch.setattr(embeddings.asyncio, "sleep", _fast_sleep)

    vectors = [[0.5, 0.5]]
    route = respx.post("https://api.mistral.ai/v1/embeddings").mock(
        side_effect=[
            httpx.Response(429, headers={"retry-after": "0"}, json={"error": "rate limited"}),
            _embed_response(vectors),
        ]
    )

    result = asyncio.run(embeddings.embed_texts(["x"]))

    assert route.call_count == 2
    assert result == vectors


@respx.mock
def test_embed_texts_raises_after_exhausting_retries(monkeypatch):
    async def _fast_sleep(_seconds):
        return None

    monkeypatch.setattr(embeddings.asyncio, "sleep", _fast_sleep)

    respx.post("https://api.mistral.ai/v1/embeddings").mock(
        return_value=httpx.Response(429, headers={"retry-after": "0"}, json={"error": "rl"})
    )

    with pytest.raises(RuntimeError, match="429"):
        asyncio.run(embeddings.embed_texts(["x"]))


@respx.mock
def test_embed_texts_non_ok_response_raises():
    respx.post("https://api.mistral.ai/v1/embeddings").mock(
        return_value=httpx.Response(500, text="internal error")
    )

    with pytest.raises(RuntimeError, match="Mistral embed failed: 500"):
        asyncio.run(embeddings.embed_texts(["x"]))


def test_embed_dims_constant():
    assert embeddings.EMBED_DIMS == 1024
