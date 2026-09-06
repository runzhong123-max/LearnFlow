from contextlib import asynccontextmanager
from pathlib import Path
import asyncio

from fastapi.testclient import TestClient
import pytest

from app.main import app, lifespan
from app.core.config import settings, DEFAULT_ENV_PATH
from learnflow_core.api import platform, health
from learnflow_core.worker_host import worker_lease


def test_platform_manifest_does_not_claim_offline_sync(monkeypatch):
    monkeypatch.setattr(settings, "desktop_mode", False)
    monkeypatch.setattr(settings, "memory_worker_embedded", False)
    response = TestClient(app).get("/api/platform")
    assert response.status_code == 200
    data = response.json()
    assert data["host"] == "learning_platform"
    assert data["state_authority"] == "server"
    assert data["memory_worker"] == "external"
    assert data["offline_sync"] == "not_available"
    assert "auth" not in data["shared_api_modules"]
    assert "projects" in data["shared_api_modules"]
    monkeypatch.setattr(settings, "desktop_mode", True)
    assert TestClient(app).get("/api/platform").json()["state_authority"] == "device_local"


def test_shared_settings_stays_in_host_environment():
    from app.api.settings import DEFAULT_ENV_PATH as shared_path
    assert shared_path == DEFAULT_ENV_PATH
    assert "packages/learning-core" not in shared_path


def test_readiness_failure_is_sanitized(monkeypatch):
    import app.db.database as database
    @asynccontextmanager
    async def unavailable():
        raise RuntimeError("private database credential must not escape")
        yield
    monkeypatch.setattr(database, "async_session", unavailable)
    response = TestClient(app).get("/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "unavailable"}


def test_api_does_not_run_external_worker(monkeypatch):
    import app.main as main
    import app.services.task_manager as tasks
    import app.services.local_agent_broker as broker
    import app.services.memory_worker as worker
    called=[]
    async def noop(): pass
    async def forbidden(stop): called.append(True)
    monkeypatch.setattr(settings,"memory_worker_embedded",False)
    monkeypatch.setattr(main,"init_db",noop)
    monkeypatch.setattr(tasks,"mark_stale_tasks_failed",noop)
    monkeypatch.setattr(broker,"mark_interrupted_runs_failed",noop)
    monkeypatch.setattr(worker,"memory_worker_loop",forbidden)
    async def run():
        async with lifespan(app):
            await asyncio.sleep(0)
    asyncio.run(run())
    assert called == []


def test_worker_lease_prevents_two_recovery_processes(tmp_path):
    pytest.importorskip("fcntl")
    path=str(tmp_path/"worker.lock")
    with worker_lease(path):
        with pytest.raises(RuntimeError,match="already owns"):
            with worker_lease(path): pass
    with worker_lease(path): pass


def test_platform_contract_is_registered_and_bound():
    from app.services.architecture_registry import registry_manifest
    manifest = registry_manifest()
    contract = next(row for row in manifest["data_contracts"] if row["id"] == "learning_platform_v1")
    assert contract["schema_version"] == "learnflow-platform/v1"
    assert contract["owner"] == "tutor_agent"
    assert contract["kernel_reads"] == [] and contract["kernel_write_path"] == "none"
    bindings = {row["id"]: row for row in manifest["implementation_bindings"]}
    assert contract["binding_ids"]
    assert all(bindings[key]["valid"] for key in contract["binding_ids"])
