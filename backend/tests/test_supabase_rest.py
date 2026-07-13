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


@respx.mock
def test_download_storage_hits_object_endpoint(monkeypatch):
    _svc_env(monkeypatch)
    route = respx.get(
        "https://proj.supabase.co/storage/v1/object/documents/org/file.pdf"
    ).mock(return_value=httpx.Response(200, content=b"%PDF-1.7 bytes"))
    data = service_client().download_storage("documents", "org/file.pdf")
    assert data == b"%PDF-1.7 bytes"
    assert route.calls.last.request.headers["authorization"] == "Bearer svc-key"


@respx.mock
def test_upload_storage_posts_bytes_with_content_type(monkeypatch):
    _svc_env(monkeypatch)
    route = respx.post(
        "https://proj.supabase.co/storage/v1/object/knowledge/org/file.pdf"
    ).mock(return_value=httpx.Response(200, json={"Key": "knowledge/org/file.pdf"}))
    service_client().upload_storage("knowledge", "org/file.pdf", b"bytes", "application/pdf")
    sent = route.calls.last.request
    assert sent.content == b"bytes"
    assert sent.headers["content-type"] == "application/pdf"


@respx.mock
def test_list_storage_posts_prefix_and_limit(monkeypatch):
    _svc_env(monkeypatch)
    route = respx.post("https://proj.supabase.co/storage/v1/object/list/knowledge").mock(
        return_value=httpx.Response(200, json=[{"name": "file.pdf"}])
    )
    out = service_client().list_storage("knowledge", "org-9", limit=500)
    assert out == [{"name": "file.pdf"}]
    import json as _json
    assert _json.loads(route.calls.last.request.content) == {"prefix": "org-9", "limit": 500}


@respx.mock
def test_remove_storage_sends_prefixes(monkeypatch):
    _svc_env(monkeypatch)
    route = respx.delete("https://proj.supabase.co/storage/v1/object/knowledge").mock(
        return_value=httpx.Response(200, json={})
    )
    service_client().remove_storage("knowledge", ["org/a.pdf", "org/b.pdf"])
    import json as _json
    assert _json.loads(route.calls.last.request.content) == {
        "prefixes": ["org/a.pdf", "org/b.pdf"]
    }


def test_try_service_client_returns_none_without_key(monkeypatch):
    from app.config import get_settings
    from app.supabase_rest import try_service_client

    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "anon-key")
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    get_settings.cache_clear()
    assert try_service_client() is None


def test_try_service_client_returns_client_with_key(monkeypatch):
    from app.config import get_settings
    from app.supabase_rest import try_service_client

    _svc_env(monkeypatch)
    get_settings.cache_clear()
    assert try_service_client() is not None


@respx.mock
def test_get_auth_user_hits_gotrue_admin_endpoint(monkeypatch):
    _svc_env(monkeypatch)
    route = respx.get("https://proj.supabase.co/auth/v1/admin/users/u1").mock(
        return_value=httpx.Response(200, json={"id": "u1", "is_anonymous": True})
    )
    user = service_client().get_auth_user("u1")
    assert user == {"id": "u1", "is_anonymous": True}
    assert route.calls.last.request.headers["authorization"] == "Bearer svc-key"


@respx.mock
def test_get_auth_user_returns_none_on_404(monkeypatch):
    _svc_env(monkeypatch)
    respx.get("https://proj.supabase.co/auth/v1/admin/users/gone").mock(
        return_value=httpx.Response(404, json={"message": "not found"})
    )
    assert service_client().get_auth_user("gone") is None


@respx.mock
def test_delete_auth_user_sends_delete(monkeypatch):
    _svc_env(monkeypatch)
    route = respx.delete("https://proj.supabase.co/auth/v1/admin/users/u1").mock(
        return_value=httpx.Response(200, json={})
    )
    service_client().delete_auth_user("u1")
    assert route.calls.last.request.method == "DELETE"


@respx.mock
def test_delete_auth_user_swallows_404(monkeypatch):
    _svc_env(monkeypatch)
    respx.delete("https://proj.supabase.co/auth/v1/admin/users/gone").mock(
        return_value=httpx.Response(404, json={"message": "not found"})
    )
    service_client().delete_auth_user("gone")  # no raise
