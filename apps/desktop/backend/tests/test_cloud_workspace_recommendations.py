import json
from types import SimpleNamespace

import httpx
import pytest

from app.core.config import settings
from app.services.cloud_device import device_request


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["experiment", "practice"])
async def test_cloud_recommendations_verify_live_stage_and_never_upload_inventory(tmp_path, monkeypatch, mode):
    monkeypatch.setattr(settings, "runtime_dir", str(tmp_path / "runtime"))
    root = tmp_path / "project"
    root.mkdir()
    (root / "importer.c").write_text('#include "normalize.h"\n// private local implementation\n')
    (root / "normalize.h").write_text('int normalize(void);\n')
    requests = []
    project = {"project": {"id": 11, "project_mode": mode}, "roadmap": {"checkpoints": [{"id": 12}, {"id": 13}]}}
    workflow = {"schema_version": "learnflow.project-workflow.v1", "project_mode": mode, "initialized": True,
        "milestones": [{"checkpoint_id": 12, "key": "implement", "status": "available", "materials": [],
            "related_files": [{"path": "importer.c", "role": "implementation", "reason": "当前阶段实现入口"}]},
            {"checkpoint_id": 13, "key": "handoff", "status": "locked", "materials": []}]}
    workflow_status = 200
    project_status = 200
    learner_id = 7
    def cloud(request):
        requests.append(request)
        assert request.method == "GET"
        assert request.content == b""
        assert not request.url.query
        if request.url.path == "/api/auth/me":
            return httpx.Response(200, json={"learner_id": learner_id})
        if request.url.path == "/api/vnext-projects/11":
            return httpx.Response(project_status, json=project)
        assert request.url.path == "/api/vnext-projects/11/workflow"
        return httpx.Response(workflow_status, json=workflow)
    async with httpx.AsyncClient(base_url="https://learn.example", transport=httpx.MockTransport(cloud)) as client:
        session = SimpleNamespace(client=client, learner_id=7)
        async def call(payload, action="recommendations"):
            return await device_request(session, "https://learn.example", 11, "workspace", action, "POST", json.dumps(payload).encode())
        assert (await call({"root_path": str(root), "client_request_id": "bind"}, "link")).status_code == 200
        before = {path: path.read_bytes() for path in (tmp_path / "runtime").rglob("*") if path.is_file()}
        response = await call({"checkpoint_id": 12})
        assert response.status_code == 200, response.body
        result = json.loads(response.body)
        assert [item["path"] for item in result["items"]] == ["importer.c", "normalize.h"]
        assert result["items"][0]["provenance"][0]["rule"] == "stage_related_file"
        assert result["learning_evidence"] is False
        assert str(root) not in str(result) and "private local implementation" not in str(result)
        assert before == {path: path.read_bytes() for path in (tmp_path / "runtime").rglob("*") if path.is_file()}
        assert (await call({"checkpoint_id": 13})).status_code == 403
        assert (await call({"checkpoint_id": 99})).status_code == 404
        assert (await call({})).status_code == 400
        assert (await call({"checkpoint_id": 12, "related_files": []})).status_code == 422
        assert (await call({"checkpoint_id": 12, "limit": 7})).status_code == 422
        workflow["initialized"] = False
        assert (await call({"checkpoint_id": 12})).status_code == 409
        workflow["initialized"] = True
        workflow_status = 503
        assert (await call({"checkpoint_id": 12})).status_code == 503
        project_status = 404
        assert (await call({"checkpoint_id": 12})).status_code == 404
        learner_id = 8
        assert (await call({"checkpoint_id": 12})).status_code == 401
        assert all("importer" not in str(request.url) and "normalize" not in str(request.url) for request in requests)


@pytest.mark.asyncio
async def test_ordinary_cloud_learning_project_without_workflow_returns_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "runtime_dir", str(tmp_path / "runtime"))
    root = tmp_path / "project"
    root.mkdir()
    def cloud(request):
        assert request.method == "GET" and not request.content
        if request.url.path == "/api/auth/me":
            return httpx.Response(200, json={"learner_id": 7})
        if request.url.path.endswith("/workflow"):
            return httpx.Response(404, json={})
        return httpx.Response(200, json={"project": {"id": 11, "project_mode": "learning"}, "roadmap": {"checkpoints": []}})
    async with httpx.AsyncClient(base_url="https://learn.example", transport=httpx.MockTransport(cloud)) as client:
        session = SimpleNamespace(client=client, learner_id=7)
        await device_request(session, "https://learn.example", 11, "workspace", "link", "POST",
            json.dumps({"root_path": str(root), "client_request_id": "bind"}).encode())
        response = await device_request(session, "https://learn.example", 11, "workspace", "recommendations", "POST", b"{}")
        assert response.status_code == 200, response.body
        result = json.loads(response.body)
        assert result["status"] == "no_stage" and result["items"] == []
