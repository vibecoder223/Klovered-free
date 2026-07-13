import asyncio
import json
import os

import httpx
import pytest
import respx

from app.config import get_settings
from app.pipeline import retrieval
from app.supabase_rest import service_client


def _env(monkeypatch):
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "anon-key")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "svc-key")
    monkeypatch.setenv("MISTRAL_API_KEY", "test-mistral-key")
    monkeypatch.setenv("EMBED_MIN_INTERVAL_MS", "0")
    monkeypatch.delenv("RAG_USE_QUERY_EXPANSION", raising=False)
    get_settings.cache_clear()


def _embed_response(vectors: list[list[float]]) -> httpx.Response:
    return httpx.Response(
        200,
        json={"data": [{"embedding": v, "index": i} for i, v in enumerate(vectors)]},
    )


@respx.mock
def test_retrieve_for_query_sends_embedding_and_rpc_args(monkeypatch):
    _env(monkeypatch)

    embed_route = respx.post("https://api.mistral.ai/v1/embeddings").mock(
        return_value=_embed_response([[0.1, 0.2, 0.3]])
    )
    rpc_route = respx.post("https://proj.supabase.co/rest/v1/rpc/match_chunks").mock(
        return_value=httpx.Response(
            200,
            json=[
                {
                    "chunk_id": "c1",
                    "text": "Our security posture covers encryption at rest.",
                    "section_path": "Security > Data Protection",
                    "page_start": 3,
                    "page_end": 3,
                    "document_filename": "security-policy.pdf",
                    "similarity": 0.91,
                },
                {
                    "chunk_id": "c2",
                    "text": "We use TLS 1.2 for data in transit.",
                    "section_path": "Security > Transit",
                    "page_start": 4,
                    "page_end": 4,
                    "document_filename": "security-policy.pdf",
                    "similarity": 0.78,
                },
            ],
        )
    )
    # No sparse matches so dense-only behavior is isolated.
    sparse_route = respx.get("https://proj.supabase.co/rest/v1/document_chunks").mock(
        return_value=httpx.Response(200, json=[])
    )

    result = asyncio.run(
        retrieval.retrieve_for_query(
            service_client(), org_id="org-1", query="what is your security posture"
        )
    )

    assert embed_route.call_count == 1
    embed_body = json.loads(embed_route.calls.last.request.content)
    assert embed_body["input"] == ["what is your security posture"]

    assert rpc_route.call_count == 1
    rpc_body = json.loads(rpc_route.calls.last.request.content)
    assert rpc_body == {
        "p_org_id": "org-1",
        "p_embedding": [0.1, 0.2, 0.3],
        "p_match_count": 20,
    }

    assert sparse_route.call_count == 1

    assert [c.chunk_id for c in result.candidates] == ["c1", "c2"]
    assert result.candidates[0].score == 0.91
    assert result.candidates[0].document_filename == "security-policy.pdf"
    assert result.candidates[0].section_path == "Security > Data Protection"
    assert result.top_score == 0.91
    assert result.query_expansion is None


@respx.mock
def test_retrieve_for_query_top_k_slicing(monkeypatch):
    _env(monkeypatch)
    respx.post("https://api.mistral.ai/v1/embeddings").mock(
        return_value=_embed_response([[0.1]])
    )
    rows = [
        {
            "chunk_id": f"c{i}",
            "text": f"text {i}",
            "section_path": None,
            "page_start": 1,
            "page_end": 1,
            "document_filename": "doc.pdf",
            "similarity": 0.9 - i * 0.05,
        }
        for i in range(10)
    ]
    respx.post("https://proj.supabase.co/rest/v1/rpc/match_chunks").mock(
        return_value=httpx.Response(200, json=rows)
    )
    respx.get("https://proj.supabase.co/rest/v1/document_chunks").mock(
        return_value=httpx.Response(200, json=[])
    )

    result = asyncio.run(
        retrieval.retrieve_for_query(
            service_client(), org_id="org-1", query="widgets and gadgets", top_k=3
        )
    )

    assert len(result.candidates) == 3
    assert [c.chunk_id for c in result.candidates] == ["c0", "c1", "c2"]


@respx.mock
def test_retrieve_for_query_merges_dense_and_sparse_dense_wins_on_dup(monkeypatch):
    _env(monkeypatch)
    respx.post("https://api.mistral.ai/v1/embeddings").mock(
        return_value=_embed_response([[0.1]])
    )
    respx.post("https://proj.supabase.co/rest/v1/rpc/match_chunks").mock(
        return_value=httpx.Response(
            200,
            json=[
                {
                    "chunk_id": "shared",
                    "text": "dense version",
                    "section_path": None,
                    "page_start": 1,
                    "page_end": 1,
                    "document_filename": "doc.pdf",
                    "similarity": 0.6,
                }
            ],
        )
    )
    respx.get("https://proj.supabase.co/rest/v1/document_chunks").mock(
        return_value=httpx.Response(
            200,
            json=[
                {
                    "id": "shared",
                    "raw_text": "raw",
                    "cleaned_text": "sparse version",
                    "section_path": None,
                    "page_start": 1,
                    "page_end": 1,
                    "sparse_terms": ["compliance", "security", "policy"],
                    "document_id": None,
                    "knowledge_document_id": "kd1",
                    "knowledge_documents": {"filename": "sparse.pdf"},
                    "documents": None,
                },
                {
                    "id": "sparse-only",
                    "raw_text": "raw2",
                    "cleaned_text": "another sparse chunk",
                    "section_path": None,
                    "page_start": 2,
                    "page_end": 2,
                    "sparse_terms": ["compliance"],
                    "document_id": None,
                    "knowledge_document_id": "kd2",
                    "knowledge_documents": {"filename": "sparse2.pdf"},
                    "documents": None,
                },
            ],
        )
    )

    result = asyncio.run(
        retrieval.retrieve_for_query(
            service_client(), org_id="org-1", query="compliance security policy"
        )
    )

    shared = next(c for c in result.candidates if c.chunk_id == "shared")
    # Dense candidate must win over the sparse one for the same chunk_id.
    assert shared.text == "dense version"
    assert shared.score == 0.6
    # The sparse-only chunk should still be present (from BM25).
    assert any(c.chunk_id == "sparse-only" for c in result.candidates)


@respx.mock
def test_sparse_search_bm25_scoring_and_filename_fallback(monkeypatch):
    _env(monkeypatch)
    # No embeddings configured -> dense retrieval skipped entirely.
    monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
    get_settings.cache_clear()

    rows_route = respx.get("https://proj.supabase.co/rest/v1/document_chunks").mock(
        return_value=httpx.Response(
            200,
            json=[
                {
                    "id": "a",
                    "raw_text": "fallback raw text",
                    "cleaned_text": None,
                    "section_path": "Intro",
                    "page_start": 1,
                    "page_end": 1,
                    "sparse_terms": ["encryption", "security", "data"],
                    "document_id": "d1",
                    "knowledge_document_id": None,
                    "knowledge_documents": None,
                    "documents": {"filename": "legacy-doc.pdf"},
                },
                {
                    "id": "b",
                    "raw_text": "raw",
                    "cleaned_text": "cleaned chunk about encryption only",
                    "section_path": "Body",
                    "page_start": 2,
                    "page_end": 2,
                    "sparse_terms": ["encryption"],
                    "document_id": "d2",
                    "knowledge_document_id": None,
                    "knowledge_documents": None,
                    "documents": None,
                },
            ],
        )
    )

    result = asyncio.run(
        retrieval.retrieve_for_query(
            service_client(), org_id="org-1", query="encryption security data at rest"
        )
    )

    assert rows_route.call_count == 1
    sent_params = rows_route.calls.last.request.url.params
    assert sent_params["org_id"] == "eq.org-1"
    assert sent_params["knowledge_document_id"] == "not.is.null"
    assert sent_params["sparse_terms"].startswith("ov.{")

    a = next(c for c in result.candidates if c.chunk_id == "a")
    assert a.text == "fallback raw text"
    assert a.document_filename == "legacy-doc.pdf"
    assert a.score > 0

    b = next(c for c in result.candidates if c.chunk_id == "b")
    assert b.text == "cleaned chunk about encryption only"
    # "a" matches more query terms than "b" -> should score higher.
    assert a.score > b.score


def test_is_no_source():
    assert retrieval.is_no_source(0.0, 0) is True
    assert retrieval.is_no_source(0.54, 3) is True
    assert retrieval.is_no_source(0.55, 3) is False
    assert retrieval.is_no_source(0.9, 0) is True


@respx.mock
def test_retrieve_for_queries_batches_single_embed_call(monkeypatch):
    _env(monkeypatch)
    embed_route = respx.post("https://api.mistral.ai/v1/embeddings").mock(
        return_value=_embed_response([[0.1], [0.2]])
    )
    respx.post("https://proj.supabase.co/rest/v1/rpc/match_chunks").mock(
        return_value=httpx.Response(
            200,
            json=[
                {
                    "chunk_id": "x1",
                    "text": "t",
                    "section_path": None,
                    "page_start": 1,
                    "page_end": 1,
                    "document_filename": "doc.pdf",
                    "similarity": 0.7,
                }
            ],
        )
    )
    respx.get("https://proj.supabase.co/rest/v1/document_chunks").mock(
        return_value=httpx.Response(200, json=[])
    )

    results = asyncio.run(
        retrieval.retrieve_for_queries(
            service_client(), org_id="org-1", queries=["first widget question", "second gadget question"]
        )
    )

    assert embed_route.call_count == 1
    embed_body = json.loads(embed_route.calls.last.request.content)
    assert embed_body["input"] == ["first widget question", "second gadget question"]

    assert len(results) == 2
    for r in results:
        assert [c.chunk_id for c in r.candidates] == ["x1"]
        assert r.query_expansion is None


# ---------- Live smoke test (guarded) ----------

def _load_real_env_file() -> dict[str, str]:
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env_path = os.path.join(here, ".env.local")
    values: dict[str, str] = {}
    if not os.path.exists(env_path):
        return values
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            values[key.strip()] = val.strip().strip('"').strip("'")
    return values


_REAL_ENV = _load_real_env_file()
_HAS_REAL_CREDS = bool(
    _REAL_ENV.get("NEXT_PUBLIC_SUPABASE_URL")
    and (_REAL_ENV.get("SUPABASE_SERVICE_ROLE_KEY"))
    and (_REAL_ENV.get("MISTRAL_API_KEY") or _REAL_ENV.get("LLM_API_KEY"))
)


@pytest.mark.skipif(not _HAS_REAL_CREDS, reason="backend/.env.local credentials not present")
def test_live_retrieval_smoke(monkeypatch):
    for k, v in _REAL_ENV.items():
        monkeypatch.setenv(k, v)
    get_settings.cache_clear()

    # Use whatever org the test env points at, or fall back to a random org_id
    # -- if it has no chunk data the RPC/BM25 legitimately return zero rows and
    # we skip below rather than failing the suite.
    org_id = _REAL_ENV.get("KLOVERED_TEST_ORG_ID") or _REAL_ENV.get("TEST_ORG_ID") or "00000000-0000-0000-0000-000000000000"

    result = asyncio.run(
        retrieval.retrieve_for_query(service_client(), org_id=org_id, query="security")
    )

    if len(result.candidates) == 0:
        pytest.skip("no chunk data available for live retrieval smoke test")

    assert isinstance(result.candidates, list)
    assert result.top_score >= 0
