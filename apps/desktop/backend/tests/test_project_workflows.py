"""No model/network required: scoped three-mode project journeys and local case lifecycle."""
import asyncio
import uuid
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, func
from app.main import app
from app.db.database import async_session
from app.models.project import Project, Checkpoint, Roadmap, Source, SourceVersion, ProjectWorkflowSubmission
from app.models.learning import LearningTask, EvidenceEvent, KernelMutation


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as test_client:
        accounts = test_client.get("/api/dev/accounts").json()
        account = next(item for item in accounts if item["username"] == "legacy-demo")
        assert test_client.post(f"/api/dev/accounts/{account['id']}/login").status_code == 200
        yield test_client


def action():
    return uuid.uuid4().hex


def create(client, mode="learning"):
    response = client.post("/api/vnext-projects", json={
        "name": "工单导入学习 " + action()[:6], "objective": "学会完成有边界条件的数据转换项目",
        "project_mode": mode, "project_brief": {"deliverables": ["可复现程序"], "constraints": ["离线数据"], "success_criteria": ["检查输入输出"]},
    })
    assert response.status_code == 200, response.text
    return response.json()


def initialize(client, project, case=None):
    payload = {"client_action_id": action()}
    if case:
        payload.update(case_id=case["id"], case_version=case["version"], case_root_hash=case["root_hash"])
    response = client.post(f"/api/vnext-projects/{project['project']['id']}/workflow/initialize", json=payload)
    assert response.status_code == 200, response.text
    return response.json(), payload


def deliver(client, project_id, checkpoint_id, answers, refs=None, assistance="independent", key=None):
    return client.post(f"/api/vnext-projects/{project_id}/checkpoints/{checkpoint_id}/deliver", json={
        "client_action_id": key or action(), "answers": answers, "artifact_refs": refs or [], "assistance_level": assistance,
    })


def test_modes_are_compatible_and_initialization_materializes_one_task_per_checkpoint(client):
    for mode in ("learning", "experiment", "practice"):
        project = create(client, mode)
        assert project["project"]["project_mode"] == mode
        assert project["roadmap"]["checkpoints"] == []
        case = client.get("/api/practice-cases").json()["cases"][0] if mode == "practice" else None
        workflow, payload = initialize(client, project, case)
        pid = project["project"]["id"]
        replay = client.post(f"/api/vnext-projects/{pid}/workflow/initialize", json=payload)
        assert replay.status_code == 200
        assert len(workflow["milestones"]) == 3
        assert workflow["milestones"][0]["status"] == "available"
        assert workflow["milestones"][1]["materials"] == []
        formal = client.get(f"/api/vnext-projects/{pid}").json()
        assert len(formal["roadmap"]["checkpoints"]) == 3
        assert len({cp["learning_task"]["id"] for cp in formal["roadmap"]["checkpoints"]}) == 3
        async def inspect():
            async with async_session() as db:
                row = await db.get(Project, pid)
                assert row.project_kind == "apprenticeship"
                count = await db.scalar(select(func.count(LearningTask.id)).where(LearningTask.project_id == pid))
                assert count == 3
        asyncio.run(inspect())


def test_workbench_is_persistent_versioned_and_idempotent(client):
    project = create(client)
    pid = project["project"]["id"]
    workflow, _ = initialize(client, project)
    cp = workflow["milestones"][0]["checkpoint_id"]
    payload = {"client_action_id": action(), "expected_revision": workflow["revision"], "workbench": {
        "active_tab": "paper", "active_checkpoint_id": cp, "active_paper_id": "hypothesis-1", "open_files": ["src/main.c"],
        "papers": [{"id": "hypothesis-1", "title": "我的预测", "kind": "hypothesis", "body": "改变输入顺序应该不影响最终排序"}],
        "delivery_drafts": {str(cp): {"answers": {"prediction": "还没写完的预测"}, "artifact_refs": [], "assistance_level": "hint"}},
    }}
    saved = client.put(f"/api/vnext-projects/{pid}/workbench", json=payload)
    assert saved.status_code == 200, saved.text
    replay = client.put(f"/api/vnext-projects/{pid}/workbench", json=payload)
    assert replay.status_code == 200
    assert replay.json()["revision"] == saved.json()["revision"]
    stale = {**payload, "client_action_id": action()}
    assert client.put(f"/api/vnext-projects/{pid}/workbench", json=stale).status_code == 409
    changed = {**payload, "workbench": {**payload["workbench"], "active_tab": "overview"}}
    assert client.put(f"/api/vnext-projects/{pid}/workbench", json=changed).status_code == 409
    restored = client.get(f"/api/vnext-projects/{pid}/workflow").json()
    assert restored["workbench"]["active_checkpoint_id"] == cp
    assert restored["workbench"]["papers"][0]["body"] == payload["workbench"]["papers"][0]["body"]
    assert restored["workbench"]["delivery_drafts"][str(cp)]["answers"]["prediction"] == "还没写完的预测"
    other = create(client)
    other_workflow, _ = initialize(client, other)
    foreign = {**payload, "expected_revision": saved.json()["revision"], "client_action_id": action(), "workbench": {**payload["workbench"], "active_checkpoint_id": other_workflow["milestones"][0]["checkpoint_id"]}}
    assert client.put(f"/api/vnext-projects/{pid}/workbench", json=foreign).status_code == 422
    foreign_draft = {**payload, "expected_revision": saved.json()["revision"], "client_action_id": action(), "workbench": {**payload["workbench"], "delivery_drafts": {str(other_workflow["milestones"][0]["checkpoint_id"]): {"answers": {}, "artifact_refs": [], "assistance_level": "independent"}}}}
    assert client.put(f"/api/vnext-projects/{pid}/workbench", json=foreign_draft).status_code == 422


def test_practice_case_validate_gate_restart_and_non_mastery(client):
    case = client.get("/api/practice-cases").json()["cases"][0]
    public = client.get(f"/api/practice-cases/{case['id']}").json()
    assert "stages" not in public and "validator" not in str(public)
    assert "201" not in str(public)
    assert public["provenance"]["kind"] == "authored_teaching_case"
    bad = client.post(f"/api/practice-cases/{case['id']}/validate", json={"version": case["version"], "root_hash": "0" * 64})
    assert bad.status_code == 409
    valid = client.post(f"/api/practice-cases/{case['id']}/validate", json={"version": case["version"], "root_hash": case["root_hash"]})
    assert valid.status_code == 200 and valid.json()["requires_confirmation"]
    project = create(client, "practice")
    pid = project["project"]["id"]
    workflow, _ = initialize(client, project, case)
    first, second, third = [item["checkpoint_id"] for item in workflow["milestones"]]
    hint_payload = {"client_action_id": action(), "level": 1}
    assert client.post(f"/api/vnext-projects/{pid}/checkpoints/{third}/hint", json=hint_payload).status_code == 409
    hint = client.post(f"/api/vnext-projects/{pid}/checkpoints/{first}/hint", json=hint_payload)
    assert hint.status_code == 200, hint.text
    assert "201" not in str(hint.json())
    assert client.post(f"/api/vnext-projects/{pid}/checkpoints/{first}/hint", json=hint_payload).status_code == 200
    assert len(client.get(f"/api/vnext-projects/{pid}/workflow").json()["milestones"][0]["hints_used"]) == 1
    assert deliver(client, pid, third, {"result": "{}", "handoff": "直接跳到结尾"}).status_code == 409
    failed = deliver(client, pid, first, {"rules": "{}", "prediction": "预测"})
    assert failed.status_code == 200
    assert not failed.json()["milestones"][0]["submission"]["feedback"]["accepted"]
    assert failed.json()["milestones"][1]["materials"] == []
    key = action()
    answers = {"rules": '{"duplicate_policy":"last_row_wins","unknown_status":"reject","email_normalization":"trim_lowercase"}', "prediction": "重复和未知状态是风险"}
    accepted = deliver(client, pid, first, answers, assistance="independent", key=key)
    assert accepted.status_code == 200
    assert accepted.json()["milestones"][0]["status"] == "accepted"
    assert accepted.json()["milestones"][0]["submission"]["assistance_level"] == "hint"
    assert accepted.json()["milestones"][1]["materials"]
    assert accepted.json()["milestones"][2]["materials"] == []
    assert deliver(client, pid, first, answers, assistance="independent", key=key).status_code == 200
    wrong = deliver(client, pid, second, {"result": '{"tickets":[],"rejected":[104]}', "observation": "有输出", "explanation": "完成"})
    assert not wrong.json()["milestones"][1]["submission"]["feedback"]["accepted"]
    actual = '{"tickets":[{"id":101,"email":"alice+work@example.com","status":"open"},{"id":102,"email":"bob@example.com","status":"closed"},{"id":103,"email":"cara@example.com","status":"closed"}],"rejected":[104]}'
    response = deliver(client, pid, second, {"result": actual, "observation": "保留最后一条", "explanation": "按合同规范化后排序"})
    assert response.json()["milestones"][1]["status"] == "accepted"
    assert "201" in str(response.json()["milestones"][2]["materials"])
    future = '{"tickets":[{"id":201,"email":"final@example.com","status":"closed"},{"id":202,"email":"second@example.com","status":"closed"}],"rejected":[203]}'
    response = deliver(client, pid, third, {"result": future, "handoff": "运行 importer.py；下一步增加空邮箱边界"})
    assert response.status_code == 200
    assert all(item["status"] == "accepted" for item in response.json()["milestones"])
    restored = client.get(f"/api/vnext-projects/{pid}/workflow").json()
    assert restored["case_ref"]["root_hash"] == case["root_hash"]
    assert restored["milestones"][2]["submission"]["feedback"]["review_required"]
    context = client.get(f"/api/vnext-projects/{pid}/agent-context", params={"checkpoint_id": first, "session_id": project["project_tutor"]["session_id"]}).json()
    assert context["project_workflow"]["milestones"][2]["materials"] == []
    async def inspect():
        async with async_session() as db:
            events = list((await db.execute(select(EvidenceEvent).where(EvidenceEvent.project_id == pid, EvidenceEvent.event_type == "project_delivery_submitted"))).scalars())
            assert len(events) == 5
            mutations = await db.scalar(select(func.count(KernelMutation.id)).where(KernelMutation.event_id.in_([event.id for event in events])))
            assert mutations == 0
            tasks = list((await db.execute(select(LearningTask).where(LearningTask.project_id == pid))).scalars())
            assert all(task.status != "completed" for task in tasks)
            from app.services.checkpoint_context import build_checkpoint_tutor_context
            project_row = await db.get(Project, pid)
            native = await build_checkpoint_tutor_context(db, learner_id=project_row.learner_id, project_id=pid, checkpoint_id=first)
            assert native["project_workflow"]["project_mode"] == "practice"
            assert native["project_workflow"]["milestones"][0]["materials"]
            assert native["project_workflow"]["milestones"][2]["materials"] == []
            assert "validator" not in str(native["project_workflow"])
    asyncio.run(inspect())


def test_reading_requires_owned_version_and_never_replaces_formal_verification(client):
    project = create(client)
    pid = project["project"]["id"]
    workflow, _ = initialize(client, project)
    first, second, third = [item["checkpoint_id"] for item in workflow["milestones"]]
    async def source():
        async with async_session() as db:
            row = Source(project_id=pid, type="file", url="课程.md", status="processed")
            db.add(row)
            await db.flush()
            version = SourceVersion(source_id=row.id, version=1, content_hash=action()*2)
            db.add(version)
            await db.commit()
            return row.id, version.id
    source_id, version_id = asyncio.run(source())
    reading = {"client_action_id": action(), "source_id": source_id, "source_version_id": version_id, "locator": "第 2 节", "notes": "我还不理解重复数据的约束"}
    bad = {**reading, "client_action_id": action(), "source_version_id": version_id + 999999}
    assert client.post(f"/api/vnext-projects/{pid}/reading", json=bad).status_code == 422
    response = client.post(f"/api/vnext-projects/{pid}/reading", json=reading)
    assert response.status_code == 200
    assert response.json()["reading_records"][0]["source_version_id"] == version_id
    assert client.post(f"/api/vnext-projects/{pid}/reading", json=reading).status_code == 200
    response = deliver(client, pid, first, {"goal": "掌握数据转换约束"}, [{"kind": "source_version", "ref": str(version_id)}])
    assert response.json()["milestones"][0]["status"] == "accepted"
    response = deliver(client, pid, second, {"teachback": "需要固定输入输出约束", "question": "如何覆盖边界"})
    assert response.json()["milestones"][1]["status"] == "accepted"
    response = deliver(client, pid, third, {"reflection": "我已经完全掌握"})
    final = response.json()["milestones"][2]
    assert final["status"] == "available"
    assert not final["submission"]["feedback"]["accepted"]
    assert {item["key"] for item in final["submission"]["feedback"]["checks"] if not item["passed"]} == {"verification", "review"}
    other = create(client)
    assert client.post(f"/api/vnext-projects/{other['project']['id']}/reading", json={**reading, "client_action_id": action()}).status_code == 422


def test_bundled_case_starter_uses_c11_stdio_and_is_not_a_solution(tmp_path):
    import json
    import subprocess
    from app.services.practice_cases import get_case, evaluate_case
    from app.services.experiment_runner import capture_files, discover_compiler
    case = get_case("support-ticket-import")
    files = {item["path"]: item["content"] for item in case["starter_files"]}
    assert "importer.c" in files and "importer.py" not in files
    assert "TODO" in files["importer.c"]
    for name, content in files.items():
        (tmp_path / name).write_text(content)
    manifest, _ = capture_files(tmp_path, ["importer.c", "input.csv"])
    assert {item["path"] for item in manifest} == {"importer.c", "input.csv"}
    compiler = discover_compiler()
    if not compiler:
        pytest.skip("C11 compiler is unavailable")
    executable = tmp_path / "fixture"
    compile_result = subprocess.run([compiler, "-std=c11", str(tmp_path / "importer.c"), "-o", str(executable)], capture_output=True, text=True, timeout=20)
    assert compile_result.returncode == 0, compile_result.stderr
    run = subprocess.run([str(executable)], input=files["input.csv"], capture_output=True, text=True, timeout=5)
    assert run.returncode == 0
    assert set(json.loads(run.stdout)) == {"tickets", "rejected"}
    checks = evaluate_case(case["stages"][1], {"result": run.stdout})
    assert not all(check["passed"] for check in checks)
