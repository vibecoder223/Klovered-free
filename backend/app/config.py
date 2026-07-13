from functools import lru_cache

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Read from the same .env.local the Next.js app uses in local dev; process
    # env wins over the file. Extra keys (the app's many other NEXT_PUBLIC_* vars)
    # are ignored so this doesn't error on the shared env file.
    model_config = SettingsConfigDict(
        env_file=(".env.local", ".env"), extra="ignore", case_sensitive=False
    )

    # The web app names these NEXT_PUBLIC_SUPABASE_URL /
    # NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. validation_alias makes pydantic read
    # those keys — from BOTH the env file and process env — into our fields.
    supabase_url: str = Field(
        default="", validation_alias=AliasChoices("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL")
    )
    supabase_anon_key: str = Field(
        default="",
        validation_alias=AliasChoices("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"),
    )
    supabase_service_role_key: str = Field(
        default="", validation_alias=AliasChoices("SUPABASE_SERVICE_ROLE_KEY")
    )
    supabase_jwt_aud: str = "authenticated"
    llm_api_key: str = Field(default="", validation_alias=AliasChoices("LLM_API_KEY"))
    mistral_api_key: str = Field(default="", validation_alias=AliasChoices("MISTRAL_API_KEY"))
    cron_secret: str = Field(default="", validation_alias=AliasChoices("CRON_SECRET"))

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
    return Settings()
