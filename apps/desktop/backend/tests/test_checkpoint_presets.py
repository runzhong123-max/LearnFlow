"""Checkpoint content design, frozen routes, future-material and file boundaries."""
import asyncio
import uuid
from types import SimpleNamespace
import pytest
from pydantic import ValidationError
from fastapi.testclient import TestClient
from app.main import app
from app.db.database import async_session
from app.models.project import Checkpoint
from learnflow_core.checkpoint_presets import CheckpointPreset, checkpoint_entry_preset


def uid():
    return uuid.uuid4().hex


def preset(kind="implementation", path="src/parser.c"):
    return {"kind": kind, "lecture_focus": "解释输入格式与边界", "practice_focus": "检查输入输出与工作流程" if kind in {"knowledge", "overview"} else "",
            "workflow_step": "处理输入" if kind == "workflow" else "",
            "required_files": [{"path": path, "purpose": "解析输入并返回明确的错误"}] if kind == "implementation" else []}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as current:
        legacy = next(a for a in current.get('/api/dev/accounts').json() if a['username'] == 'legacy-demo')
        assert current.post(f"/api/dev/accounts/{legacy['id']}/login").status_code == 200
        yield current


@pytest.mark.parametrize("path", ["/tmp/main.c", "../main.c", "a/../b.c", "a\\b.c", ".learnflow/state", ".git/config", ".env", "a/.env.local", "a//b.c", "a\x00.c"])
def test_file_plan_rejects_unsafe_paths(path):
    with pytest.raises(ValidationError):
        CheckpointPreset.model_validate(preset(path=path))


def test_mode_defaults_supply_material_pair_and_overview():
    cp = SimpleNamespace(title="理解数据", description="识别字段与约束", order=1, brief={})
    for mode, kind in (("learning", "knowledge"), ("practice", "overview")):
        view = checkpoint_entry_preset(SimpleNamespace(project_mode=mode, name="数据导入"), cp, workflow_titles=["综述", "接手", "交付"])
        assert view["kind"] == kind and view["file_kinds"] == ["lecture", "practice"]
        assert view["desktop_guidance"] == (mode == "practice")
        assert view["help_surface"] == "code_paper"
    assert view["overview_outline"] == "综述 → 接手 → 交付"
    assert not view["configured"]


def test_experiment_confirmation_uses_explicit_serial_file_plan_and_is_idempotent(client):
    plans = [{"key": key, "title": title, "objective": title, "entry_preset": preset(path=path)} for key, title, path in
             [("parse", "实现输入解析", "src/parser.c"), ("solve", "实现求解逻辑", "src/solver.c"), ("integrate", "实现完整调用", "src/main.c")]]
    prepared = client.post('/api/project-guidance/prepare', json={"client_action_id": uid(), "project_mode": "experiment",
        "name": "SAT 求解器", "objective": "分模块实现完整求解器", "checkpoints": plans})
    assert prepared.status_code == 200, prepared.text
    candidate = prepared.json()
    assert candidate["candidate"]["checkpoints"] == plans
    body = {"client_action_id": uid(), "expected_root_hash": candidate["root_hash"], "confirmed": True}
    url = f"/api/project-guidance/{candidate['candidate_id']}/confirm"
    response = client.post(url, json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    repeated = client.post(url, json=body).json()
    assert not repeated["created"] and repeated["project_id"] == result["project_id"]
    stages = result["workflow"]["milestones"]
    assert [s["key"] for s in stages] == [s["key"] for s in plans]
    assert stages[0]["entry_preset"]["required_files"] == plans[0]["entry_preset"]["required_files"]
    assert stages[1]["entry_preset"] is None and stages[2]["entry_preset"] is None
    current = result["workspace"]["roadmap"]["checkpoints"][0]
    context = client.get(f"/api/vnext-projects/{result['project_id']}/agent-context", params={"checkpoint_id": current["id"], "session_id": current["session_id"]}).json()
    assert "entry_preset" not in context["roadmap"]["checkpoints"][1]
    assert context["project_workflow"]["milestones"][1]["entry_preset"] is None
    # File plans have no file/grade side effect, and locked case content cannot be generated.
    future = result["workspace"]["roadmap"]["checkpoints"][1]["learning_task"]
    generation = client.post(f"/api/learning-files/tasks/{future['id']}/generate", json={"file_kinds": ["lecture"], "expected_version": future["version"], "client_request_id": uid()})
    assert generation.status_code == 409, generation.text
    def submit_file(path):
        report = client.post(f"/api/vnext-projects/{result['project_id']}/device-reports", json={
            "schema_version": "learnflow.device-report.v1", "client_action_id": uid(), "checkpoint_id": current["id"],
            "action": "files", "status": "completed", "snapshot_hash": "a" * 64, "exit_code": None,
            "summary": "文件清单", "manifest": [{"path": path, "sha256": "b" * 64, "size": 12}], "steps": []})
        assert report.status_code == 200, report.text
        delivery = client.post(f"/api/vnext-projects/{result['project_id']}/checkpoints/{current['id']}/deliver", json={
            "client_action_id": uid(), "answers": {"reflection": "记录本次实现与检查依据"},
            "artifact_refs": [report.json()["artifact_ref"]], "assistance_level": "independent"})
        assert delivery.status_code == 200, delivery.text
        return delivery.json()["milestones"][0]["submission"]["feedback"]
    missing = submit_file("unrelated.c")
    assert not missing["accepted"]
    assert any(c["key"] == "required_file_0" and not c["passed"] for c in missing["checks"])
    complete = submit_file("src/parser.c")
    assert complete["accepted"] and complete["mastery_inference"] is False


def test_learning_preset_roundtrip_and_started_design_cannot_change(client):
    workspace = client.post('/api/vnext-projects', json={"name": "数据库基础", "objective": "理解索引与事务"}).json()
    project_id = workspace["project"]["id"]
    specs = [{"key": key, "title": title, "objective": title, "success_criteria": [title], "estimated_minutes": 45,
              "prerequisites": [] if index == 0 else ["index"], "entry_preset": preset("knowledge")}
             for index, (key, title) in enumerate([("index", "理解索引"), ("transaction", "理解事务")])]
    request = {"project_theme": workspace["project"]["name"], "checkpoints": specs, "client_action_id": uid()}
    response = client.post(f'/api/vnext-projects/{project_id}/roadmap/apply', json=request)
    assert response.status_code == 200, response.text
    checkpoints = response.json()["roadmap"]["checkpoints"]
    assert checkpoints[0]["entry_preset"]["file_kinds"] == ["lecture", "practice"]
    async def complete():
        async with async_session() as db:
            cp = await db.get(Checkpoint, checkpoints[0]["id"])
            cp.learning_status = "completed"  # Fixture representing the existing deterministic runtime output.
            await db.commit()
    asyncio.run(complete())
    assert client.get(f'/api/vnext-projects/{project_id}/workflow').json()["milestones"][1]["status"] == "available"
    revised = [{**spec, "id": row["id"]} for spec, row in zip(specs, checkpoints)]
    revised[0]["entry_preset"] = {**preset("knowledge"), "lecture_focus": "偷偷改写已开始关卡"}
    refused = client.put(f'/api/vnext-projects/{project_id}/roadmap', json={**request, "client_action_id": uid(), "expected_revision": 1, "checkpoints": revised})
    assert refused.status_code == 409, refused.text


def test_explicit_file_design_does_not_inherit_legacy_stage_fields():
    from learnflow_core.project_workflows import _stage_for, SCHEMA_VERSION
    cp = SimpleNamespace(id=1, title="实现解析器", description="完成解析接口", brief={
        "checkpoint_key": "implement", "workflow_template": SCHEMA_VERSION, "entry_preset": preset()})
    stage = _stage_for(cp, None, SimpleNamespace(project_mode="experiment"))
    assert stage["validator"] == "artifact"
    assert [field["key"] for field in stage["fields"]] == ["reflection"]
