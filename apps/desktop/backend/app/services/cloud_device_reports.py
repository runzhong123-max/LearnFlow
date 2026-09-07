"""Explicitly publish bounded operation receipts, never source files or mastery."""
from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Literal

import httpx
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError


class PublishRunReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    checkpoint_id: int = Field(gt=0)
    confirm_share: Literal[True]
    client_action_id: str = Field(min_length=4, max_length=120)


_locks: dict[str, asyncio.Lock] = {}


async def publish_run_report(session, project_id: int, storage: Path, run_id: int, body: bytes):
    # Caller has already checked the native token and live cloud project owner.
    from app.services.cloud_device import digest, save

    try:
        request = PublishRunReport.model_validate_json(body)
    except ValidationError:
        return JSONResponse({"detail": "请确认将本次运行摘要加入指定阶段交付"}, 422)
    async with _locks.setdefault(str(storage), asyncio.Lock()):
        try:
            state = json.loads((storage / "binding.json").read_text())
            run = next((item for item in state.get("runs", []) if item["id"] == run_id), None)
            if not run:
                return JSONResponse({"detail": "运行记录不存在"}, 404)
            if run.get("action") not in {"run", "verify"} or run.get("status") != "completed":
                return JSONResponse({"detail": "请先完成一次真实运行或验证，再加入交付"}, 409)
            original_checkpoint = run.get("checkpoint_id") or run.get("request", {}).get("checkpoint_id")
            if original_checkpoint is not None and original_checkpoint != request.checkpoint_id:
                return JSONResponse({"detail": "运行记录属于其他阶段"}, 409)
            steps = run.get("result", {}).get("steps") or []
            if not steps or any(step.get("exit_code") != 0 or step.get("timed_out") or step.get("output_limited") for step in steps):
                return JSONResponse({"detail": "本次运行尚未成功完成，不能用作已完成运行交付"}, 409)
            # A local run number is not globally unique across a learner's devices.
            device_path = storage / "report-device.json"
            if device_path.exists():
                device_id = json.loads(device_path.read_text())["id"]
            else:
                device_id = uuid.uuid4().hex
                save(device_path, {"id": device_id})
            payload = {
                "schema_version": "learnflow.device-report.v1",
                "client_action_id": f"device-report:{device_id}:{digest(request.client_action_id)[:32]}",
                "checkpoint_id": request.checkpoint_id, "action": run["action"],
                "status": "completed", "snapshot_hash": run["snapshot_hash"], "exit_code": 0,
                "summary": f"本机运行 #{run_id} 已完成，共 {len(steps)} 个命令步骤。仅报告操作事实；不证明独立完成或掌握。",
                "manifest": [{key: entry[key] for key in ("path", "sha256", "size")} for entry in run["manifest"]],
                # Deliberately omit stdout/stderr, command strings and source bytes.
                "steps": [{"name": str(step.get("name", "run"))[:100], "exit_code": step["exit_code"]} for step in steps],
            }
            return await _publish_receipt(session, project_id, storage, request.client_action_id, payload)
        except (OSError, ValueError, KeyError, TypeError):
            return JSONResponse({"detail": "本机运行记录无法读取或格式不完整"}, 409)
        except httpx.HTTPError:
            return JSONResponse({"detail": "报告暂时无法保存到云项目，可用同一请求重试；本机记录已保留"}, 503)


async def _publish_receipt(session, project_id: int, storage: Path, request_id: str, payload: dict):
    from app.services.cloud_device import digest, save
    journal = storage / "reported-runs.json"
    reports = json.loads(journal.read_text()) if journal.exists() else {}
    fingerprint = digest(payload)
    previous = reports.get(request_id)
    if previous:
        if previous["fingerprint"] != fingerprint:
            return JSONResponse({"detail": "同一报告请求编号的内容不同"}, 409)
        return JSONResponse(previous["result"])
    if not getattr(session, "csrf", ""):
        csrf = await session.client.get("/api/auth/csrf")
        if csrf.status_code != 200:
            return JSONResponse({"detail": "云端会话已过期，请重新登录"}, 401)
        session.csrf = csrf.json()["csrf_token"]
    response = await session.client.post(f"/api/vnext-projects/{project_id}/device-reports", json=payload,
                                         headers={"X-CSRF-Token": session.csrf})
    if response.status_code not in {200, 201}:
        return JSONResponse(response.json(), response.status_code)
    result = response.json()
    reports[request_id] = {"fingerprint": fingerprint, "result": result}
    save(journal, reports)
    return JSONResponse(result)


class ReportFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(min_length=1, max_length=500)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class PublishFileReport(PublishRunReport):
    files: list[ReportFile] = Field(min_length=1, max_length=64)


async def publish_file_report(session, project_id: int, storage: Path, body: bytes):
    from app.services.cloud_device import digest, save
    from app.services.workspace_files import canonical_root, read_workspace_file, WorkspaceError
    try:
        request = PublishFileReport.model_validate_json(body)
    except ValidationError:
        return JSONResponse({"detail": "请确认要加入交付的文件版本和阶段"}, 422)
    async with _locks.setdefault(str(storage), asyncio.Lock()):
        try:
            state = json.loads((storage / "binding.json").read_text())
            root = canonical_root(state["root"])
            manifest = []
            for selected in request.files:
                file = read_workspace_file(root, selected.path)
                if file["sha256"] != selected.sha256:
                    return JSONResponse({"detail": "文件已变化，请重新读取后加入交付"}, 409)
                manifest.append({key: file[key] for key in ("path", "sha256", "size")})
            manifest.sort(key=lambda file: file["path"])
            if len({file["path"] for file in manifest}) != len(manifest):
                return JSONResponse({"detail": "文件清单不能重复"}, 422)
            device_path = storage / "report-device.json"
            if device_path.exists():
                device_id = json.loads(device_path.read_text())["id"]
            else:
                device_id = uuid.uuid4().hex
                save(device_path, {"id": device_id})
            payload = {
                "schema_version": "learnflow.device-report.v1",
                "client_action_id": f"device-files:{device_id}:{digest(request.client_action_id)[:32]}",
                "checkpoint_id": request.checkpoint_id, "action": "files", "status": "completed",
                "snapshot_hash": digest(manifest), "exit_code": None,
                "summary": f"本机文件版本摘要，共 {len(manifest)} 个文件。未报告执行或独立完成。",
                "manifest": manifest, "steps": [],
            }
            return await _publish_receipt(session, project_id, storage, request.client_action_id, payload)
        except WorkspaceError as exc:
            return JSONResponse({"detail": exc.detail}, exc.status_code)
        except (OSError, ValueError, KeyError, TypeError):
            return JSONResponse({"detail": "本机文件无法读取或报告格式不完整"}, 409)
        except httpx.HTTPError:
            return JSONResponse({"detail": "文件摘要暂时无法保存到云项目，可用同一请求重试"}, 503)
