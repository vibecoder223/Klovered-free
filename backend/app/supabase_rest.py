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

    def download_storage(self, bucket: str, path: str) -> bytes:
        # Storage lives under /storage/v1/object, not PostgREST. Mirrors the TS
        # supabase.storage.from(bucket).download(path). Service-role only.
        settings = get_settings()
        url = f"{settings.supabase_url}/storage/v1/object/{bucket}/{path}"
        with httpx.Client(timeout=60.0) as client:
            resp = client.get(url, headers=self._headers)
            resp.raise_for_status()
            return resp.content

    def upload_storage(self, bucket: str, path: str, data: bytes, content_type: str) -> None:
        # Mirrors supabase.storage.from(bucket).upload(path, data, {contentType}).
        settings = get_settings()
        url = f"{settings.supabase_url}/storage/v1/object/{bucket}/{path}"
        headers = {**self._headers, "Content-Type": content_type}
        with httpx.Client(timeout=60.0) as client:
            resp = client.post(url, headers=headers, content=data)
            resp.raise_for_status()

    def list_storage(self, bucket: str, prefix: str, limit: int = 1000) -> list[dict]:
        # Mirrors supabase.storage.from(bucket).list(prefix, {limit}).
        settings = get_settings()
        url = f"{settings.supabase_url}/storage/v1/object/list/{bucket}"
        with httpx.Client(timeout=30.0) as client:
            resp = client.post(url, headers=self._headers, json={"prefix": prefix, "limit": limit})
            resp.raise_for_status()
            return resp.json()

    def remove_storage(self, bucket: str, paths: list[str]) -> None:
        # Mirrors supabase.storage.from(bucket).remove(paths).
        settings = get_settings()
        url = f"{settings.supabase_url}/storage/v1/object/{bucket}"
        with httpx.Client(timeout=30.0) as client:
            resp = client.request(
                "DELETE", url, headers=self._headers, json={"prefixes": paths}
            )
            resp.raise_for_status()


def user_client(token: str) -> SupabaseRest:
    return SupabaseRest(token)


def service_client() -> SupabaseRest:
    return SupabaseRest(get_settings().supabase_service_role_key, is_service_role=True)


def try_service_client() -> SupabaseRest | None:
    """Service client if SUPABASE_SERVICE_ROLE_KEY is configured, else None —
    mirrors the TS tryCreateAdminClient() fallback-to-user-client pattern."""
    if not get_settings().supabase_service_role_key:
        return None
    return service_client()


def resolve_org(token: str, user_id: str) -> str | None:
    rows = user_client(token).get(
        "team_members",
        {"select": "org_id", "user_id": f"eq.{user_id}", "limit": "1"},
    )
    return rows[0]["org_id"] if rows else None
