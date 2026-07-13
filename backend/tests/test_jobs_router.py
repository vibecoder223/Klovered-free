import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import app
from app.routers import jobs as jobs_router

client = TestClient(app, raise_server_exceptions=False)


def _set_secret(monkeypatch, secret="s3cret"):
    monkeypatch.setenv("CRON_SECRET", secret)
    config.get_settings.cache_clear()


def test_drain_without_secret_configured_is_503():
    r = client.post("/api/pipeline/jobs/drain", headers={"x-cron-secret": "whatever"})
    assert r.status_code == 503
    assert r.json() == {"error": "CRON_SECRET not configured"}


def test_drain_wrong_secret_is_403(monkeypatch):
    _set_secret(monkeypatch)
    r = client.post("/api/pipeline/jobs/drain", headers={"x-cron-secret": "wrong"})
    assert r.status_code == 403


def test_drain_runs_and_returns_result(monkeypatch):
    _set_secret(monkeypatch)
    seen = {}

    async def fake_run_drain(db):
        seen["called"] = True
        return {"claimed": 3, "results": [{"id": "j1", "stage": "ingest", "ok": True}]}

    monkeypatch.setattr(jobs_router, "run_drain", fake_run_drain)
    r = client.post("/api/pipeline/jobs/drain", headers={"x-cron-secret": "s3cret"})
    assert r.status_code == 200
    assert r.json() == {"claimed": 3, "results": [{"id": "j1", "stage": "ingest", "ok": True}]}
    assert seen["called"]


def test_drain_accepts_get_with_bearer(monkeypatch):
    # Vercel Cron issues GET with Authorization: Bearer <CRON_SECRET>.
    _set_secret(monkeypatch)

    async def fake_run_drain(db):
        return {"claimed": 0, "results": []}

    monkeypatch.setattr(jobs_router, "run_drain", fake_run_drain)
    r = client.get("/api/pipeline/jobs/drain", headers={"authorization": "Bearer s3cret"})
    assert r.status_code == 200
    assert r.json() == {"claimed": 0, "results": []}
