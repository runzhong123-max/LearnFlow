import asyncio
import base64
import hashlib
import json
import os
import sqlite3
import struct
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update

from app.core.config import settings
from app.db.database import async_session
from app.main import app
from app.models.learning import (
    AgentMessage,
    AuthLoginAttempt,
    AuthSession,
    DesktopPetCapability,
    DesktopPetContextPackage,
    ReviewSchedule,
    UserAccount,
)
from app.models.project import Checkpoint, Project, Roadmap
from app.services.auth import (
    ModelCredentialDecryptionError,
    account_model_provider_config,
    account_vision_provider_config,
    decrypt_model_credential,
    decrypt_vision_credential,
)


BACKEND_ROOT = Path(__file__).resolve().parents[1]
BROWSER_HEADERS = {
    "Origin": "http://testserver",
    "Sec-Fetch-Site": "same-origin",
}
ADMIN_DTO_KEYS = {
    "account_number",
    "username",
    "display_name",
    "role",
    "status",
    "created_at",
    "updated_at",
    "last_login_at",
    "project_count",
    "api_key_configured",
}


@pytest.fixture(autouse=True)
def fast_test_kdf(monkeypatch):
    # Production defaults remain RFC-style Argon2id costs; these per-test
    # values keep the focused suite quick while exercising the same PHC path.
    monkeypatch.setattr(settings, "auth_argon2_time_cost", 1)
    monkeypatch.setattr(settings, "auth_argon2_memory_cost_kib", 8_192)
    monkeypatch.setattr(settings, "auth_argon2_parallelism", 1)
    monkeypatch.setattr(settings, "auth_login_ip_free_failures", 1_000)
    monkeypatch.setattr(settings, "dev_test_login_enabled", False)
    monkeypatch.setattr(settings, "auth_api_key_kek", "")
    monkeypatch.setattr(settings, "auth_api_key_kek_version", 1)
    monkeypatch.setattr(settings, "auth_runtime_bridge_token", "")


def registration(
    username: str,
    *,
    password: str = "LearnFlow-安全密码-2026!",
    display_name: str | None = None,
) -> dict:
    return {
        "username": username,
        "password": password,
        "display_name": display_name or username,
        "education_stage": "undergraduate",
        "background": "Python 基础",
        "focus_areas": ["认证安全"],
        "weekly_hours": 6,
        "preferred_modes": ["explanation", "practice"],
        "career_goal": "",
        "career_goal_status": "exploring",
    }


def browser(client: TestClient) -> TestClient:
    client.headers.update(BROWSER_HEADERS)
    return client


def bind_csrf(client: TestClient) -> str:
    response = client.get("/api/auth/csrf")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    token = response.json()["csrf_token"]
    client.headers["X-CSRF-Token"] = token
    return token


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def legacy_scrypt(password: str) -> str:
    salt = b"legacy-auth-salt"
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=2**14,
        r=8,
        p=1,
        dklen=32,
    )
    return "scrypt$16384$8$1$" + "$".join((
        base64.urlsafe_b64encode(salt).decode(),
        base64.urlsafe_b64encode(digest).decode(),
    ))


def run_auth_migration(db_path: Path) -> dict:
    script = """
import asyncio
import json
from sqlalchemy import func, select
from app.db.database import async_session, init_db
from app.models.learning import AuthSession, SchemaMigration, UserAccount

async def main():
    await init_db()
    await init_db()
    async with async_session() as db:
        accounts = (await db.execute(
            select(UserAccount).order_by(UserAccount.id.asc())
        )).scalars().all()
        sessions = (await db.execute(
            select(AuthSession).order_by(AuthSession.id.asc())
        )).scalars().all()
        migration_count = (await db.execute(
            select(func.count(SchemaMigration.id)).where(
                SchemaMigration.version == "v19-auth-rbac-phase-a"
            )
        )).scalar_one()
        print(json.dumps({
            "accounts": [{
                "id": account.id,
                "normalized": account.username_normalized,
                "account_number": account.account_number,
                "role": account.role,
                "password_version": account.password_version,
                "auth_epoch": account.auth_epoch,
                "must_change_password": bool(account.must_change_password),
            } for account in accounts],
            "sessions": [{
                "id": session.id,
                "auth_epoch": session.auth_epoch,
                "csrf_token_hash": session.csrf_token_hash,
                "absolute_expires_at": str(session.absolute_expires_at),
                "idle_expires_at": str(session.idle_expires_at),
                "revoked_at": str(session.revoked_at),
                "revoked_reason": session.revoked_reason,
            } for session in sessions],
            "migration_count": migration_count,
        }, ensure_ascii=False))

asyncio.run(main())
"""
    env = os.environ.copy()
    env.update({
        "DATABASE_URL": f"sqlite+aiosqlite:///{db_path}",
        "DEV_TEST_LOGIN_ENABLED": "false",
        "COMPETITION_DEMO_MODE": "false",
        "LLM_API_KEY": "",
        "MEMORY_AUTO_SYNTHESIS_ENABLED": "false",
        "PYTHONPATH": str(BACKEND_ROOT),
    })
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=BACKEND_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    if result.returncode != 0:
        pytest.fail(
            "auth migration subprocess failed\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    return json.loads(lines[-1])


def create_legacy_auth_database(db_path: Path) -> None:
    connection = sqlite3.connect(db_path)
    try:
        connection.executescript("""
            CREATE TABLE user_accounts (
                id INTEGER PRIMARY KEY,
                username VARCHAR(32) NOT NULL,
                username_normalized VARCHAR(32) NOT NULL UNIQUE,
                password_hash TEXT,
                status VARCHAR(20) NOT NULL DEFAULT 'active',
                is_legacy_demo BOOLEAN NOT NULL DEFAULT 0,
                created_at DATETIME,
                updated_at DATETIME,
                last_login_at DATETIME
            );
            CREATE TABLE auth_sessions (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                token_hash VARCHAR(64) NOT NULL UNIQUE,
                is_dev_login BOOLEAN NOT NULL DEFAULT 0,
                expires_at DATETIME NOT NULL,
                last_seen_at DATETIME,
                revoked_at DATETIME,
                created_at DATETIME
            );
            INSERT INTO user_accounts VALUES
                (1, 'legacy-demo', 'legacy-demo', NULL, 'active', 1,
                 '2024-01-01 00:00:00', '2024-01-01 00:00:00', NULL),
                (2, 'ryan123', 'ryan123', 'scrypt$legacy', 'active', 0,
                 '2024-01-02 00:00:00', '2024-01-02 00:00:00', NULL),
                (3, 'Ryan', 'ryan', 'scrypt$legacy', 'active', 0,
                 '2024-01-03 00:00:00', '2024-01-03 00:00:00', NULL);
            INSERT INTO auth_sessions VALUES
                (1, 3,
                 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                 0, '2035-01-01 00:00:00', '2024-01-03 00:00:00', NULL,
                 '2024-01-03 00:00:00');
        """)
        connection.commit()
    finally:
        connection.close()


def test_fresh_database_auth_migration_is_idempotent(tmp_path):
    db_path = tmp_path / "fresh-auth.db"
    result = run_auth_migration(db_path)
    assert result["migration_count"] == 1
    assert result["sessions"] == []
    assert result["accounts"] == [{
        "id": 1,
        "normalized": "legacy-demo",
        "account_number": 1,
        "role": "user",
        "password_version": 0,
        "auth_epoch": 0,
        "must_change_password": True,
    }]

    connection = sqlite3.connect(db_path)
    try:
        table_names = {
            row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        indexes = connection.execute("PRAGMA index_list(user_accounts)").fetchall()
        account_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(user_accounts)")
        }
    finally:
        connection.close()
    assert "auth_login_attempts" in table_names
    assert "auth_account_number_sequences" in table_names
    assert any(row[1] == "ix_user_accounts_account_number" and row[2] for row in indexes)
    assert {
        "api_key_ciphertext",
        "api_key_nonce",
        "api_key_hint",
        "api_key_encryption_version",
        "api_key_updated_at",
        "provider_base_url",
        "provider_model",
        "vision_api_key_ciphertext",
        "vision_api_key_nonce",
        "vision_api_key_hint",
        "vision_api_key_encryption_version",
        "vision_api_key_updated_at",
        "vision_provider_base_url",
        "vision_provider_model",
    }.issubset(account_columns)


def test_legacy_migration_promotes_only_exact_ryan_and_revokes_old_sessions(tmp_path):
    db_path = tmp_path / "legacy-auth.db"
    create_legacy_auth_database(db_path)
    result = run_auth_migration(db_path)
    accounts = {item["normalized"]: item for item in result["accounts"]}

    assert result["migration_count"] == 1
    assert accounts["ryan"]["id"] == 3
    assert accounts["ryan"]["account_number"] == 0
    assert accounts["ryan"]["role"] == "admin"
    assert accounts["ryan123"]["id"] == 2
    assert accounts["ryan123"]["account_number"] > 0
    assert accounts["ryan123"]["role"] == "user"
    assert accounts["legacy-demo"]["role"] == "user"
    assert len({item["account_number"] for item in accounts.values()}) == len(accounts)

    assert len(result["sessions"]) == 1
    migrated_session = result["sessions"][0]
    assert migrated_session["csrf_token_hash"] is None
    assert migrated_session["absolute_expires_at"] != "None"
    assert migrated_session["idle_expires_at"] != "None"
    assert migrated_session["revoked_at"] != "None"
    assert migrated_session["revoked_reason"] == "auth_phase_a_migration"
    assert (tmp_path / "backups" / "legacy-auth-pre-auth-phase-a-v19.db").exists()


def test_auth_startup_repairs_account_inserted_by_an_old_process(tmp_path):
    db_path = tmp_path / "rolling-upgrade-auth.db"
    create_legacy_auth_database(db_path)
    first = run_auth_migration(db_path)
    assert first["migration_count"] == 1

    connection = sqlite3.connect(db_path)
    try:
        connection.execute(
            """
            INSERT INTO user_accounts (
                username, username_normalized, password_hash, account_number,
                role, password_version, auth_epoch, must_change_password,
                status, is_legacy_demo, created_at, updated_at
            ) VALUES (?, ?, ?, NULL, 'user', 1, 0, 0, 'active', 0, ?, ?)
            """,
            (
                "late-old-process",
                "late-old-process",
                "scrypt$legacy",
                "2024-01-04 00:00:00",
                "2024-01-04 00:00:00",
            ),
        )
        connection.commit()
    finally:
        connection.close()

    repaired = run_auth_migration(db_path)
    accounts = {item["normalized"]: item for item in repaired["accounts"]}
    assert repaired["migration_count"] == 1
    assert accounts["ryan"]["account_number"] == 0
    assert accounts["late-old-process"]["account_number"] > 0
    assert len({item["account_number"] for item in accounts.values()}) == len(accounts)


def test_password_policy_two_categories_and_argon2id_hash_only_storage():
    with TestClient(app) as raw_client:
        client = browser(raw_client)
        one_category = client.post(
            "/api/auth/register",
            json=registration(
                "one_category_rejected",
                password="correct horse battery staple",
            ),
        )
        assert one_category.status_code == 422
        assert client.post(
            "/api/auth/register",
            json=registration("short_password_rejected", password="Abc123!"),
        ).status_code == 422
        assert client.post(
            "/api/auth/register",
            json=registration("long_password_rejected", password="密" * 129),
        ).status_code == 422

        minimum_valid = client.post(
            "/api/auth/register",
            json=registration("minimum_valid_password", password="abcdefg1"),
        )
        assert minimum_valid.status_code == 200, minimum_valid.text
        client.cookies.clear()

        password = "LearnFlow-安全密码-2026!"
        created = client.post(
            "/api/auth/register",
            json=registration("unicode_argon_user", password=password),
        )
        assert created.status_code == 200, created.text
        raw_token = client.cookies.get(settings.auth_cookie_name)
        assert raw_token
        csrf = bind_csrf(client)

        async def stored_security_values():
            async with async_session() as db:
                account = (await db.execute(select(UserAccount).where(
                    UserAccount.username_normalized == "unicode_argon_user"
                ))).scalar_one()
                session = (await db.execute(select(AuthSession).where(
                    AuthSession.token_hash == sha256_text(raw_token)
                ))).scalar_one()
                return (
                    account.password_hash,
                    account.password_version,
                    session.token_hash,
                    session.csrf_token_hash,
                )

        password_hash, version, token_hash, csrf_hash = asyncio.run(
            stored_security_values()
        )
        assert password_hash.startswith("$argon2id$")
        assert password not in password_hash
        assert version == 1
        assert token_hash == sha256_text(raw_token)
        assert token_hash != raw_token
        assert csrf_hash == sha256_text(csrf)
        assert csrf_hash != csrf


def test_account_model_credential_encrypted_crud_empty_preserve_and_test(monkeypatch):
    secret = "sk-account-secret-1234567890"
    with TestClient(app) as raw_client:
        client = browser(raw_client)
        created = client.post(
            "/api/auth/register",
            json=registration("model_credential_owner"),
        )
        assert created.status_code == 200, created.text
        bind_csrf(client)

        metadata = client.get("/api/auth/model-credential")
        assert metadata.status_code == 200
        assert metadata.json() == {
            "configured": False,
            "key_hint": "",
            "updated_at": None,
            "base_url": "",
            "model": "",
        }
        # Empty submissions are an explicit no-op and do not require a KEK.
        preserved_empty = client.put(
            "/api/auth/model-credential",
            json={"api_key": "   "},
        )
        assert preserved_empty.status_code == 200
        assert preserved_empty.json()["configured"] is False

        missing_kek = client.put(
            "/api/auth/model-credential",
            json={"api_key": secret},
        )
        assert missing_kek.status_code == 503
        assert "AUTH_API_KEY_KEK" in missing_kek.json()["detail"]

        kek = base64.urlsafe_b64encode(b"K" * 32).decode().rstrip("=")
        monkeypatch.setattr(settings, "auth_api_key_kek", kek)
        invalid_unicode = client.put(
            "/api/auth/model-credential",
            json={"api_key": "这不是 API Key"},
        )
        assert invalid_unicode.status_code == 422
        assert "格式无效" in invalid_unicode.json()["detail"]
        assert client.get("/api/auth/model-credential").json()["configured"] is False

        invalid_whitespace = client.put(
            "/api/auth/model-credential",
            json={"api_key": "sk-invalid key"},
        )
        assert invalid_whitespace.status_code == 422
        assert client.get("/api/auth/model-credential").json()["configured"] is False

        saved = client.put(
            "/api/auth/model-credential",
            json={
                "api_key": secret,
                "base_url": "https://provider.example/v1/chat/completions",
                "model": "credential-test-model",
            },
        )
        assert saved.status_code == 200, saved.text
        assert set(saved.json()) == {"configured", "key_hint", "updated_at", "base_url", "model"}
        assert saved.json()["configured"] is True
        assert saved.json()["key_hint"] == "sk-…7890"
        assert saved.json()["base_url"] == "https://provider.example/v1"
        assert saved.json()["model"] == "credential-test-model"
        assert secret not in saved.text

        bridge_unconfigured = client.post(
            "/api/auth/model-credential/internal/resolve"
        )
        assert bridge_unconfigured.status_code == 503
        assert bridge_unconfigured.headers["cache-control"] == "no-store"
        assert secret not in bridge_unconfigured.text

        bridge_token = "runtime-bridge-test-token-0123456789abcdef"
        monkeypatch.setattr(settings, "auth_runtime_bridge_token", bridge_token)
        browser_direct = client.post(
            "/api/auth/model-credential/internal/resolve",
            headers={"X-LearnFlow-Runtime-Bridge-Token": bridge_token},
        )
        assert browser_direct.status_code == 403
        assert secret not in browser_direct.text

        server_headers = {
            "Origin": "",
            "Sec-Fetch-Site": "",
            # Node's server-side fetch implementation adds this header on its
            # own. It is not browser provenance unless accompanied by Origin,
            # Sec-Fetch-Site, destination, or user-navigation metadata.
            "Sec-Fetch-Mode": "cors",
            "X-LearnFlow-Runtime-Bridge-Token": bridge_token,
        }
        wrong_bridge = client.post(
            "/api/auth/model-credential/internal/resolve",
            headers={**server_headers, "X-LearnFlow-Runtime-Bridge-Token": "wrong"},
        )
        assert wrong_bridge.status_code == 403
        assert secret not in wrong_bridge.text

        session_cookie = client.cookies.get(settings.auth_cookie_name)
        client.cookies.clear()
        missing_account_auth = client.post(
            "/api/auth/model-credential/internal/resolve",
            headers=server_headers,
        )
        assert missing_account_auth.status_code == 401
        assert missing_account_auth.headers["cache-control"] == "no-store"
        client.cookies.set(settings.auth_cookie_name, session_cookie)

        resolved = client.post(
            "/api/auth/model-credential/internal/resolve",
            headers=server_headers,
        )
        assert resolved.status_code == 200, resolved.text
        assert resolved.headers["cache-control"] == "no-store"
        assert resolved.headers["pragma"] == "no-cache"
        assert resolved.json() == {
            "api_key": secret,
            "key_hint": "sk-…7890",
            "version": 1,
            "base_url": "https://provider.example/v1",
            "model": "credential-test-model",
        }

        async def encrypted_snapshot():
            async with async_session() as db:
                account = (await db.execute(select(UserAccount).where(
                    UserAccount.username_normalized == "model_credential_owner"
                ))).scalar_one()
                plaintext = decrypt_model_credential(account)
                return {
                    "id": account.id,
                    "ciphertext": account.api_key_ciphertext,
                    "nonce": account.api_key_nonce,
                    "hint": account.api_key_hint,
                    "version": account.api_key_encryption_version,
                    "updated_at": account.api_key_updated_at,
                    "plaintext": plaintext,
                }

        snapshot = asyncio.run(encrypted_snapshot())
        assert snapshot["id"] > 0
        assert snapshot["plaintext"] == secret
        assert snapshot["hint"] == "sk-…7890"
        assert snapshot["version"] == 1
        assert snapshot["updated_at"] is not None
        assert secret not in snapshot["ciphertext"]
        nonce_padding = "=" * (-len(snapshot["nonce"]) % 4)
        assert len(base64.urlsafe_b64decode(snapshot["nonce"] + nonce_padding)) == 12

        copied_envelope = SimpleNamespace(
            id=snapshot["id"] + 1,
            api_key_ciphertext=snapshot["ciphertext"],
            api_key_nonce=snapshot["nonce"],
            api_key_hint=snapshot["hint"],
            api_key_encryption_version=snapshot["version"],
        )
        with pytest.raises(ModelCredentialDecryptionError):
            decrypt_model_credential(copied_envelope)

        # A masked/empty save preserves the exact authenticated envelope.
        assert client.put(
            "/api/auth/model-credential",
            json={"api_key": ""},
        ).status_code == 200
        preserved = asyncio.run(encrypted_snapshot())
        assert preserved["ciphertext"] == snapshot["ciphertext"]
        assert preserved["nonce"] == snapshot["nonce"]

        captured = {}

        class FakeCompletions:
            async def create(self, **kwargs):
                captured["request"] = kwargs
                return SimpleNamespace(model="credential-test-model")

        class FakeAsyncOpenAI:
            def __init__(self, *, api_key, base_url):
                captured["api_key"] = api_key
                captured["base_url"] = base_url
                self.chat = SimpleNamespace(completions=FakeCompletions())

        import openai

        monkeypatch.setattr(openai, "AsyncOpenAI", FakeAsyncOpenAI)
        tested = client.post("/api/auth/model-credential/test", json={})
        assert tested.status_code == 200, tested.text
        assert tested.json()["status"] == "ok"
        assert tested.json()["model"] == "credential-test-model"
        assert captured["api_key"] == secret
        assert captured["base_url"] == "https://provider.example/v1"

        deleted = client.delete("/api/auth/model-credential")
        assert deleted.status_code == 200
        assert deleted.json()["configured"] is False
        assert deleted.json()["key_hint"] == ""
        assert deleted.json()["base_url"] == ""
        assert deleted.json()["model"] == ""
        assert secret not in deleted.text
        assert client.post(
            "/api/auth/model-credential/test",
            json={"base_url": "https://provider.example/v1", "model": "model"},
        ).status_code == 409


def test_account_vision_credential_isolated_from_tutor_and_supports_reuse(monkeypatch):
    tutor_secret = "sk-tutor-secret-1234567890"
    vision_secret = "sk-vision-secret-0987654321"
    kek = base64.urlsafe_b64encode(b"V" * 32).decode().rstrip("=")
    monkeypatch.setattr(settings, "auth_api_key_kek", kek)
    with TestClient(app) as raw_client:
        client = browser(raw_client)
        created = client.post(
            "/api/auth/register",
            json=registration("vision_credential_owner"),
        )
        assert created.status_code == 200, created.text
        bind_csrf(client)

        tutor_saved = client.put(
            "/api/auth/model-credential",
            json={
                "api_key": tutor_secret,
                "base_url": "https://tutor.example/v1",
                "model": "tutor-model",
            },
        )
        assert tutor_saved.status_code == 200, tutor_saved.text

        inherited = client.get("/api/auth/vision-credential")
        assert inherited.status_code == 200, inherited.text
        inherited_body = inherited.json()
        assert inherited_body == {
            "configured": True,
            "uses_tutor_key": True,
            "key_hint": "sk-…7890",
            "updated_at": inherited_body["updated_at"],
            "base_url": "https://tutor.example/v1",
            "model": "tutor-model",
        }

        vision_saved = client.put(
            "/api/auth/vision-credential",
            json={
                "api_key": vision_secret,
                "base_url": "https://vision.example/v1/chat/completions",
                "model": "vision-model",
            },
        )
        assert vision_saved.status_code == 200, vision_saved.text
        assert vision_saved.json()["configured"] is True
        assert vision_saved.json()["uses_tutor_key"] is False
        assert vision_saved.json()["key_hint"] == "sk-…4321"
        assert vision_saved.json()["base_url"] == "https://vision.example/v1"
        assert vision_secret not in vision_saved.text

        async def credential_snapshot():
            async with async_session() as db:
                account = (await db.execute(select(UserAccount).where(
                    UserAccount.username_normalized == "vision_credential_owner"
                ))).scalar_one()
                vision_config = account_vision_provider_config(account)
                tutor_config = account_model_provider_config(account)
                return {
                    "id": account.id,
                    "tutor_ciphertext": account.api_key_ciphertext,
                    "tutor_nonce": account.api_key_nonce,
                    "tutor_hint": account.api_key_hint,
                    "tutor_version": account.api_key_encryption_version,
                    "vision_ciphertext": account.vision_api_key_ciphertext,
                    "vision_nonce": account.vision_api_key_nonce,
                    "vision_hint": account.vision_api_key_hint,
                    "vision_version": account.vision_api_key_encryption_version,
                    "vision_config": vision_config,
                    "tutor_config": tutor_config,
                }

        snapshot = asyncio.run(credential_snapshot())
        assert snapshot["vision_config"].api_key == vision_secret
        assert snapshot["vision_config"].base_url == "https://vision.example/v1"
        assert snapshot["vision_config"].model == "vision-model"
        assert snapshot["tutor_config"].api_key == tutor_secret
        assert vision_secret not in str(snapshot["vision_ciphertext"])

        tutor_envelope_as_vision = SimpleNamespace(
            id=snapshot["id"],
            vision_api_key_ciphertext=snapshot["tutor_ciphertext"],
            vision_api_key_nonce=snapshot["tutor_nonce"],
            vision_api_key_hint=snapshot["tutor_hint"],
            vision_api_key_encryption_version=snapshot["tutor_version"],
        )
        vision_envelope_as_tutor = SimpleNamespace(
            id=snapshot["id"],
            api_key_ciphertext=snapshot["vision_ciphertext"],
            api_key_nonce=snapshot["vision_nonce"],
            api_key_hint=snapshot["vision_hint"],
            api_key_encryption_version=snapshot["vision_version"],
        )
        with pytest.raises(ModelCredentialDecryptionError):
            decrypt_vision_credential(tutor_envelope_as_vision)
        with pytest.raises(ModelCredentialDecryptionError):
            decrypt_model_credential(vision_envelope_as_tutor)

        captured = {}

        class FakeCompletions:
            async def create(self, **kwargs):
                captured["request"] = kwargs
                return SimpleNamespace(model="vision-model")

        class FakeAsyncOpenAI:
            def __init__(self, *, api_key, base_url):
                captured["api_key"] = api_key
                captured["base_url"] = base_url
                self.chat = SimpleNamespace(completions=FakeCompletions())

            async def close(self):
                return None

        import openai

        monkeypatch.setattr(openai, "AsyncOpenAI", FakeAsyncOpenAI)
        tested = client.post("/api/auth/vision-credential/test")
        assert tested.status_code == 200, tested.text
        assert tested.json()["model"] == "vision-model"
        assert captured["api_key"] == vision_secret
        assert captured["base_url"] == "https://vision.example/v1"
        assert captured["request"]["messages"][0]["content"][1]["type"] == "image_url"
        image_url = captured["request"]["messages"][0]["content"][1]["image_url"]["url"]
        image_data = base64.b64decode(image_url.split(",", 1)[1])
        assert struct.unpack(">II", image_data[16:24]) == (16, 16)

        reused = client.put(
            "/api/auth/vision-credential",
            json={
                "use_tutor_key": True,
                "base_url": "https://reuse.example/v1",
                "model": "reuse-vision-model",
            },
        )
        assert reused.status_code == 200, reused.text
        assert reused.json()["uses_tutor_key"] is True
        assert reused.json()["key_hint"] == "sk-…7890"

        async def reused_config():
            async with async_session() as db:
                account = (await db.execute(select(UserAccount).where(
                    UserAccount.username_normalized == "vision_credential_owner"
                ))).scalar_one()
                return account_vision_provider_config(account)

        reuse_config = asyncio.run(reused_config())
        assert reuse_config.api_key == tutor_secret
        assert reuse_config.base_url == "https://reuse.example/v1"
        assert reuse_config.model == "reuse-vision-model"

        removed = client.delete("/api/auth/vision-credential")
        assert removed.status_code == 200, removed.text
        assert removed.json()["configured"] is True
        assert removed.json()["uses_tutor_key"] is True
        assert removed.json()["base_url"] == "https://tutor.example/v1"
        assert removed.json()["model"] == "tutor-model"

        async def restored_tutor_config():
            async with async_session() as db:
                account = (await db.execute(select(UserAccount).where(
                    UserAccount.username_normalized == "vision_credential_owner"
                ))).scalar_one()
                return account_model_provider_config(account), account_vision_provider_config(account)

        tutor_config, fallback_config = asyncio.run(restored_tutor_config())
        assert tutor_config.api_key == tutor_secret
        assert fallback_config == tutor_config


def test_ryan_zero_admin_safe_projection_and_user_isolation(monkeypatch):
    with TestClient(app) as raw_admin, TestClient(app) as raw_user:
        admin = browser(raw_admin)
        user = browser(raw_user)
        ryan = admin.post(
            "/api/auth/register",
            json=registration("Ryan", display_name="Ryan Admin"),
        )
        ordinary = user.post(
            "/api/auth/register",
            json=registration("ordinary_rbac_user", display_name="Ordinary User"),
        )
        assert ryan.status_code == ordinary.status_code == 200
        assert ryan.json()["account_number"] == 0
        assert ryan.json()["role"] == "admin"
        assert ordinary.json()["account_number"] > 0
        assert ordinary.json()["role"] == "user"
        assert user.get("/api/admin/accounts").status_code == 403

        bind_csrf(user)
        monkeypatch.setattr(
            settings,
            "auth_api_key_kek",
            base64.urlsafe_b64encode(b"A" * 32).decode().rstrip("="),
        )
        ordinary_secret = "sk-ordinary-private-2468"
        credential = user.put(
            "/api/auth/model-credential",
            json={"api_key": ordinary_secret},
        )
        assert credential.status_code == 200, credential.text
        project = user.post("/api/projects", json={
            "name": "普通用户私有项目",
            "description": "管理员角色不能绕过学习资源 ownership",
            "user_level": "beginner",
        })
        assert project.status_code == 200, project.text
        assert admin.get(f"/api/projects/{project.json()['id']}").status_code == 404

        projection = admin.get("/api/admin/accounts")
        assert projection.status_code == 200, projection.text
        rows = projection.json()
        assert any(row["account_number"] == 0 and row["username"] == "Ryan" for row in rows)
        for row in rows:
            assert set(row) == ADMIN_DTO_KEYS
            assert isinstance(row["project_count"], int)
        ordinary_projection = next(
            row for row in rows if row["username"] == "ordinary_rbac_user"
        )
        assert ordinary_projection["api_key_configured"] is True
        assert ordinary_secret not in projection.text
        assert "sk-…2468" not in projection.text

        async def ryan_identity():
            async with async_session() as db:
                account = (await db.execute(select(UserAccount).where(
                    UserAccount.username_normalized == "ryan"
                ))).scalar_one()
                return account.id, account.account_number

        ryan_id, ryan_number = asyncio.run(ryan_identity())
        assert ryan_id > 0
        assert ryan_number == 0
        serialized = json.dumps(rows, ensure_ascii=False).casefold()
        assert ordinary_secret.casefold() not in serialized
        assert "password_hash" not in serialized
        assert "csrf_token" not in serialized
        assert "desktop_auth_token" not in serialized
        assert "llm_api_key" not in serialized


def test_legacy_scrypt_login_upgrades_to_argon2id():
    password = "Legacy-兼容密码-2026!"
    with TestClient(app) as raw_client:
        client = browser(raw_client)
        created = client.post(
            "/api/auth/register",
            json=registration("legacy_upgrade_user", password=password),
        )
        assert created.status_code == 200, created.text
        bind_csrf(client)
        assert client.post("/api/auth/logout").status_code == 200

        async def install_legacy_hash():
            async with async_session() as db:
                account = (await db.execute(select(UserAccount).where(
                    UserAccount.username_normalized == "legacy_upgrade_user"
                ))).scalar_one()
                account.password_hash = legacy_scrypt(password)
                account.password_version = 1
                account.password_upgraded_at = None
                await db.commit()

        asyncio.run(install_legacy_hash())
        logged_in = client.post("/api/auth/login", json={
            "username": "LEGACY_UPGRADE_USER",
            "password": password,
        })
        assert logged_in.status_code == 200, logged_in.text

        async def upgraded_values():
            async with async_session() as db:
                account = (await db.execute(select(UserAccount).where(
                    UserAccount.username_normalized == "legacy_upgrade_user"
                ))).scalar_one()
                return (
                    account.password_hash,
                    account.password_version,
                    account.password_upgraded_at,
                )

        password_hash, version, upgraded_at = asyncio.run(upgraded_values())
        assert password_hash.startswith("$argon2id$")
        assert version == 2
        assert upgraded_at is not None


def test_cookie_csrf_origin_revocation_and_desktop_bearer_exemption(monkeypatch):
    monkeypatch.setattr(settings, "desktop_mode", True)
    monkeypatch.setattr(settings, "desktop_token", "desktop-test-boundary")
    desktop_header = {"X-LearnFlow-Desktop-Token": settings.desktop_token}

    with TestClient(app) as raw_client:
        client = browser(raw_client)
        created = client.post(
            "/api/auth/register",
            json=registration("csrf_cookie_user"),
        )
        assert created.status_code == 200
        saved_token = client.cookies.get(settings.auth_cookie_name)
        assert client.post("/api/auth/logout").status_code == 403
        assert client.get("/api/auth/me").status_code == 200

        csrf = bind_csrf(client)
        cross_site = client.post("/api/auth/logout", headers={
            "Origin": "https://evil.example",
            "Sec-Fetch-Site": "cross-site",
            "X-CSRF-Token": csrf,
        })
        assert cross_site.status_code == 403
        assert client.post("/api/auth/logout").status_code == 200

        del client.headers["X-CSRF-Token"]
        logged_in = client.post("/api/auth/login", json={
            "username": "csrf_cookie_user",
            "password": "LearnFlow-安全密码-2026!",
        })
        assert logged_in.status_code == 200, logged_in.text
        assert bind_csrf(client) != csrf

        client.cookies.clear()
        client.cookies.set(settings.auth_cookie_name, saved_token)
        assert client.get("/api/auth/me").status_code == 401

        async def revocation_reason():
            async with async_session() as db:
                return (await db.execute(select(AuthSession.revoked_reason).where(
                    AuthSession.token_hash == sha256_text(saved_token)
                ))).scalar_one()

        assert asyncio.run(revocation_reason()) == "logout"

    with TestClient(app) as raw_issuer:
        issuer = browser(raw_issuer)
        issued = issuer.post(
            "/api/auth/register",
            headers=desktop_header,
            json=registration("desktop_bearer_user"),
        )
        assert issued.status_code == 200, issued.text
        bearer = issued.json()["desktop_auth_token"]

    with TestClient(app) as bearer_client:
        desktop_secret = "sk-desktop-secret-1234567890"
        monkeypatch.setattr(
            settings,
            "auth_api_key_kek",
            base64.urlsafe_b64encode(b"D" * 32).decode().rstrip("="),
        )
        bridge_token = "desktop-runtime-bridge-token-0123456789"
        monkeypatch.setattr(settings, "auth_runtime_bridge_token", bridge_token)
        bearer_headers = {
            "Authorization": f"Bearer {bearer}",
            **desktop_header,
        }
        saved = bearer_client.put(
            "/api/auth/model-credential",
            headers=bearer_headers,
            json={"api_key": desktop_secret},
        )
        assert saved.status_code == 200, saved.text
        resolved = bearer_client.post(
            "/api/auth/model-credential/internal/resolve",
            headers={
                **bearer_headers,
                "X-LearnFlow-Runtime-Bridge-Token": bridge_token,
            },
        )
        assert resolved.status_code == 200, resolved.text
        assert resolved.json()["api_key"] == desktop_secret
        assert resolved.headers["cache-control"] == "no-store"
        response = bearer_client.post("/api/auth/logout", headers={
            **bearer_headers,
        })
        assert response.status_code == 200, response.text


def test_desktop_webview_cross_site_login_exempt_from_browser_security(monkeypatch):
    # The Tauri window origin (dev http://localhost:4174, prod tauri://localhost)
    # is inherently cross-site to the sidecar API on 127.0.0.1:<port>.  A valid
    # X-LearnFlow-Desktop-Token must let pre-auth calls (login/register, no
    # bearer yet) reach the CSRF bootstrap routes instead of being rejected by
    # _validate_browser_source with a 403 and no ACAO header.
    monkeypatch.setattr(settings, "desktop_mode", True)
    monkeypatch.setattr(settings, "desktop_token", "desktop-webview-boundary")
    webview_headers = {
        "Origin": "http://localhost:4174",
        "Sec-Fetch-Site": "cross-site",
        "X-LearnFlow-Desktop-Token": settings.desktop_token,
    }
    with TestClient(app) as client:
        created = client.post(
            "/api/auth/register",
            headers=webview_headers,
            json=registration("desktop_webview_user"),
        )
        assert created.status_code == 200, created.text
        login = client.post("/api/auth/login", headers=webview_headers, json={
            "username": "desktop_webview_user",
            "password": "LearnFlow-安全密码-2026!",
        })
        assert login.status_code == 200, login.text
        assert login.json().get("desktop_auth_token")
        # The same cross-site web origin WITHOUT the desktop token stays blocked.
        blocked = client.post("/api/auth/logout", headers={
            "Origin": "http://localhost:4174",
            "Sec-Fetch-Site": "cross-site",
        })
        assert blocked.status_code == 403, blocked.text


def test_unannotated_in_process_testclient_remains_compatible():
    # Existing integration tests intentionally use Starlette's synthetic
    # testclient@testserver transport and predate browser security headers.
    # This exact pair is not reachable over a real network.
    with TestClient(app) as client:
        created = client.post(
            "/api/auth/register",
            json=registration("legacy_testclient_compat"),
        )
        assert created.status_code == 200, created.text
        project = client.post("/api/projects", json={
            "name": "TestClient compatibility",
            "description": "Synthetic in-process request",
            "user_level": "beginner",
        })
        assert project.status_code == 200, project.text


def test_idle_absolute_expiry_and_password_epoch_revocation():
    original_password = "Epoch-原始密码-2026!"
    replacement_password = "Epoch-替换密码-2027!"
    with TestClient(app) as raw_first:
        first = browser(raw_first)
        assert first.post(
            "/api/auth/register",
            json=registration("expiry_epoch_user", password=original_password),
        ).status_code == 200
        idle_token = first.cookies.get(settings.auth_cookie_name)

        async def expire(token: str, field: str):
            async with async_session() as db:
                session = (await db.execute(select(AuthSession).where(
                    AuthSession.token_hash == sha256_text(token)
                ))).scalar_one()
                setattr(session, field, datetime.utcnow() - timedelta(seconds=1))
                await db.commit()

        asyncio.run(expire(idle_token, "idle_expires_at"))
        assert first.get("/api/auth/me").status_code == 401
        assert first.post("/api/auth/login", json={
            "username": "expiry_epoch_user",
            "password": original_password,
        }).status_code == 200
        absolute_token = first.cookies.get(settings.auth_cookie_name)
        asyncio.run(expire(absolute_token, "absolute_expires_at"))
        assert first.get("/api/auth/me").status_code == 401

        assert first.post("/api/auth/login", json={
            "username": "expiry_epoch_user",
            "password": original_password,
        }).status_code == 200
        bind_csrf(first)
        with TestClient(app) as raw_second:
            second = browser(raw_second)
            assert second.post("/api/auth/login", json={
                "username": "expiry_epoch_user",
                "password": original_password,
            }).status_code == 200
            changed = first.post("/api/auth/password", json={
                "current_password": original_password,
                "new_password": replacement_password,
            })
            assert changed.status_code == 200, changed.text
            assert first.get("/api/auth/me").status_code == 200
            assert second.get("/api/auth/me").status_code == 401

        with TestClient(app) as raw_login:
            login_client = browser(raw_login)
            assert login_client.post("/api/auth/login", json={
                "username": "expiry_epoch_user",
                "password": original_password,
            }).status_code == 401
            assert login_client.post("/api/auth/login", json={
                "username": "expiry_epoch_user",
                "password": replacement_password,
            }).status_code == 200

        async def epoch_state():
            async with async_session() as db:
                account = (await db.execute(select(UserAccount).where(
                    UserAccount.username_normalized == "expiry_epoch_user"
                ))).scalar_one()
                revoked = (await db.execute(select(func.count(AuthSession.id)).where(
                    AuthSession.user_id == account.id,
                    AuthSession.revoked_reason == "password_changed",
                ))).scalar_one()
                active_epochs = list((await db.execute(select(AuthSession.auth_epoch).where(
                    AuthSession.user_id == account.id,
                    AuthSession.revoked_at.is_(None),
                ))).scalars().all())
                return account.auth_epoch, account.password_version, revoked, active_epochs

        auth_epoch, password_version, revoked, active_epochs = asyncio.run(epoch_state())
        assert auth_epoch == 1
        assert password_version == 2
        assert revoked >= 2
        assert active_epochs and set(active_epochs) == {1}


def test_database_persistent_account_backoff_and_unified_errors(monkeypatch):
    monkeypatch.setattr(settings, "auth_login_account_free_failures", 2)
    monkeypatch.setattr(settings, "auth_login_backoff_base_seconds", 1)
    monkeypatch.setattr(settings, "auth_login_backoff_max_seconds", 1)
    password = "RateLimit-安全密码-2026!"
    username = "persistent_rate_user"

    with TestClient(app) as raw_client:
        client = browser(raw_client)
        assert client.post(
            "/api/auth/register",
            json=registration(username, password=password),
        ).status_code == 200
        bind_csrf(client)
        assert client.post("/api/auth/logout").status_code == 200

        missing = client.post("/api/auth/login", json={
            "username": "missing_rate_identity",
            "password": "wrong",
        })
        wrong_one = client.post("/api/auth/login", json={
            "username": username,
            "password": "wrong",
        })
        wrong_two = client.post("/api/auth/login", json={
            "username": username,
            "password": "wrong",
        })
        throttled = client.post("/api/auth/login", json={
            "username": username,
            "password": "wrong",
        })
        assert missing.status_code == wrong_one.status_code == wrong_two.status_code == 401
        assert missing.json()["detail"] == wrong_one.json()["detail"] == "用户名或密码错误"
        assert throttled.status_code == 429
        assert int(throttled.headers["retry-after"]) >= 1
        assert client.post("/api/auth/login", json={
            "username": username,
            "password": password,
        }).status_code == 429

        account_key = sha256_text(f"account:{username}")

        async def age_attempts():
            async with async_session() as db:
                await db.execute(update(AuthLoginAttempt).where(
                    AuthLoginAttempt.account_key_hash == account_key,
                ).values(attempted_at=datetime.utcnow() - timedelta(seconds=2)))
                await db.commit()

        asyncio.run(age_attempts())
        recovered = client.post("/api/auth/login", json={
            "username": username,
            "password": password,
        })
        assert recovered.status_code == 200, recovered.text

        async def remaining_account_failures():
            async with async_session() as db:
                return (await db.execute(select(func.count(AuthLoginAttempt.id)).where(
                    AuthLoginAttempt.account_key_hash == account_key,
                ))).scalar_one()

        assert asyncio.run(remaining_account_failures()) == 0


def test_dev_account_switching_is_default_closed_and_loopback_only(monkeypatch):
    assert settings.dev_test_login_enabled is False
    with TestClient(app) as raw_local:
        local = browser(raw_local)
        assert local.get("/api/dev/accounts").status_code == 404
        monkeypatch.setattr(settings, "dev_test_login_enabled", True)
        accounts = local.get("/api/dev/accounts")
        assert accounts.status_code == 200, accounts.text
        assert accounts.json()
        switched = local.post(f"/api/dev/accounts/{accounts.json()[0]['id']}/login")
        assert switched.status_code == 200, switched.text
        assert switched.json()["is_dev_login"] is True

        with TestClient(app, base_url="http://example.com") as raw_remote:
            remote = raw_remote
            remote.headers.update({
                "Origin": "http://example.com",
                "Sec-Fetch-Site": "same-origin",
            })
            assert remote.get("/api/dev/accounts").status_code == 404
            assert remote.post(
                f"/api/dev/accounts/{accounts.json()[0]['id']}/login"
            ).status_code == 404


def test_desktop_pet_capability_refresh_requires_parent_bearer(monkeypatch):
    monkeypatch.setattr(settings, "desktop_mode", True)
    monkeypatch.setattr(settings, "desktop_token", "desktop-pet-refresh-boundary")
    desktop_header = {"X-LearnFlow-Desktop-Token": settings.desktop_token}

    with TestClient(app) as raw_issuer:
        issued = browser(raw_issuer).post(
            "/api/auth/register",
            headers=desktop_header,
            json=registration("desktop_pet_refresh_user"),
        )
        assert issued.status_code == 200, issued.text
        bearer = issued.json()["desktop_auth_token"]
        original_capability = issued.json()["desktop_pet_capability_token"]

    bearer_headers = {"Authorization": f"Bearer {bearer}", **desktop_header}
    pet_headers = {"Authorization": f"Bearer {original_capability}", **desktop_header}
    with TestClient(app) as raw_client:
        client = browser(raw_client)
        rejected = client.post("/api/auth/desktop-pet-capability", headers=pet_headers)
        assert rejected.status_code == 403

        refreshed = client.post("/api/auth/desktop-pet-capability", headers=bearer_headers)
        assert refreshed.status_code == 200, refreshed.text
        assert refreshed.headers["cache-control"] == "no-store"
        assert refreshed.headers["pragma"] == "no-cache"
        replacement_capability = refreshed.json()["desktop_pet_capability_token"]
        assert replacement_capability.startswith("lfpet_")
        assert replacement_capability != original_capability

        assert client.get("/api/pet/bootstrap", headers=pet_headers).status_code == 401
        replacement_headers = {"Authorization": f"Bearer {replacement_capability}", **desktop_header}
        assert client.get("/api/pet/bootstrap", headers=replacement_headers).status_code == 200

    async def refresh_state():
        async with async_session() as db:
            account = (await db.execute(select(UserAccount).where(
                UserAccount.username_normalized == "desktop_pet_refresh_user",
            ))).scalar_one()
            sessions = list((await db.execute(select(AuthSession).where(
                AuthSession.user_id == account.id,
            ))).scalars().all())
            capabilities = list((await db.execute(select(DesktopPetCapability).where(
                DesktopPetCapability.user_id == account.id,
                DesktopPetCapability.revoked_at.is_(None),
            ))).scalars().all())
            return sessions, capabilities

    sessions, capabilities = asyncio.run(refresh_state())
    assert len(sessions) == 1
    assert len(capabilities) == 1


def test_desktop_pet_capability_least_privilege_bootstrap_and_context_lifecycle(monkeypatch):
    monkeypatch.setattr(settings, "desktop_mode", True)
    monkeypatch.setattr(settings, "desktop_token", "desktop-pet-test-boundary")
    desktop_header = {"X-LearnFlow-Desktop-Token": settings.desktop_token}
    external_reference = "外部字幕：神经网络通过多层非线性变换学习表示。"
    document_reference = "# 外部讲义摘录\n\n反向传播通过链式法则计算参数的梯度。"

    with TestClient(app) as raw_issuer:
        issuer = browser(raw_issuer)
        issued = issuer.post(
            "/api/auth/register",
            headers=desktop_header,
            json=registration("desktop_pet_capability_user"),
        )
        assert issued.status_code == 200, issued.text
        bearer = issued.json()["desktop_auth_token"]
        capability = issued.json()["desktop_pet_capability_token"]
        learner_id = issued.json()["learner_id"]
        assert capability.startswith("lfpet_")
        assert bearer not in capability

    async def seed_review_focus():
        async with async_session() as db:
            project = Project(learner_id=learner_id, name="桌宠复习提醒")
            db.add(project)
            await db.flush()
            roadmap = Roadmap(project_id=project.id, raw_json={})
            db.add(roadmap)
            await db.flush()
            checkpoint = Checkpoint(
                roadmap_id=roadmap.id,
                title="反向传播",
                order=1,
            )
            db.add(checkpoint)
            await db.flush()
            db.add(ReviewSchedule(
                learner_id=learner_id,
                project_id=project.id,
                checkpoint_id=checkpoint.id,
                item_type="concept",
                item_id=1,
                subject_key="神经网络反向传播",
                phase="active",
                due_at=datetime.utcnow() - timedelta(minutes=5),
                lapse_count=2,
                last_grade="again",
            ))
            await db.commit()

    asyncio.run(seed_review_focus())

    bearer_headers = {"Authorization": f"Bearer {bearer}", **desktop_header}
    pet_headers = {"Authorization": f"Bearer {capability}", **desktop_header}
    with TestClient(app) as raw_client:
        client = browser(raw_client)
        bootstrap = client.get("/api/pet/bootstrap", headers=pet_headers)
        assert bootstrap.status_code == 200, bootstrap.text
        assert bootstrap.json()["authority"] == "formal_learnflow_objects"
        assert bootstrap.json()["review"]["focus_subjects"] == [{
            "subject": "神经网络反向传播",
            "reason_code": "review_lapse",
        }]
        assert bootstrap.json()["review"]["mastery_unchanged"] is True
        assert client.get("/api/auth/model-credential", headers=pet_headers).status_code == 403
        assert client.post("/api/learning-tasks", headers=pet_headers, json={}).status_code == 403

        created_session = client.post("/api/agent/sessions", headers=bearer_headers, json={
            "session_type": "global",
            "create_new": True,
            "title": "桌宠正式会话",
        })
        assert created_session.status_code == 200, created_session.text
        session_id = created_session.json()["id"]

        context = client.post("/api/pet/context-packages", headers=pet_headers, json={
            "kind": "video_transcript",
            "content": external_reference,
            "source_label": "学习者确认的外部视频字幕",
        })
        assert context.status_code == 200, context.text
        context_id = context.json()["id"]
        assert context.json()["requires_confirmation"] is True
        confirmed = client.post(
            f"/api/pet/context-packages/{context_id}/confirm",
            headers=pet_headers,
            json={"session_id": session_id},
        )
        assert confirmed.status_code == 200, confirmed.text
        assert confirmed.json()["status"] == "confirmed"

        document_context = client.post(
            "/api/pet/context-packages/document",
            headers=pet_headers,
            files={"file": ("反向传播讲义.md", document_reference.encode("utf-8"), "text/markdown")},
        )
        assert document_context.status_code == 200, document_context.text
        document_context_id = document_context.json()["id"]
        assert document_context.json()["kind"] == "document_excerpt"
        assert "反向传播讲义.md" in document_context.json()["source_label"]
        document_confirmed = client.post(
            f"/api/pet/context-packages/{document_context_id}/confirm",
            headers=pet_headers,
            json={"session_id": session_id},
        )
        assert document_confirmed.status_code == 200, document_confirmed.text
        assert document_confirmed.json()["status"] == "confirmed"

        reply = client.post(
            f"/api/agent/sessions/{session_id}/turns",
            headers=pet_headers,
            json={
                "message": "请根据我确认的外部参考，用自己的话解释。",
                "client_turn_id": "desktop-pet-context-turn-001",
                "context": {"surface": "desktop_pet"},
                "context_refs": [context_id, document_context_id],
            },
        )
        assert reply.status_code == 200, reply.text
        # Restricted pet turn cannot pivot scope or act; context_refs rejected for browsers.
        pivot = client.post(
            f"/api/agent/sessions/{session_id}/turns",
            headers=pet_headers,
            json={"message": "换个项目聊聊", "client_turn_id": "desktop-pet-turn-pivot",
                  "project_id": 999},
        )
        assert pivot.status_code == 403, pivot.text
        no_client_turn = client.post(
            f"/api/agent/sessions/{session_id}/turns",
            headers=pet_headers,
            json={"message": "没有幂等键的桌宠消息"},
        )
        assert no_client_turn.status_code == 422, no_client_turn.text
        replay = client.post(
            f"/api/agent/sessions/{session_id}/turns",
            headers=pet_headers,
            json={
                "message": "请根据我确认的外部参考，用自己的话解释。",
                "client_turn_id": "desktop-pet-context-turn-001",
                "context": {"surface": "desktop_pet"},
                "context_refs": [context_id, document_context_id],
            },
        )
        assert replay.status_code == 200, replay.text

    async def pet_context_state():
        async with async_session() as db:
            package = await db.get(DesktopPetContextPackage, context_id)
            document_package = await db.get(DesktopPetContextPackage, document_context_id)
            capability_row = (await db.execute(select(DesktopPetCapability).where(
                DesktopPetCapability.token_hash == sha256_text(capability.removeprefix("lfpet_")),
            ))).scalar_one()
            messages = list((await db.execute(select(AgentMessage).where(
                AgentMessage.session_id == session_id,
            ))).scalars().all())
            return package, document_package, capability_row, messages

    package, document_package, capability_row, messages = asyncio.run(pet_context_state())
    assert capability_row.token_hash != capability.removeprefix("lfpet_")
    assert package.status == "consumed"
    assert package.content is None
    assert package.consumed_by_turn_id == "desktop-pet-context-turn-001"
    assert package.session_id == session_id
    assert document_package.status == "consumed"
    assert document_package.content is None
    assert document_package.consumed_by_turn_id == "desktop-pet-context-turn-001"
    serialized_messages = json.dumps(
        [message.meta_data for message in messages], ensure_ascii=False,
    )
    assert external_reference not in serialized_messages
    assert document_reference not in serialized_messages
    assert context_id in serialized_messages
