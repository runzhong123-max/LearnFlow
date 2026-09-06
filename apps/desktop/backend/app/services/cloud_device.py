"""Device-only files and trusted experiments, keyed by cloud authority and owner.

Only native desktop requests reach this module after live cloud ownership
validation. Metadata is an operation journal, never a learning-state writer.
"""
from __future__ import annotations
import asyncio
import hashlib
import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path

from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from app.core.config import settings
from app.schemas.workspace import WorkspaceLinkRequest, WorkspaceFileWriteRequest
from app.schemas.experiment import ExperimentRunPreviewRequest, ExperimentRunConfirmRequest
from app.services.workspace_files import (WorkspaceError, canonical_root, scan_workspace_tree,
    read_workspace_file, build_write_preview, validate_base_hash, resolve_workspace_path)
from app.services.experiment_runner import (experiment_profiles, capture_files, discover_compiler,
    run_snapshot, boundary_fields)
from app.services.project_runner import runtime_root

_lock = asyncio.Lock()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def save(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + "." + secrets.token_hex(8))
    with temporary.open("x") as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, ensure_ascii=False)
    temporary.replace(path)


async def device_request(session, origin: str, project_id: int, area: str, action: str, method: str, body: bytes):
    # Never trust IDs from the UI or a stale local binding alone.
    account = await session.client.get('/api/auth/me')
    if account.status_code != 200 or account.json().get('learner_id') != session.learner_id:
        return JSONResponse({'detail': '云端会话已失效，请重新登录'}, 401)
    project = await session.client.get(f'/api/vnext-projects/{project_id}')
    if project.status_code != 200:
        return JSONResponse({'detail': '当前云端账号无权访问此项目'}, 404 if project.status_code in {403, 404} else 503)
    key = digest([origin, session.learner_id, project_id])
    storage = Path(runtime_root(create=True)) / 'cloud-devices' / key
    metadata = storage / 'binding.json'
    try:
        payload = json.loads(body) if body else {}
        async with _lock:
            state = json.loads(metadata.read_text()) if metadata.exists() else {'runs': [], 'operations': {}}
            if area == 'workspace' and action == 'link' and method == 'POST':
                data = WorkspaceLinkRequest.model_validate(payload)
                root = canonical_root(data.root_path, create=data.create)
                if root == storage or root in storage.parents or storage in root.parents:
                    raise WorkspaceError(409, '项目目录必须与应用数据目录分离', 'runtime_overlap')
                if state.get('root') and state['root'] != str(root):
                    raise WorkspaceError(409, '此云项目已绑定另一目录，请使用新项目以保留原绑定', 'already_bound')
                state.update(root=str(root), authority=origin, learner_id=session.learner_id, project_id=project_id)
                save(metadata, state)
                return JSONResponse({'id': project_id, 'project_id': project_id, 'root_path': str(root), 'status': 'linked'})
            if area == 'experiments' and action == 'profiles' and method == 'GET':
                return JSONResponse(experiment_profiles())
            if not state.get('root'):
                return JSONResponse({'detail': '此云项目尚未绑定本机目录'}, 404)
            root = canonical_root(state['root'])
            if area == 'workspace':
                if action == 'tree' and method == 'GET':
                    return JSONResponse(jsonable_encoder({'workspace_id': project_id, 'project_id': project_id,
                        'root_name': root.name, 'nodes': scan_workspace_tree(root)}))
                if action.startswith('files/'):
                    name = action.removeprefix('files/')
                    if method == 'GET':
                        return JSONResponse(jsonable_encoder(read_workspace_file(root, name)))
                    if method == 'PUT':
                        data = WorkspaceFileWriteRequest.model_validate(payload)
                        fingerprint = digest([name, payload])
                        previous = state['operations'].get(data.idempotency_key)
                        if previous:
                            if previous['fingerprint'] != fingerprint:
                                raise WorkspaceError(409, '重复请求内容不同', 'idempotency_conflict')
                            return JSONResponse(previous['result'])
                        preview = build_write_preview(root, name, data.content, actor='user')
                        target = preview['path']
                        validate_base_hash(target, data.base_hash)
                        # Preserve the previous bytes outside the linked project.
                        if target.exists():
                            history = storage / 'history' / secrets.token_hex(16)
                            history.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                            history.write_bytes(target.read_bytes())
                            os.chmod(history, 0o600)
                        temporary = target.with_name('.learnflow-write-' + secrets.token_hex(16))
                        with temporary.open('xb') as stream:
                            stream.write(data.content.encode())
                        os.chmod(temporary, target.stat().st_mode & 0o777 if target.exists() else 0o600)
                        temporary.replace(target)
                        result = {'path': name, 'sha256': preview['new_hash'], 'learning_evidence': False}
                        state['operations'][data.idempotency_key] = {'fingerprint': fingerprint, 'result': result}
                        save(metadata, state)
                        return JSONResponse(result)
                if action == 'reveal' and method == 'POST' and sys.platform == 'darwin':
                    _, target = resolve_workspace_path(root, payload.get('path', ''), actor='user')
                    subprocess.Popen(['/usr/bin/open', '-R', str(target)])
                    return JSONResponse({'status': 'revealed'})
                if action == 'open':
                    return JSONResponse({'detail': '请先在 Finder 中显示文件，再自行选择打开方式'}, 409)
            if area == 'experiments':
                if action == 'runs' and method == 'GET':
                    return JSONResponse({'runs': list(reversed(state['runs']))})
                if action == 'runs/preview' and method == 'POST':
                    data = ExperimentRunPreviewRequest.model_validate(payload)
                    requested = data.model_dump()
                    for run in state['runs']:
                        if run['client_request_id'] == data.client_request_id:
                            if run['request_hash'] != digest(requested):
                                raise WorkspaceError(409, '重复运行请求内容不同', 'idempotency_conflict')
                            return JSONResponse(run)
                    compiler = discover_compiler()
                    if not compiler:
                        raise WorkspaceError(409, '未找到本机 C 编译器', 'compiler_missing')
                    manifest, files = capture_files(root, data.files)
                    request = data.model_dump(exclude={'client_request_id'})
                    request['compiler'] = compiler
                    run_id = len(state['runs']) + 1
                    snapshot = storage / 'runs' / str(run_id) / 'source'
                    snapshot.mkdir(parents=True, mode=0o700)
                    for name, content in files.items():
                        destination = snapshot / name
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        destination.write_bytes(content)
                    run = dict(id=run_id, project_id=project_id, profile_id=data.profile_id, action=data.action,
                               status='proposed', snapshot_hash=digest([manifest, request]), manifest=manifest,
                               request=request, request_hash=digest(requested), client_request_id=data.client_request_id,
                               expires=time.time()+900, result={'steps': [], **boundary_fields()})
                    state['runs'].append(run)
                    save(metadata, state)
                    return JSONResponse(run)
                parts = action.split('/')
                if len(parts) >= 2 and parts[0] == 'runs' and parts[1].isdigit():
                    run = next((r for r in state['runs'] if r['id'] == int(parts[1])), None)
                    if run is None:
                        return JSONResponse({'detail': '运行不存在'}, 404)
                    if len(parts) == 2 and method == 'GET':
                        return JSONResponse(run)
                    if parts[2:] == ['confirm'] and method == 'POST':
                        confirmation = ExperimentRunConfirmRequest.model_validate(payload)
                        if confirmation.snapshot_hash != run['snapshot_hash']:
                            raise WorkspaceError(409, '运行快照不匹配', 'snapshot_conflict')
                        if run['status'] != 'proposed':
                            return JSONResponse(run)
                        if time.time() > run['expires']:
                            raise WorkspaceError(409, '运行确认已过期', 'expired')
                        manifest, _ = capture_files(root, run['request']['files'])
                        if digest([manifest, run['request']]) != run['snapshot_hash']:
                            raise WorkspaceError(409, '源文件已变化，请重新预览', 'stale')
                        snapshot = storage / 'runs' / str(run['id']) / 'source'
                        snapshot_manifest, _ = capture_files(snapshot, run['request']['files'])
                        if digest([snapshot_manifest, run['request']]) != run['snapshot_hash']:
                            raise WorkspaceError(409, '快照已变化，请重新预览', 'stale')
                        run['status'] = 'running'
                        save(metadata, state)
                        try:
                            run['status'], run['result'] = await asyncio.to_thread(run_snapshot, str(snapshot), run['request'])
                        except Exception:
                            run['status'], run['result'] = 'failed', {'error': '本机执行失败', **boundary_fields()}
                        save(metadata, state)
                        return JSONResponse(run)
            return JSONResponse({'detail': '设备操作不支持'}, 404)
    except WorkspaceError as exc:
        return JSONResponse({'detail': exc.detail}, exc.status_code)
    except (ValidationError, ValueError, TypeError):
        return JSONResponse({'detail': '设备请求格式无效'}, 422)
    except OSError:
        return JSONResponse({'detail': '本机文件操作失败，请检查目录权限和磁盘空间'}, 409)
