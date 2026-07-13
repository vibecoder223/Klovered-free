import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import app
from app.routers import cron as cron_router

client = TestClient(app, raise_server_exceptions=False)


def _set_secret(monkeypatch, secret="s3cret"):
    monkeypatch.setenv("CRON_SECRET", secret)
    config.get_settings.cache_clear()


class FakeDb:
    def __init__(self, orgs=None, members_by_org=None, users_by_id=None, deals_by_org=None):
        self.orgs = orgs or []
        self.members_by_org = members_by_org or {}
        self.users_by_id = users_by_id or {}
        self.deals_by_org = deals_by_org or {}
        self.deleted_orgs = []
        self.deleted_users = []
        self.removed_storage = []
        self.list_calls = []

    def get(self, table, params):
        if table == "organizations":
            return self.orgs
        if table == "team_members":
            org_id = params["org_id"].removeprefix("eq.")
            return self.members_by_org.get(org_id, [])
        if table == "deals":
            org_id = params["org_id"].removeprefix("eq.")
            return self.deals_by_org.get(org_id, [])
        return []

    def get_auth_user(self, user_id):
        return self.users_by_id.get(user_id)

    def delete(self, table, params):
        if table == "organizations":
            self.deleted_orgs.append(params["id"])

    def delete_auth_user(self, user_id):
        self.deleted_users.append(user_id)

    def list_storage(self, bucket, prefix, limit=1000):
        self.list_calls.append((bucket, prefix))
        return [{"name": "a.pdf"}] if prefix in ("org-1", "deal-1") else []

    def remove_storage(self, bucket, paths):
        self.removed_storage.append((bucket, paths))


def test_cleanup_without_secret_configured_is_503():
    # Unified with drain via verify_cron_request: a missing server-side
    # CRON_SECRET is a misconfiguration (503), not a client auth failure (403).
    r = client.post("/api/pipeline/cron/cleanup", headers={"x-cron-secret": "x"})
    assert r.status_code == 503


def test_cleanup_forbidden_wrong_secret(monkeypatch):
    _set_secret(monkeypatch)
    r = client.post("/api/pipeline/cron/cleanup", headers={"x-cron-secret": "wrong"})
    assert r.status_code == 403


def test_cleanup_accepts_get_with_bearer(monkeypatch):
    # Vercel Cron issues GET with Authorization: Bearer <CRON_SECRET>.
    _set_secret(monkeypatch)
    db = FakeDb(orgs=[])
    monkeypatch.setattr(cron_router, "service_client", lambda: db)
    r = client.get(
        "/api/pipeline/cron/cleanup",
        headers={"authorization": "Bearer s3cret"},
    )
    assert r.status_code == 200


def test_cleanup_purges_all_anonymous_org(monkeypatch):
    _set_secret(monkeypatch)
    db = FakeDb(
        orgs=[{"id": "org-1", "slug": "guest-abc", "created_at": "2020-01-01T00:00:00Z"}],
        members_by_org={"org-1": [{"user_id": "u1"}]},
        users_by_id={"u1": {"id": "u1", "is_anonymous": True}},
        deals_by_org={"org-1": [{"id": "deal-1"}]},
    )
    monkeypatch.setattr(cron_router, "service_client", lambda: db)

    r = client.post("/api/pipeline/cron/cleanup", headers={"x-cron-secret": "s3cret"})
    assert r.status_code == 200
    body = r.json()
    assert body == {
        "ok": True,
        "scanned": 1,
        "purged": 1,
        "skippedUpgraded": 0,
        "filesRemoved": 2,
    }
    assert db.deleted_orgs == ["eq.org-1"]
    assert db.deleted_users == ["u1"]
    assert ("knowledge", ["org-1/a.pdf"]) in db.removed_storage
    assert ("documents", ["deal-1/a.pdf"]) in db.removed_storage


def test_cleanup_skips_org_with_upgraded_member(monkeypatch):
    _set_secret(monkeypatch)
    db = FakeDb(
        orgs=[{"id": "org-2", "slug": "guest-xyz", "created_at": "2020-01-01T00:00:00Z"}],
        members_by_org={"org-2": [{"user_id": "u2"}]},
        users_by_id={"u2": {"id": "u2", "is_anonymous": False}},
    )
    monkeypatch.setattr(cron_router, "service_client", lambda: db)

    r = client.post("/api/pipeline/cron/cleanup", headers={"x-cron-secret": "s3cret"})
    assert r.status_code == 200
    body = r.json()
    assert body["purged"] == 0
    assert body["skippedUpgraded"] == 1
    assert db.deleted_orgs == []
    assert db.deleted_users == []


def test_cleanup_one_bad_org_does_not_abort_sweep(monkeypatch):
    _set_secret(monkeypatch)

    class ExplodingDb(FakeDb):
        def get_auth_user(self, user_id):
            if user_id == "boom":
                raise RuntimeError("gotrue down")
            return super().get_auth_user(user_id)

    db = ExplodingDb(
        orgs=[
            {"id": "org-bad", "slug": "guest-bad", "created_at": "2020-01-01T00:00:00Z"},
            {"id": "org-1", "slug": "guest-ok", "created_at": "2020-01-01T00:00:00Z"},
        ],
        members_by_org={"org-bad": [{"user_id": "boom"}], "org-1": [{"user_id": "u1"}]},
        users_by_id={"u1": {"id": "u1", "is_anonymous": True}},
    )
    monkeypatch.setattr(cron_router, "service_client", lambda: db)

    r = client.post("/api/pipeline/cron/cleanup", headers={"x-cron-secret": "s3cret"})
    assert r.status_code == 200
    body = r.json()
    assert body["scanned"] == 2
    assert body["purged"] == 1
    assert db.deleted_orgs == ["eq.org-1"]
    assert "errors" in body and "guest-bad" in body["errors"][0]


def test_cleanup_swallows_auth_user_delete_failure(monkeypatch):
    _set_secret(monkeypatch)

    class FlakyDeleteDb(FakeDb):
        def delete_auth_user(self, user_id):
            raise RuntimeError("already gone")

    db = FlakyDeleteDb(
        orgs=[{"id": "org-1", "slug": "guest-abc", "created_at": "2020-01-01T00:00:00Z"}],
        members_by_org={"org-1": [{"user_id": "u1"}]},
        users_by_id={"u1": {"id": "u1", "is_anonymous": True}},
    )
    monkeypatch.setattr(cron_router, "service_client", lambda: db)

    r = client.post("/api/pipeline/cron/cleanup", headers={"x-cron-secret": "s3cret"})
    assert r.status_code == 200
    assert r.json()["purged"] == 1  # org delete still counted despite user-delete failure
