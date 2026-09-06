"""Fail-closed multi-file runner for trusted local development only."""
import os
import re
import sys
import tempfile
from pathlib import PurePosixPath
from typing import Dict, List, Optional

from app.core.config import settings
from app.services.execution_policy import (
    ExecutionPolicyError,
    execution_boundary_fields,
    require_dependency_install,
    require_trusted_local_execution,
    run_trusted_local_process,
)

MAX_EXECUTION_TIME = 60  # seconds
MAX_OUTPUT_SIZE = 200 * 1024  # 200KB
MAX_ENVIRONMENT_SETUP_TIME = 180  # seconds
MAX_PROJECT_FILES = 32
MAX_PROJECT_FILE_SIZE = 256 * 1024
MAX_PROJECT_TOTAL_SIZE = 1024 * 1024
MAX_REQUIREMENTS = 8
MAX_REQUIREMENT_LENGTH = 120
VENV_NAME = "learnflow-runtime"
_REQUIREMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-\[\],<>=!~+*]*$")


def runtime_root(*, create: bool = False) -> str:
    """Root for local dev runtime state; status reads do not create it."""
    root = getattr(settings, "runtime_dir", "") or os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "runtime",
    )
    if create:
        os.makedirs(root, exist_ok=True)
    return root


def venv_dir() -> str:
    return os.path.join(runtime_root(), VENV_NAME)


def workspace_dir(exercise_id: int) -> str:
    d = os.path.join(runtime_root(create=True), "workspaces", f"ex{int(exercise_id)}")
    os.makedirs(d, exist_ok=True)
    return d


def venv_ready() -> bool:
    """True if the runtime venv exists and has a python binary."""
    return bool(_venv_python())


def _venv_python() -> str:
    candidates = (
        os.path.join(venv_dir(), "Scripts", "python.exe"),
        os.path.join(venv_dir(), "bin", "python"),
    )
    return next((item for item in candidates if os.path.isfile(item)), "")


def installed_requirements() -> List[str]:
    """Requirements already installed in the runtime venv (from marker file)."""
    marker = os.path.join(venv_dir(), ".requirements")
    if not os.path.isfile(marker):
        return []
    try:
        with open(marker, encoding="utf-8") as f:
            return [line.strip() for line in f if line.strip()][:MAX_REQUIREMENTS]
    except OSError:
        return []


def _mark_installed(requirements: List[str]) -> None:
    marker = os.path.join(venv_dir(), ".requirements")
    with open(marker, "w", encoding="utf-8") as f:
        f.write("\n".join(requirements))


def _validated_requirements(requirements: Optional[List[str]]) -> List[str]:
    raw = list(requirements or [])
    if len(raw) > MAX_REQUIREMENTS:
        raise ExecutionPolicyError(
            code="dependency_count_limit_exceeded",
            message=f"依赖数量超过允许的 {MAX_REQUIREMENTS} 个上限。",
            status_code=422,
        )
    normalized: list[str] = []
    for item in raw:
        requirement = str(item or "").strip()
        if (
            not requirement
            or len(requirement) > MAX_REQUIREMENT_LENGTH
            or not _REQUIREMENT_RE.fullmatch(requirement)
        ):
            raise ExecutionPolicyError(
                code="dependency_spec_unsupported",
                message="依赖仅允许有界的包名与版本约束；路径、URL、选项和环境标记均不支持。",
                status_code=422,
            )
        if requirement not in normalized:
            normalized.append(requirement)
    return normalized


def ensure_environment(requirements: Optional[List[str]] = None, timeout: int = 600) -> Dict:
    """Create a bounded dev venv and optionally install explicitly allowed deps.

    Dependency installation has a separate opt-in even when execution itself
    is enabled.
    """
    policy_fields = require_trusted_local_execution("project_environment_prepare")
    requirements = _validated_requirements(requirements)
    created = False
    installed: list[str] = []
    environment_process_executed = False
    have = set(installed_requirements())
    missing = [item for item in requirements if item not in have]
    if missing:
        require_dependency_install()

    root = runtime_root(create=True)
    try:
        requested_timeout = float(timeout)
    except (TypeError, ValueError):
        requested_timeout = float(MAX_ENVIRONMENT_SETUP_TIME)
    effective_timeout = min(max(requested_timeout, 1.0), float(MAX_ENVIRONMENT_SETUP_TIME))

    if not venv_ready():
        _log("creating_runtime_venv")
        result = run_trusted_local_process(
            [sys.executable, "-m", "venv", venv_dir()],
            operation="project_environment_create",
            cwd=root,
            timeout=effective_timeout,
            max_output_bytes=MAX_OUTPUT_SIZE,
            policy_fields=policy_fields,
        )
        environment_process_executed = bool(result.get("started"))
        if result["exit_code"] != 0 or not venv_ready():
            return {
                "ready": False,
                "created": False,
                "installed": [],
                "message": "创建运行环境失败",
                "error_code": result.get("error_code") or "environment_create_failed",
                **result,
            }
        created = True
        _log("runtime_venv_created")

    if missing:
        py = _venv_python()
        _log(f"installing_dependencies count={len(missing)}")
        result = run_trusted_local_process(
            [
                py, "-m", "pip", "install", "--quiet", "--no-input",
                "--isolated", "--no-cache-dir", "--disable-pip-version-check",
                *missing,
            ],
            operation="dependency_install",
            cwd=root,
            timeout=effective_timeout,
            max_output_bytes=MAX_OUTPUT_SIZE,
            policy_fields=policy_fields,
        )
        environment_process_executed = environment_process_executed or bool(result.get("started"))
        if result["exit_code"] != 0:
            return {
                "ready": False,
                "created": created,
                "installed": [],
                "message": "依赖安装失败",
                "error_code": result.get("error_code") or "dependency_install_failed",
                **result,
            }
        installed = missing
        _mark_installed(sorted(have.union(missing)))

    return {
        "ready": True,
        "created": created,
        "installed": installed,
        "message": "环境就绪" if not installed else f"已安装 {len(installed)} 个依赖",
        "limits": {
            "max_dependencies": MAX_REQUIREMENTS,
            "setup_timeout_seconds": effective_timeout,
        },
        **execution_boundary_fields(executed=environment_process_executed),
    }


def _safe_relative_path(raw_name: str) -> str:
    normalized = str(raw_name or "").replace("\\", "/").strip()
    path = PurePosixPath(normalized)
    if (
        not normalized
        or len(normalized) > 200
        or path.is_absolute()
        or any(ord(character) < 32 for character in normalized)
        or any(":" in part for part in path.parts)
        or any(part in {"", ".", ".."} for part in path.parts)
    ):
        raise ExecutionPolicyError(
            code="project_file_path_unsupported",
            message="项目文件名必须是有界的相对路径，且不能包含路径穿越。",
            status_code=422,
        )
    return path.as_posix()


def _validated_project_files(files: List[Dict]) -> List[Dict[str, str]]:
    raw = list(files or [])
    if len(raw) > MAX_PROJECT_FILES:
        raise ExecutionPolicyError(
            code="project_file_count_limit_exceeded",
            message=f"项目文件数量超过允许的 {MAX_PROJECT_FILES} 个上限。",
            status_code=422,
        )
    validated: list[dict[str, str]] = []
    seen: set[str] = set()
    total_size = 0
    for item in raw:
        name = _safe_relative_path(item.get("name", ""))
        if name in seen:
            raise ExecutionPolicyError(
                code="duplicate_project_file",
                message=f"项目包含重复文件: {name}",
                status_code=422,
            )
        content = str(item.get("content", ""))
        size = len(content.encode("utf-8"))
        if size > MAX_PROJECT_FILE_SIZE:
            raise ExecutionPolicyError(
                code="project_file_size_limit_exceeded",
                message=f"项目文件 {name} 超过单文件大小上限。",
                status_code=413,
            )
        total_size += size
        if total_size > MAX_PROJECT_TOTAL_SIZE:
            raise ExecutionPolicyError(
                code="project_total_size_limit_exceeded",
                message="项目文件总大小超过允许上限。",
                status_code=413,
            )
        seen.add(name)
        validated.append({"name": name, "content": content})
    return validated


def write_project_files(
    exercise_id: int,
    files: List[Dict],
    *,
    workdir: str | None = None,
) -> str:
    """Write validated project inputs into a bounded local dev workspace."""
    workdir = workdir or workspace_dir(exercise_id)
    for item in _validated_project_files(files):
        name = item["name"]
        path = os.path.join(workdir, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(item["content"])
    return workdir


def run_project(
    exercise_id: int,
    files: List[Dict],
    entrypoint: str,
    requirements: Optional[List[str]] = None,
    timeout: int = MAX_EXECUTION_TIME,
) -> Dict:
    """Run a bounded project in an ordinary, non-isolated host process."""
    policy_fields = require_trusted_local_execution("project_code_execution")
    validated_files = _validated_project_files(files)
    validated_requirements = _validated_requirements(requirements)
    safe_entrypoint = _safe_relative_path(entrypoint or "main.py")
    if safe_entrypoint not in {item["name"] for item in validated_files}:
        raise ExecutionPolicyError(
            code="project_entrypoint_missing",
            message=f"入口文件 {safe_entrypoint} 不在受限项目文件中。",
            status_code=422,
        )
    env_result = ensure_environment(validated_requirements)
    if not env_result["ready"]:
        raise ExecutionPolicyError(
            code=str(env_result.get("error_code") or "execution_environment_unavailable"),
            message=str(env_result.get("message") or "本地开发执行环境不可用。"),
            executed=bool(env_result.get("started")),
        )
    try:
        requested_timeout = float(timeout)
    except (TypeError, ValueError):
        requested_timeout = float(MAX_EXECUTION_TIME)
    effective_timeout = min(max(requested_timeout, 0.1), float(MAX_EXECUTION_TIME))
    workspaces = os.path.join(runtime_root(create=True), "workspaces")
    os.makedirs(workspaces, exist_ok=True)
    prefix = f"ex{int(exercise_id)}-"
    with tempfile.TemporaryDirectory(
        prefix=prefix,
        dir=workspaces,
        ignore_cleanup_errors=True,
    ) as workdir:
        write_project_files(exercise_id, validated_files, workdir=workdir)
        target = os.path.join(workdir, safe_entrypoint)
        result = run_trusted_local_process(
            [_venv_python(), target],
            operation="project_code_execution",
            cwd=workdir,
            timeout=effective_timeout,
            max_output_bytes=MAX_OUTPUT_SIZE,
            policy_fields=policy_fields,
        )
        if not result.get("started"):
            raise ExecutionPolicyError(
                code=str(result.get("error_code") or "process_start_failed"),
                message="本地开发项目进程未能启动。",
            )
        if result["timed_out"]:
            result["stderr"] = (
                (result.get("stderr") or "")
                + f"\n执行超过 {effective_timeout:g} 秒上限，进程组已终止。"
            ).lstrip("\n")
        result["env"] = env_result
        result["limits"] = {
            "timeout_seconds": effective_timeout,
            "max_output_bytes": MAX_OUTPUT_SIZE,
            "max_input_files": MAX_PROJECT_FILES,
            "max_input_file_bytes": MAX_PROJECT_FILE_SIZE,
            "max_input_project_bytes": MAX_PROJECT_TOTAL_SIZE,
            "max_dependencies": MAX_REQUIREMENTS,
        }
        return result


# ── stdout-based judging (project mode) ──

def check_stdout(stdout: str, config: Dict) -> Dict:
    """
    Judge stdout against config:
        {"pattern": "accuracy: (\\d+\\.\\d+)%", "min_accuracy": 90.0}
    Returns {"passed": bool, "expected": str, "actual": str, "detail": str}
    """
    pattern = config.get("pattern", "")
    if not pattern:
        return {"passed": False, "expected": "stdout 检查", "actual": "未配置检查规则",
                "detail": "缺少 judge_config.pattern"}

    match = re.search(pattern, stdout)
    if not match:
        return {"passed": False, "expected": f"匹配 {pattern}", "actual": "未匹配到",
                "detail": "stdout 中没有匹配到预期的输出。请检查你的 print 格式。"}

    actual = float(match.group(1))
    min_acc = float(config.get("min_accuracy", 0))
    passed = actual >= min_acc
    return {
        "passed": passed,
        "expected": f">= {min_acc}",
        "actual": f"{actual}",
        "detail": "准确率达到要求 🎉" if passed else f"准确率 {actual} 未达到 {min_acc}，继续调参试试",
    }


def _log(msg: str) -> None:
    print(
        "[project_runner] "
        f"{msg} execution_boundary=trusted_local_process "
        "filesystem_isolation=false network_isolation=false secrets_isolation=false",
        flush=True,
    )
