import os
from urllib.parse import urlsplit

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings
from typing import List


DEFAULT_ENV_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env"
)
CONFIGURED_ENV_PATH = os.environ.get("LEARNFLOW_SETTINGS_PATH")
ENV_FILES = (
    (DEFAULT_ENV_PATH, CONFIGURED_ENV_PATH)
    if CONFIGURED_ENV_PATH and CONFIGURED_ENV_PATH != DEFAULT_ENV_PATH
    else (DEFAULT_ENV_PATH,)
)


def normalize_openai_base_url(value: str) -> str:
    """Accept provider roots as well as commonly pasted full endpoint URLs."""
    normalized = str(value or "").strip().rstrip("/")
    lowered = normalized.casefold()
    for suffix in ("/chat/completions", "/responses"):
        if lowered.endswith(suffix):
            normalized = normalized[: -len(suffix)].rstrip("/")
            lowered = normalized.casefold()
            break
    if lowered in {
        "https://api.deepseek.com",
        "https://api.deepseek.com/v1",
    }:
        return "https://api.deepseek.com"
    return normalized


def openai_chat_provider_kwargs(
    base_url: str,
    model: str,
    *,
    thinking_enabled: bool,
) -> dict:
    """Return narrowly scoped OpenAI-compatible provider extensions.

    Reasoning models spend the output budget on their thinking pass before any
    visible text, so a deployment that pairs one with a short interactive turn
    can receive empty content. The effort value is forwarded verbatim rather
    than matched against a provider list: whoever configures the model knows
    which value it accepts, and an unset value keeps the request untouched so
    models without a reasoning mode are unaffected.
    """
    hostname = (urlsplit(str(base_url or "")).hostname or "").casefold()
    model_name = str(model or "").casefold()
    extra_body: dict = {}
    if hostname == "api.xiaomimimo.com" and model_name.startswith("mimo-"):
        extra_body["thinking"] = {
            "type": "enabled" if thinking_enabled else "disabled",
        }
    configured_effort = str(settings.llm_reasoning_effort or "").strip()
    if configured_effort:
        extra_body["reasoning_effort"] = configured_effort
    return {"extra_body": extra_body} if extra_body else {}


class Settings(BaseSettings):
    app_name: str = "LearnFlow"
    app_version: str = "0.1.0"

    # LLM
    llm_api_key: str = ""
    llm_base_url: str = "https://api.openai.com/v1"
    llm_model: str = "gpt-4o-mini"
    # Forwarded verbatim to the provider when set. Reasoning models spend the
    # output budget on thinking first, so lowering or disabling the effort
    # keeps interactive turns from returning empty content. Leave empty for
    # models that have no reasoning mode.
    llm_reasoning_effort: str = ""
    # User-visible online enhancement has a long but bounded wall-clock budget.
    # Deterministic fallbacks remain usable when the provider reaches it.
    tutor_model_budget_seconds: float = 180.0
    learning_task_plan_model_budget_seconds: float = 120.0
    micro_learning_artifact_model_budget_seconds: float = 180.0

    # Central server only. Never distribute this shared secret in a desktop bundle.
    role_atlas_gateway_base_url: str = ""
    role_atlas_gateway_secret: str = ""
    role_atlas_gateway_timeout_seconds: float = 30.0

    # Server-only Xingchen integration for candidate learning-task artifacts.
    # Provider credentials are loaded from an ignored feature-private file and
    # are never returned to the browser or plugin package.
    learning_task_xfyun_credentials_path: str = ""
    learning_task_conversion_base_url: str = ""
    learning_task_bundle_credentials_path: str = ""
    learning_task_bundle_ca_file: str = ""
    learning_task_conversion_timeout_seconds: float = 30.0
    learning_task_conversion_max_source_segments: int = 16

    # Vision (image understanding) — Moonshot
    vision_api_key: str = ""
    vision_base_url: str = "https://api.moonshot.cn/v1"
    vision_model: str = "moonshot-v1-8k-vision-preview"
    vision_api_enhance: bool = False  # allow paid API captioning of pure graphics

    # Reference-source cache. This is deliberately outside any linked project
    # workspace: GitHub/URL processing may persist images and markdown here for
    # rendering, but those files are not project files.
    source_cache_dir: str = Field(
        default="data/repo-files",
        validation_alias=AliasChoices("SOURCE_CACHE_DIR", "REPO_FILES_DIR"),
    )
    # Uploaded reference originals also live outside project workspaces.
    source_uploads_dir: str = Field(
        default="data/source-uploads",
        validation_alias="SOURCE_UPLOADS_DIR",
    )
    max_source_upload_bytes: int = 25 * 1024 * 1024

    # Project-mode runtime (venv + workspaces for multi-file exercises)
    runtime_dir: str = ""  # empty → <backend>/runtime

    # Database
    database_url: str = "sqlite+aiosqlite:///./learnflow.db"
    five_kernel_enabled: bool = True
    # Module/Claim consolidation is part of the normal memory projection. It
    # remains asynchronous, but must be enabled by default so queued Facts do
    # not leave a learner's graph permanently incomplete.
    memory_auto_synthesis_enabled: bool = True
    memory_worker_embedded: bool = True
    github_token: str = ""
    github_resource_search_enabled: bool = True
    # Passwordless account switching is a local development/demo affordance.
    # Production starts closed and the route also verifies the socket peer is
    # loopback before exposing account metadata or issuing a session.
    dev_test_login_enabled: bool = False
    competition_demo_mode: bool = False
    # Desktop sidecar mode. Keep disabled in browser/server deployments.
    desktop_mode: bool = False
    desktop_token: str = ""
    local_agent_runs_dir: str = ""  # empty -> platform temp directory
    local_agent_default_timeout_seconds: int = 900
    local_agent_max_output_bytes: int = 2 * 1024 * 1024
    auth_cookie_name: str = "learnflow_session"
    # Set to a shared parent domain (for example `.example.com`) when
    # LearnFlow and Role Atlas use sibling subdomains with shared login.
    auth_cookie_domain: str = ""
    # The existing setting remains the absolute browser-session lifetime.
    auth_session_days: int = 7
    auth_session_idle_minutes: int = 120
    auth_session_touch_interval_seconds: int = 60
    auth_cookie_secure: bool = False
    auth_argon2_time_cost: int = 3
    auth_argon2_memory_cost_kib: int = 65_536
    auth_argon2_parallelism: int = 4
    auth_kdf_max_concurrency: int = 2
    auth_kdf_queue_timeout_seconds: float = 15.0
    auth_login_window_seconds: int = 15 * 60
    auth_login_account_free_failures: int = 3
    auth_login_ip_free_failures: int = 20
    auth_login_backoff_base_seconds: int = 2
    auth_login_backoff_max_seconds: int = 5 * 60
    # URL-safe base64 for exactly 32 random bytes. It is a deployment secret,
    # never persisted in the application database or returned by an API.
    auth_api_key_kek: str = Field(default="", repr=False)
    auth_api_key_kek_version: int = 1
    # Server-only capability used by the vNext Tutor proxy to resolve the
    # currently authenticated account's encrypted provider credential.  It
    # must never be embedded in or forwarded to browser code.
    auth_runtime_bridge_token: str = Field(default="", repr=False)
    # Short-lived, learner-bound Role Package handoff verification secret.
    role_package_launch_secret: str = Field(default="", repr=False)
    # Public registration is closed unless this deployment-controlled code is
    # supplied by the registering user. Empty keeps local/test environments open.
    registration_invite_code: str = Field(default="", repr=False)
    # -1 means unlimited. The account projection keeps the quota contract
    # stable while the initial production cohort is intentionally unmetered.
    default_account_credit_limit: int = -1

    # Embedding
    embedding_backend: str = "local"  # local | api
    embedding_model: str = "text-embedding-ada-002"  # for api backend
    embedding_api_key: str = ""  # separate from llm_api_key
    embedding_base_url: str = ""  # separate from llm_base_url (empty = use llm_base_url)

    # CORS — stored as comma-separated in env, split at use
    cors_origins: str = "http://localhost:4174,http://127.0.0.1:4174"

    log_level: str = "info"

    class Config:
        # Desktop settings override the repository .env when present. Falling
        # back to the repository file keeps existing local credentials usable
        # after upgrading from older desktop builds that did not persist a
        # separate settings.env yet.
        env_file = ENV_FILES
        # Removed integrations may leave inert keys in an operator-managed env
        # file during rollback or upgrade.  Unknown keys must not resurrect a
        # capability and should not prevent the current authority from booting.
        extra = "ignore"

    @field_validator("llm_base_url", mode="before")
    @classmethod
    def normalize_llm_base_url(cls, value: str) -> str:
        return normalize_openai_base_url(value)

    @property
    def cors_origins_list(self) -> List[str]:
        return [s.strip() for s in self.cors_origins.split(",") if s.strip()]

    @property
    def repo_files_dir(self) -> str:
        """Compatibility alias for integrations using the old setting name."""
        return self.source_cache_dir


settings = Settings()
