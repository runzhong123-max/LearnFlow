"""Fail-closed Python execution for explicitly trusted local development."""
import os
import sys
import tempfile
from typing import Dict

from app.services.execution_policy import (
    ExecutionPolicyError,
    require_trusted_local_execution,
    run_trusted_local_process,
)


MAX_EXECUTION_TIME = 10  # seconds
MAX_OUTPUT_SIZE = 100 * 1024  # 100KB
MAX_CODE_SIZE = 256 * 1024  # bytes
MAX_INPUT_SIZE = 64 * 1024  # bytes


def _python_command(script_path: str) -> list[str]:
    """Build the command that executes a Python script.

    In a source checkout ``sys.executable`` is Python.  In the packaged desktop
    app it is the PyInstaller sidecar, so launching it with a ``.py`` argument
    starts the API parser instead of running the script.  The sidecar exposes a
    small, explicit script mode for that frozen-runtime fallback.
    """
    try:
        from app.services.project_runner import venv_dir
        candidates = (
            os.path.join(venv_dir(), "Scripts", "python.exe"),
            os.path.join(venv_dir(), "bin", "python"),
        )
        for candidate in candidates:
            if os.path.isfile(candidate):
                return [candidate, script_path]
    except Exception:
        pass
    if getattr(sys, "frozen", False):
        return [sys.executable, "--run-python-script", script_path]
    return [sys.executable, script_path]


def execute_code(
    code: str,
    test_input: str = "",
    timeout: int = MAX_EXECUTION_TIME,
) -> Dict:
    """Execute Python in an ordinary host process only under explicit policy.

    Returns:
        A bounded process result that truthfully identifies the host boundary
        and the lack of filesystem, network, or secrets isolation.
    """
    policy_fields = require_trusted_local_execution("python_code_execution")
    code_bytes = str(code or "").encode("utf-8")
    input_bytes = str(test_input or "").encode("utf-8")
    if len(code_bytes) > MAX_CODE_SIZE:
        raise ExecutionPolicyError(
            code="code_size_limit_exceeded",
            message=f"代码超过允许的 {MAX_CODE_SIZE} 字节上限。",
            status_code=413,
        )
    if len(input_bytes) > MAX_INPUT_SIZE:
        raise ExecutionPolicyError(
            code="input_size_limit_exceeded",
            message=f"标准输入超过允许的 {MAX_INPUT_SIZE} 字节上限。",
            status_code=413,
        )
    try:
        requested_timeout = float(timeout)
    except (TypeError, ValueError):
        requested_timeout = float(MAX_EXECUTION_TIME)
    effective_timeout = min(max(requested_timeout, 0.1), float(MAX_EXECUTION_TIME))

    try:
        with tempfile.TemporaryDirectory(
            prefix="learnflow-code-",
            ignore_cleanup_errors=True,
        ) as workdir:
            fpath = os.path.join(workdir, "main.py")
            with open(fpath, "w", encoding="utf-8") as script:
                script.write(str(code or ""))
            result = run_trusted_local_process(
                _python_command(fpath),
                operation="python_code_execution",
                cwd=workdir,
                input_text=str(test_input or ""),
                timeout=effective_timeout,
                max_output_bytes=MAX_OUTPUT_SIZE,
                policy_fields=policy_fields,
            )
            if not result.get("started"):
                raise ExecutionPolicyError(
                    code=str(result.get("error_code") or "process_start_failed"),
                    message="本地开发执行进程未能启动。",
                )
            result["limits"] = {
                "timeout_seconds": effective_timeout,
                "max_output_bytes": MAX_OUTPUT_SIZE,
                "max_code_bytes": MAX_CODE_SIZE,
                "max_input_bytes": MAX_INPUT_SIZE,
            }
            return result
    except ExecutionPolicyError:
        raise
    except Exception as exc:
        raise ExecutionPolicyError(
            code="execution_preparation_failed",
            message=f"本地开发执行准备失败: {type(exc).__name__}。",
        ) from exc
