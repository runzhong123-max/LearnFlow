import asyncio
import base64
import hashlib
import hmac
import json
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.config import settings
from app.db.database import async_session
from app.main import app
from app.models.learning import AgentMessage, EvidenceEvent
from app.services.role_package_launch import RolePackageLaunchError, verify_role_package_launch


SECRET = "shared-role-package-launch-secret-32-bytes"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        accounts = test_client.get("/api/dev/accounts")
        assert accounts.status_code == 200
        legacy = next(item for item in accounts.json() if item["username"] == "legacy-demo")
        assert test_client.post(f"/api/dev/accounts/{legacy['id']}/login").status_code == 200
        csrf = test_client.get("/api/auth/csrf")
        test_client.headers["x-csrf-token"] = csrf.json()["csrf_token"]
        yield test_client


def token_for(*, subject: str, launch_id: str = "launch-test", issued_at: int | None = None, expires_at: int | None = None):
    issued_at = int(time.time()) if issued_at is None else issued_at
    expires_at = issued_at + 300 if expires_at is None else expires_at
    payload = {
        "protocol": "role-package-launch.v1",
        "launchId": launch_id,
        "subject": subject,
        "issuedAt": issued_at,
        "expiresAt": expires_at,
        "source": "graph_hub",
        "roleTitle": "网络运维工程师",
        "packageRef": {
            "packageId": "role.network-ops",
            "packageVersion": "1.0.0",
            "snapshotId": "snapshot:network-ops",
            "rootHash": "a" * 64,
        },
    }
    body = base64.urlsafe_b64encode(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()).rstrip(b"=").decode()
    signature = base64.urlsafe_b64encode(hmac.new(SECRET.encode(), body.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
    return f"{body}.{signature}"


def test_launch_token_rejects_tampering_and_expiration():
    token = token_for(subject="learnflow:learner:1", issued_at=1_700_000_000, expires_at=1_700_000_060)
    assert verify_role_package_launch(token, SECRET, now=1_700_000_010)["launchId"] == "launch-test"
    with pytest.raises(RolePackageLaunchError):
        verify_role_package_launch(f"{token[:-1]}x", SECRET, now=1_700_000_010)
    with pytest.raises(RolePackageLaunchError):
        verify_role_package_launch(token, SECRET, now=1_700_000_061)


def test_signed_launch_creates_one_plugin_bound_chat_without_learning_evidence(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "role_package_launch_secret", SECRET)
    learner_id = client.get("/api/auth/me").json()["learner_id"]
    token = token_for(subject=f"learnflow:learner:{learner_id}")
    payload = {"token": token, "client_conversation_id": "chat-role-launch-test"}
    created = client.post("/api/agent/role-package-launches/consume", json=payload)
    replay = client.post("/api/agent/role-package-launches/consume", json=payload)
    assert created.status_code == replay.status_code == 200
    assert created.json()["id"] == replay.json()["id"]
    assert created.json()["plugin_ids"] == ["role_capability_graph"]
    assert created.json()["role_package_binding"]["package_ref"]["rootHash"] == "a" * 64
    tool_run = created.json()["messages"][0]["meta_data"]["vnext"]["toolRuns"][0]
    assert tool_run["plugin"]["result"]["payload"]["requiredSelector"] == {
        "packageId": "role.network-ops",
        "packageVersion": "1.0.0",
        "snapshotId": "snapshot:network-ops",
    }

    async def stored_counts():
        async with async_session() as db:
            messages = list((await db.execute(select(AgentMessage).where(
                AgentMessage.session_id == created.json()["id"],
            ))).scalars())
            events = list((await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.session_id == created.json()["id"],
            ))).scalars())
            return len(messages), len(events)

    assert asyncio.run(stored_counts()) == (1, 0)


def test_signed_launch_is_bound_to_current_learner(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "role_package_launch_secret", SECRET)
    response = client.post("/api/agent/role-package-launches/consume", json={
        "token": token_for(subject="learnflow:learner:999999", launch_id="wrong-owner"),
        "client_conversation_id": "chat-wrong-owner",
    })
    assert response.status_code == 403
