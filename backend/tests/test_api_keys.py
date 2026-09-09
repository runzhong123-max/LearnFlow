import asyncio
import base64
import hashlib
import json
from pathlib import Path
import stat
import subprocess
import sys
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from app.core.config import settings
from app.db.database import async_session
from app.main import app
from app.models.learning import AuthApiKey, AuthApiKeySecret, UserAccount


PASSWORD = "Api-key-tests-2026!"
BROWSER = {"Origin": "http://testserver", "Sec-Fetch-Site": "same-origin"}


@pytest.fixture
def owner(monkeypatch):
    monkeypatch.setattr(settings, "auth_argon2_time_cost", 1)
    monkeypatch.setattr(settings, "auth_argon2_memory_cost_kib", 8192)
    monkeypatch.setattr(settings, "auth_argon2_parallelism", 1)
    monkeypatch.setattr(settings, "registration_invite_code", "")
    monkeypatch.setattr(settings, "desktop_mode", False)
    kek = base64.urlsafe_b64encode(b"k" * 32).decode()
    monkeypatch.setattr(settings, "auth_api_key_kek", kek)
    monkeypatch.setattr(settings, "auth_api_key_kek_version", 1)
    monkeypatch.setenv("AUTH_API_KEY_KEK", kek)
    monkeypatch.setenv("AUTH_API_KEY_KEK_VERSION", "1")
    with TestClient(app) as client:
        client.headers.update(BROWSER)
        username = "key_" + __import__("secrets").token_hex(7)
        response = client.post("/api/auth/register", json={
            "username": username, "password": PASSWORD, "display_name": username,
            "education_stage": "working", "background": "API tests",
            "focus_areas": ["testing"], "weekly_hours": 4, "preferred_modes": ["practice"],
        })
        assert response.status_code == 200, response.text
        client.headers["X-CSRF-Token"] = client.get("/api/auth/csrf").json()["csrf_token"]
        yield client


def issue(owner, **overrides):
    response = owner.post("/api/auth/api-keys", json={
        "name": "My desktop", "password": PASSWORD, **overrides,
    })
    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def key_headers(token):
    return {"Authorization": f"Bearer {token}", "Cookie": "", "X-CSRF-Token": ""}


def test_key_hash_authentication_scope_and_strict_authorization(owner):
    created = issue(owner)
    token, key_id = created["api_key"], created["metadata"]["id"]
    assert token.startswith("lfak_") and len(token) == 48
    metadata = owner.get("/api/auth/api-keys").json()["api_keys"]
    assert len(metadata) == 1 and token not in str(metadata)

    async def inspect():
        async with async_session() as db:
            key = await db.get(AuthApiKey, key_id)
            assert key.token_hash == hashlib.sha256(token.encode()).hexdigest()
            assert token not in str(key.__dict__)
            assert timedelta(days=29) < key.expires_at - key.created_at <= timedelta(days=30)
    asyncio.run(inspect())
    key_account = owner.get("/api/auth/me", headers=key_headers(token))
    assert key_account.status_code == 200
    assert key_account.json()["learner_id"] == owner.get("/api/auth/me").json()["learner_id"]
    response = owner.get("/api/auth/api-key/verify", headers=key_headers(token))
    assert response.status_code == 204 and not response.content
    assert owner.get("/api/auth/api-key/verify").status_code == 401
    for authorization in ("", "Basic value", "Bearer invalid", "Bearer " + token + " ", "Bearer " + token + ", Bearer " + token):
        assert owner.get("/api/auth/me", headers={"Authorization": authorization}).status_code == 401
    assert owner.get("/api/auth/me", headers=[("Authorization", f"Bearer {token}"), ("Authorization", f"Bearer {token}")]).status_code == 401


def test_key_write_without_csrf_and_no_account_privilege_escalation(owner, monkeypatch):
    token = issue(owner)["api_key"]
    headers = key_headers(token)
    project = owner.post("/api/projects", headers=headers, json={"name": "Key owned project", "objective": "Test ownership"})
    assert project.status_code == 200, project.text
    for method, path, body in (
        ("get", "/api/auth/api-keys", None),
        ("post", "/api/auth/api-keys", {"name": "child", "password": PASSWORD}),
        ("post", "/api/auth/password", {"current_password": PASSWORD, "new_password": "New-password-2026!"}),
        ("get", "/api/admin/accounts", None),
        ("get", "/api/auth/model-credential", None),
    ):
        response = owner.request(method, path, headers=headers, **({"json": body} if body else {}))
        assert response.status_code == 403, (path, response.text)
    assert owner.post("/api/auth/model-credential/internal/resolve", headers=headers).status_code in (403, 503)
    monkeypatch.setattr(settings, "auth_runtime_bridge_token", "test-runtime-bridge-" + "x" * 32)
    monkeypatch.setattr(settings, "llm_api_key", "sk-server-test")
    # Server resolver keeps its additional bridge requirement; browser provenance is stripped.
    with TestClient(app) as native:
        resolved = native.post("/api/auth/model-credential/internal/resolve", headers={
            **key_headers(token), "X-LearnFlow-Runtime-Bridge-Token": settings.auth_runtime_bridge_token,
        })
        assert resolved.status_code == 200, resolved.text


def test_key_reauth_csrf_expiry_and_revocation(owner):
    assert owner.post("/api/auth/api-keys", headers={"X-CSRF-Token": ""}, json={"name": "missing csrf", "password": PASSWORD}).status_code == 403
    assert owner.post("/api/auth/api-keys", json={"name": "wrong password", "password": "incorrect"}).status_code == 403
    for days in (0, 91, 1.5, True):
        assert owner.post("/api/auth/api-keys", json={"name": "invalid expiry", "password": PASSWORD, "expires_in_days": days}).status_code == 422
    created = issue(owner, expires_in_days=90)
    key_id, headers = created["metadata"]["id"], key_headers(created["api_key"])
    for _ in range(2):
        assert owner.delete(f"/api/auth/api-keys/{key_id}").status_code == 200
    assert owner.get("/api/auth/me", headers=headers).status_code == 401
    created = issue(owner)
    async def expire():
        async with async_session() as db:
            await db.execute(update(AuthApiKey).where(AuthApiKey.id == created["metadata"]["id"]).values(expires_at=datetime.utcnow() - timedelta(seconds=1)))
            await db.commit()
    asyncio.run(expire())
    assert owner.get("/api/auth/me", headers=key_headers(created["api_key"])).status_code == 401


def test_key_password_epoch_and_disabled_account(owner):
    created = issue(owner)
    user_id = owner.get("/api/auth/me").json()["id"]
    async def status(value):
        async with async_session() as db:
            await db.execute(update(UserAccount).where(UserAccount.id == user_id).values(status=value))
            await db.commit()
    asyncio.run(status("disabled"))
    assert owner.get("/api/auth/me", headers=key_headers(created["api_key"])).status_code == 401
    asyncio.run(status("active"))
    changed = owner.post("/api/auth/password", json={"current_password": PASSWORD, "new_password": "Changed-api-password-2026!"})
    assert changed.status_code == 200, changed.text
    assert owner.get("/api/auth/me", headers=key_headers(created["api_key"])).status_code == 401
    async def inspect():
        async with async_session() as db:
            key = await db.get(AuthApiKey, created["metadata"]["id"])
            assert key.revoked_reason == "password_changed"
            assert await db.get(AuthApiKeySecret, key.id) is None
    asyncio.run(inspect())


def test_admin_key_identity_bridge_receives_effective_user_role(owner):
    account_id = owner.get("/api/auth/me").json()["id"]
    async def promote():
        async with async_session() as db:
            await db.execute(update(UserAccount).where(UserAccount.id == account_id).values(role="admin"))
            await db.commit()
    asyncio.run(promote())
    token = issue(owner)["api_key"]
    # Role Atlas resolves the same credential through /auth/me and trusts this role.
    native = owner.get("/api/auth/me", headers=key_headers(token))
    assert native.status_code == 200 and native.json()["role"] == "user"
    assert native.json()["id"] == account_id
    assert owner.get("/api/auth/status", headers=key_headers(token)).json()["role"] == "user"
    assert owner.get("/api/admin/accounts", headers=key_headers(token)).status_code == 403
    assert owner.get("/api/auth/me").json()["role"] == "admin"
    assert owner.get("/api/admin/accounts").status_code == 200


def test_foreign_keys_and_projects_remain_inaccessible(owner):
    created = issue(owner)
    project = owner.post("/api/projects", json={"name": "Private", "objective": "Owned"}).json()
    with TestClient(app) as foreign:
        foreign.headers.update(BROWSER)
        suffix = __import__("secrets").token_hex(6)
        registered = foreign.post("/api/auth/register", json={
            "username": "foreign_" + suffix, "password": PASSWORD, "display_name": "Foreign",
            "education_stage": "working", "background": "API", "focus_areas": ["testing"],
            "weekly_hours": 4, "preferred_modes": ["practice"],
        })
        assert registered.status_code == 200
        foreign.headers["X-CSRF-Token"] = foreign.get("/api/auth/csrf").json()["csrf_token"]
        assert foreign.get("/api/auth/api-keys").json() == {"api_keys": []}
        assert foreign.delete(f"/api/auth/api-keys/{created['metadata']['id']}").status_code == 404
        assert foreign.post(f"/api/auth/api-keys/{created['metadata']['id']}/reveal", json={"password": PASSWORD}).status_code == 404
        foreign_key = issue(foreign)["api_key"]
        assert foreign.get(f"/api/projects/{project['id']}", headers=key_headers(foreign_key)).status_code == 404


def test_operator_cli_requires_explicit_account_and_exclusive_secret_file(owner, tmp_path):
    username = owner.get("/api/auth/me").json()["username"]
    script = Path(__file__).resolve().parents[1] / "scripts/manage_api_keys.py"
    output = tmp_path / "desktop-key.json"
    command = [sys.executable, str(script), "--username", username, "create", "--name", "CLI desktop", "--output", str(output)]
    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    secret = json.loads(output.read_text())
    assert secret["api_key"] not in result.stdout + result.stderr
    assert "api_key" not in json.loads(result.stdout)
    assert stat.S_IMODE(output.stat().st_mode) == 0o600
    before = output.read_bytes()
    assert subprocess.run(command, capture_output=True).returncode != 0
    assert output.read_bytes() == before
    assert len(owner.get("/api/auth/api-keys").json()["api_keys"]) == 1
    assert owner.get("/api/auth/me", headers=key_headers(secret["api_key"])).status_code == 200
    wrong_owner = subprocess.run([sys.executable, str(script), "--username", "does-not-exist", "revoke", "--id", str(secret["metadata"]["id"])], capture_output=True)
    assert wrong_owner.returncode != 0
    revoked = subprocess.run([sys.executable, str(script), "--username", username, "revoke", "--id", str(secret["metadata"]["id"])], capture_output=True)
    assert revoked.returncode == 0, revoked.stderr
    assert owner.get("/api/auth/me", headers=key_headers(secret["api_key"])).status_code == 401


def test_repeated_copy_is_encrypted_owner_only_and_password_gated(owner):
    created = issue(owner)
    key_id, token = created["metadata"]["id"], created["api_key"]
    path = f"/api/auth/api-keys/{key_id}/reveal"
    assert created["metadata"]["copy_available"] is True
    async def inspect():
        async with async_session() as db:
            envelope = await db.get(AuthApiKeySecret, key_id)
            assert envelope and token not in envelope.ciphertext
            assert envelope.encryption_version == 1
    asyncio.run(inspect())
    assert owner.post(path, json={"password": "incorrect"}).status_code == 403
    assert owner.get("/api/auth/me").status_code == 200
    assert owner.post(path, headers={"X-CSRF-Token": ""}, json={"password": PASSWORD}).status_code == 403
    assert owner.post(path, headers=key_headers(token), json={"password": PASSWORD}).status_code == 403
    for _ in range(3):
        result = owner.post(path, json={"password": PASSWORD})
        assert result.status_code == 200
        assert result.json()["api_key"] == token
        assert result.headers["cache-control"] == "no-store"
    assert token not in owner.get("/api/auth/api-keys").text
    owner.delete(f"/api/auth/api-keys/{key_id}")
    assert owner.post(path, json={"password": PASSWORD}).status_code == 409
    async def removed():
        async with async_session() as db:
            assert await db.get(AuthApiKeySecret, key_id) is None
    asyncio.run(removed())


def test_copy_legacy_expired_and_foreign_keys(owner):
    created = issue(owner)
    key_id = created["metadata"]["id"]
    async def remove_envelope():
        async with async_session() as db:
            await db.delete(await db.get(AuthApiKeySecret, key_id))
            await db.commit()
    asyncio.run(remove_envelope())
    assert not owner.get("/api/auth/api-keys").json()["api_keys"][0]["copy_available"]
    assert owner.post(f"/api/auth/api-keys/{key_id}/reveal", json={"password": PASSWORD}).status_code == 409
    assert owner.get("/api/auth/me", headers=key_headers(created["api_key"])).status_code == 200
    assert owner.post("/api/auth/api-keys/999999/reveal", json={"password": PASSWORD}).status_code == 404


def test_copy_fails_closed_for_missing_wrong_kek_or_tampered_envelope(owner, monkeypatch):
    created = issue(owner)
    key_id = created["metadata"]["id"]
    path = f"/api/auth/api-keys/{key_id}/reveal"
    original = settings.auth_api_key_kek
    for value in ("", base64.urlsafe_b64encode(b"x" * 32).decode()):
        monkeypatch.setattr(settings, "auth_api_key_kek", value)
        assert owner.post(path, json={"password": PASSWORD}).status_code == 503
        assert owner.get("/api/auth/me", headers=key_headers(created["api_key"])).status_code == 200
    monkeypatch.setattr(settings, "auth_api_key_kek", "")
    before = len(owner.get("/api/auth/api-keys").json()["api_keys"])
    assert owner.post("/api/auth/api-keys", json={"name": "no encryption", "password": PASSWORD}).status_code == 503
    assert len(owner.get("/api/auth/api-keys").json()["api_keys"]) == before
    monkeypatch.setattr(settings, "auth_api_key_kek", original)
    another = issue(owner)
    async def swap():
        async with async_session() as db:
            envelope = await db.get(AuthApiKeySecret, key_id)
            other = await db.get(AuthApiKeySecret, another["metadata"]["id"])
            envelope.ciphertext = other.ciphertext
            await db.commit()
    asyncio.run(swap())
    assert owner.post(path, json={"password": PASSWORD}).status_code == 503


def test_key_validation_never_echoes_password(owner):
    secret_password = "sensitive-invalid-input-" * 20
    for path, body in (("/api/auth/api-keys", {"name": "test", "password": secret_password}),
                       ("/api/auth/api-keys/1/reveal", {"password": secret_password})):
        response = owner.post(path, json=body)
        assert response.status_code == 422
        assert secret_password not in response.text
        assert "sensitive-invalid-input" not in response.text
        assert response.headers["cache-control"] == "no-store"
