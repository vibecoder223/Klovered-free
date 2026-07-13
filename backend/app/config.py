from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Read from the same .env.local the Next.js app uses in local dev; env vars
    # win over the file. Extra keys (the app's many NEXT_PUBLIC_* vars) are
    # ignored so this doesn't error on the shared env file.
    model_config = SettingsConfigDict(
        env_file=(".env.local", ".env"), extra="ignore", case_sensitive=False
    )

    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_service_role_key: str = ""
    supabase_jwt_aud: str = "authenticated"
    llm_api_key: str = ""
    mistral_api_key: str = ""
    cron_secret: str = ""

    # NOTE: the app's env uses NEXT_PUBLIC_SUPABASE_URL /
    # NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. Those names are mapped onto
    # supabase_url / supabase_anon_key in get_settings() below.

    @property
    def jwks_url(self) -> str:
        return f"{self.supabase_url}/auth/v1/.well-known/jwks.json"

    @property
    def postgrest_url(self) -> str:
        return f"{self.supabase_url}/rest/v1"

    @property
    def llm_key(self) -> str:
        return self.llm_api_key or self.mistral_api_key


@lru_cache
def get_settings() -> Settings:
    import os

    # Honor the NEXT_PUBLIC_* aliases without a custom settings source: read them
    # explicitly and pass as overrides when present.
    overrides = {}
    if os.getenv("NEXT_PUBLIC_SUPABASE_URL"):
        overrides["supabase_url"] = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
    if os.getenv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"):
        overrides["supabase_anon_key"] = os.environ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]
    return Settings(**overrides)
