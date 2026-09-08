"""Authored conversion recipes and scoped, answer-isolated operational runtime."""
import asyncio
from copy import deepcopy
import json
import uuid
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select, func
from app.main import app
from app.db.database import async_session
from app.models.project import Project, ProjectWorkflowState
from app.models.learning import LearningTask, EvidenceEvent, KernelMutation
from learnflow_core.work_task_designs import (compile_design, design_catalog, digest, evaluate_design_stage, long_tail_draft, public_design, validate_design)
from learnflow_core.project_workflows import materialize_design


def brief(title="库存 CSV 数据导入"):
    return {"task_title": title, "task_description": "接手并交付" + title,
            "work_context": "新员工接到交接单，需要对照约定独立完成", "deliverable": title + "的可复现交付",
            "acceptance_criteria": ["保留边界处理和复现依据"], "constraints": ["离线教学数据"],
            "learner_level": "会基本编程", "source_refs": [{"task_id": "task-17", "version": "1.2", "root_hash": "a" * 64}]}


@pytest.mark.parametrize("recipe,title,fixture", [
    ("data-import-quality", "库存 CSV 数据导入", "inventory.csv"),
    ("service-integration-delivery", "新客户服务接口接入实施", "onboarding.json"),
    ("incident-investigation", "值班告警与故障排查", "incident-window.json"),
])
@pytest.mark.parametrize("mode", ["experiment", "practice"])
def test_recipes_have_different_materials_and_verified_public_boundary(recipe, title, fixture, mode):
    design = compile_design(brief(title), mode, recipe)
    assert validate_design(design)["valid"]
    assert compile_design(brief(title), mode, recipe) == design
    assert any(f["path"] == fixture for f in design["starter_files"])
    assert design["relation_map"][0]["input_text"] == title
    assert design["acceptance"]["scope"] == "authored_fixture_only"
    assert not design["acceptance"]["mastery_inference"]
    public = public_design(design)
    assert "assessment" not in str(public) and "hints" not in str(public)
    assert "materials" not in str(public)
    final = design["stages"][-1]
    assert final["independent_validation"]
    assert final["assessment"]["expected"] not in [f["content"] for f in public["starter_files"]]
    assert evaluate_design_stage(final, {"result": json.dumps(final["assessment"]["expected"])})[0]["passed"]
    assert not evaluate_design_stage(final, {"result": "{}"})[0]["passed"]
    assert not evaluate_design_stage(final, {"result": "I cannot answer"})[0]["passed"]


def test_parameters_change_real_contract_and_expected_result():
    original = compile_design(brief(), "practice", "data-import-quality")
    modified = brief()
    modified["constraints"] = ["重复记录保留首条", "SKU小写"]
    design = compile_design(modified, "practice", "data-import-quality")
    assert design["root_hash"] != original["root_hash"]
    assert design["stages"][1]["assessment"]["expected"]["records"][0] == {"id": 11, "sku": "bolt-a", "quantity": 2}
    assert "保留第一行" in design["starter_files"][0]["content"]
    assert all(item["status"] == "applied" for item in design["constraint_review"])
    bad = brief()
    bad["constraints"] = ["允许负数"]
    with pytest.raises(HTTPException) as exc:
        compile_design(bad, "practice", "data-import-quality")
    assert exc.value.detail["code"] == "unsupported"
    bad["constraints"] = ["保留首条", "保留最后"]
    assert design_catalog(bad)[0]["readiness"] == "unsupported"


def test_unsupported_missing_inputs_and_long_tail_are_honest():
    missing = design_catalog({"task_title": "CSV 导入"})
    assert all(item["readiness"] == "missing_input" for item in missing)
    assert "deliverable" in missing[0]["missing_fields"]
    custom = brief("烘焙发酵温度控制")
    assert all(item["readiness"] == "unsupported" for item in design_catalog(custom))
    with pytest.raises(HTTPException):
        compile_design(custom, "experiment", "data-import-quality")
    draft = long_tail_draft(custom, "experiment")
    assert not draft["can_materialize"] and not draft["auto_execute"]
    assert draft["readiness"] == "needs_domain_authoring"
    assert draft["proposed_phases"][0]["target_deliverable"] == custom["deliverable"]
    assert draft["acceptance_map"][0]["requirement"] == custom["acceptance_criteria"][0]
    assert len(draft["missing_validation"]) >= 4
    assert not validate_design(draft)["valid"]


def test_rehashed_private_answers_and_unsafe_files_are_rejected():
    design = compile_design(brief(), "practice", "data-import-quality")
    forged = deepcopy(design)
    forged["stages"][-1]["assessment"]["expected"] = {}
    forged["root_hash"] = digest({k: v for k, v in forged.items() if k != "root_hash"})
    assert "not_authored_compiler_output" in validate_design(forged)["errors"]
    forged = deepcopy(design)
    forged["starter_files"][0]["path"] = "../.learnflow/config.json"
    forged["root_hash"] = digest({k: v for k, v in forged.items() if k != "root_hash"})
    assert "unsafe_starter_path" in validate_design(forged)["errors"]


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as client:
        account = next(item for item in client.get("/api/dev/accounts").json() if item["username"] == "legacy-demo")
        assert client.post(f"/api/dev/accounts/{account['id']}/login").status_code == 200
        yield client


def key():
    return uuid.uuid4().hex


def create_materialized(client, design):
    response = client.post("/api/vnext-projects", json={"name": design["title"] + key()[:5],
        "objective": design["objective"], "project_mode": design["project_mode"], "project_brief": {}})
    assert response.status_code == 200, response.text
    pid = response.json()["project"]["id"]
    action = key()
    async def init():
        async with async_session() as db:
            project = await db.get(Project, pid)
            view = await materialize_design(db, project, design, action)
            replay = await materialize_design(db, project, design, action)
            assert view["revision"] == replay["revision"]
            await db.commit()
            return view
    return pid, asyncio.run(init())


def delivery(client, pid, cp, stage, *, assistance="independent", invalid=False):
    answers = {f["key"]: "我记录了当前材料的逐项推导和运行依据" for f in stage["fields"]}
    answers["result"] = "{}" if invalid else json.dumps(stage["assessment"]["expected"])
    return client.post(f"/api/vnext-projects/{pid}/checkpoints/{cp}/deliver", json={
        "client_action_id": key(), "answers": answers, "artifact_refs": [], "assistance_level": assistance})


@pytest.mark.parametrize("mode", ["practice", "experiment"])
def test_materialized_design_locks_answers_replays_and_preserves_evidence(client, mode):
    design = compile_design(brief("值班告警与故障排查"), mode, "incident-investigation")
    pid, workflow = create_materialized(client, design)
    cps = [item["checkpoint_id"] for item in workflow["milestones"]]
    assert len(cps) == len(design["stages"])
    assert "assessment" not in str(workflow)
    assert "compiled_design" not in str(workflow)
    assert "pool-19" not in str(workflow)
    assert workflow["case_ref"]["root_hash"] == design["root_hash"]
    assert delivery(client, pid, cps[-1], design["stages"][-1]).status_code == 409
    invalid = delivery(client, pid, cps[0], design["stages"][0], invalid=True)
    assert invalid.status_code == 200
    assert invalid.json()["milestones"][1]["materials"] == []
    hinted = client.post(f"/api/vnext-projects/{pid}/checkpoints/{cps[0]}/hint", json={"client_action_id": key(), "level": 1})
    assert hinted.status_code == 200
    for index, (cp, stage) in enumerate(zip(cps, design["stages"])):
        if index == len(cps) - 1:
            hint = client.post(f"/api/vnext-projects/{pid}/checkpoints/{cp}/hint", json={"client_action_id": key(), "level": 1})
            assert hint.status_code == 409
            assert client.get(f"/api/vnext-projects/{pid}/checkpoints/{cp}/assistance").status_code == 409
        response = delivery(client, pid, cp, stage)
        assert response.status_code == 200, response.text
        workflow = response.json()
        assert workflow["milestones"][index]["status"] == "accepted", response.text
        assert "assessment" not in str(workflow)
        if index == 0:
            assert workflow["milestones"][0]["submission"]["assistance_level"] == "hint"
    assert workflow["milestones"][-1]["hint_levels"] == 0
    assert all(item["formal_learning_status"] == "not_started" for item in workflow["milestones"])
    assert client.get(f"/api/vnext-projects/{pid}/workflow").json()["case_ref"]["root_hash"] == design["root_hash"]
    async def inspect():
        async with async_session() as db:
            tasks = list((await db.execute(select(LearningTask).where(LearningTask.project_id == pid))).scalars())
            assert len(tasks) == len(cps) and all(task.status != "completed" for task in tasks)
            state = await db.scalar(select(ProjectWorkflowState).where(ProjectWorkflowState.project_id == pid))
            assert state.case_ref["compiled_design"] == design
            events = list((await db.execute(select(EvidenceEvent).where(EvidenceEvent.project_id == pid, EvidenceEvent.event_type == "project_delivery_submitted"))).scalars())
            assert len(events) == len(cps) + 1
            assert await db.scalar(select(func.count(KernelMutation.id)).where(KernelMutation.event_id.in_([event.id for event in events]))) == 0
    asyncio.run(inspect())


def test_assisted_final_never_becomes_independent_on_retry(client):
    design = compile_design(brief(), "practice", "data-import-quality")
    pid, workflow = create_materialized(client, design)
    for item, stage in zip(workflow["milestones"][:-1], design["stages"][:-1]):
        assert delivery(client, pid, item["checkpoint_id"], stage).status_code == 200
    cp = workflow["milestones"][-1]["checkpoint_id"]
    stage = design["stages"][-1]
    response = delivery(client, pid, cp, stage, assistance="together")
    assert response.status_code == 200
    assert response.json()["milestones"][-1]["status"] == "available"
    retry = delivery(client, pid, cp, stage, assistance="independent")
    assert retry.json()["milestones"][-1]["status"] == "available"
    assert retry.json()["milestones"][-1]["submission"]["assistance_level"] == "together"
