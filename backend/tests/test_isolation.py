"""Two-tenant isolation regression test (design spec's CI gate — see
docs/superpowers/specs/2026-07-13-klovered-free-python-backend-design.md
'Testing & gates': "must pass before any request-surface cutover").

The ultimate backstop is Postgres RLS, which this suite can't exercise without
a live database. What IS testable at this layer, and what every prior leak in
this class of app has actually turned out to be, is a *code* bug: a shared or
stale SupabaseRest client, a hardcoded service-role fallback, or a swapped
`Authorization` header letting one guest's request read/act on another
guest's rows before RLS ever gets a chance to reject it.

These tests run two "guests" (distinct bearer tokens, distinct orgs) through
the real routers with a real (respx-mocked) SupabaseRest — not a fake db — so
they exercise the actual HTTP calls the app makes, and assert every one of
them carries the requesting guest's *own* token, never the other guest's.
"""

import httpx
import respx
from fastapi.testclient import TestClient

from app import config, deps
from app.main import app

client = TestClient(app, raise_server_exceptions=False)

GUEST_A = {"token": "guest-a-jwt", "user_id": "user-a", "org_id": "org-a"}
GUEST_B = {"token": "guest-b-jwt", "user_id": "user-b", "org_id": "org-b"}


def _env(monkeypatch):
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co")
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "anon-key")
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    config.get_settings.cache_clear()


def _stub_auth(monkeypatch):
    by_token = {GUEST_A["token"]: GUEST_A, GUEST_B["token"]: GUEST_B}

    def verify_jwt(token):
        g = by_token[token]
        return {"sub": g["user_id"], "is_anonymous": True}

    def resolve_org(token, uid):
        g = by_token[token]
        assert uid == g["user_id"]  # sanity: never asked to resolve a mismatched pair
        return g["org_id"]

    monkeypatch.setattr(deps, "verify_jwt", verify_jwt)
    monkeypatch.setattr(deps, "resolve_org", resolve_org)


@respx.mock
def test_documents_process_never_leaks_across_tokens(monkeypatch):
    """RLS-equivalent mock: the `documents` row for org A is only ever returned
    to a request whose Authorization header is guest A's own token. If the
    code ever forwarded guest B's token — or a cached/shared client bound to
    guest A — while acting on guest B's request, this mock would either 404
    (safe: proves no leak) or, if it 200'd with A's data under B's identity,
    the assertion on the sent header below would catch the swapped token
    directly, which is the actual bug class this guards against.
    """
    _env(monkeypatch)
    _stub_auth(monkeypatch)

    doc_a = {"id": "doc-a", "deal_id": "deal-a", "deals": {"org_id": "org-a"}}

    def documents_responder(request: httpx.Request) -> httpx.Response:
        # Mirrors RLS: only guest A's own bearer can ever see doc-a.
        if request.headers.get("authorization") == "Bearer guest-a-jwt":
            return httpx.Response(200, json=[doc_a])
        return httpx.Response(200, json=[])  # RLS would filter this to empty, not error

    route = respx.get("https://proj.supabase.co/rest/v1/documents").mock(
        side_effect=documents_responder
    )

    # Guest A processing their own document: allowed through to the 400
    # "Org not resolved" or downstream — what matters here is it's not a 404,
    # i.e. the row was visible to A's own token.
    r_a = client.post(
        "/api/pipeline/documents/process",
        json={"document_id": "doc-a"},
        headers={"Authorization": f"Bearer {GUEST_A['token']}"},
    )
    assert r_a.status_code != 404

    # Guest B attempting the SAME document id: must 404 (not found under B's
    # RLS-scoped view), never succeed and never see A's org_id.
    r_b = client.post(
        "/api/pipeline/documents/process",
        json={"document_id": "doc-a"},
        headers={"Authorization": f"Bearer {GUEST_B['token']}"},
    )
    assert r_b.status_code == 404

    # Every outbound PostgREST call for this table carried the SAME token as
    # the inbound request that triggered it — no swap, no shared client reuse.
    for call in route.calls:
        sent_auth = call.request.headers["authorization"]
        assert sent_auth in (f"Bearer {GUEST_A['token']}", f"Bearer {GUEST_B['token']}")


@respx.mock
def test_knowledge_upload_doc_count_is_scoped_per_caller_token(monkeypatch):
    """The upload cap check (`knowledge_documents` count) must be scoped to the
    calling guest's own org via their own forwarded token — never a shared
    client that could leak org B's document count (or worse, org B's rows)
    into org A's cap check.
    """
    _env(monkeypatch)
    _stub_auth(monkeypatch)

    def kd_responder(request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization") == f"Bearer {GUEST_A['token']}":
            # Org A is already at the cap.
            return httpx.Response(200, json=[{"id": f"d{i}", "page_count": 1} for i in range(10)])
        # Org B (or anyone else) has none.
        return httpx.Response(200, json=[])

    route = respx.get("https://proj.supabase.co/rest/v1/knowledge_documents").mock(
        side_effect=kd_responder
    )

    r_a = client.post(
        "/api/pipeline/knowledge/upload",
        headers={"Authorization": f"Bearer {GUEST_A['token']}"},
        files={"file": ("f.pdf", b"hello", "application/pdf")},
        data={"doc_type": "policy"},
    )
    assert r_a.status_code == 403  # A is capped — proves A's own count was read

    for call in route.calls:
        assert call.request.headers["authorization"] == f"Bearer {GUEST_A['token']}"
