"""Fail-closed policy for executing untrusted Python in local development.

LearnFlow does not provide an isolation boundary for Python execution.  The
only supported opt-in runs a normal host process for trusted local
development, with bounded I/O and best-effort process-group cleanup.
"""
from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from typing import Any, Sequence

from fastapi import HTTPException


EXECUTION_ENV_VAR = "LEARNFLOW_EXECUTION_ENVIRONMENT"
EXECUTION_POLICY_VAR = "LEARNFLOW_CODE_EXECUTION_POLICY"
PIP_INSTALL_VAR = "LEARNFLOW_TRUSTED_LOCAL_PIP_INSTALL"

DEVELOPMENT_ENVIRONMENT = "development"
TRUSTED_LOCAL_PROCESS = "trusted_local_process"
NOT_EXECUTED = "not_executed"
UNSUPPORTED_CODE = "code_execution_unsupported"

_TRUE_VALUES = {"1", "true", "yes", "on"}
_SAFE_PARENT_ENV_KEYS = {
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "TZ",
    "WINDIR",
}


def _normalized_env(name: str) -> str:
    return str(os.environ.get(name, "") or "").strip().casefold()


def _isolation_fields() -> dict[str, Any]:
    return {
        "filesystem_isolation": False,
        "network_isolation": False,
        "secrets_isolation": False,
        "environment_sanitization": "allowlist_only",
    }


def execution_policy_status() -> dict[str, Any]:
    """Return the current operator policy without executing anything."""
    environment = _normalized_env(EXECUTION_ENV_VAR)
    requested_policy = _normalized_env(EXECUTION_POLICY_VAR)
    enabled = (
        environment == DEVELOPMENT_ENVIRONMENT
        and requested_policy == TRUSTED_LOCAL_PROCESS
    )
    if enabled:
        reason_code = "trusted_local_development_enabled"
    elif environment != DEVELOPMENT_ENVIRONMENT:
        reason_code = "development_environment_required"
    else:
        reason_code = "trusted_local_policy_not_enabled"
    return {
        "enabled": enabled,
        "status": "enabled" if enabled else "unsupported",
        "code": reason_code if enabled else UNSUPPORTED_CODE,
        "execution_policy": (
            "trusted_local_development" if enabled else "disabled"
        ),
        "execution_boundary": TRUSTED_LOCAL_PROCESS if enabled else NOT_EXECUTED,
        "requested_boundary": TRUSTED_LOCAL_PROCESS,
        "environment": environment or "unspecified",
        "dependency_install_enabled": (
            enabled and _normalized_env(PIP_INSTALL_VAR) in _TRUE_VALUES
        ),
        **_isolation_fields(),
    }


def execution_boundary_fields(*, executed: bool) -> dict[str, Any]:
    """Return truthful fields for an execution result or refusal."""
    status = execution_policy_status()
    return {
        "execution_policy": status["execution_policy"],
        "execution_boundary": TRUSTED_LOCAL_PROCESS if executed else NOT_EXECUTED,
        "requested_boundary": TRUSTED_LOCAL_PROCESS,
        **_isolation_fields(),
    }


def unsupported_detail(
    *,
    code: str = UNSUPPORTED_CODE,
    message: str | None = None,
    executed: bool = False,
) -> dict[str, Any]:
    return {
        "code": code,
        "status": "unsupported",
        "message": message or (
            "代码执行默认关闭；仅操作员明确启用 trusted-local development policy "
            "后才允许普通宿主进程执行。"
        ),
        **execution_boundary_fields(executed=executed),
    }


class ExecutionPolicyError(HTTPException):
    """Stable HTTP-compatible refusal used by API and background callers."""

    def __init__(
        self,
        *,
        code: str = UNSUPPORTED_CODE,
        message: str | None = None,
        status_code: int = 503,
        executed: bool = False,
    ) -> None:
        self.error_code = code
        super().__init__(
            status_code=status_code,
            detail=unsupported_detail(code=code, message=message, executed=executed),
        )


def _log_policy(operation: str, status: str, boundary: str, **fields: Any) -> None:
    rendered = " ".join(
        f"{key}={str(value).casefold() if isinstance(value, bool) else value}"
        for key, value in fields.items()
    )
    print(
        "[execution_policy] "
        f"operation={operation} status={status} execution_boundary={boundary} "
        "filesystem_isolation=false network_isolation=false secrets_isolation=false"
        + (f" {rendered}" if rendered else ""),
        flush=True,
    )


def require_trusted_local_execution(operation: str) -> dict[str, Any]:
    """Refuse unless the operator explicitly selected the local dev policy."""
    status = execution_policy_status()
    if not status["enabled"]:
        _log_policy(
            operation,
            "unsupported",
            NOT_EXECUTED,
            code=UNSUPPORTED_CODE,
            environment=status["environment"],
        )
        raise ExecutionPolicyError()
    _log_policy(
        operation,
        "policy_allowed",
        TRUSTED_LOCAL_PROCESS,
        policy="trusted_local_development",
    )
    return execution_boundary_fields(executed=True)


def require_dependency_install(operation: str = "dependency_install") -> None:
    status = execution_policy_status()
    if not status["enabled"]:
        require_trusted_local_execution(operation)
    if _normalized_env(PIP_INSTALL_VAR) not in _TRUE_VALUES:
        _log_policy(
            operation,
            "unsupported",
            NOT_EXECUTED,
            code="dependency_install_unsupported",
        )
        raise ExecutionPolicyError(
            code="dependency_install_unsupported",
            message=(
                "trusted-local 代码执行已启用，但请求安装依赖仍被拒绝；"
                "依赖安装需要单独的显式开发开关。"
            ),
        )
    _log_policy(
        operation,
        "policy_allowed",
        TRUSTED_LOCAL_PROCESS,
        policy="trusted_local_development_with_dependency_install",
    )


def sanitized_subprocess_environment(workdir: str) -> dict[str, str]:
    """Build a minimal child environment without inheriting app credentials."""
    env = {
        key: value
        for key in _SAFE_PARENT_ENV_KEYS
        if (value := os.environ.get(key))
    }
    env.update({
        "HOME": workdir,
        "TMPDIR": workdir,
        "TMP": workdir,
        "TEMP": workdir,
        "XDG_CACHE_HOME": os.path.join(workdir, ".cache"),
        "XDG_CONFIG_HOME": os.path.join(workdir, ".config"),
        "XDG_DATA_HOME": os.path.join(workdir, ".local", "share"),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONNOUSERSITE": "1",
        "PYTHONUNBUFFERED": "1",
    })
    if os.name == "nt":
        env["USERPROFILE"] = workdir
    return env


class _BoundedOutput:
    def __init__(self, limit: int) -> None:
        self.limit = max(1, int(limit))
        self.total = 0
        self.parts: dict[str, list[bytes]] = {"stdout": [], "stderr": []}
        self.exceeded = threading.Event()
        self._lock = threading.Lock()

    def add(self, stream_name: str, chunk: bytes) -> None:
        with self._lock:
            remaining = max(0, self.limit - self.total)
            if remaining:
                kept = chunk[:remaining]
                self.parts[stream_name].append(kept)
                self.total += len(kept)
            if len(chunk) > remaining:
                self.exceeded.set()

    def text(self, stream_name: str) -> str:
        return b"".join(self.parts[stream_name]).decode("utf-8", errors="replace")


def _drain_pipe(pipe: Any, stream_name: str, output: _BoundedOutput) -> None:
    try:
        while True:
            chunk = pipe.read(8192)
            if not chunk:
                return
            output.add(stream_name, chunk)
    except (OSError, ValueError):
        return


def _write_stdin(pipe: Any, input_bytes: bytes) -> None:
    try:
        if input_bytes:
            pipe.write(input_bytes)
            pipe.flush()
    except (BrokenPipeError, OSError, ValueError):
        pass
    finally:
        try:
            pipe.close()
        except (OSError, ValueError):
            pass


def _process_group_exists(process_group_id: int) -> bool:
    if os.name == "nt":
        return False
    try:
        os.killpg(process_group_id, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _terminate_process_group(process: subprocess.Popen[bytes]) -> None:
    """Terminate the leader and same-group descendants, then force cleanup."""
    if os.name == "nt":
        try:
            process.send_signal(signal.CTRL_BREAK_EVENT)
        except OSError:
            try:
                process.terminate()
            except OSError:
                pass
        if process.poll() is None:
            try:
                process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                try:
                    process.kill()
                except OSError:
                    pass
        return

    process_group_id = process.pid
    try:
        os.killpg(process_group_id, signal.SIGTERM)
    except ProcessLookupError:
        return
    except PermissionError:
        try:
            process.kill()
        except OSError:
            pass
    if process.poll() is None:
        try:
            process.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            pass
    deadline = time.monotonic() + 0.1
    while time.monotonic() < deadline:
        if not _process_group_exists(process_group_id):
            return
        time.sleep(0.01)
    try:
        os.killpg(process_group_id, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            if process.poll() is None:
                process.kill()
        except OSError:
            pass


def run_trusted_local_process(
    command: Sequence[str],
    *,
    operation: str,
    cwd: str,
    input_text: str = "",
    timeout: float,
    max_output_bytes: int,
    policy_fields: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run a bounded host process and clean up its process group."""
    boundary = policy_fields or require_trusted_local_execution(operation)
    input_bytes = input_text.encode("utf-8")
    output = _BoundedOutput(max_output_bytes)
    process: subprocess.Popen[bytes] | None = None
    started_at = time.monotonic()
    timed_out = False
    output_limited = False
    start_error = ""

    popen_kwargs: dict[str, Any] = {
        "cwd": cwd,
        "env": sanitized_subprocess_environment(cwd),
        "stdin": subprocess.PIPE,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": False,
        "shell": False,
    }
    if os.name == "nt":
        popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        popen_kwargs["start_new_session"] = True

    try:
        process = subprocess.Popen([str(item) for item in command], **popen_kwargs)
    except Exception as exc:
        start_error = f"{type(exc).__name__}: {exc}"
        _log_policy(
            operation,
            "start_failed",
            NOT_EXECUTED,
            code="process_start_failed",
        )
        return {
            "stdout": "",
            "stderr": f"执行进程启动失败: {start_error}",
            "exit_code": -1,
            "timed_out": False,
            "output_limited": False,
            "elapsed": round(time.monotonic() - started_at, 3),
            "started": False,
            "error_code": "process_start_failed",
            **execution_boundary_fields(executed=False),
        }

    readers = [
        threading.Thread(
            target=_drain_pipe,
            args=(process.stdout, "stdout", output),
            daemon=True,
        ),
        threading.Thread(
            target=_drain_pipe,
            args=(process.stderr, "stderr", output),
            daemon=True,
        ),
    ]
    writer = threading.Thread(
        target=_write_stdin,
        args=(process.stdin, input_bytes),
        daemon=True,
    )
    for thread in readers:
        thread.start()
    writer.start()

    deadline = started_at + max(0.1, float(timeout))
    try:
        while process.poll() is None:
            if output.exceeded.is_set():
                output_limited = True
                _terminate_process_group(process)
                break
            if time.monotonic() >= deadline:
                timed_out = True
                _terminate_process_group(process)
                break
            time.sleep(0.01)
        try:
            process.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            timed_out = True
            _terminate_process_group(process)
            process.wait(timeout=1.0)
    finally:
        # A script may exit after spawning a same-group child. Always remove
        # remaining members before the temporary working directory is cleaned.
        if _process_group_exists(process.pid):
            _terminate_process_group(process)
        writer.join(timeout=1.0)
        for thread in readers:
            thread.join(timeout=1.0)

    output_limited = output_limited or output.exceeded.is_set()
    stdout = output.text("stdout")
    stderr = output.text("stderr")
    elapsed = round(time.monotonic() - started_at, 3)
    status = "timed_out" if timed_out else "output_limited" if output_limited else "completed"
    _log_policy(
        operation,
        status,
        TRUSTED_LOCAL_PROCESS,
        elapsed=elapsed,
        exit_code=process.returncode,
    )
    return {
        "stdout": stdout,
        "stderr": stderr,
        "exit_code": process.returncode,
        "timed_out": timed_out,
        "output_limited": output_limited,
        "elapsed": elapsed,
        "started": True,
        "error_code": (
            "execution_timeout" if timed_out
            else "output_limit_exceeded" if output_limited
            else None
        ),
        **boundary,
    }
