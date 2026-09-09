import asyncio
import base64
from copy import deepcopy
import hashlib
import hmac
import json
import time

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.ecosystem import router
from app.core.config import settings
from app.db.database import Base, get_db
from app.models import project  # noqa: F401
from app.models.ecosystem import CurriculumAutomaticOperation, CurriculumCommit, CurriculumResolution
from app.models.learning import EvidenceEvent, KernelMutation, Learner, LearnerProfile, UserAccount
from app.services.auth import load_current_learner
from app.services import curriculum_catalog as catalog, ecosystem_gateway as gw, role_learning_automatic as auto

REF = {"packageId": "role:test", "packageVersion": "1", "snapshotId": "snapshot:test", "rootHash": "a" * 64}
BODY = {"requestId": "production:one", "packageRef": REF, "projectId": "project:one",
        "projectVersionId": "version:one", "sourceRunId": "run:one", "policyVersion": auto.POLICY_VERSION}


@pytest.fixture(autouse=True)
def configuration(monkeypatch):
    monkeypatch.setattr(settings, "role_atlas_gateway_secret", "automount-test-secret-" * 3)
    monkeypatch.setattr(settings, "desktop_mode", False)


def token(body, *, claims=None, raw_claims=None):
    value = {"v": 1, "iss": "role-atlas", "aud": "learnflow-curriculum", "sub": "learnflow:learner:1",
             "iat": int(time.time()), "exp": int(time.time()) + 60,
             "requestId": BODY["requestId"], "bodyHash": hashlib.sha256(body).hexdigest()}
    value.update(claims or {})
    encoded = base64.urlsafe_b64encode(raw_claims or gw.canonical_bytes(value)).decode().rstrip("=")
    return encoded + "." + hmac.new(settings.role_atlas_gateway_secret.encode(), encoded.encode(), hashlib.sha256).hexdigest()


@pytest.mark.parametrize("change", [
    {"iss": "learnflow"}, {"aud": "role-atlas"}, {"v": True}, {"role": "admin"},
    {"exp": 999}, {"exp": 1061}, {"iat": 1010},
    {"iat": True}, {"sub": "learnflow:learner:01"}, {"sub": "learnflow:learner:0"},
    {"sub": "learnflow:learner:9999999999999999999"}, {"sub": "role:user:1"}, {"requestId": "other"},
    {"bodyHash": "0" * 64},
])
def test_reverse_delegation_rejects_invalid_claims(change):
    raw = gw.canonical_bytes(BODY)
    with pytest.raises(gw.GatewayError) as error:
        auto.delegated_subject(token(raw, claims={"iat": 1000, "exp": 1060, **change}), raw, BODY["requestId"], now=1000)
    assert error.value.code == "delegation_denied"


def test_delegation_binds_bytes_and_does_not_accept_duplicate_claims_or_other_secret(monkeypatch):
    raw = gw.canonical_bytes(BODY)
    signed = token(raw)
    assert auto.delegated_subject(signed, raw, BODY["requestId"]) == 1
    for bad, payload in [(signed, raw + b" "), (signed[:-1] + ("0" if signed[-1] != "0" else "1"), raw),
                         (token(raw, raw_claims=b'{"v":1,"v":1}'), raw)]:
        with pytest.raises(gw.GatewayError):
            auto.delegated_subject(bad, payload, BODY["requestId"])
    monkeypatch.setattr(settings, "desktop_mode", True)
    with pytest.raises(gw.GatewayError) as error:
        auto.delegated_subject(signed, raw, BODY["requestId"])
    assert error.value.code == "gateway_unavailable"


async def database(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'automatic.db'}", connect_args={"timeout": 15})
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as db:
        for identifier in (1, 2):
            db.add(UserAccount(id=identifier, username=f"user{identifier}", username_normalized=f"user{identifier}", account_number=identifier))
            db.add(Learner(id=identifier, user_id=identifier, key=f"learner-{identifier}"))
            db.add(LearnerProfile(learner_id=identifier))
        await db.commit()
    return engine, sessions


def gateway_fixture(count=1, unresolved_ids=()):
    calls = []
    nodes = [{"id": f"point:{i:03}", "type": "knowledge_skill"} for i in range(count)]
    async def fake(current, operation, request_id, payload):
        calls.append((operation, request_id, deepcopy(payload)))
        if operation == "package.resolve":
            if current.learner.id != 1:
                raise gw.GatewayError("package_unavailable", "private", 404)
            return {"packageRef": REF, "result": {"semantic": {"nodes": nodes}}}
        if operation == "learning.resolve":
            assert payload.get("allowStandaloneRoots") is True
            assert 0 < len(payload["targetIds"]) <= 25
            graph, namespace = payload["graph"], payload["namespace"]
            result = {"protocol": "role-learning-resolution/v2", "packageRef": REF,
                      "graphRef": catalog.graph_ref(graph), "namespace": namespace,
                      "alignment": {"protocolVersion": "learnflow-role-learning-alignment/v2", "packageRef": REF,
                                    "graphRef": catalog.graph_ref(graph), "bindings": []},
                      "pendingBindings": [], "unresolved": []}
            added = []
            for node_id in payload["targetIds"]:
                if node_id in unresolved_ids:
                    result["unresolved"].append({"roleNodeId": node_id, "reason": "needs_evidence", "candidates": []})
                    continue
                target = {"namespace": namespace, "id": node_id, "revision": 1}
                binding = {"id": "binding:" + node_id, "roleNodeId": node_id, "target": target}
                if any(n["id"] == node_id and n["namespace"] == namespace for n in graph["nodes"]):
                    result["alignment"]["bindings"].append(binding)
                else:
                    added.append(target)
                    result["pendingBindings"].append(binding)
            if added:
                result["extensionProposal"] = {"namespace": namespace, "packageRef": REF,
                                                "baseGraphRef": catalog.graph_ref(graph), "nodes": added, "edges": [], "sources": []}
            return result
        if operation == "learning.validate_extension":
            graph = deepcopy(payload["graph"])
            for key in ("nodes", "edges", "sources"):
                graph[key] += payload["proposal"][key]
            return {"graph": graph, "proposal": payload["proposal"]}
        if operation == "learning.validate_alignment":
            return {"alignment": payload["alignment"]}
        raise AssertionError(operation)
    return fake, calls


def test_api_real_account_signature_owner_and_browser_boundary(tmp_path, monkeypatch):
    fake, calls = gateway_fixture()
    monkeypatch.setattr(gw, "dispatch", fake)
    async def run():
        engine, sessions = await database(tmp_path)
        app = FastAPI()
        app.include_router(router, prefix="/api")
        async def db_override():
            async with sessions() as db:
                yield db
        app.dependency_overrides[get_db] = db_override
        try:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
                raw = gw.canonical_bytes(BODY)
                headers = {"Content-Type": "application/json", "X-Role-Atlas-Delegation": token(raw)}
                url = "/api/ecosystem/learning-path/automatic"
                assert (await client.post(url, content=raw, headers={"Content-Type": "application/json"})).status_code == 403
                for browser in ({"Cookie": "a=b"}, {"Origin": "https://learnflow.club"}, {"Authorization": "Bearer x"}, {"Sec-Fetch-Site": "same-origin"}):
                    assert (await client.post(url, content=raw, headers={**headers, **browser})).status_code == 403
                response = await client.post(url, content=raw, headers=headers)
                assert response.status_code == 200
                data = response.json()["data"]
                assert data["status"] == "completed" and data["points"][0]["status"] == "created"
                assert response.headers["cache-control"] == "no-store"
                for sub, expected in [("learnflow:learner:2", 404), ("learnflow:learner:3", 403)]:
                    response = await client.post(url, content=raw, headers={**headers, "X-Role-Atlas-Delegation": token(raw, claims={"sub": sub})})
                    assert response.status_code == expected
                async with sessions() as db:
                    await db.execute(update(UserAccount).where(UserAccount.id == 1).values(status="disabled"))
                    await db.commit()
                assert (await client.post(url, content=raw, headers=headers)).status_code == 403
                for extra in ({"namespace": "evil"}, {"graph": {}}, {"targetIds": ["x"]}, {"policyVersion": "other"}):
                    content = gw.canonical_bytes({**BODY, **extra})
                    response = await client.post(url, content=content, headers={**headers, "X-Role-Atlas-Delegation": token(content)})
                    assert response.status_code == 422
        finally:
            await engine.dispose()
    asyncio.run(run())


def test_batches_all_points_replay_and_zero_kernel(tmp_path, monkeypatch):
    fake, calls = gateway_fixture(161, {"point:005"})
    monkeypatch.setattr(gw, "dispatch", fake)
    async def run():
        engine, sessions = await database(tmp_path)
        try:
            async with sessions() as db:
                current = await load_current_learner(db, 1)
                response = await auto.automatic_mount(db, current, BODY)
                assert response["status"] == "partial"
                assert len(response["points"]) == 161 and len(response["receipts"]) == 7
                assert len(response["unresolved"]) == 1 and response["masteryUnchanged"] is True
                before = len([call for call in calls if call[0] == "learning.resolve"])
                assert response == await auto.automatic_mount(db, current, BODY)
                assert before == len([call for call in calls if call[0] == "learning.resolve"])
                alias = {**BODY, "requestId": "different:delivery"}
                assert response == await auto.automatic_mount(db, current, alias)
                assert (await db.execute(select(func.count()).select_from(CurriculumCommit))).scalar() == 7
                events = list((await db.execute(select(EvidenceEvent))).scalars())
                assert len(events) == 7
                assert all(event.actor_type == "system" and event.payload["production_context"]["policyVersion"] == auto.POLICY_VERSION for event in events)
                assert all(event.provenance["authorization"] == "role_production_start" for event in events)
                assert (await db.execute(select(func.count()).select_from(KernelMutation))).scalar() == 0
                with pytest.raises(gw.GatewayError) as error:
                    await auto.automatic_mount(db, current, {**BODY, "sourceRunId": "changed"})
                assert error.value.code == "idempotency_conflict"
                async def denied(*args):
                    raise gw.GatewayError("package_unavailable", "private revoked", 404)
                monkeypatch.setattr(gw, "dispatch", denied)
                with pytest.raises(gw.GatewayError):
                    await auto.automatic_mount(db, current, BODY)
        finally:
            await engine.dispose()
    asyncio.run(run())


@pytest.mark.parametrize("count", [0, 1])
def test_unresolved_only_never_commits(tmp_path, monkeypatch, count):
    fake, calls = gateway_fixture(count, {"point:000"})
    monkeypatch.setattr(gw, "dispatch", fake)
    async def run():
        engine, sessions = await database(tmp_path)
        try:
            async with sessions() as db:
                response = await auto.automatic_mount(db, await load_current_learner(db, 1), BODY)
                assert response["status"] == "needs_research" and response["receipts"] == []
                assert (await db.execute(select(func.count()).select_from(CurriculumCommit))).scalar() == 0
                assert (await db.execute(select(func.count()).select_from(EvidenceEvent))).scalar() == 0
        finally:
            await engine.dispose()
    asyncio.run(run())


def test_resume_after_commit_response_loss_and_new_identity_reuses_nodes(tmp_path, monkeypatch):
    fake, calls = gateway_fixture()
    monkeypatch.setattr(gw, "dispatch", fake)
    original = catalog.commit
    async def lost(*args, **kwargs):
        await original(*args, **kwargs)
        raise RuntimeError("connection lost after committed")
    async def run():
        engine, sessions = await database(tmp_path)
        try:
            async with sessions() as db:
                current = await load_current_learner(db, 1)
                monkeypatch.setattr(catalog, "commit", lost)
                with pytest.raises(RuntimeError):
                    await auto.automatic_mount(db, current, BODY)
            monkeypatch.setattr(catalog, "commit", original)
            async with sessions() as db:
                current = await load_current_learner(db, 1)
                response = await auto.automatic_mount(db, current, BODY)
                assert response["points"][0]["status"] == "created"
                assert (await db.execute(select(func.count()).select_from(CurriculumCommit))).scalar() == 1
                new = {**BODY, "requestId": "next", "sourceRunId": "next", "projectVersionId": "next"}
                response = await auto.automatic_mount(db, current, new)
                assert response["points"][0]["status"] == "existing"
                assert response["receipts"][0]["addedNodeIds"] == []
        finally:
            await engine.dispose()
    asyncio.run(run())


def test_cas_re_resolves_with_new_key(tmp_path, monkeypatch):
    fake, calls = gateway_fixture()
    monkeypatch.setattr(gw, "dispatch", fake)
    original = catalog.commit
    first = True
    async def conflict(db, current, request_id, resolution_id, **kwargs):
        nonlocal first
        if first:
            first = False
            other = await catalog.resolve(db, current, "other:resolve", REF, ["point:000"], automatic=True)
            await original(db, current, "other:commit", other["resolutionId"])
        return await original(db, current, request_id, resolution_id, **kwargs)
    monkeypatch.setattr(catalog, "commit", conflict)
    async def run():
        engine, sessions = await database(tmp_path)
        try:
            async with sessions() as db:
                response = await auto.automatic_mount(db, await load_current_learner(db, 1), BODY)
                assert response["status"] == "completed"
                assert response["points"][0]["status"] == "existing"
                keys = [call[1] for call in calls if call[0] == "learning.resolve" and call[1].startswith("role-auto:")]
                assert len(keys) == 2 and keys[0] != keys[1] and all(key.endswith(":resolve") for key in keys)
                assert (await db.execute(select(func.count()).select_from(KernelMutation))).scalar() == 0
        finally:
            await engine.dispose()
    asyncio.run(run())


def test_manual_and_automatic_resolution_keys_cannot_mix(tmp_path, monkeypatch):
    fake, calls = gateway_fixture()
    monkeypatch.setattr(gw, "dispatch", fake)
    async def run():
        engine, sessions = await database(tmp_path)
        try:
            async with sessions() as db:
                current = await load_current_learner(db, 1)
                await catalog.resolve(db, current, "key", REF, ["point:000"], automatic=True)
                with pytest.raises(gw.GatewayError) as error:
                    await catalog.resolve(db, current, "key", REF, ["point:000"])
                assert error.value.code == "idempotency_conflict"
        finally:
            await engine.dispose()
    asyncio.run(run())


def test_concurrent_deliveries_produce_one_source_revision(tmp_path, monkeypatch):
    fake, calls = gateway_fixture()
    barrier, arrived = None, 0
    async def concurrent(current, operation, request_id, payload):
        nonlocal arrived
        if operation == "learning.resolve":
            arrived += 1
            if arrived == 2:
                barrier.set()
            await asyncio.wait_for(barrier.wait(), timeout=10)
        return await fake(current, operation, request_id, payload)
    monkeypatch.setattr(gw, "dispatch", concurrent)
    async def run():
        nonlocal barrier
        barrier = asyncio.Event()
        engine, sessions = await database(tmp_path)
        try:
            async def call():
                async with sessions() as db:
                    return await auto.automatic_mount(db, await load_current_learner(db, 1), BODY)
            results = await asyncio.gather(call(), call())
            assert results[0] == results[1] and results[0]["status"] == "completed"
            async with sessions() as db:
                assert (await db.execute(select(func.count()).select_from(CurriculumAutomaticOperation))).scalar() == 1
                assert (await db.execute(select(func.count()).select_from(CurriculumCommit))).scalar() == 1
                assert (await db.execute(select(func.count()).select_from(EvidenceEvent))).scalar() == 1
                assert (await db.execute(select(func.count()).select_from(KernelMutation))).scalar() == 0
        finally:
            await engine.dispose()
    asyncio.run(run())


def test_real_middleware_accepts_only_signed_server_request(tmp_path, monkeypatch):
    from app.main import app
    fake, calls = gateway_fixture()
    monkeypatch.setattr(gw, "dispatch", fake)
    async def run():
        engine, sessions = await database(tmp_path)
        async def db_override():
            async with sessions() as db:
                yield db
        app.dependency_overrides[get_db] = db_override
        try:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://learnflow.test") as client:
                raw = gw.canonical_bytes(BODY)
                headers = {"Content-Type": "application/json", "X-Role-Atlas-Delegation": token(raw)}
                url = "/api/ecosystem/learning-path/automatic"
                good = await client.post(url, content=raw, headers=headers)
                assert good.status_code == 200 and good.json()["data"]["status"] == "completed"
                blocked = await client.post(url, content=raw, headers={**headers, "Origin": "https://evil.test"})
                assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "request_denied"
                unsigned = await client.post(url, content=raw, headers={"Content-Type": "application/json"})
                assert unsigned.status_code == 403
        finally:
            app.dependency_overrides.pop(get_db, None)
            await engine.dispose()
    asyncio.run(run())


def test_contradictory_resolution_is_rejected_before_write(tmp_path, monkeypatch):
    fake, calls = gateway_fixture()
    async def broken(*args):
        result = await fake(*args)
        if args[1] == "learning.resolve":
            result["unresolved"] = [{"roleNodeId": "point:000", "reason": "needs_evidence", "candidates": []}]
        return result
    monkeypatch.setattr(gw, "dispatch", broken)
    async def run():
        engine, sessions = await database(tmp_path)
        try:
            async with sessions() as db:
                with pytest.raises(gw.GatewayError) as error:
                    await auto.automatic_mount(db, await load_current_learner(db, 1), BODY)
                assert error.value.code == "invalid_resolution"
                assert (await db.execute(select(func.count()).select_from(CurriculumCommit))).scalar() == 0
                assert (await db.execute(select(func.count()).select_from(EvidenceEvent))).scalar() == 0
        finally:
            await engine.dispose()
    asyncio.run(run())
