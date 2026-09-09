"""Import an account-owned immutable cloud proposal into a new device directory.

No commands are executed, no local identity is created, and this device journal
is not learning evidence. Cloud ownership is checked on every request.
"""
from __future__ import annotations

import asyncio
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile

from fastapi.responses import JSONResponse

from app.services.cloud_device import digest, save
from app.services.project_runner import runtime_root
from app.services.workspace_files import WorkspaceError, canonical_root, _is_link_or_reparse

_lock = asyncio.Lock()
TICKET = re.compile(r'[A-Za-z0-9_-]{32,128}')
HASH = re.compile(r'[a-f0-9]{64}')
MAX_FILES = 32
MAX_FILE_BYTES = 256 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024
MARKER = '.learnflow-conversion.json'


def validate_starter_files(files, expected_manifest_hash: str):
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        raise WorkspaceError(422, '初始文件数量无效', 'invalid_manifest')
    seen, manifest, prepared, total = set(), [], [], 0
    for file in files:
        if not isinstance(file, dict) or set(file) != {'path', 'content', 'sha256'}:
            raise WorkspaceError(422, '初始文件格式无效', 'invalid_manifest')
        name, content, file_hash = file['path'], file['content'], file['sha256']
        if not isinstance(name, str) or not 1 <= len(name) <= 240 or '\\' in name:
            raise WorkspaceError(422, '初始文件路径无效', 'invalid_path')
        parts = name.split('/')
        # Portable names, no dotfiles, drive syntax, reparse escapes or Windows devices.
        if any(not re.fullmatch(r'[\w][\w. -]{0,79}', part, re.UNICODE)
               or part.endswith(('.', ' '))
               or part.split('.')[0].upper() in {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{i}' for i in range(10)), *(f'LPT{i}' for i in range(10))}
               for part in parts):
            raise WorkspaceError(422, '初始文件包含不安全路径', 'invalid_path')
        key = name.casefold()
        if key in seen or any(key.startswith(p + '/') or p.startswith(key + '/') for p in seen):
            raise WorkspaceError(422, '初始文件路径重复或冲突', 'duplicate_path')
        seen.add(key)
        if not isinstance(content, str) or '\x00' in content or not isinstance(file_hash, str) or not HASH.fullmatch(file_hash):
            raise WorkspaceError(422, '初始文件必须是带校验值的文本', 'invalid_file')
        data = content.encode('utf-8')
        total += len(data)
        if len(data) > MAX_FILE_BYTES or total > MAX_TOTAL_BYTES:
            raise WorkspaceError(413, '初始文件超过导入大小限制', 'too_large')
        if hashlib.sha256(data).hexdigest() != file_hash:
            raise WorkspaceError(409, '初始文件校验失败，请返回网页重新生成交接', 'hash_mismatch')
        manifest.append({'path': name, 'sha256': file_hash, 'size': len(data)})
        prepared.append((name, data))
    canonical = json.dumps(manifest, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    if hashlib.sha256(canonical).hexdigest() != expected_manifest_hash:
        raise WorkspaceError(409, '文件清单已变化，请重新预览', 'manifest_mismatch')
    return prepared


def checked_parent(value: str, storage: Path):
    root = canonical_root(value)
    # Reject symlinks in the supplied path as well as the final component.
    supplied = Path(value).expanduser()
    for path in [supplied, *supplied.parents]:
        if _is_link_or_reparse(path):
            raise WorkspaceError(400, '所选路径包含符号链接或重解析点', 'unsafe_link')
    if root == storage or root in storage.parents or storage in root.parents:
        raise WorkspaceError(409, '项目目录必须与应用数据目录分离', 'runtime_overlap')
    return root


def rename_exclusive(source: Path, target: Path):
    """Publish the entire prepared tree without replacing any existing target."""
    if sys.platform == 'darwin':
        lib = ctypes.CDLL(None, use_errno=True)
        result = lib.renamex_np(os.fsencode(source), os.fsencode(target), 4)  # RENAME_EXCL
    elif sys.platform.startswith('linux'):
        lib = ctypes.CDLL(None, use_errno=True)
        if not hasattr(lib, 'renameat2'):
            raise WorkspaceError(409, '此系统不支持安全的整目录导入', 'unsupported_atomic_import')
        result = lib.renameat2(-100, os.fsencode(source), -100, os.fsencode(target), 1)
    elif os.name == 'nt':
        os.rename(source, target)  # Windows refuses an existing target.
        return
    else:
        raise WorkspaceError(409, '此系统不支持安全的整目录导入', 'unsupported_atomic_import')
    if result:
        error = ctypes.get_errno()
        if error in {errno.EEXIST, errno.ENOTEMPTY}:
            raise WorkspaceError(409, '目标目录已存在；请选择其他父目录，已有文件不会覆盖', 'destination_exists')
        raise OSError(error, 'Atomic import failed')


def install_files(parent: Path, target: Path, prepared, marker, metadata: Path, state):
    temporary = Path(tempfile.mkdtemp(prefix='.learnflow-import-', dir=parent))
    try:
        os.chmod(temporary, 0o700)
        for name, data in prepared:
            destination = temporary / name
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with destination.open('xb') as stream:
                os.chmod(destination, 0o600)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        save(temporary / MARKER, marker)
        # The chosen parent must retain its original identity before publish.
        if parent.resolve(strict=True) != parent or _is_link_or_reparse(parent):
            raise WorkspaceError(409, '所选目录已变化，请重新选择', 'parent_changed')
        rename_exclusive(temporary, target)
        state.update(root=str(target), **marker)
        save(metadata, state)
    finally:
        if temporary.exists() and not temporary.is_symlink():
            shutil.rmtree(temporary)


async def import_handoff(session, origin: str, ticket: str, body: bytes):
    try:
        if not TICKET.fullmatch(ticket):
            raise WorkspaceError(400, '交接链接格式无效', 'invalid_ticket')
        payload = json.loads(body)
        if (set(payload) != {'client_action_id', 'expected_root_hash', 'confirmed', 'parent_path'}
            or payload['confirmed'] is not True
            or not isinstance(payload['client_action_id'], str)
            or not re.fullmatch(r'[A-Za-z0-9_-]{8,128}', payload['client_action_id'])
            or not isinstance(payload['expected_root_hash'], str)
            or not HASH.fullmatch(payload['expected_root_hash'])
            or not isinstance(payload['parent_path'], str)):
            raise WorkspaceError(422, '请先预览方案并明确确认导入', 'confirmation_required')
        account = await session.client.get('/api/auth/me')
        if account.status_code != 200 or account.json().get('learner_id') != session.learner_id:
            return JSONResponse({'detail': '云端会话已失效，请重新登录'}, 401)
        endpoint = f'/api/work-task-conversions/handoff/{ticket}'
        preview_response = await session.client.get(endpoint)
        if preview_response.status_code != 200:
            return JSONResponse({'detail': '交接已过期、不可用或不属于当前账号；请用网页同一账号重新发起'}, preview_response.status_code if preview_response.status_code in {401, 403, 404, 409, 410} else 503)
        preview = preview_response.json()
        if (preview.get('schema_version') != 'learnflow.work-task-conversion.v1'
            or preview.get('learner_id') != session.learner_id
            or preview.get('candidate', {}).get('project_mode') not in {'experiment', 'practice'}):
            raise WorkspaceError(409, '客户端无法导入此方案，请更新客户端或返回网页', 'unsupported_proposal')
        if preview.get('root_hash') != payload['expected_root_hash']:
            raise WorkspaceError(409, '方案已变化，请重新预览确认', 'proposal_changed')
        prepared = validate_starter_files(preview.get('starter_files'), preview.get('starter_manifest_hash'))
        runtime = Path(runtime_root(create=True)).resolve()
        parent = checked_parent(payload['parent_path'], runtime)
        async with _lock:
            from app.services.cloud_connection import cloud_mutation_headers
            mutation_headers = await cloud_mutation_headers(session)
            confirmation = {k: payload[k] for k in ('client_action_id', 'expected_root_hash', 'confirmed')}
            consumed_response = await session.client.post(endpoint, json=confirmation, headers=mutation_headers)
            if consumed_response.status_code != 200:
                return JSONResponse({'detail': '云端项目导入未完成，请刷新预览后重试'}, consumed_response.status_code if consumed_response.status_code in {401, 403, 404, 409, 410, 422} else 503)
            result = consumed_response.json()
            project_id = result.get('project_id')
            if (not isinstance(project_id, int) or isinstance(project_id, bool) or project_id <= 0
                or result.get('root_hash') != payload['expected_root_hash']
                or result.get('starter_manifest_hash') != preview['starter_manifest_hash']):
                raise WorkspaceError(409, '云端返回的项目或文件快照不一致', 'handoff_mismatch')
            validate_starter_files(result.get('starter_files'), preview['starter_manifest_hash'])
            # Verify the formal project separately before binding any directory.
            project = await session.client.get(f'/api/vnext-projects/{project_id}')
            if project.status_code != 200:
                return JSONResponse({'detail': '当前账号无法验证导入项目'}, 403)
            key = digest([origin, session.learner_id, project_id])
            storage = runtime / 'cloud-devices' / key
            metadata = storage / 'binding.json'
            state = json.loads(metadata.read_text()) if metadata.exists() else {'runs': [], 'operations': {}}
            marker = {'authority': origin, 'learner_id': session.learner_id, 'project_id': project_id,
                      'conversion_root_hash': payload['expected_root_hash'], 'starter_manifest_hash': preview['starter_manifest_hash']}
            target = parent / f'LearnFlow-project-{project_id}'
            if state.get('root'):
                if any(state.get(k) != v for k, v in marker.items()):
                    raise WorkspaceError(409, '项目已绑定本机目录，无法覆盖导入', 'already_bound')
                target = canonical_root(state['root'])
            elif os.path.lexists(target):
                # Recover only our own complete publish after an interrupted metadata save.
                if _is_link_or_reparse(target) or not target.is_dir() or _is_link_or_reparse(target / MARKER):
                    raise WorkspaceError(409, '目标目录已存在，已有文件不会覆盖', 'destination_exists')
                if not (target / MARKER).is_file() or json.loads((target / MARKER).read_text()) != marker:
                    raise WorkspaceError(409, '目标目录已存在，已有文件不会覆盖', 'destination_exists')
                for name, data in prepared:
                    file = target / name
                    if any(_is_link_or_reparse(path) for path in [file, *file.parents] if path != parent):
                        raise WorkspaceError(409, '导入目录包含不安全链接', 'unsafe_link')
                    if not file.is_file() or file.read_bytes() != data:
                        raise WorkspaceError(409, '已发布的初始文件发生变化，请检查本机目录', 'recovery_conflict')
                state.update(root=str(target), **marker)
                save(metadata, state)
            else:
                await asyncio.to_thread(install_files, parent, target, prepared, marker, metadata, state)
            # Do not leak full cloud proposal or local files back into logs or URLs.
            return JSONResponse({'project_id': project_id, 'project_tutor': result.get('project_tutor'),
                                 'navigation': {'kind': 'project', 'path': f'/projects/{project_id}'},
                                 'root_path': str(target), 'learning_evidence': False, 'status': 'imported'})
    except WorkspaceError as exc:
        return JSONResponse({'detail': exc.detail, 'code': exc.code}, exc.status_code)
    except (ValueError, TypeError, KeyError, AttributeError):
        return JSONResponse({'detail': '交接数据格式无效或客户端版本不支持'}, 422)
    except OSError:
        return JSONResponse({'detail': '本机导入失败，请检查目录权限与可用空间；可以重试同一交接'}, 409)
