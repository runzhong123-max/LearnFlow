import asyncio
import base64
from copy import deepcopy
import hashlib
import hmac
import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from app.api.ecosystem import router
from app.core.config import settings
from app.db.database import Base, get_db
from app.models import learning, project, ecosystem  # noqa: F401
from app.models.learning import Learner, EvidenceEvent, KernelMutation
from app.models.ecosystem import CurriculumCommit, CurriculumGraphHead
from app.services.auth import get_current_learner
from app.services import ecosystem_gateway as gw, curriculum_catalog as catalog

REF = {"packageId": "test-role", "packageVersion": "1", "snapshotId": "snapshot-1", "rootHash": "a" * 64}


def current(learner_id=1):
    return SimpleNamespace(learner=SimpleNamespace(id=learner_id), account=SimpleNamespace(role="user"))


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setattr(settings, "role_atlas_gateway_base_url", "https://roles.example")
    monkeypatch.setattr(settings, "role_atlas_gateway_secret", "test-server-secret-" * 3)
    monkeypatch.setattr(settings, "desktop_mode", False)


def transport(monkeypatch, handler):
    original = httpx.AsyncClient
    def factory(**kwargs):
        assert kwargs["follow_redirects"] is False
        assert kwargs["trust_env"] is False
        return original(**kwargs, transport=httpx.MockTransport(handler))
    monkeypatch.setattr(gw.httpx, "AsyncClient", factory)


def test_signed_fixed_destination_without_browser_credentials(configured, monkeypatch):
    def handler(request):
        assert str(request.url) == "https://roles.example/api/integrations/learnflow/gateway"
        assert "cookie" not in request.headers and "authorization" not in request.headers
        assert "x-learnflow-desktop-token" not in request.headers
        segment, signature = request.headers["X-LearnFlow-Delegation"].split(".")
        assert hmac.compare_digest(signature, hmac.new(settings.role_atlas_gateway_secret.encode(), segment.encode(), hashlib.sha256).hexdigest())
        claims = json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))
        assert claims["sub"] == "learnflow:learner:7"
        assert claims["exp"] - claims["iat"] == 60
        assert claims["bodyHash"] == hashlib.sha256(request.content).hexdigest()
        assert claims["requestId"] == "request-1"
        return httpx.Response(200, json={"protocol": gw.PROTOCOL, "requestId": "request-1", "ok": True, "data": {"items": []}})
    transport(monkeypatch, handler)
    assert asyncio.run(gw.dispatch(current(7), "catalog.search", "request-1", {"query": "运维"})) == {"items": []}


@pytest.mark.parametrize("url", ["http://roles.example", "https://roles.example/path", "https://user:pass@roles.example", "https://roles.example?url=x", "https://roles.example:bad"])
def test_unsafe_configuration_rejected(configured, monkeypatch, url):
    monkeypatch.setattr(settings, "role_atlas_gateway_base_url", url)
    with pytest.raises(gw.GatewayError) as error:
        gw.gateway_url()
    assert error.value.status == 503


def test_sidecar_never_uses_shared_secret(configured, monkeypatch):
    monkeypatch.setattr(settings, "desktop_mode", True)
    with pytest.raises(gw.GatewayError) as error:
        gw.gateway_url()
    assert error.value.code == "gateway_unavailable"


@pytest.mark.parametrize("mode,code,status", [("timeout", "upstream_timeout", 504), ("redirect", "upstream_redirect", 502), ("oversize", "upstream_too_large", 502), ("wrong_id", "invalid_upstream_response", 502), ("private", "package_unavailable", 404), ("offline", "upstream_unavailable", 503)])
def test_remote_failures_are_explicit_and_redacted(configured, monkeypatch, mode, code, status):
    def handler(request):
        if mode == "timeout":
            raise httpx.ReadTimeout("SECRET UPSTREAM DIAGNOSTIC")
        if mode == "offline":
            raise httpx.ConnectError("SECRET UPSTREAM DIAGNOSTIC")
        if mode == "redirect":
            return httpx.Response(302, headers={"Location": "https://evil.example"})
        if mode == "oversize":
            return httpx.Response(200, content=b"x" * (gw.MAX_BYTES + 1))
        return httpx.Response(403 if mode == "private" else 200, json={"protocol": gw.PROTOCOL, "requestId": "request-1" if mode == "private" else "wrong", "ok": mode != "private", "error": {"message": "SECRET UPSTREAM DIAGNOSTIC"}})
    transport(monkeypatch, handler)
    with pytest.raises(gw.GatewayError) as error:
        asyncio.run(gw.dispatch(current(), "package.resolve", "request-1", {"packageRef": REF}))
    assert (error.value.code, error.value.status) == (code, status)
    assert "SECRET" not in str(error.value)


def test_api_requires_auth_and_rejects_internal_operations(configured):
    app = FastAPI()
    app.include_router(router, prefix="/api")
    with TestClient(app) as client:
        response = client.get("/api/ecosystem/capabilities")
        assert response.status_code == 401
        assert response.json()["ok"] is False
        assert response.headers["cache-control"] == "no-store"
        app.dependency_overrides[get_current_learner] = lambda: current()
        response = client.post("/api/ecosystem/dispatch", json={"protocol": gw.PROTOCOL, "requestId": "r1", "operation": "learning.resolve", "payload": {}})
        assert response.status_code == 400
        assert response.json()["requestId"] == "r1"
        response = client.post("/api/ecosystem/learning-path/resolve", json={"requestId": "r2", "packageRef": REF, "namespace": "evil"})
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "invalid_request"


async def database(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'catalog.db'}", connect_args={"timeout": 15})
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as db:
        db.add_all([Learner(id=1, key="test-one"), Learner(id=2, key="test-two")])
        await db.commit()
    return engine, sessions


def resolver(extension=False):
    async def fake(current, operation, request_id, payload):
        if operation == "package.resolve":
            return {"packageRef": REF}
        if operation == "learning.resolve":
            graph = payload["graph"]
            result = {"protocol": "role-learning-resolution/v2", "packageRef": REF, "graphRef": catalog.graph_ref(graph), "namespace": payload["namespace"],
                      "alignment": {"protocolVersion": "learnflow-role-learning-alignment/v2", "packageRef": REF, "graphRef": catalog.graph_ref(graph), "bindings": []}, "pendingBindings": [], "unresolved": []}
            if extension:
                result["extensionProposal"] = {"protocolVersion": "learnflow-graph-extension-proposal/v2", "idempotencyKey": request_id, "baseGraphRef": catalog.graph_ref(graph), "packageRef": REF,
                                               "namespace": payload["namespace"], "sources": [], "nodes": [{"id": "skill-x", "namespace": payload["namespace"]}], "edges": []}
                result["pendingBindings"] = [{"id": "b-x", "target": {"id": "skill-x", "namespace": payload["namespace"], "revision": 1}}]
            return result
        if operation == "learning.validate_extension":
            merged = deepcopy(payload["graph"])
            for key in ("sources", "nodes", "edges"):
                merged[key] += payload["proposal"][key]
            return {"graph": merged, "proposal": payload["proposal"]}
        if operation == "learning.validate_alignment":
            return {"alignment": payload["alignment"]}
        raise AssertionError(operation)
    return fake


@pytest.mark.parametrize("extension", [False, True])
def test_catalog_owner_isolation_idempotency_stale_and_zero_kernel(tmp_path, monkeypatch, extension):
    monkeypatch.setattr(gw, "dispatch", resolver(extension))
    async def run():
        engine, sessions = await database(tmp_path)
        try:
            async with sessions() as db:
                a = await catalog.resolve(db, current(), "resolve-a", REF, None)
                b = await catalog.resolve(db, current(), "resolve-b", REF, None)
                assert (await catalog.resolve(db, current(), "resolve-a", REF, None))["resolutionId"] == a["resolutionId"]
                with pytest.raises(gw.GatewayError) as error:
                    await catalog.resolve(db, current(), "resolve-a", REF, ["changed"])
                assert error.value.code == "idempotency_conflict"
                with pytest.raises(gw.GatewayError) as error:
                    await catalog.commit(db, current(2), "commit-a", a["resolutionId"])
                assert error.value.status == 404
                receipt = await catalog.commit(db, current(), "commit-a", a["resolutionId"])
                assert receipt == await catalog.commit(db, current(), "commit-a", a["resolutionId"])
                assert receipt["masteryUnchanged"] is True
                assert receipt["alignment"]["graphRef"] == receipt["graphRef"]
                assert receipt["addedNodeIds"] == (["skill-x"] if extension else [])
                assert len(receipt["alignment"]["bindings"]) == (1 if extension else 0)
                with pytest.raises(gw.GatewayError) as error:
                    await catalog.commit(db, current(), "commit-a", b["resolutionId"])
                assert error.value.code == "idempotency_conflict"
                with pytest.raises(gw.GatewayError) as error:
                    await catalog.commit(db, current(), "commit-b", b["resolutionId"])
                assert error.value.code == "stale_graph"
                assert (await catalog.read_graph(db, current(2)))["revision"] == catalog.official_graph()["revision"]
                assert (await db.execute(select(func.count()).select_from(CurriculumCommit))).scalar() == 1
                assert (await db.execute(select(func.count()).select_from(KernelMutation))).scalar() == 0
                event = (await db.execute(select(EvidenceEvent))).scalar_one()
                assert event.event_type == "learning_path_extension_committed"
                assert event.payload["mastery_unchanged"] is True
        finally:
            await engine.dispose()
    asyncio.run(run())


def test_concurrent_commits_one_wins_and_audit_atomic(tmp_path, monkeypatch):
    fake = resolver()
    async def run():
        engine, sessions = await database(tmp_path)
        try:
            monkeypatch.setattr(gw, "dispatch", fake)
            async with sessions() as db:
                a = await catalog.resolve(db, current(), "resolve-a", REF, None)
                b = await catalog.resolve(db, current(), "resolve-b", REF, None)
            barrier = asyncio.Event()
            entered = 0
            async def gated(*args):
                nonlocal entered
                if args[1] == "learning.validate_alignment":
                    entered += 1
                    if entered == 2:
                        barrier.set()
                    await asyncio.wait_for(barrier.wait(), timeout=5)
                return await fake(*args)
            monkeypatch.setattr(gw, "dispatch", gated)
            async def attempt(resolution, key):
                async with sessions() as db:
                    try:
                        return await catalog.commit(db, current(), key, resolution["resolutionId"])
                    except gw.GatewayError as error:
                        return error
            results = await asyncio.gather(attempt(a, "commit-a"), attempt(b, "commit-b"))
            assert sum(isinstance(result, dict) for result in results) == 1
            assert next(result for result in results if isinstance(result, gw.GatewayError)).status == 409
            async with sessions() as db:
                assert (await db.execute(select(func.count()).select_from(CurriculumCommit))).scalar() == 1
                assert (await db.execute(select(func.count()).select_from(EvidenceEvent))).scalar() == 1
        finally:
            await engine.dispose()
    asyncio.run(run())


def test_commit_rechecks_visibility_and_rolls_back_validation_failure(tmp_path, monkeypatch):
    async def run():
        engine, sessions = await database(tmp_path)
        try:
            monkeypatch.setattr(gw, "dispatch", resolver(True))
            async with sessions() as db:
                preview = await catalog.resolve(db, current(), "resolve-a", REF, None)
                async def denied(*args):
                    raise gw.GatewayError("package_unavailable", "不可用", 404)
                monkeypatch.setattr(gw, "dispatch", denied)
                with pytest.raises(gw.GatewayError):
                    await catalog.commit(db, current(), "commit-a", preview["resolutionId"])
                assert (await db.execute(select(func.count()).select_from(CurriculumCommit))).scalar() == 0
                assert (await db.get(CurriculumGraphHead, 1)).revision == catalog.official_graph()["revision"]
                assert (await db.execute(select(func.count()).select_from(EvidenceEvent))).scalar() == 0
        finally:
            await engine.dispose()
    asyncio.run(run())


def test_remote_validator_cannot_replace_official_source(tmp_path, monkeypatch):
    async def run():
        engine, sessions = await database(tmp_path)
        fake = resolver(True)
        try:
            monkeypatch.setattr(gw, "dispatch", fake)
            async with sessions() as db:
                preview = await catalog.resolve(db, current(), "resolve-a", REF, None)
                async def tamper(*args):
                    response = await fake(*args)
                    if args[1] == "learning.validate_extension":
                        response["graph"]["nodes"][0]["title"] = "silently replaced"
                    return response
                monkeypatch.setattr(gw, "dispatch", tamper)
                with pytest.raises(gw.GatewayError) as error:
                    await catalog.commit(db, current(), "commit-a", preview["resolutionId"])
                assert error.value.code == "invalid_validation_result"
                assert (await db.execute(select(func.count()).select_from(CurriculumCommit))).scalar() == 0
                assert (await db.get(CurriculumGraphHead, 1)).revision == catalog.official_graph()["revision"]
        finally:
            await engine.dispose()
    asyncio.run(run())


def test_event_failure_rolls_back_graph_receipt_and_audit(tmp_path, monkeypatch):
    async def run():
        engine, sessions = await database(tmp_path)
        try:
            monkeypatch.setattr(gw, "dispatch", resolver())
            async with sessions() as db:
                preview = await catalog.resolve(db, current(), "resolve-a", REF, None)
                async def broken_event(*args, **kwargs):
                    raise RuntimeError("audit transaction failed")
                monkeypatch.setattr(catalog, "record_event", broken_event)
                with pytest.raises(RuntimeError):
                    await catalog.commit(db, current(), "commit-a", preview["resolutionId"])
                assert (await db.get(CurriculumGraphHead, 1)).revision == catalog.official_graph()["revision"]
                assert (await db.execute(select(func.count()).select_from(CurriculumCommit))).scalar() == 0
        finally:
            await engine.dispose()
    asyncio.run(run())


def test_real_browser_middleware_rejects_cross_origin_ecosystem_write():
    from app.main import app
    with TestClient(app) as client:
        response = client.post("/api/ecosystem/dispatch", headers={"Origin": "https://evil.example"}, json={"protocol": gw.PROTOCOL, "requestId": "csrf-test", "operation": "catalog.search", "payload": {}})
        assert response.status_code == 403
        assert response.json()["ok"] is False
        assert response.json()["error"]["code"] == "request_denied"
        assert response.headers["Cache-Control"] == "no-store"
