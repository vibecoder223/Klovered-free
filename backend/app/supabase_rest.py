import httpx

from .config import get_settings


class SupabaseRest:
    """Thin PostgREST client. On the user path, `apikey` is the anon key and the
    Authorization bearer is the guest JWT, so Postgres RLS scopes every row to
    the guest's org. On the service path, both are the service-role key and RLS
    is bypassed (trusted worker code only)."""

    def __init__(self, bearer: str, *, is_service_role: bool = False):
        settings = get_settings()
        self._base = settings.postgrest_url
        apikey = settings.supabase_service_role_key if is_service_role else settings.supabase_anon_key
        self._headers = {
            "apikey": apikey,
            "Authorization": f"Bearer {bearer}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    def get(self, table: str, params: dict) -> list[dict]:
        with httpx.Client(timeout=15.0) as client:
            resp = client.get(f"{self._base}/{table}", headers=self._headers, params=params)
            resp.raise_for_status()
            return resp.json()

    def insert(self, table: str, rows: dict | list[dict]) -> list[dict]:
        # Prefer: return=representation so the inserted rows (with generated ids)
        # come back, matching the TS supabase-js .insert().select() usage.
        headers = {**self._headers, "Prefer": "return=representation"}
        with httpx.Client(timeout=30.0) as client:
            resp = client.post(f"{self._base}/{table}", headers=headers, json=rows)
            resp.raise_for_status()
            return resp.json()

    def update(self, table: str, params: dict, patch: dict) -> list[dict]:
        headers = {**self._headers, "Prefer": "return=representation"}
        with httpx.Client(timeout=30.0) as client:
            resp = client.patch(
                f"{self._base}/{table}", headers=headers, params=params, json=patch
            )
            resp.raise_for_status()
            return resp.json()

    def delete(self, table: str, params: dict) -> None:
        with httpx.Client(timeout=30.0) as client:
            resp = client.delete(f"{self._base}/{table}", headers=self._headers, params=params)
            resp.raise_for_status()

    def rpc(self, fn: str, args: dict | None = None):
        with httpx.Client(timeout=60.0) as client:
            resp = client.post(f"{self._base}/rpc/{fn}", headers=self._headers, json=args or {})
            resp.raise_for_status()
            return resp.json()


def user_client(token: str) -> SupabaseRest:
    return SupabaseRest(token)


def service_client() -> SupabaseRest:
    return SupabaseRest(get_settings().supabase_service_role_key, is_service_role=True)


def resolve_org(token: str, user_id: str) -> str | None:
    rows = user_client(token).get(
        "team_members",
        {"select": "org_id", "user_id": f"eq.{user_id}", "limit": "1"},
    )
    return rows[0]["org_id"] if rows else None
