"""Offline recommendations are scoped navigation, never a cloud upload or evidence write."""
import json
from pathlib import Path
import uuid

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import app
from app.services import workspace_recommendations as service
from app.services.workspace_files import WorkspaceError


def stage(**changes):
    return {"checkpoint_id": 12, "key": "implement", "status": "available", "title": "实现导入",
            "objective": "检查输入边界", "materials": [], "related_files": [], **changes}


def recommend(root, value=None, limit=6):
    return service.recommend_files(root, stage() if value is None else value,
                                   project_id=7, checkpoint_id=12, limit=limit)


def write(root, path, content="int value;\n"):
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    return target


def test_fixed_stage_paths_precede_materials_keywords_and_one_hop_includes(tmp_path):
    write(tmp_path, "src/importer.c", '#include "convert.h"\n/* #include "ignored.h" */\n')
    write(tmp_path, "src/convert.h", '#include "deeper.h"\n')
    write(tmp_path, "src/deeper.h")
    write(tmp_path, "src/ignored.h")
    write(tmp_path, "input.csv", "id,email\n1,learner@example.test\n")
    write(tmp_path, "normalize.c")
    value = stage(objective="normalize 输入数据", related_files=[{"path": "src/importer.c", "role": "implementation", "reason": "当前阶段修改入口"}],
                  materials=[{"id": "batch-a", "body": "读取 input.csv 再实现转换。"}])
    result = recommend(tmp_path, value)
    assert [item["path"] for item in result["items"]] == ["src/importer.c", "input.csv", "normalize.c", "src/convert.h"]
    assert result["items"][0]["reason"] == "当前阶段修改入口"
    assert result["items"][-1]["provenance"] == [{"stage_key": "implement", "rule": "local_import", "source_path": "src/importer.c", "line": 1}]
    assert result == recommend(tmp_path, value)
    assert "learner@example.test" not in json.dumps(result)
    assert result["learning_evidence"] is False


def test_local_imports_resolve_only_one_unambiguous_allowed_neighbor(tmp_path):
    write(tmp_path, "src/view.ts", 'import {value} from "./model";\nconst x = require("../shared");\n"import fake from \'./fake\'";\n// import y from "./fake";\nimport z from "external";\n')
    write(tmp_path, "src/model.ts")
    write(tmp_path, "shared.js")
    write(tmp_path, "src/fake.ts")
    value = stage(related_files=[{"path": "src/view.ts"}])
    assert {item["path"] for item in recommend(tmp_path, value)["items"]} == {"src/view.ts", "src/model.ts", "shared.js"}
    write(tmp_path, "src/model.js")
    assert "src/model.ts" not in {item["path"] for item in recommend(tmp_path, value)["items"]}


def test_no_matches_and_missing_stage_do_not_invent_recommendations(tmp_path):
    write(tmp_path, "README.md")
    write(tmp_path, "unrelated.c")
    assert recommend(tmp_path)["items"] == []
    assert recommend(tmp_path)["status"] == "no_matches"
    empty = service.recommend_files(tmp_path / "not-scanned", None, project_id=7, checkpoint_id=None)
    assert empty["status"] == "no_stage" and not empty["truncated"]


def test_scan_excludes_broker_protected_paths_links_binary_and_oversized_text(tmp_path):
    protected = [".env", ".env.local", ".npmrc", ".ssh/key", ".git/config", "nested/.git/config",
                 "node_modules/pkg/index.ts", ".learnflow/project.lfproject", "saved.lflecture"]
    for path in protected:
        write(tmp_path, path)
    outside = tmp_path.parent / ("outside-" + uuid.uuid4().hex)
    outside.mkdir()
    write(outside, "leaked.c")
    (tmp_path / "link.c").symlink_to(outside / "leaked.c")
    (tmp_path / "linked").symlink_to(outside, target_is_directory=True)
    (tmp_path / "binary.c").write_bytes(b"\x00content")
    write(tmp_path, "large.c", "x" * (service.MAX_FILE_BYTES + 1))
    write(tmp_path, "valid.c")
    paths = protected + ["link.c", "linked/leaked.c", "binary.c", "large.c", "valid.c"]
    value = stage(materials=[{"id": "names", "body": "\n".join(paths)}])
    result = recommend(tmp_path, value)
    assert [item["path"] for item in result["items"]] == ["valid.c"]
    assert result["truncated"]
    assert not (tmp_path / ".learnflow" / "index.json").exists()


def test_inventory_and_reads_are_bounded_with_stable_six_item_output(tmp_path, monkeypatch):
    for index in range(10):
        write(tmp_path, f"input{index}.csv", "content")
    value = stage(materials=[{"id": "input", "body": " ".join(f"input{i}.csv" for i in range(10))}])
    assert len(recommend(tmp_path, value)["items"]) == 6
    assert len(recommend(tmp_path, value, 2)["items"]) == 2
    monkeypatch.setattr(service, "MAX_FILES", 3)
    result = recommend(tmp_path, value)
    assert len(result["items"]) == 3 and result["truncated"]
    monkeypatch.setattr(service, "MAX_READ_BYTES", 7)
    assert len(recommend(tmp_path, value)["items"]) == 1
    monkeypatch.setattr(service, "MAX_DIRECTORY_ENTRIES", 2)
    result = recommend(tmp_path, value)
    assert result["items"] == [] and result["truncated"]


def test_changed_or_symlink_replaced_file_is_not_read(tmp_path):
    path = write(tmp_path, "input.c")
    inventory, _ = service._files(tmp_path)
    path.write_text("changed")
    assert service._read_text(tmp_path, "input.c", inventory["input.c"]) is None
    path.unlink()
    path.symlink_to(tmp_path.parent / "outside")
    assert service._read_text(tmp_path, "input.c", inventory["input.c"]) is None


def test_explicit_stage_file_survives_discovery_budget_without_bypassing_exclusions(tmp_path, monkeypatch):
    for index in range(5):
        write(tmp_path, f"a{index}.c")
    write(tmp_path, "src/target.c")
    write(tmp_path, "node_modules/target.c")
    monkeypatch.setattr(service, "MAX_FILES", 2)
    value = stage(related_files=[{"path": "node_modules/target.c"}, {"path": "../outside.c"}, {"path": "src/target.c"}])
    result = recommend(tmp_path, value)
    assert [item["path"] for item in result["items"]] == ["src/target.c"]
    assert result["truncated"]


@pytest.mark.parametrize("mode", ["experiment", "practice"])
def test_stage_authority_cannot_be_bypassed(mode):
    workflow = {"schema_version": "learnflow.project-workflow.v1", "project_mode": mode, "initialized": True,
                "milestones": [stage(), stage(checkpoint_id=13, status="locked")]}
    assert service.select_stage(workflow, 12, mode)["key"] == "implement"
    for checkpoint, code in [(None, "checkpoint_required"), (99, "checkpoint_not_found"), (13, "checkpoint_locked")]:
        with pytest.raises(WorkspaceError) as failure:
            service.select_stage(workflow, checkpoint, mode)
        assert failure.value.code == code
    with pytest.raises(WorkspaceError, match="正式阶段"):
        service.select_stage({}, 12, mode)


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as client:
        account = next(item for item in client.get('/api/dev/accounts').json() if item['username'] == 'legacy-demo')
        assert client.post(f"/api/dev/accounts/{account['id']}/login").status_code == 200
        yield client


def test_local_api_requires_native_project_and_checkpoint_scope(client, tmp_path, monkeypatch):
    token = "recommendation-test-token"
    monkeypatch.setattr(settings, "desktop_mode", True)
    monkeypatch.setattr(settings, "desktop_token", token)
    headers = {"X-LearnFlow-Desktop-Token": token}
    def create(mode):
        response = client.post('/api/vnext-projects', json={"name": "Recommend " + uuid.uuid4().hex[:6],
            "objective": "处理 input 文件", "project_mode": mode})
        assert response.status_code == 200, response.text
        return response.json()["project"]["id"]
    def initialize(project_id):
        response = client.post(f'/api/vnext-projects/{project_id}/workflow/initialize', json={"client_action_id": uuid.uuid4().hex})
        assert response.status_code == 200, response.text
        return response.json()["milestones"]
    pid = create("experiment")
    stages = initialize(pid)
    write(tmp_path, "input.c")
    link = client.post(f'/api/projects/{pid}/workspace/link', headers=headers, json={"root_path": str(tmp_path), "client_request_id": uuid.uuid4().hex})
    assert link.status_code == 200, link.text
    url = f'/api/projects/{pid}/workspace/recommendations'
    assert client.post(url, json={"checkpoint_id": stages[0]["checkpoint_id"]}).status_code == 404
    assert client.post(url, headers=headers, json={}).status_code == 400
    assert client.post(url, headers=headers, json={"checkpoint_id": stages[1]["checkpoint_id"]}).status_code == 403
    other = initialize(create("experiment"))
    assert client.post(url, headers=headers, json={"checkpoint_id": other[0]["checkpoint_id"]}).status_code == 404
    for payload in [{"checkpoint_id": True}, {"limit": 7}, {"related_files": [{"path": "input.c"}]}]:
        assert client.post(url, headers=headers, json=payload).status_code == 422
    response = client.post(url, headers=headers, json={"checkpoint_id": stages[0]["checkpoint_id"]})
    assert response.status_code == 200, response.text
    assert response.json()["checkpoint_id"] == stages[0]["checkpoint_id"]
    assert response.json()["learning_evidence"] is False
    assert [item["path"] for item in response.json()["items"]] == ["input.c"]
    learning = create("learning")
    learning_root = tmp_path / "learning"
    write(learning_root, "unrelated.c")
    assert client.post(f'/api/projects/{learning}/workspace/link', headers=headers,
        json={"root_path": str(learning_root), "client_request_id": uuid.uuid4().hex}).status_code == 200
    ordinary = client.post(f'/api/projects/{learning}/workspace/recommendations', headers=headers, json={})
    assert ordinary.status_code == 200 and ordinary.json()["status"] == "no_stage"
    monkeypatch.setattr(settings, "desktop_mode", False)
    assert client.post(url, headers=headers, json={"checkpoint_id": stages[0]["checkpoint_id"]}).status_code == 404
