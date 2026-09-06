"""Fixed C profiles on a confirmed snapshot, with truthful host-process limits.

Snapshot access is scoped; the compiler and resulting program are ordinary
trusted local processes. Neither a copied directory nor a timeout is an OS
filesystem, network, secret, or resource isolation boundary.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.database import async_session
from app.models.experiment import ExperimentRun
from app.models.project import Project, ProjectWorkspace
from app.schemas.experiment import ExperimentRunPreviewRequest
from app.services.execution_policy import run_trusted_local_process
from app.services.learning_runtime import record_event
from app.services.project_runner import runtime_root
from app.services.workspace_files import WorkspaceError, canonical_root, resolve_workspace_path


MAX_FILE_BYTES = 512 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024
MAX_OUTPUT_BYTES = 32 * 1024
BUILD_TIMEOUT_SECONDS = 20
RUN_TIMEOUT_SECONDS = 5
ALLOWED_SUFFIXES = {".c", ".h", ".txt", ".cnf", ".csv", ".json", ".dat"}
WARNING = (
    "将在本机用 C 编译器处理所选文件，并按操作运行程序。仅运行你信任的代码。"
    "临时副本不会自动写回源码，但进程拥有本机用户权限，可能访问或修改其他文件、"
    "联网或读取凭据；没有操作系统沙箱。超时和输出上限不限制内存或磁盘写入。"
    "编译与样例通过只是运行记录，不代表正式提交、关卡通过或知识掌握。"
)
_tasks: dict[int, asyncio.Task] = {}
_execution_slots: asyncio.Semaphore | None = None


def boundary_fields() -> dict:
    return {
        "execution_policy": "desktop_explicit_trusted_local",
        "execution_boundary": "trusted_local_process",
        "filesystem_isolation": False,
        "network_isolation": False,
        "secrets_isolation": False,
        "resource_isolation": False,
        "environment_sanitization": "allowlist_only",
        "warning": WARNING,
        "learning_evidence": False,
    }


def _desktop_only() -> None:
    if not settings.desktop_mode or not settings.desktop_token:
        raise WorkspaceError(404, "Desktop experiment runner is unavailable", "desktop_required")


def discover_compiler() -> str | None:
    # Never search the project directory or a relative PATH entry.
    path = os.pathsep.join(
        entry for entry in os.environ.get("PATH", os.defpath).split(os.pathsep)
        if entry and Path(entry).is_absolute()
    )
    for name in ("clang", "gcc"):
        found = shutil.which(name, path=path)
        if found:
            return str(Path(found).absolute())
    return None


def experiment_profiles() -> dict:
    _desktop_only()
    compiler = discover_compiler()
    return {"profiles": [{
        "id": "c11", "name": "C11 本地实验", "available": bool(compiler),
        "compiler": compiler, "actions": ["syntax", "build", "run", "verify"],
        "unavailable_reason": None if compiler else "未找到 clang 或 gcc，请先安装 C 工具链。",
        "requires_confirmation": True,
        "limits": {
            "max_files": 64, "max_file_bytes": MAX_FILE_BYTES,
            "max_total_bytes": MAX_TOTAL_BYTES, "max_output_bytes_per_step": MAX_OUTPUT_BYTES,
            "build_timeout_seconds": BUILD_TIMEOUT_SECONDS,
            "run_timeout_seconds": RUN_TIMEOUT_SECONDS, "max_test_cases": 8,
        },
        **boundary_fields(),
    }]}


def _digest(value: object) -> str:
    return hashlib.sha256(json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")).hexdigest()


def _read_scoped_file(root: Path, relative: str) -> bytes:
    """Reject links at every traversed level and bound reads, including races."""
    relative, target = resolve_workspace_path(root, relative, actor="agent")
    descriptors: list[int] = []
    try:
        if os.name != "nt" and os.open in os.supports_dir_fd:
            directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            current = os.open(root, directory_flags)
            descriptors.append(current)
            parts = Path(relative).parts
            for part in parts[:-1]:
                current = os.open(part, directory_flags, dir_fd=current)
                descriptors.append(current)
            descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current)
        else:
            descriptor = os.open(target, os.O_RDONLY | getattr(os, "O_BINARY", 0))
        descriptors.append(descriptor)
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise WorkspaceError(400, "实验输入必须是普通文件", "not_regular_file")
        if before.st_size > MAX_FILE_BYTES:
            raise WorkspaceError(413, "实验输入超过单文件大小限制", "file_too_large")
        chunks: list[bytes] = []
        size = 0
        while True:
            chunk = os.read(descriptor, min(65536, MAX_FILE_BYTES + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_FILE_BYTES:
                raise WorkspaceError(413, "实验输入超过单文件大小限制", "file_too_large")
        after = os.fstat(descriptor)
        resolve_workspace_path(root, relative, actor="agent")
        current_stat = target.stat(follow_symlinks=False)
        def identity(info):
            return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
        if identity(before) != identity(after) or identity(after) != identity(current_stat):
            raise WorkspaceError(409, "读取时文件发生变化，请重新预览", "snapshot_stale")
        return b"".join(chunks)
    except OSError as exc:
        raise WorkspaceError(409, "无法安全读取实验文件，请刷新后重试", "snapshot_read_failed") from exc
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def capture_files(root: Path, paths: list[str]) -> tuple[list[dict], dict[str, bytes]]:
    root = canonical_root(str(root))
    files: dict[str, bytes] = {}
    seen: set[str] = set()
    total = 0
    if not 1 <= len(paths) <= 64:
        raise WorkspaceError(422, "实验必须选择 1 至 64 个文件", "file_count_limit")
    for raw in paths:
        if len(raw) > 240 or any(ord(ch) < 32 for ch in raw) or ":" in raw:
            raise WorkspaceError(422, "实验文件路径无效", "invalid_path")
        relative, _ = resolve_workspace_path(root, raw, actor="agent")
        if relative.casefold() in seen:
            raise WorkspaceError(422, "实验不能重复选择同一文件", "duplicate_file")
        seen.add(relative.casefold())
        if Path(relative).suffix.casefold() not in ALLOWED_SUFFIXES:
            raise WorkspaceError(422, "C Profile 只接收 C 源码、头文件和受支持的数据文件", "unsupported_file_type")
        content = _read_scoped_file(root, relative)
        total += len(content)
        if total > MAX_TOTAL_BYTES:
            raise WorkspaceError(413, "实验输入超过总大小限制", "snapshot_too_large")
        files[relative] = content
    if not any(Path(name).suffix.casefold() == ".c" for name in files):
        raise WorkspaceError(422, "请至少选择一个 C 源文件", "c_source_required")
    manifest = [
        {"path": name, "size": len(content), "sha256": hashlib.sha256(content).hexdigest()}
        for name, content in sorted(files.items())
    ]
    return manifest, files


async def preview_run(
    db: AsyncSession, workspace: ProjectWorkspace, data: ExperimentRunPreviewRequest,
) -> ExperimentRun:
    _desktop_only()
    request = data.model_dump(exclude={"client_request_id"})
    request_hash = _digest(request)
    key = f"experiment:{workspace.learner_id}:{workspace.project_id}:{data.client_request_id}"
    existing = (await db.execute(select(ExperimentRun).where(
        ExperimentRun.idempotency_key == key,
    ))).scalar_one_or_none()
    if existing:
        if existing.request_hash != request_hash:
            raise WorkspaceError(409, "同一请求编号不能用于不同的运行配置", "idempotency_conflict")
        return existing
    compiler = discover_compiler()
    if not compiler:
        raise WorkspaceError(409, "未找到 clang 或 gcc，请先安装 C 工具链", "compiler_missing")
    root = canonical_root(workspace.root_path)
    manifest, files = await asyncio.to_thread(capture_files, root, data.files)
    request["compiler"] = compiler
    snapshot_hash = _digest({"manifest": manifest, "request": request})
    storage = Path(runtime_root(create=True)).resolve() / "experiments"
    if storage == root or root in storage.parents or storage in root.parents:
        raise WorkspaceError(409, "实验运行目录必须与项目目录分离", "runtime_overlaps_workspace")
    storage.mkdir(parents=True, exist_ok=True, mode=0o700)
    run_dir = Path(tempfile.mkdtemp(prefix="run-", dir=storage))
    snapshot = run_dir / "source"
    try:
        snapshot.mkdir()
        for name, content in files.items():
            destination = snapshot / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        run = ExperimentRun(
            learner_id=workspace.learner_id, project_id=workspace.project_id,
            workspace_id=workspace.id, checkpoint_id=data.checkpoint_id,
            profile_id=data.profile_id, action=data.action, status="proposed",
            snapshot_hash=snapshot_hash, manifest=manifest, request=request,
            request_hash=request_hash, snapshot_path=str(snapshot), workspace_root=str(root),
            result={"steps": [], "passed": None, "requires_confirmation": True, **boundary_fields()},
            idempotency_key=key, expires_at=datetime.utcnow() + timedelta(minutes=15),
        )
        db.add(run)
        await db.commit()
        await db.refresh(run)
        return run
    except BaseException:
        shutil.rmtree(run_dir, ignore_errors=True)
        raise


async def confirm_run(db: AsyncSession, run: ExperimentRun, snapshot_hash: str) -> ExperimentRun:
    _desktop_only()
    if snapshot_hash != run.snapshot_hash:
        raise WorkspaceError(409, "确认内容与预览不一致", "snapshot_hash_mismatch")
    if run.status != "proposed":
        return run
    now = datetime.utcnow()
    if run.expires_at <= now:
        run.status = "expired"
        await db.commit()
        raise WorkspaceError(409, "运行预览已过期，请重新预览", "preview_expired")
    workspace = await db.get(ProjectWorkspace, run.workspace_id)
    if not workspace or workspace.status != "linked" or workspace.root_path != run.workspace_root:
        run.status = "stale"
        await db.commit()
        raise WorkspaceError(409, "项目关联目录已变化，请重新预览", "workspace_changed")
    try:
        manifest, _ = await asyncio.to_thread(capture_files, Path(workspace.root_path), run.request["files"])
        snapshot_manifest, _ = await asyncio.to_thread(capture_files, Path(run.snapshot_path), run.request["files"])
        if manifest != run.manifest or snapshot_manifest != run.manifest:
            raise WorkspaceError(409, "源码或运行副本已变化，请重新预览", "snapshot_stale")
    except WorkspaceError:
        run.status = "stale"
        await db.commit()
        raise
    # Only one confirmation wins even if multiple windows confirm concurrently.
    claimed = await db.execute(update(ExperimentRun).where(
        ExperimentRun.id == run.id, ExperimentRun.status == "proposed",
    ).values(status="queued", confirmed_at=now))
    if not claimed.rowcount:
        await db.refresh(run)
        return run
    await record_event(
        db, learner_id=run.learner_id, project_id=run.project_id,
        checkpoint_id=run.checkpoint_id, source="desktop_experiment_runner",
        event_type="experiment_run_started", actor_type="user",
        payload={"run_id": run.id, "action": run.action, "snapshot_hash": run.snapshot_hash},
        provenance={"confirmation": "desktop_user", "profile_id": run.profile_id},
        client_event_id=f"experiment:{run.id}:started",
    )
    await db.commit()
    await db.refresh(run)
    schedule_run(run.id)
    return run


def schedule_run(run_id: int) -> None:
    existing = _tasks.get(run_id)
    if existing and not existing.done():
        return
    task = asyncio.create_task(execute_run(run_id))
    _tasks[run_id] = task
    task.add_done_callback(lambda finished: _tasks.pop(run_id, None))


def run_snapshot(snapshot_path: str, request: dict) -> tuple[str, dict]:
    _desktop_only()
    snapshot = Path(snapshot_path)
    output_dir = snapshot.parent / "build"
    output_dir.mkdir(exist_ok=True)
    executable = output_dir / ("experiment.exe" if os.name == "nt" else "experiment")
    sources = [str(snapshot / name) for name in request["files"] if Path(name).suffix.casefold() == ".c"]
    command = [request["compiler"], "-std=c11", "-Wall", "-Wextra", "-pedantic", "-O0", "-I", str(snapshot), "-x", "c"]
    if request["action"] == "syntax":
        command += ["-fsyntax-only", *sources]
    else:
        command += [*sources, "-o", str(executable), "-lm"]
    result = {"steps": [], "passed": None, "requires_confirmation": False, **boundary_fields()}

    def execute(name: str, command: list[str], *, stdin: str = "", timeout: int):
        step = run_trusted_local_process(
            command, operation="desktop_c_experiment", cwd=str(snapshot),
            input_text=stdin, timeout=timeout, max_output_bytes=MAX_OUTPUT_BYTES,
            policy_fields=boundary_fields(),
        )
        step.update({"name": name, "command": command})
        result["steps"].append(step)
        return step

    def failure(step: dict) -> str | None:
        if step["timed_out"]:
            return "timed_out"
        if step["output_limited"]:
            return "output_limited"
        if not step["started"] or step["exit_code"] != 0:
            return "failed"
        return None

    built = execute("语法检查" if request["action"] == "syntax" else "构建", command, timeout=BUILD_TIMEOUT_SECONDS)
    if failed := failure(built):
        return failed, result
    if request["action"] in {"syntax", "build"}:
        return "completed", result
    program = [str(executable), *request.get("args", [])]
    if request["action"] == "run":
        step = execute("程序运行", program, stdin=request.get("stdin", ""), timeout=RUN_TIMEOUT_SECONDS)
        return failure(step) or "completed", result
    all_passed = True
    for test in request["test_cases"]:
        step = execute(test["name"], program, stdin=test["stdin"], timeout=RUN_TIMEOUT_SECONDS)
        failed = failure(step)
        # Visible, exact stdout cases; no claim of hidden or independent assessment.
        step["passed"] = not failed and step["stdout"].replace("\r\n", "\n") == test["expected_stdout"].replace("\r\n", "\n")
        step["expected_stdout"] = test["expected_stdout"]
        all_passed = all_passed and step["passed"]
        if failed:
            result["passed"] = False
            return failed, result
    result["passed"] = all_passed
    return "completed" if all_passed else "failed", result


async def execute_run(run_id: int) -> None:
    global _execution_slots
    # One active host process workflow per sidecar.
    if _execution_slots is None:
        _execution_slots = asyncio.Semaphore(1)
    async with _execution_slots:
        async with async_session() as db:
            run = await db.get(ExperimentRun, run_id)
            if not run or run.status != "queued" or not run.confirmed_at:
                return
            project = await db.get(Project, run.project_id)
            if not project or project.visibility == "deleted":
                run.status = "interrupted"
                run.finished_at = datetime.utcnow()
                await db.commit()
                return
            run.status = "running"
            await db.commit()
            try:
                manifest, _ = await asyncio.to_thread(capture_files, Path(run.snapshot_path), run.request["files"])
                if manifest != run.manifest:
                    raise WorkspaceError(409, "等待运行期间副本已变化", "snapshot_stale")
                status, result = await asyncio.to_thread(run_snapshot, run.snapshot_path, run.request)
            except WorkspaceError as exc:
                status, result = "stale", {
                    **boundary_fields(), "steps": [], "passed": None,
                    "error_code": exc.code, "message": exc.detail,
                }
            except Exception as exc:
                status, result = "failed", {
                    **boundary_fields(), "steps": [], "passed": None,
                    "error_code": "experiment_runtime_failed", "message": type(exc).__name__,
                }
            run.status = status
            run.result = result
            run.finished_at = datetime.utcnow()
            await record_event(
                db, learner_id=run.learner_id, project_id=run.project_id,
                checkpoint_id=run.checkpoint_id, source="desktop_experiment_runner",
                event_type="experiment_run_completed", actor_type="tool",
                payload={"run_id": run.id, "status": status, "snapshot_hash": run.snapshot_hash, "passed": result.get("passed")},
                provenance={"profile_id": run.profile_id, "execution_boundary": "trusted_local_process"},
                client_event_id=f"experiment:{run.id}:completed",
            )
            await db.commit()


async def mark_interrupted_experiment_runs() -> None:
    """A restart never silently reruns previously confirmed code."""
    global _execution_slots
    _execution_slots = None
    async with async_session() as db:
        runs = list((await db.execute(select(ExperimentRun).where(
            ExperimentRun.status.in_(["queued", "running"]),
        ))).scalars())
        for run in runs:
            run.status = "interrupted"
            run.finished_at = datetime.utcnow()
            run.result = {
                **(run.result or {}), "error_code": "sidecar_restarted",
                "message": "桌面运行时已重启；此操作没有自动重跑，请重新预览并确认。",
            }
            await record_event(
                db, learner_id=run.learner_id, project_id=run.project_id,
                checkpoint_id=run.checkpoint_id, source="desktop_experiment_runner",
                event_type="experiment_run_completed", actor_type="tool",
                payload={"run_id": run.id, "status": "interrupted", "snapshot_hash": run.snapshot_hash, "passed": None},
                provenance={"reason": "sidecar_restart"},
                client_event_id=f"experiment:{run.id}:completed",
            )
        await db.commit()
