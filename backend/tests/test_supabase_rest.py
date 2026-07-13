import httpx
import respx

from app.config import get_settings
from app.supabase_rest import resolve_org, service_client


def _svc_env(monkeypatch):
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "anon-key")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "svc-key")
    get_settings.cache_clear()


@respx.mock
def test_user_client_sends_anon_apikey_and_user_bearer(monkeypatch):
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "anon-key")
    get_settings.cache_clear()

    route = respx.get("https://proj.supabase.co/rest/v1/team_members").mock(
        return_value=httpx.Response(200, json=[{"org_id": "org-9"}])
    )
    org = resolve_org("guest-jwt", "guest-abc")

    assert org == "org-9"
    sent = route.calls.last.request
    assert sent.headers["apikey"] == "anon-key"
    assert sent.headers["authorization"] == "Bearer guest-jwt"


@respx.mock
def test_resolve_org_returns_none_when_no_membership(monkeypatch):
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "anon-key")
    get_settings.cache_clear()

    respx.get("https://proj.supabase.co/rest/v1/team_members").mock(
        return_value=httpx.Response(200, json=[])
    )
    assert resolve_org("guest-jwt", "nobody") is None


@respx.mock
def test_service_insert_returns_representation(monkeypatch):
    _svc_env(monkeypatch)
    route = respx.post("https://proj.supabase.co/rest/v1/jobs").mock(
        return_value=httpx.Response(201, json=[{"id": "job-1", "stage": "ingest"}])
    )
    out = service_client().insert("jobs", {"stage": "ingest", "org_id": "org-9"})
    assert out == [{"id": "job-1", "stage": "ingest"}]
    sent = route.calls.last.request
    assert sent.headers["apikey"] == "svc-key"
    assert sent.headers["authorization"] == "Bearer svc-key"
    assert sent.headers["prefer"] == "return=representation"


@respx.mock
def test_service_update_sends_patch_with_filters(monkeypatch):
    _svc_env(monkeypatch)
    route = respx.patch("https://proj.supabase.co/rest/v1/documents").mock(
        return_value=httpx.Response(200, json=[{"id": "d-1", "processing_status": "completed"}])
    )
    out = service_client().update(
        "documents", {"id": "eq.d-1"}, {"processing_status": "completed"}
    )
    assert out[0]["processing_status"] == "completed"
    assert route.calls.last.request.method == "PATCH"


@respx.mock
def test_service_rpc_posts_to_rpc_path(monkeypatch):
    _svc_env(monkeypatch)
    route = respx.post("https://proj.supabase.co/rest/v1/rpc/claim_jobs").mock(
        return_value=httpx.Response(200, json=[{"id": "job-1"}])
    )
    out = service_client().rpc("claim_jobs", {"p_limit": 5})
    assert out == [{"id": "job-1"}]
    assert route.calls.last.request.method == "POST"


@respx.mock
def test_service_delete_sends_delete(monkeypatch):
    _svc_env(monkeypatch)
    route = respx.delete("https://proj.supabase.co/rest/v1/jobs").mock(
        return_value=httpx.Response(204)
    )
    service_client().delete("jobs", {"document_id": "eq.d-1"})
    assert route.calls.last.request.method == "DELETE"
