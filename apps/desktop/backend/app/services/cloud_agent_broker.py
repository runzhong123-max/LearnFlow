"""Cloud-owned, device-only engineering runs. No local learner rows or evidence writes.

The existing Codex adapter and safe file helpers are reused, while cloud authority
and run persistence stay in the device journal. This is not an OS/network sandbox.
"""
from __future__ import annotations

import asyncio
import base64
from copy import deepcopy
import hashlib
import json
import secrets
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Literal

from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.core.config import settings
from app.services import local_agent_broker as broker
from app.services.workspace_files import (
    WorkspaceError, _atomic_write, build_write_preview, canonical_root,
    resolve_workspace_path, normalize_relative_path,
)

_EPOCH = secrets.token_hex(16)
_locks: dict[str, asyncio.Lock] = {}
_tasks: dict[tuple[str, int], asyncio.Task] = {}
MAX_EVENTS = 500
MAX_RESULT_BYTES = 8 * 1024 * 1024
PREVIEW_TTL = 900


class RequestModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class ProfileCreate(RequestModel):
    name: str = Field(min_length=1, max_length=120)
    executable_path: str | None = Field(default=None, max_length=1000)
    priority: int = Field(default=100, ge=0, le=10000)
    timeout_seconds: int = Field(default=900, ge=30, le=3600)
    client_request_id: str = Field(min_length=1, max_length=160)


class ProfileUpdate(ProfileCreate):
    enabled: bool = True


class RunPreview(RequestModel):
    task_type: Literal['code_change', 'bug_fix', 'refactor', 'test', 'documentation'] = 'code_change'
    goal: str = Field(min_length=2, max_length=2000)
    constraints: list[str] = Field(default_factory=list, max_length=20)
    required_capabilities: list[Literal['code_edit', 'test']] = Field(default_factory=lambda: ['code_edit'], max_length=2)
    checkpoint_id: int | None = Field(default=None, gt=0)
    session_id: int | None = Field(default=None, gt=0)
    client_request_id: str = Field(min_length=1, max_length=160)


class RunConfirm(RequestModel):
    snapshot_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    confirm_run: Literal[True]
    idempotency_key: str = Field(min_length=1, max_length=160)


class RunCancel(RequestModel):
    idempotency_key: str = Field(min_length=1, max_length=160)


class RunApply(RequestModel):
    snapshot_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    result_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    confirm_apply: Literal[True]
    confirmed_deletions: list[str] = Field(default_factory=list, max_length=20000)
    confirmed_moves: list[str] = Field(default_factory=list, max_length=20000)
    idempotency_key: str = Field(min_length=1, max_length=160)


def _digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _save(storage: Path, state: dict):
    storage.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = storage / 'agent-journal.json'
    temporary = storage / ('.agent-journal-' + secrets.token_hex(8))
    with temporary.open('x', encoding='utf-8') as stream:
        temporary.chmod(0o600)
        json.dump(state, stream, ensure_ascii=False)
    temporary.replace(path)


def _event(run: dict, kind: str, payload: dict):
    sequence = run.get('event_sequence', 0) + 1
    run['event_sequence'] = sequence
    run.setdefault('events', []).append({'sequence': sequence, 'event_type': kind, 'payload': payload})
    run['events'] = run['events'][-MAX_EVENTS:]


def _load(storage: Path) -> dict:
    path = storage / 'agent-journal.json'
    state = json.loads(path.read_text()) if path.exists() else {'profiles': [], 'runs': [], 'requests': {}}
    changed = False
    for run in state['runs']:
        if run['status'] in {'queued', 'running', 'applying'} and run.get('process_epoch') != _EPOCH:
            run.update(status='interrupted', finished_at=time.time(), error={'code': 'interrupted', 'message': '应用已重启；操作不会自动重跑。'})
            _event(run, 'interrupted', {'learning_evidence': False})
            changed = True
    if changed:
        _save(storage, state)
    return state


def _lock(storage: Path):
    return _locks.setdefault(str(storage), asyncio.Lock())


def _boundary() -> dict:
    return {'learning_evidence': False, 'mastery_inference': False,
            'sandbox_policy': 'workspace_write', 'network_policy': 'unmanaged',
            'network_boundary_enforced': False, 'host_read_policy': 'unmanaged',
            'host_read_boundary_enforced': False,
            'warning': '工程 Agent 在筛选后的隔离副本工作；网络和同主机读取未受管。真实文件写回需要再次确认。'}


def _public_run(run: dict) -> dict:
    return {key: deepcopy(value) for key, value in run.items()
            if key not in {'events', 'operations', 'root', 'process_epoch', 'profile_snapshot'}}


def _run(state: dict, run_id: int) -> dict:
    run = next((item for item in state['runs'] if item['id'] == run_id), None)
    if run is None:
        raise broker.LocalAgentError(404, '工程 Agent 运行不存在', 'run_not_found')
    return run


def _replay(state: dict, key: str, request: object):
    previous = state['requests'].get(key)
    if previous and previous['fingerprint'] != _digest(request):
        raise broker.LocalAgentError(409, '幂等键已用于不同请求', 'idempotency_conflict')
    return previous


def _remember(state: dict, key: str, request: object, kind: str, object_id: int):
    state['requests'][key] = {'fingerprint': _digest(request), 'kind': kind, 'id': object_id}


def _binding_root(storage: Path) -> Path:
    path = storage / 'binding.json'
    binding = json.loads(path.read_text()) if path.exists() else {}
    if not binding.get('root'):
        raise broker.LocalAgentError(409, '先为这个云项目绑定本机目录', 'workspace_not_linked')
    return canonical_root(binding['root'])


async def _scope(session, project_id: int, project: dict, request: dict):
    checkpoint_id, session_id = request.get('checkpoint_id'), request.get('session_id')
    if checkpoint_id is not None:
        checkpoints = (project.get('roadmap') or {}).get('checkpoints') or []
        if not any(item.get('id') == checkpoint_id for item in checkpoints):
            raise broker.LocalAgentError(404, '关卡不属于当前云项目', 'scope_mismatch')
    if session_id is not None:
        response = await session.client.get(f'/api/agent/sessions/{session_id}')
        if response.status_code != 200:
            raise broker.LocalAgentError(404, '当前账号无权访问该导师会话', 'scope_mismatch')
        value = response.json()
        if value.get('project_id') != project_id or (checkpoint_id is not None and value.get('checkpoint_id') != checkpoint_id):
            raise broker.LocalAgentError(409, '导师会话与项目或关卡不一致', 'scope_mismatch')
        if checkpoint_id is None and value.get('checkpoint_id') is not None:
            raise broker.LocalAgentError(409, '关卡导师任务必须指定同一关卡', 'scope_mismatch')


def _snapshot_paths(storage: Path, run_id: int) -> tuple[Path, Path, Path]:
    isolation = storage / 'agent-runs' / str(run_id)
    return isolation, isolation / 'base', isolation / 'worktree'


def _run_snapshot_hash(run: dict) -> str:
    request = {key: run[key] for key in RunPreview.model_fields}
    return _digest([run['manifest'], request, run['profile_snapshot']])


def _verify_snapshot(storage: Path, run: dict, *, original: bool = True):
    if _run_snapshot_hash(run) != run['snapshot_hash']:
        raise broker.LocalAgentError(409, '任务或执行配置已变化，请重新准备', 'request_stale')
    _, base, worktree = _snapshot_paths(storage, run['id'])
    expected = run['manifest']['included']
    if broker._snapshot_manifest(base) != expected or broker._snapshot_manifest(worktree) != expected:
        raise broker.LocalAgentError(409, '隔离快照已变化，请重新准备任务', 'snapshot_stale')
    if original:
        root = _binding_root(storage)
        if str(root) != run['root'] or broker._snapshot_manifest(root) != expected:
            raise broker.LocalAgentError(409, '源工程已变化，请重新准备任务', 'source_stale')


async def _fresh_scope(session, project_id: int, run: dict):
    account = await session.client.get('/api/auth/me')
    project = await session.client.get(f'/api/vnext-projects/{project_id}')
    if account.status_code != 200 or account.json().get('learner_id') != session.learner_id or project.status_code != 200:
        raise broker.LocalAgentError(401, '云端会话或项目授权已失效', 'cloud_auth_expired')
    await _scope(session, project_id, project.json(), run)


async def _append(storage: Path, run_id: int, kind: str, payload: dict):
    async with _lock(storage):
        state = _load(storage)
        run = _run(state, run_id)
        if run['status'] != 'running':
            return
        _event(run, kind, payload)
        _save(storage, state)


async def _read_output(storage: Path, run_id: int, process, adapter) -> list[dict]:
    total = 0
    buffer = b''
    events = []
    while True:
        chunk = await process.stdout.read(4096)
        if not chunk:
            break
        total += len(chunk)
        if total > settings.local_agent_max_output_bytes:
            raise broker.LocalAgentError(409, '工程 Agent 输出达到上限，已停止执行', 'output_limited')
        buffer += chunk
        # Bound individual events even when a CLI emits one enormous JSON line.
        while b'\n' in buffer or len(buffer) >= 8192:
            position = buffer.find(b'\n')
            take = position + 1 if 0 <= position < 8192 else min(len(buffer), 8192)
            raw, buffer = buffer[:take], buffer[take:]
            event = adapter.parse_event(raw.decode('utf-8', errors='replace').rstrip())
            events.append(event)
            events = events[-MAX_EVENTS:]
            await _append(storage, run_id, 'output', event)
    if buffer:
        event = adapter.parse_event(buffer.decode('utf-8', errors='replace'))
        events.append(event)
        await _append(storage, run_id, 'output', event)
    await process.wait()
    return events


async def _stop_process(adapter, process):
    # Process.wait can hang when an unread stdout pipe is full. Discard output
    # in bounded chunks while the adapter terminates the process group.
    async def drain():
        if process.stdout:
            while await process.stdout.read(8192):
                pass
    draining = asyncio.create_task(drain())
    try:
        await adapter.cancel(process)
        await asyncio.wait_for(draining, timeout=5)
    finally:
        if not draining.done():
            draining.cancel()
        await asyncio.gather(draining, return_exceptions=True)


async def _execute(storage: Path, run_id: int, session, project_id: int):
    process = None
    adapter = None
    try:
        async with _lock(storage):
            state = _load(storage)
            run = _run(state, run_id)
            if run['status'] != 'queued':
                return
            run_copy = deepcopy(run)
        await _fresh_scope(session, project_id, run_copy)
        await asyncio.to_thread(_verify_snapshot, storage, run_copy)
        profile = SimpleNamespace(**run_copy['profile_snapshot'])
        adapter = broker.adapter_for(profile)
        probe = await adapter.probe(profile)
        if not probe.get('available') or not probe.get('authenticated'):
            raise broker.LocalAgentError(409, '所选 CLI 不可用或未登录；请在本机完成配置', 'agent_unavailable')
        isolation, _, worktree = _snapshot_paths(storage, run_id)
        await broker._initialize_isolated_git_repository(isolation, worktree)
        # Check the fixed snapshot once more after asynchronous setup, before CLI start.
        await asyncio.to_thread(_verify_snapshot, storage, run_copy)
        async with _lock(storage):
            state = _load(storage)
            run = _run(state, run_id)
            if run['status'] != 'queued':
                return
            run.update(status='running', started_at=time.time())
            _event(run, 'started', _boundary())
            _save(storage, state)
        prompt = broker._prompt_for(SimpleNamespace(**run_copy, base_manifest=run_copy['manifest']), profile)
        starting = asyncio.create_task(adapter.start(profile, worktree, prompt))
        try:
            process = await asyncio.shield(starting)
        except asyncio.CancelledError:
            # Retain the handle even if cancellation arrived during spawn.
            process = await starting
            raise
        if process is None or process.stdout is None:
            raise broker.LocalAgentError(409, '适配器没有提供受控输出进程', 'adapter_unsupported')
        events = await asyncio.wait_for(_read_output(storage, run_id, process, adapter), timeout=profile.timeout_seconds)
        if await asyncio.to_thread(broker._snapshot_manifest, isolation / 'base') != run_copy['manifest']['included']:
            raise broker.LocalAgentError(409, '执行期间基线快照被修改，禁止写回', 'baseline_stale')
        changes, diff, risks = await asyncio.to_thread(broker._collect_changes, isolation / 'base', worktree)
        if len(json.dumps([changes, diff]).encode()) > MAX_RESULT_BYTES or any(item.get('code') == 'diff_truncated' for item in risks):
            raise broker.LocalAgentError(409, '修改结果过大，无法完整审阅和安全写回', 'result_limited')
        for change in changes:
            change['change'] = {'create': 'added', 'write': 'modified', 'delete': 'deleted', 'move': 'moved'}[change['operation']]
            if change['operation'] == 'move':
                change['old_path'] = change['path']
        result = {**adapter.collect_result(events, process.returncode), **_boundary()}
        result['risks'] = [*result.get('risks', []), *risks]
        async with _lock(storage):
            state = _load(storage)
            run = _run(state, run_id)
            if run['status'] != 'running':
                return
            run.update(status='completed' if process.returncode == 0 else 'failed', finished_at=time.time(),
                       changed_files=changes, diff_text=diff, result=result,
                       result_hash=_digest([run['snapshot_hash'], changes, diff]))
            _event(run, run['status'], {'return_code': process.returncode, 'changed_file_count': len(changes), 'learning_evidence': False})
            _save(storage, state)
    except BaseException as exc:
        if adapter and process:
            await asyncio.shield(_stop_process(adapter, process))
        async with _lock(storage):
            state = _load(storage)
            run = _run(state, run_id)
            if run['status'] not in {'canceled', 'interrupted'}:
                code = 'timed_out' if isinstance(exc, asyncio.TimeoutError) else 'interrupted' if isinstance(exc, asyncio.CancelledError) else getattr(exc, 'code', 'execution_failed')
                status = code if code in {'timed_out', 'output_limited', 'interrupted'} else 'failed'
                run.update(status=status, finished_at=time.time(), error={'code': code, 'message': getattr(exc, 'detail', '工程 Agent 未完成；不会自动重跑')})
                _event(run, status, {'code': code, 'learning_evidence': False})
                _save(storage, state)
    finally:
        _tasks.pop((str(storage), run_id), None)


def _remove_created_directories(directories: list[Path]):
    for directory in reversed(directories):
        try:
            directory.rmdir()
        except FileNotFoundError:
            pass


def _apply(storage: Path, run: dict, data: RunApply):
    changes = run['changed_files']
    if data.result_hash != run['result_hash'] or _digest([run['snapshot_hash'], changes, run['diff_text']]) != data.result_hash:
        raise broker.LocalAgentError(409, '修改结果已变化，请重新审阅', 'result_stale')
    if any(item['operation'] == 'delete' and item['path'] not in data.confirmed_deletions for item in changes) or any(item['operation'] == 'move' and item['path'] not in data.confirmed_moves for item in changes):
        raise broker.LocalAgentError(400, '删除与移动必须逐项明确确认', 'separate_confirmation_required')
    root = _binding_root(storage)
    if str(root) != run['root']:
        raise broker.LocalAgentError(409, '项目绑定已变化', 'source_stale')
    created_directories = []
    backups = {}
    try:
        for change in changes:
            if change['operation'] not in {'create', 'write', 'delete', 'move'}:
                raise broker.LocalAgentError(403, '不支持此类文件修改', 'unsupported_change')
            for name in [change['path'], change.get('destination_path')]:
                if not name:
                    continue
                name = normalize_relative_path(name)
                if broker._is_secret(name) or broker._is_managed_learning_descriptor(name) or any(part.casefold() in broker.EXCLUDED_DIRECTORIES for part in Path(name).parts):
                    raise broker.LocalAgentError(403, '拒绝写回受保护文件', 'protected_change')
                # Create only missing parent directories, after the second confirmation.
                # Each step uses the same path/link/credential policy as ordinary files.
                parts = Path(name).parts
                for index in range(1, len(parts)):
                    relative = '/'.join(parts[:index])
                    _, parent = resolve_workspace_path(root, relative, actor='agent', allow_missing_leaf=True)
                    if not parent.exists():
                        parent.mkdir()
                        created_directories.append(parent)
                    elif not parent.is_dir():
                        raise broker.LocalAgentError(409, '文件父路径不是目录', 'source_stale')
            broker._validate_apply_target(root, change)
            if change['operation'] in {'create', 'write'}:
                if broker.sha256_bytes(change['content'].encode('utf-8')) != change['new_hash']:
                    raise broker.LocalAgentError(409, '文件内容摘要不匹配', 'result_stale')
                build_write_preview(root, change['path'], change['content'], actor='agent')
        backups = broker._backup_apply_targets(root, changes)
        backup_path = storage / 'agent-runs' / str(run['id']) / 'apply-backup.json'
        _atomic_write(backup_path, json.dumps({name: base64.b64encode(value).decode() if value is not None else None for name, value in backups.items()}).encode())
        for change in changes:
            broker._validate_apply_target(root, change)
            _, target = resolve_workspace_path(root, change['path'], actor='agent', allow_missing_leaf=change['operation'] == 'create')
            if change['operation'] in {'create', 'write'}:
                _atomic_write(target, change['content'].encode('utf-8'))
            elif change['operation'] == 'delete':
                target.unlink()
            elif change['operation'] == 'move':
                _, destination = resolve_workspace_path(root, change['destination_path'], actor='agent', allow_missing_leaf=True)
                target.replace(destination)
    except BaseException:
        if backups:
            broker._restore_apply_targets(root, backups)
        _remove_created_directories(created_directories)
        raise
    return backups, created_directories


async def agent_request(session, project_id: int, project: dict, storage: Path,
                        action: str, method: str, payload: object):
    """Called only after the cloud device gateway validates live owner and project."""
    try:
        if not isinstance(payload, dict):
            raise ValueError('object required')
        async with _lock(storage):
            state = _load(storage)
            if action == 'profiles' and method == 'GET':
                return JSONResponse({'profiles': state['profiles'], **_boundary()})
            if action == 'profiles' and method == 'POST':
                data = ProfileCreate.model_validate(payload)
                request = data.model_dump()
                key = 'profile:' + data.client_request_id
                previous = _replay(state, key, request)
                if previous:
                    return JSONResponse(next(item for item in state['profiles'] if item['id'] == previous['id']))
                if any(item['name'] == data.name for item in state['profiles']):
                    raise broker.LocalAgentError(409, '这个配置名称已存在', 'profile_name_conflict')
                profile = {**data.model_dump(exclude={'client_request_id'}), 'id': len(state['profiles']) + 1,
                           'adapter': 'codex_cli', 'enabled': True, 'capabilities': ['code_edit', 'test'],
                           'task_types': sorted(broker.ALLOWED_TASK_TYPES), **_boundary()}
                profile['last_probe'] = await broker.adapter_for(SimpleNamespace(**profile)).probe(SimpleNamespace(**profile))
                state['profiles'].append(profile)
                _remember(state, key, request, 'profile', profile['id'])
                _save(storage, state)
                return JSONResponse(profile)
            profile_path = action.split('/')
            if len(profile_path) == 2 and profile_path[0] == 'profiles' and profile_path[1].isdigit() and method == 'PUT':
                profile_id = int(profile_path[1])
                data = ProfileUpdate.model_validate(payload)
                request = [profile_id, data.model_dump()]
                key = 'profile-update:' + data.client_request_id
                previous = _replay(state, key, request)
                profile = next((item for item in state['profiles'] if item['id'] == profile_id), None)
                if not profile:
                    raise broker.LocalAgentError(404, '工程 Agent 配置不存在', 'profile_not_found')
                if previous:
                    return JSONResponse(profile)
                if any(item['id'] != profile_id and item['name'] == data.name for item in state['profiles']):
                    raise broker.LocalAgentError(409, '这个配置名称已存在', 'profile_name_conflict')
                # PUT replaces editable settings. Omitting a path restores auto-discovery.
                # A run keeps its own immutable profile_snapshot until a new preview.
                profile.update(data.model_dump(exclude={'client_request_id'}))
                configured = SimpleNamespace(**profile)
                profile['last_probe'] = await broker.adapter_for(configured).probe(configured)
                _remember(state, key, request, 'profile', profile_id)
                _save(storage, state)
                return JSONResponse(profile)
            if action == 'runs' and method == 'GET':
                for run in state['runs']:
                    await _scope(session, project_id, project, run)
                return JSONResponse({'runs': [_public_run(run) for run in reversed(state['runs'])]})
            if action == 'runs/preview' and method == 'POST':
                data = RunPreview.model_validate(payload)
                if any(len(value) > 500 for value in data.constraints) or not data.goal.strip():
                    raise ValueError('invalid task text')
                request = data.model_dump()
                await _scope(session, project_id, project, request)
                key = 'preview:' + data.client_request_id
                previous = _replay(state, key, request)
                if previous:
                    return JSONResponse(_public_run(_run(state, previous['id'])))
                profiles = sorted(state['profiles'], key=lambda item: (item['priority'], item['id']))
                candidates = [item for item in profiles if item['enabled'] and data.task_type in item['task_types'] and set(data.required_capabilities) <= set(item['capabilities'])]
                if not candidates:
                    raise broker.LocalAgentError(409, '先配置满足任务能力的本机 Codex CLI', 'profile_required')
                profile = None
                for candidate in candidates:
                    configured = SimpleNamespace(**candidate)
                    candidate['last_probe'] = await broker.adapter_for(configured).probe(configured)
                    if candidate['last_probe'].get('available') and candidate['last_probe'].get('authenticated'):
                        profile = candidate
                        break
                _save(storage, state)
                if profile is None:
                    raise broker.LocalAgentError(409, '已配置的 CLI 不可用或未登录；请修正路径或在本机登录后重试', 'agent_unavailable')
                root = _binding_root(storage)
                run_id = len(state['runs']) + 1
                isolation, base, worktree = _snapshot_paths(storage, run_id)
                if isolation.exists():
                    # A failed preview may have left an uncommitted directory; never reuse it.
                    run_id = max(run_id, max((int(path.name) for path in isolation.parent.iterdir() if path.name.isdigit()), default=0) + 1)
                    isolation, base, worktree = _snapshot_paths(storage, run_id)
                manifest = await asyncio.to_thread(broker._copy_safe_snapshot, root, base)
                if any(reason in manifest['summary']['skipped_by_reason'] for reason in ('copy_failed', 'source_changed_during_snapshot', 'file_count_budget_exceeded', 'total_bytes_budget_exceeded')):
                    raise broker.LocalAgentError(409, '工程快照不完整或变化，请缩小工程范围后重试', 'snapshot_incomplete')
                await asyncio.to_thread(broker._copy_manifest_snapshot, base, worktree, manifest)
                run = {**request, **_boundary(), 'id': run_id, 'project_id': project_id,
                       'profile_id': profile['id'], 'profile_snapshot': deepcopy(profile),
                       'root': str(root), 'status': 'proposed', 'created_at': time.time(),
                       'expires_at': time.time() + PREVIEW_TTL, 'manifest': manifest,
                       'snapshot_hash': _digest([manifest, request, profile]), 'changed_files': [], 'diff_text': '',
                       'result': _boundary(), 'result_hash': '', 'error': {}, 'events': []}
                await asyncio.to_thread(_verify_snapshot, storage, run)
                _event(run, 'proposed', {'learning_evidence': False})
                state['runs'].append(run)
                _remember(state, key, request, 'run', run_id)
                _save(storage, state)
                return JSONResponse(_public_run(run))
            parts = action.split('/')
            if len(parts) < 2 or parts[0] != 'runs' or not parts[1].isdigit():
                raise broker.LocalAgentError(404, '设备 Agent 操作不支持', 'operation_not_found')
            run_id = int(parts[1])
            run = _run(state, run_id)
            await _scope(session, project_id, project, run)
            operation = '/'.join(parts[2:])
            if method == 'GET' and operation == '':
                return JSONResponse(_public_run(run))
            if method == 'GET' and operation == 'events':
                return JSONResponse({'events': run['events'], 'next_sequence': run.get('event_sequence', 0), 'truncated': run.get('event_sequence', 0) > MAX_EVENTS})
            if method != 'POST' or operation not in {'confirm', 'cancel', 'apply'}:
                raise broker.LocalAgentError(404, '设备 Agent 操作不支持', 'operation_not_found')
            schema = {'confirm': RunConfirm, 'cancel': RunCancel, 'apply': RunApply}[operation]
            data = schema.model_validate(payload)
            request = [run_id, operation, data.model_dump()]
            key = 'operation:' + data.idempotency_key
            if _replay(state, key, request):
                return JSONResponse(_public_run(run))
            if operation == 'confirm':
                if data.snapshot_hash != run['snapshot_hash']:
                    raise broker.LocalAgentError(409, '任务快照不匹配', 'snapshot_mismatch')
                if run['status'] != 'proposed':
                    raise broker.LocalAgentError(409, '当前运行不能再次确认', 'invalid_status')
                if time.time() > run['expires_at']:
                    run['status'] = 'expired'
                    _save(storage, state)
                    raise broker.LocalAgentError(409, '任务预览已过期，请重新准备', 'expired')
                await asyncio.to_thread(_verify_snapshot, storage, run)
                run.update(status='queued', confirmed_at=time.time(), process_epoch=_EPOCH)
                _event(run, 'confirmed', {'learning_evidence': False})
                _remember(state, key, request, 'run', run_id)
                _save(storage, state)
                _tasks[(str(storage), run_id)] = asyncio.create_task(_execute(storage, run_id, session, project_id))
                return JSONResponse(_public_run(run))
            if operation == 'cancel':
                if run['status'] not in {'proposed', 'queued', 'running', 'canceled'}:
                    raise broker.LocalAgentError(409, '当前运行无法取消', 'invalid_status')
                run.update(status='canceled', finished_at=time.time())
                _event(run, 'canceled', {'learning_evidence': False})
                _remember(state, key, request, 'run', run_id)
                _save(storage, state)
                task = _tasks.get((str(storage), run_id))
                if task:
                    task.cancel()
                return JSONResponse(_public_run(run))
            if data.snapshot_hash != run['snapshot_hash'] or data.result_hash != run['result_hash']:
                raise broker.LocalAgentError(409, '快照或结果摘要不匹配', 'result_stale')
            if run['status'] != 'completed':
                raise broker.LocalAgentError(409, '当前运行结果无法写回', 'invalid_status')
            # No awaits during this transaction: cancellation cannot split a local write batch.
            backups, created_directories = _apply(storage, run, data)
            run.update(status='applied', applied_at=time.time())
            _event(run, 'applied', {'changed_file_count': len(run['changed_files']), 'learning_evidence': False})
            _remember(state, key, request, 'run', run_id)
            try:
                _save(storage, state)
            except OSError:
                broker._restore_apply_targets(_binding_root(storage), backups)
                _remove_created_directories(created_directories)
                raise
            return JSONResponse(_public_run(run))
    except broker.LocalAgentError as exc:
        return JSONResponse({'detail': {'code': exc.code, 'message': exc.detail}}, exc.status_code)
    except WorkspaceError as exc:
        return JSONResponse({'detail': {'code': exc.code, 'message': exc.detail}}, exc.status_code)
    except (ValidationError, ValueError, TypeError):
        return JSONResponse({'detail': {'code': 'invalid_request', 'message': '设备 Agent 请求格式无效'}}, 422)
    except OSError:
        return JSONResponse({'detail': {'code': 'device_io_failed', 'message': '本机工程操作失败，请检查目录权限与磁盘'}}, 409)
