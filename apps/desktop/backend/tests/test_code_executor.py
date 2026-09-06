import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from app.services import code_executor, execution_policy, project_runner, task_runners
from app.services.execution_policy import (
    EXECUTION_ENV_VAR,
    EXECUTION_POLICY_VAR,
    PIP_INSTALL_VAR,
    ExecutionPolicyError,
)


def enable_trusted_local(monkeypatch):
    monkeypatch.setenv(EXECUTION_ENV_VAR, "development")
    monkeypatch.setenv(EXECUTION_POLICY_VAR, "trusted_local_process")
    monkeypatch.delenv(PIP_INSTALL_VAR, raising=False)


def test_frozen_executor_uses_sidecar_script_mode(tmp_path, monkeypatch):
    monkeypatch.setattr(project_runner, "venv_dir", lambda: str(tmp_path / "missing-runtime"))
    monkeypatch.setattr(code_executor.sys, "frozen", True, raising=False)
    monkeypatch.setattr(code_executor.sys, "executable", "/Applications/LearnFlow.app/backend")

    assert code_executor._python_command("/tmp/exercise.py") == [
        "/Applications/LearnFlow.app/backend",
        "--run-python-script",
        "/tmp/exercise.py",
    ]


def test_desktop_sidecar_script_mode_executes_python(tmp_path):
    script = tmp_path / "answer.py"
    script.write_text("value = input().strip()\nprint(value.upper())\n", encoding="utf-8")
    entrypoint = Path(__file__).parents[1] / "desktop_entry.py"

    result = subprocess.run(
        [sys.executable, str(entrypoint), "--run-python-script", str(script)],
        input="learnflow\n",
        capture_output=True,
        text=True,
        timeout=10,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout == "LEARNFLOW\n"


def test_executor_is_fail_closed_by_default(monkeypatch):
    monkeypatch.delenv(EXECUTION_ENV_VAR, raising=False)
    monkeypatch.delenv(EXECUTION_POLICY_VAR, raising=False)

    def forbidden_process(*args, **kwargs):
        raise AssertionError("disabled execution must not create a process")

    monkeypatch.setattr(execution_policy.subprocess, "Popen", forbidden_process)
    with pytest.raises(ExecutionPolicyError) as caught:
        code_executor.execute_code("print('must not run')")

    assert caught.value.status_code == 503
    assert caught.value.detail["code"] == "code_execution_unsupported"
    assert caught.value.detail["execution_boundary"] == "not_executed"
    assert caught.value.detail["filesystem_isolation"] is False
    assert caught.value.detail["network_isolation"] is False
    assert caught.value.detail["secrets_isolation"] is False


def test_production_marker_cannot_be_overridden_by_execution_opt_in(monkeypatch):
    monkeypatch.setenv(EXECUTION_ENV_VAR, "production")
    monkeypatch.setenv(EXECUTION_POLICY_VAR, "trusted_local_process")

    def forbidden_process(*args, **kwargs):
        raise AssertionError("production must never create a code process")

    monkeypatch.setattr(execution_policy.subprocess, "Popen", forbidden_process)
    with pytest.raises(ExecutionPolicyError) as caught:
        code_executor.execute_code("print('must not run')")

    assert caught.value.status_code == 503
    assert caught.value.detail["code"] == "code_execution_unsupported"


def test_explicit_dev_policy_runs_with_truthful_boundary_and_scrubbed_env(monkeypatch):
    enable_trusted_local(monkeypatch)
    monkeypatch.setenv("LEARNFLOW_TEST_SECRET", "must-not-reach-child")
    result = code_executor.execute_code(
        "import os\nvalue = int(input())\nprint(value * 2)\n"
        "print(os.environ.get('LEARNFLOW_TEST_SECRET', 'missing'))",
        test_input="21\n",
    )

    assert result["exit_code"] == 0
    assert result["stdout"].splitlines() == ["42", "missing"]
    assert result["execution_boundary"] == "trusted_local_process"
    assert result["filesystem_isolation"] is False
    assert result["network_isolation"] is False
    assert result["secrets_isolation"] is False
    assert result["environment_sanitization"] == "allowlist_only"


def test_process_start_failure_is_503_not_a_learner_result(monkeypatch):
    enable_trusted_local(monkeypatch)

    def unavailable_process(*args, **kwargs):
        raise OSError("interpreter unavailable")

    monkeypatch.setattr(execution_policy.subprocess, "Popen", unavailable_process)
    with pytest.raises(ExecutionPolicyError) as caught:
        code_executor.execute_code("print(1)")

    assert caught.value.status_code == 503
    assert caught.value.detail["code"] == "process_start_failed"
    assert caught.value.detail["execution_boundary"] == "not_executed"


def test_timeout_terminates_same_group_descendants(tmp_path, monkeypatch):
    enable_trusted_local(monkeypatch)
    pid_file = tmp_path / "child.pid"
    result = code_executor.execute_code(
        "import pathlib, subprocess, sys, time\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        f"pathlib.Path({str(pid_file)!r}).write_text(str(child.pid))\n"
        "while True: time.sleep(0.05)\n",
        timeout=0.25,
    )

    assert result["timed_out"] is True
    assert result["execution_boundary"] == "trusted_local_process"
    child_pid = int(pid_file.read_text(encoding="utf-8"))
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.02)
    else:
        pytest.fail(f"child process {child_pid} survived process-group cleanup")


def test_completed_parent_does_not_leave_background_child(tmp_path, monkeypatch):
    enable_trusted_local(monkeypatch)
    pid_file = tmp_path / "background-child.pid"
    result = code_executor.execute_code(
        "import pathlib, subprocess, sys\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        f"pathlib.Path({str(pid_file)!r}).write_text(str(child.pid))\n"
        "print('parent-done')\n",
        timeout=2,
    )

    assert result["exit_code"] == 0
    child_pid = int(pid_file.read_text(encoding="utf-8"))
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.02)
    else:
        pytest.fail(f"background child {child_pid} survived successful execution cleanup")


def test_output_limit_terminates_process(tmp_path, monkeypatch):
    del tmp_path
    enable_trusted_local(monkeypatch)
    monkeypatch.setattr(code_executor, "MAX_OUTPUT_SIZE", 1024)
    result = code_executor.execute_code(
        "import sys, time\n"
        "while True:\n"
        "    sys.stdout.write('x' * 2048)\n"
        "    sys.stdout.flush()\n"
        "    time.sleep(0.001)\n",
    )

    assert result["output_limited"] is True
    assert len(result["stdout"].encode("utf-8")) <= 1024
    assert result["error_code"] == "output_limit_exceeded"


def test_dependency_install_requires_separate_dev_switch(monkeypatch):
    enable_trusted_local(monkeypatch)
    monkeypatch.setattr(project_runner, "installed_requirements", lambda: [])
    monkeypatch.setattr(project_runner, "venv_ready", lambda: False)

    def forbidden_process(*args, **kwargs):
        raise AssertionError("pip/venv must not start without dependency opt-in")

    monkeypatch.setattr(execution_policy.subprocess, "Popen", forbidden_process)
    with pytest.raises(ExecutionPolicyError) as caught:
        project_runner.ensure_environment(["requests==2.32.0"])

    assert caught.value.status_code == 503
    assert caught.value.detail["code"] == "dependency_install_unsupported"
    assert caught.value.detail["execution_boundary"] == "not_executed"


def test_project_inputs_are_bounded_before_environment_setup(monkeypatch):
    enable_trusted_local(monkeypatch)
    files = [
        {"name": f"file-{index}.py", "content": ""}
        for index in range(project_runner.MAX_PROJECT_FILES + 1)
    ]
    with pytest.raises(ExecutionPolicyError) as caught:
        project_runner.run_project(1, files, "file-0.py")

    assert caught.value.status_code == 422
    assert caught.value.detail["code"] == "project_file_count_limit_exceeded"


def test_project_runner_requires_explicit_dev_policy_before_writes(tmp_path, monkeypatch):
    monkeypatch.delenv(EXECUTION_ENV_VAR, raising=False)
    monkeypatch.delenv(EXECUTION_POLICY_VAR, raising=False)

    def forbidden_root(*args, **kwargs):
        raise AssertionError("disabled project execution must not create runtime files")

    monkeypatch.setattr(project_runner, "runtime_root", forbidden_root)
    with pytest.raises(ExecutionPolicyError) as caught:
        project_runner.run_project(
            1,
            [{"name": "main.py", "content": "print(1)"}],
            "main.py",
        )

    assert caught.value.status_code == 503
    assert caught.value.detail["execution_boundary"] == "not_executed"


def test_project_runner_reports_real_host_boundary(tmp_path, monkeypatch):
    enable_trusted_local(monkeypatch)
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    monkeypatch.setattr(
        project_runner,
        "runtime_root",
        lambda *, create=False: str(runtime),
    )
    monkeypatch.setattr(project_runner, "_venv_python", lambda: sys.executable)
    monkeypatch.setattr(project_runner, "ensure_environment", lambda requirements: {
        "ready": True,
        "created": False,
        "installed": [],
        "execution_boundary": "not_executed",
    })

    result = project_runner.run_project(
        7,
        [{"name": "main.py", "content": "print('project-ok')"}],
        "main.py",
        timeout=2,
    )

    assert result["exit_code"] == 0
    assert result["stdout"].strip() == "project-ok"
    assert result["execution_boundary"] == "trusted_local_process"
    assert result["filesystem_isolation"] is False
    assert list((runtime / "workspaces").iterdir()) == []


def test_model_matplotlib_block_is_never_executed(tmp_path, monkeypatch):
    enable_trusted_local(monkeypatch)
    marker = tmp_path / "model-code-ran"

    def forbidden_process(*args, **kwargs):
        raise AssertionError("model-generated visual code must never create a process")

    monkeypatch.setattr(execution_policy.subprocess, "Popen", forbidden_process)
    rendered = task_runners._postprocess_section(
        "before\n```matplotlib\n"
        f"open({str(marker)!r}, 'w').write('bad')\n"
        "```\nafter",
        "",
        1,
        str(tmp_path),
    )

    assert not marker.exists()
    assert "视觉说明（unsupported）" in rendered
    assert "open(" not in rendered

    refusal = task_runners._render_matplotlib_block("print('never')", str(tmp_path), 0)
    assert refusal["execution_boundary"] == "not_executed"
    assert refusal["filesystem_isolation"] is False
    assert refusal["network_isolation"] is False
    assert refusal["secrets_isolation"] is False
