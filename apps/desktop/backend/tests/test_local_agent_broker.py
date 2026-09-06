from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import time

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.core.config import settings
from app.db.database import async_session
from app.main import app
from app.models.learning import EvidenceEvent, KernelMutation
from app.models.project import (
    Checkpoint, LocalAgentProfile, LocalAgentRun, Project, Roadmap,
)
from app.services import local_agent_broker as broker
from app.services.local_agent_broker import CodexCliAdapter


DESKTOP_TOKEN = "local-agent-test-token"
HEADERS = {"X-LearnFlow-Desktop-Token": DESKTOP_TOKEN}


def run_git(root: Path, *args: str, env: dict[str, str] | None = None) -> str:
    git = shutil.which("git")
    assert git, "Git is required for local Agent isolation tests"
    controlled_env = dict(os.environ)
    controlled_env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})
    if env:
        controlled_env.update(env)
    result = subprocess.run(
        [git, "-C", str(root), *args], check=True, capture_output=True, text=True,
        env=controlled_env,
    )
    return result.stdout.strip()


def commit_all(root: Path, message: str, timestamp: str) -> str:
    run_git(root, "add", "-A", "--", ".")
    commit_env = {
        "GIT_AUTHOR_NAME": "Source Author",
        "GIT_AUTHOR_EMAIL": "source@example.test",
        "GIT_COMMITTER_NAME": "Source Author",
        "GIT_COMMITTER_EMAIL": "source@example.test",
        "GIT_AUTHOR_DATE": timestamp,
        "GIT_COMMITTER_DATE": timestamp,
    }
    run_git(
        root, "-c", "commit.gpgSign=false", "commit", "--quiet", "--no-verify",
        "-m", message, env=commit_env,
    )
    return run_git(root, "rev-parse", "HEAD")


def initialize_git_repository(root: Path) -> None:
    root.mkdir(parents=True)
    run_git(root, "init", "--quiet")


def git_state(root: Path) -> dict[str, str]:
    index_text = run_git(root, "rev-parse", "--git-path", "index")
    index_path = Path(index_text)
    if not index_path.is_absolute():
        index_path = root / index_path
    index_digest = hashlib.sha256(index_path.read_bytes()).hexdigest()
    return {
        "head": run_git(root, "rev-parse", "HEAD"),
        "index_sha256": index_digest,
        "reflog": run_git(root, "reflog", "show", "--all", "--format=%H%x09%gD%x09%gs"),
    }


def registration(username: str):
    return {
        "username": username,
        "password": "learnflow-pass-123",
        "display_name": username,
        "education_stage": "undergraduate",
        "background": "Python 基础",
        "focus_areas": ["工程实践"],
        "weekly_hours": 5,
        "preferred_modes": ["practice", "project"],
        "career_goal": "",
        "career_goal_status": "exploring",
    }


def enable_desktop_demo(monkeypatch, run_dir: Path):
    monkeypatch.setattr(settings, "desktop_mode", True)
    monkeypatch.setattr(settings, "desktop_token", DESKTOP_TOKEN)
    monkeypatch.setattr(settings, "competition_demo_mode", True)
    monkeypatch.setattr(settings, "local_agent_runs_dir", str(run_dir))


def seed_project(client: TestClient, root: Path) -> tuple[int, int]:
    project_response = client.post("/api/projects", json={
        "name": "Broker Test", "description": "isolated Agent", "user_level": "beginner",
    })
    assert project_response.status_code == 200
    project_id = project_response.json()["id"]

    async def seed_checkpoint():
        async with async_session() as db:
            project = await db.get(Project, project_id)
            roadmap = Roadmap(project_id=project.id, raw_json={})
            db.add(roadmap)
            await db.flush()
            checkpoint = Checkpoint(
                roadmap_id=roadmap.id, title="本地构建", description="Agent test", order=1,
                learning_status="in_progress",
            )
            db.add(checkpoint)
            await db.commit()
            return checkpoint.id

    checkpoint_id = asyncio.run(seed_checkpoint())
    linked = client.post(
        f"/api/projects/{project_id}/workspace/link", headers=HEADERS,
        json={"root_path": str(root), "platform": "test", "create": False, "client_request_id": f"broker-{project_id}"},
    )
    assert linked.status_code == 200, linked.text
    return project_id, checkpoint_id


def wait_for_run(client: TestClient, run_id: int) -> dict:
    for _ in range(100):
        response = client.get(f"/api/local-agent/runs/{run_id}", headers=HEADERS)
        assert response.status_code == 200, response.text
        data = response.json()
        if data["status"] in {"completed", "failed", "canceled", "stale", "applied"}:
            return data
        time.sleep(0.03)
    raise AssertionError("local Agent run did not finish")


def test_safe_snapshot_records_git_secrets_symlinks_and_manifest(tmp_path):
    root = tmp_path / "source"
    root.mkdir()
    (root / ".git").write_text("gitdir: /must/not/be/copied\n", encoding="utf-8")
    (root / ".env").write_text("SECRET=never-copy\n", encoding="utf-8")
    (root / "private.pem").write_text("private-key\n", encoding="utf-8")
    nested = root / "nested"
    (nested / ".git").mkdir(parents=True)
    (nested / ".git" / "config").write_text("source git metadata\n", encoding="utf-8")
    source_file = root / "src" / "main.py"
    source_file.parent.mkdir()
    source_file.write_text("print('safe')\n", encoding="utf-8")
    outside = tmp_path / "outside-secret.txt"
    outside.write_text("outside\n", encoding="utf-8")
    symlink_created = True
    try:
        (root / "linked-secret").symlink_to(outside)
    except OSError:
        symlink_created = False

    destination = tmp_path / "snapshot"
    manifest = broker._copy_safe_snapshot(root, destination)
    second_manifest = broker._copy_safe_snapshot(root, tmp_path / "snapshot-again")

    assert set(manifest["included"]) == {"src/main.py"}
    assert (destination / "src" / "main.py").read_text(encoding="utf-8") == "print('safe')\n"
    assert not (destination / ".git").exists()
    assert not (destination / "nested" / ".git").exists()
    assert not (destination / ".env").exists()
    assert not (destination / "private.pem").exists()
    if symlink_created:
        assert not (destination / "linked-secret").exists()

    skipped = {(entry["path"], entry["reason"]) for entry in manifest["skipped"]}
    assert (".git", "git_metadata") in skipped
    assert ("nested/.git", "git_metadata") in skipped
    assert (".env", "secret") in skipped
    assert ("private.pem", "secret") in skipped
    if symlink_created:
        assert ("linked-secret", "link_or_reparse") in skipped
    summary = manifest["summary"]
    assert summary["source_git_metadata_included"] is False
    assert summary["included_file_count"] == 1
    assert summary["included_total_bytes"] == len(b"print('safe')\n")
    assert len(summary["manifest_sha256"]) == 64
    assert summary["manifest_sha256"] == second_manifest["summary"]["manifest_sha256"]


def test_snapshot_enforces_file_count_and_total_byte_budgets(tmp_path, monkeypatch):
    root = tmp_path / "source"
    root.mkdir()
    (root / "a.txt").write_bytes(b"aaaa")
    (root / "b.txt").write_bytes(b"bbbb")
    (root / "c.txt").write_bytes(b"c")

    monkeypatch.setattr(broker, "MAX_SNAPSHOT_FILES", 1)
    monkeypatch.setattr(broker, "MAX_SNAPSHOT_TOTAL_BYTES", 100)
    count_manifest = broker._copy_safe_snapshot(root, tmp_path / "count-limited")
    assert set(count_manifest["included"]) == {"a.txt"}
    assert count_manifest["summary"]["included_file_count"] == 1
    assert count_manifest["summary"]["skipped_by_reason"]["file_count_budget_exceeded"] == 2
    assert count_manifest["summary"]["limits"]["max_file_count"] == 1

    monkeypatch.setattr(broker, "MAX_SNAPSHOT_FILES", 10)
    monkeypatch.setattr(broker, "MAX_SNAPSHOT_TOTAL_BYTES", 5)
    byte_manifest = broker._copy_safe_snapshot(root, tmp_path / "byte-limited")
    assert set(byte_manifest["included"]) == {"a.txt", "c.txt"}
    assert byte_manifest["summary"]["included_total_bytes"] == 5
    assert byte_manifest["summary"]["skipped_by_reason"]["total_bytes_budget_exceeded"] == 1
    assert byte_manifest["summary"]["limits"]["max_total_bytes"] == 5


def test_regular_git_repository_uses_fresh_deterministic_baseline(tmp_path, monkeypatch):
    source = tmp_path / "source-repository"
    initialize_git_repository(source)
    tracked = source / "tracked.txt"
    tracked.write_text("first\n", encoding="utf-8")
    first_source_commit = commit_all(source, "source first", "2024-01-01T00:00:00+00:00")
    tracked.write_text("second\n", encoding="utf-8")
    (source / ".gitignore").write_text("dirty.txt\n", encoding="utf-8")
    source_head = commit_all(source, "source second", "2024-01-02T00:00:00+00:00")
    assert first_source_commit != source_head
    run_git(source, "remote", "add", "origin", "https://example.invalid/source.git")
    (source / "dirty.txt").write_text("current disk snapshot\n", encoding="utf-8")
    before = git_state(source)
    monkeypatch.setattr(settings, "local_agent_runs_dir", str(tmp_path / "runs"))

    isolation, isolated_worktree, manifest = asyncio.run(broker._prepare_isolation(source, 101))
    _, second_worktree, second_manifest = asyncio.run(broker._prepare_isolation(source, 102))

    assert not (isolation / "base" / ".git").exists()
    assert (isolated_worktree / ".git").is_dir()
    assert run_git(isolated_worktree, "remote") == ""
    assert run_git(isolated_worktree, "rev-list", "--count", "HEAD") == "1"
    assert source_head not in run_git(isolated_worktree, "rev-list", "--all")
    assert run_git(isolated_worktree, "branch", "--show-current") == broker.ISOLATED_GIT_BRANCH
    assert run_git(
        isolated_worktree, "show", "-s", "--format=%an|%ae|%at|%s", "HEAD",
    ) == (
        "LearnFlow Broker|broker@localhost|946684800|"
        "LearnFlow isolated baseline"
    )
    assert (isolated_worktree / "tracked.txt").read_text(encoding="utf-8") == "second\n"
    assert (isolated_worktree / "dirty.txt").read_text(encoding="utf-8") == "current disk snapshot\n"
    assert run_git(isolated_worktree, "ls-files", "--error-unmatch", "dirty.txt") == "dirty.txt"
    assert manifest["git"]["source_history_included"] is False
    assert manifest["git"]["remote_count"] == 0
    assert manifest["git"]["baseline_commit"] == second_manifest["git"]["baseline_commit"]
    assert run_git(second_worktree, "remote") == ""
    assert manifest["summary"]["skipped_by_reason"]["git_metadata"] == 1
    assert git_state(source) == before
    assert run_git(source, "remote", "get-url", "origin") == "https://example.invalid/source.git"


def test_real_git_worktree_does_not_mutate_source_git_state(tmp_path, monkeypatch):
    repository = tmp_path / "repository"
    initialize_git_repository(repository)
    (repository / "tracked.txt").write_text("source worktree\n", encoding="utf-8")
    source_commit = commit_all(repository, "source baseline", "2024-02-01T00:00:00+00:00")
    run_git(repository, "remote", "add", "origin", "https://example.invalid/worktree.git")

    linked = tmp_path / "linked-worktree"
    run_git(repository, "worktree", "add", "--quiet", "-b", "linked-branch", str(linked))
    assert (linked / ".git").is_file()
    git_pointer_before = (linked / ".git").read_text(encoding="utf-8")
    source_git_dir = Path(git_pointer_before.removeprefix("gitdir:").strip()).resolve()
    (linked / "untracked.txt").write_text("included current file\n", encoding="utf-8")
    (linked / ".env").write_text("SECRET=not-in-snapshot\n", encoding="utf-8")
    before = git_state(linked)
    monkeypatch.setattr(settings, "local_agent_runs_dir", str(tmp_path / "runs"))

    isolation, isolated_worktree, manifest = asyncio.run(broker._prepare_isolation(linked, 201))

    assert (linked / ".git").read_text(encoding="utf-8") == git_pointer_before
    assert git_state(linked) == before
    assert before["head"] == source_commit
    assert not (isolation / "base" / ".git").exists()
    assert (isolated_worktree / ".git").is_dir()
    isolated_git_dir = Path(run_git(isolated_worktree, "rev-parse", "--absolute-git-dir")).resolve()
    assert isolated_git_dir.is_relative_to(isolated_worktree.resolve())
    assert isolated_git_dir != source_git_dir
    assert run_git(isolated_worktree, "remote") == ""
    assert run_git(isolated_worktree, "rev-list", "--count", "HEAD") == "1"
    assert source_commit not in run_git(isolated_worktree, "rev-list", "--all")
    assert (isolated_worktree / "untracked.txt").read_text(encoding="utf-8") == "included current file\n"
    assert not (isolated_worktree / ".env").exists()
    assert manifest["summary"]["skipped_by_reason"]["git_metadata"] == 1
    assert manifest["summary"]["skipped_by_reason"]["secret"] == 1
    isolated_control_text = "\n".join(
        path.read_text(encoding="utf-8", errors="ignore")
        for path in (isolated_git_dir / "config", isolated_git_dir / "HEAD", isolated_git_dir / "logs" / "HEAD")
    )
    assert str(source_git_dir) not in isolated_control_text


def test_seeded_agent_requires_two_confirmations_and_writes_zero_kernel_events(tmp_path, monkeypatch):
    enable_desktop_demo(monkeypatch, tmp_path / "runs")
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "main.txt").write_text("original\n", encoding="utf-8")
    (root / ".env").write_text("SECRET=not-copied\n", encoding="utf-8")
    symlink_supported = True
    try:
        (root / "linked-secret").symlink_to(root / ".env")
    except OSError:
        symlink_supported = False

    with TestClient(app) as client:
        registered = client.post("/api/auth/register", json=registration("broker_two_confirmations"))
        assert registered.status_code == 200
        learner_id = registered.json()["learner_id"]
        project_id, checkpoint_id = seed_project(client, root)
        profiles = client.get("/api/desktop/agent-profiles", headers=HEADERS)
        assert profiles.status_code == 200
        fake = next(item for item in profiles.json() if item["adapter"] == "deterministic_fake")
        assert fake["network_policy"] == "managed_off"
        assert fake["last_probe"]["network_boundary_enforced"] is True

        session = client.post("/api/agent/sessions", json={
            "session_type": "checkpoint", "project_id": project_id, "checkpoint_id": checkpoint_id,
        }).json()
        proposal = client.post(f"/api/agent/sessions/{session['id']}/turns", json={
            "message": "请让本地 Agent 修改项目文件并补一个演示结果",
            "project_id": project_id, "checkpoint_id": checkpoint_id,
        })
        assert proposal.status_code == 200, proposal.text
        card = proposal.json()["action_card"]
        assert card["status"] == "pending_confirmation"
        assert card["target_summary"]["profile_name"] == "Seeded Demo Agent"
        assert card["target_summary"]["network_policy"] == "managed_off"
        assert not (root / "learnflow-seeded-agent.md").exists()

        without_token = client.post(f"/api/agent/actions/{card['id']}/confirm")
        assert without_token.status_code == 404
        confirmed = client.post(f"/api/agent/actions/{card['id']}/confirm", headers=HEADERS)
        assert confirmed.status_code == 200, confirmed.text
        run_id = confirmed.json()["executed_action"]["result"]["local_agent_run"]["id"]
        finished = wait_for_run(client, run_id)
        assert finished["status"] == "completed", finished
        assert finished["result"]["requires_second_confirmation"] is True
        assert finished["result"]["snapshot"]["summary"]["source_git_metadata_included"] is False
        assert finished["result"]["snapshot"]["summary"]["included_file_count"] == 1
        assert finished["result"]["snapshot"]["git"]["source_history_included"] is False
        assert finished["result"]["snapshot"]["git"]["remote_count"] == 0
        assert finished["changed_files"][0]["path"] == "learnflow-seeded-agent.md"
        assert not (root / "learnflow-seeded-agent.md").exists()

        async def inspect_isolation_and_events():
            async with async_session() as db:
                run = await db.get(LocalAgentRun, run_id)
                isolation = Path(run.isolation_root)
                event_count = (await db.execute(select(func.count(EvidenceEvent.id)).where(
                    EvidenceEvent.learner_id == learner_id,
                    EvidenceEvent.event_type.in_(["local_agent_started", "local_agent_completed"]),
                ))).scalar_one()
                kernel_count = (await db.execute(select(func.count(KernelMutation.id)).where(
                    KernelMutation.learner_id == learner_id,
                ))).scalar_one()
                return isolation, event_count, kernel_count

        isolation, event_count, kernel_count_before_apply = asyncio.run(inspect_isolation_and_events())
        assert not (isolation / "base" / ".env").exists()
        assert not (isolation / "worktree" / ".env").exists()
        if symlink_supported:
            assert not (isolation / "base" / "linked-secret").exists()
        assert event_count == 2

        refused = client.post(f"/api/local-agent/runs/{run_id}/apply", headers=HEADERS, json={
            "confirm_apply": False, "confirmed_deletions": [], "confirmed_moves": [],
            "idempotency_key": "refused-apply",
        })
        assert refused.status_code == 400
        assert not (root / "learnflow-seeded-agent.md").exists()

        applied = client.post(f"/api/local-agent/runs/{run_id}/apply", headers=HEADERS, json={
            "confirm_apply": True, "confirmed_deletions": [], "confirmed_moves": [],
            "idempotency_key": "accepted-apply",
        })
        assert applied.status_code == 200, applied.text
        assert applied.json()["status"] == "applied"
        assert (root / "learnflow-seeded-agent.md").exists()

        async def kernel_count():
            async with async_session() as db:
                return (await db.execute(select(func.count(KernelMutation.id)).where(
                    KernelMutation.learner_id == learner_id,
                ))).scalar_one()

        assert asyncio.run(kernel_count()) == kernel_count_before_apply


def test_apply_rejects_stale_workspace_and_preserves_user_content(tmp_path, monkeypatch):
    enable_desktop_demo(monkeypatch, tmp_path / "runs")
    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "learnflow-seeded-agent.md"
    target.write_text("baseline\n", encoding="utf-8")

    with TestClient(app) as client:
        assert client.post("/api/auth/register", json=registration("broker_stale_guard")).status_code == 200
        project_id, checkpoint_id = seed_project(client, root)
        client.get("/api/desktop/agent-profiles", headers=HEADERS)
        session = client.post("/api/agent/sessions", json={
            "session_type": "checkpoint", "project_id": project_id, "checkpoint_id": checkpoint_id,
        }).json()
        proposed = client.post(f"/api/agent/sessions/{session['id']}/turns", json={
            "message": "请让本地 Agent 修改项目文件",
            "project_id": project_id, "checkpoint_id": checkpoint_id,
        }).json()["action_card"]
        confirmed = client.post(f"/api/agent/actions/{proposed['id']}/confirm", headers=HEADERS).json()
        run_id = confirmed["executed_action"]["result"]["local_agent_run"]["id"]
        assert wait_for_run(client, run_id)["status"] == "completed"
        target.write_text("user changed after run\n", encoding="utf-8")
        stale = client.post(f"/api/local-agent/runs/{run_id}/apply", headers=HEADERS, json={
            "confirm_apply": True, "confirmed_deletions": [], "confirmed_moves": [],
            "idempotency_key": "stale-apply",
        })
        assert stale.status_code == 409
        assert target.read_text(encoding="utf-8") == "user changed after run\n"
        assert client.get(f"/api/local-agent/runs/{run_id}", headers=HEADERS).json()["status"] == "stale"


def test_delete_requires_separate_confirmation_and_batch_failure_rolls_back(tmp_path, monkeypatch):
    enable_desktop_demo(monkeypatch, tmp_path / "runs")
    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "remove-me.txt"
    target.write_text("keep until second confirmation\n", encoding="utf-8")

    with TestClient(app) as client:
        registered = client.post("/api/auth/register", json=registration("broker_delete_confirm"))
        assert registered.status_code == 200
        learner_id = registered.json()["learner_id"]
        project_id, checkpoint_id = seed_project(client, root)
        session_response = client.post("/api/agent/sessions", json={
            "session_type": "checkpoint", "project_id": project_id, "checkpoint_id": checkpoint_id,
        }).json()

        async def seed_completed_run():
            async with async_session() as db:
                profile = LocalAgentProfile(
                    learner_id=learner_id, name="Manual Test Profile", adapter="deterministic_fake",
                    enabled=True, priority=10, task_types=["code_change"], capabilities=["code_edit"],
                    sandbox_policy="workspace_write", network_policy="managed_off", timeout_seconds=60,
                )
                db.add(profile)
                await db.flush()
                from app.models.learning import AgentAction
                action = AgentAction(
                    session_id=session_response["id"], learner_id=learner_id,
                    project_id=project_id, checkpoint_id=checkpoint_id,
                    capability="delegate_local_agent_task", status="completed",
                    side_effect="execution", confirmation_policy="explicit", target={},
                )
                db.add(action)
                await db.flush()
                run = LocalAgentRun(
                    learner_id=learner_id, project_id=project_id, checkpoint_id=checkpoint_id,
                    session_id=session_response["id"], action_id=action.id, profile_id=profile.id,
                    task_type="code_change", goal="delete", status="completed",
                    idempotency_key=f"manual-delete:{project_id}",
                    changed_files=[{
                        "operation": "delete", "path": "remove-me.txt",
                        "base_hash": broker.sha256_file(target), "new_hash": None,
                        "requires_separate_confirmation": True,
                    }],
                )
                db.add(run)
                await db.commit()
                return run.id

        run_id = asyncio.run(seed_completed_run())
        missing_confirmation = client.post(f"/api/local-agent/runs/{run_id}/apply", headers=HEADERS, json={
            "confirm_apply": True, "confirmed_deletions": [], "confirmed_moves": [],
            "idempotency_key": "missing-delete-confirmation",
        })
        assert missing_confirmation.status_code == 400
        assert target.exists()

        original_apply = broker.apply_operation
        def fail_after_delete(*args, **kwargs):
            original_apply(*args, **kwargs)
            raise RuntimeError("simulated batch failure")
        monkeypatch.setattr(broker, "apply_operation", fail_after_delete)
        failed = client.post(f"/api/local-agent/runs/{run_id}/apply", headers=HEADERS, json={
            "confirm_apply": True, "confirmed_deletions": ["remove-me.txt"], "confirmed_moves": [],
            "idempotency_key": "confirmed-delete",
        })
        assert failed.status_code == 500
        assert target.read_text(encoding="utf-8") == "keep until second confirmation\n"


def test_profile_contract_rejects_fake_shell_templates_and_false_network_claims(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "desktop_mode", True)
    monkeypatch.setattr(settings, "desktop_token", DESKTOP_TOKEN)
    monkeypatch.setattr(settings, "competition_demo_mode", False)
    with TestClient(app) as client:
        assert client.post("/api/auth/register", json=registration("broker_profile_contract")).status_code == 200
        fake = client.post("/api/desktop/agent-profiles", headers=HEADERS, json={
            "name": "not allowed", "adapter": "deterministic_fake",
            "network_policy": "managed_off", "executable_path": "/bin/sh -c anything",
        })
        assert fake.status_code in {403, 422}
        false_offline = client.post("/api/desktop/agent-profiles", headers=HEADERS, json={
            "name": "false offline", "adapter": "codex_cli", "network_policy": "managed_off",
        })
        assert false_offline.status_code == 422
        missing = client.post("/api/desktop/agent-profiles", headers=HEADERS, json={
            "name": "missing codex", "adapter": "codex_cli", "network_policy": "unmanaged",
            "executable_path": str(tmp_path / "missing-codex"),
        })
        assert missing.status_code == 200
        assert missing.json()["last_probe"]["available"] is False
        assert missing.json()["last_probe"]["network_policy"] == "unmanaged"
        assert missing.json()["last_probe"]["network_boundary_enforced"] is False
        assert missing.json()["last_probe"]["host_read_policy"] == "unmanaged"
        assert missing.json()["last_probe"]["host_read_boundary_enforced"] is False


def test_codex_adapter_uses_fixed_argument_array_without_shell(monkeypatch, tmp_path):
    captured: dict = {}

    class FakeStdin:
        def write(self, value): captured["prompt"] = value
        async def drain(self): return None
        def close(self): captured["closed"] = True

    class FakeProcess:
        stdin = FakeStdin()

    async def fake_exec(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return FakeProcess()

    executable = tmp_path / "codex"
    executable.write_text("#!/bin/sh\n", encoding="utf-8")
    executable.chmod(0o700)
    profile = LocalAgentProfile(
        learner_id=1, name="Codex", adapter="codex_cli", executable_path=str(executable),
        network_policy="unmanaged", sandbox_policy="workspace_write",
    )
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    asyncio.run(CodexCliAdapter().start(profile, tmp_path, "do the task"))
    assert captured["args"] == (
        str(executable.resolve()), "exec", "--json", "--sandbox", "workspace-write",
        "-C", str(tmp_path), "-",
    )
    assert "shell" not in captured["kwargs"]
    assert captured["kwargs"]["stderr"] == asyncio.subprocess.STDOUT
    assert captured["prompt"] == b"do the task"
