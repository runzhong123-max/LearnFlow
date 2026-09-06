from __future__ import annotations

import asyncio
from pathlib import Path
import time
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.config import settings
from app.db.database import async_session
from app.main import app
from app.models.learning import EvidenceEvent, KernelMutation
from app.services import experiment_runner as runner
from app.services.workspace_files import WorkspaceError


HEADERS = {"X-LearnFlow-Desktop-Token": "experiment-test-token"}


def setup_project(client, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "desktop_mode", True)
    monkeypatch.setattr(settings, "desktop_token", HEADERS["X-LearnFlow-Desktop-Token"])
    monkeypatch.setattr(settings, "runtime_dir", str(tmp_path / "runtime"))
    registered = client.post("/api/auth/register", json={
        "username": f"experiment_{uuid.uuid4().hex[:12]}", "password": "experiment-pass-123",
        "display_name": "Experiment test", "education_stage": "undergraduate",
        "background": "C", "focus_areas": ["C"], "weekly_hours": 5,
        "preferred_modes": ["project"], "career_goal": "", "career_goal_status": "exploring",
    })
    assert registered.status_code == 200, registered.text
    project = client.post("/api/projects", json={
        "name": "可信 C 测试", "description": "fixture only", "user_level": "beginner",
    }).json()
    source = tmp_path / "project"
    source.mkdir()
    (source / "main.c").write_text('#include <stdio.h>\nint main(void) { int n; if(scanf("%d", &n)!=1) return 1; printf("%d\\n", n*2); return 0; }\n')
    linked = client.post(f"/api/projects/{project['id']}/workspace/link", headers=HEADERS, json={
        "root_path": str(source), "create": False, "platform": "test", "client_request_id": "fixture",
    })
    assert linked.status_code == 200, linked.text
    return project["id"], source


def preview(client, project_id, **changes):
    return client.post(f"/api/projects/{project_id}/experiments/runs/preview", headers=HEADERS, json={
        "profile_id": "c11", "action": "run", "files": ["main.c"], "stdin": "4\n",
        "client_request_id": "run-1", **changes,
    })


def wait_result(client, project_id, run_id):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        result = client.get(f"/api/projects/{project_id}/experiments/runs/{run_id}", headers=HEADERS)
        assert result.status_code == 200, result.text
        if result.json()["status"] not in {"queued", "running"}:
            return result.json()
        time.sleep(0.03)
    pytest.fail("trusted fixture experiment did not finish")


def test_snapshot_rejects_escapes_secrets_links_and_oversize(tmp_path):
    (tmp_path / "main.c").write_text("int main(void) { return 0; }")
    (tmp_path / "large.c").write_bytes(b" " * (runner.MAX_FILE_BYTES + 1))
    (tmp_path / "credentials.json").write_text("{}")
    for files in (["../outside.c"], ["/tmp/main.c"], ["credentials.json"], ["large.c"], ["main.c", "MAIN.c"]):
        with pytest.raises(WorkspaceError):
            runner.capture_files(tmp_path, files)
    (tmp_path / "alias.c").symlink_to(tmp_path / "main.c")
    with pytest.raises(WorkspaceError, match="符号链接"):
        runner.capture_files(tmp_path, ["alias.c"])
    outside = tmp_path.parent / f"outside-{uuid.uuid4().hex}"
    outside.mkdir()
    try:
        (outside / "main.c").write_text("int main(void) { return 0; }")
        (tmp_path / "linked").symlink_to(outside, target_is_directory=True)
        with pytest.raises(WorkspaceError):
            runner.capture_files(tmp_path, ["linked/main.c"])
    finally:
        (outside / "main.c").unlink()
        outside.rmdir()


def test_preview_confirmation_scope_staleness_and_idempotency(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "discover_compiler", lambda: "/trusted/compiler")
    scheduled = []
    monkeypatch.setattr(runner, "schedule_run", scheduled.append)
    with TestClient(app) as client:
        project_id, source = setup_project(client, monkeypatch, tmp_path)
        route = f"/api/projects/{project_id}/experiments"
        assert client.get(route + "/profiles").status_code == 404
        assert client.get(route + "/profiles", headers={"X-LearnFlow-Desktop-Token": "wrong"}).status_code == 404
        profiles = client.get(route + "/profiles", headers=HEADERS).json()["profiles"][0]
        assert profiles["filesystem_isolation"] is False
        first = preview(client, project_id)
        assert first.status_code == 200, first.text
        run = first.json()
        assert run["status"] == "proposed" and not scheduled
        assert "snapshot_path" not in run and "workspace_root" not in run
        assert preview(client, project_id).json()["id"] == run["id"]
        assert preview(client, project_id, stdin="5\n").status_code == 409
        confirm = route + f"/runs/{run['id']}/confirm"
        assert client.post(confirm, headers=HEADERS, json={"snapshot_hash": run["snapshot_hash"]}).status_code == 422
        assert client.post(confirm, headers=HEADERS, json={"snapshot_hash": run["snapshot_hash"], "acknowledge_trusted_local": False}).status_code == 422
        assert client.post(confirm, headers=HEADERS, json={"snapshot_hash": "a" * 64, "acknowledge_trusted_local": True}).status_code == 409
        (source / "main.c").write_text("int main(void) { return 0; }\n")
        stale = client.post(confirm, headers=HEADERS, json={"snapshot_hash": run["snapshot_hash"], "acknowledge_trusted_local": True})
        assert stale.status_code == 409 and not scheduled
        assert client.get(route + f"/runs/{run['id']}", headers=HEADERS).json()["status"] == "stale"
        with TestClient(app) as another:
            registered = another.post("/api/auth/register", json={
                "username": f"other_{uuid.uuid4().hex[:12]}", "password": "experiment-pass-123", "display_name": "Other",
                "education_stage": "undergraduate", "background": "C", "focus_areas": ["C"],
                "weekly_hours": 5, "preferred_modes": ["project"],
            })
            assert registered.status_code == 200, registered.text
            assert another.get(route + f"/runs/{run['id']}", headers=HEADERS).status_code == 404
        monkeypatch.setattr(settings, "desktop_mode", False)
        assert client.get(route + "/runs", headers=HEADERS).status_code == 404


def test_real_c_verify_persists_snapshot_results_and_zero_kernel_events(tmp_path, monkeypatch):
    if not runner.discover_compiler():
        pytest.skip("C compiler is unavailable")
    with TestClient(app) as client:
        project_id, source = setup_project(client, monkeypatch, tmp_path)
        original = (source / "main.c").read_bytes()
        run_response = preview(client, project_id, action="verify", stdin="", test_cases=[
            {"name": "正数", "stdin": "4\n", "expected_stdout": "8\n"},
            {"name": "负数", "stdin": "-3\n", "expected_stdout": "-6\n"},
        ])
        assert run_response.status_code == 200, run_response.text
        run = run_response.json()
        route = f"/api/projects/{project_id}/experiments/runs/{run['id']}"
        confirmation = {"snapshot_hash": run["snapshot_hash"], "acknowledge_trusted_local": True}
        response = client.post(route + "/confirm", headers=HEADERS, json=confirmation)
        assert response.status_code == 200, response.text
        finished = wait_result(client, project_id, run["id"])
        assert finished["status"] == "completed", finished
        assert finished["result"]["passed"] is True
        assert len(finished["result"]["steps"]) == 3
        assert finished["result"]["steps"][1]["stdout"] == "8\n"
        assert finished["result"]["learning_evidence"] is False
        assert finished["manifest"] == run["manifest"]
        assert finished["confirmed_at"] and finished["finished_at"]
        assert (source / "main.c").read_bytes() == original
        assert not (source / "experiment").exists()
        repeated = client.post(route + "/confirm", headers=HEADERS, json=confirmation).json()
        assert repeated["id"] == run["id"] and repeated["status"] == "completed"

        async def assert_events():
            async with async_session() as db:
                events = list((await db.execute(select(EvidenceEvent).where(
                    EvidenceEvent.project_id == project_id,
                    EvidenceEvent.event_type.in_(["experiment_run_started", "experiment_run_completed"]),
                ))).scalars())
                assert [event.event_type for event in events] == ["experiment_run_started", "experiment_run_completed"]
                mutations = list((await db.execute(select(KernelMutation).where(
                    KernelMutation.event_id.in_([event.id for event in events]),
                ))).scalars())
                assert mutations == []
        asyncio.run(assert_events())


def test_trusted_fixture_compile_failure_and_output_limit(tmp_path, monkeypatch):
    compiler = runner.discover_compiler()
    if not compiler:
        pytest.skip("C compiler is unavailable")
    monkeypatch.setattr(settings, "desktop_mode", True)
    monkeypatch.setattr(settings, "desktop_token", "test")
    snapshot = tmp_path / "source"
    snapshot.mkdir()
    (snapshot / "main.c").write_text("int main( { this is a controlled syntax error; }\n")
    request = {"compiler": compiler, "files": ["main.c"], "action": "run"}
    status, result = runner.run_snapshot(str(snapshot), request)
    assert status == "failed" and len(result["steps"]) == 1
    (snapshot / "main.c").write_text('#include <stdio.h>\nint main(void) { for(int i=0; i<100000; ++i) puts("bounded fixture output"); return 0; }\n')
    monkeypatch.setattr(runner, "MAX_OUTPUT_BYTES", 1024)
    status, result = runner.run_snapshot(str(snapshot), request)
    assert status == "output_limited", result
    assert len(result["steps"][-1]["stdout"].encode()) <= 1024
    (snapshot / "main.c").write_text("int main(void) { for(;;) {} }\n")
    monkeypatch.setattr(runner, "RUN_TIMEOUT_SECONDS", 0.1)
    status, result = runner.run_snapshot(str(snapshot), request)
    assert status == "timed_out" and result["steps"][-1]["timed_out"]


def test_trusted_fixture_syntax_build_and_visible_case_mismatch(tmp_path, monkeypatch):
    compiler = runner.discover_compiler()
    if not compiler:
        pytest.skip("C compiler is unavailable")
    monkeypatch.setattr(settings, "desktop_mode", True)
    monkeypatch.setattr(settings, "desktop_token", "test")
    snapshot = tmp_path / "source"
    snapshot.mkdir()
    (snapshot / "helper.h").write_text("int answer(void);\n")
    (snapshot / "helper.c").write_text('#include "helper.h"\nint answer(void) { return 42; }\n')
    (snapshot / "main.c").write_text('#include <stdio.h>\n#include "helper.h"\nint main(void) { printf("%d\\n", answer()); return 0; }\n')
    request = {"compiler": compiler, "files": ["main.c", "helper.c", "helper.h"], "action": "syntax"}
    for action in ["syntax", "build"]:
        status, result = runner.run_snapshot(str(snapshot), {**request, "action": action})
        assert status == "completed" and len(result["steps"]) == 1
        assert result["passed"] is None
    status, result = runner.run_snapshot(str(snapshot), {
        **request, "action": "verify",
        "test_cases": [{"name": "mismatch", "stdin": "", "expected_stdout": "43\n"}],
    })
    assert status == "failed" and result["passed"] is False
    assert result["steps"][-1]["stdout"] == "42\n"


def test_restart_marks_queued_run_interrupted_without_executing(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "discover_compiler", lambda: "/trusted/compiler")
    scheduled = []
    monkeypatch.setattr(runner, "schedule_run", scheduled.append)
    with TestClient(app) as client:
        project_id, _ = setup_project(client, monkeypatch, tmp_path)
        run = preview(client, project_id).json()
        route = f"/api/projects/{project_id}/experiments/runs/{run['id']}"
        response = client.post(route + "/confirm", headers=HEADERS, json={
            "snapshot_hash": run["snapshot_hash"], "acknowledge_trusted_local": True,
        })
        assert response.status_code == 200 and response.json()["status"] == "queued"
        assert scheduled == [run["id"]]
    with TestClient(app) as restarted:
        restarted.cookies.update(client.cookies)
        result = restarted.get(route, headers=HEADERS)
        assert result.status_code == 200, result.text
        assert result.json()["status"] == "interrupted"
        assert result.json()["finished_at"]
        assert scheduled == [run["id"]]
