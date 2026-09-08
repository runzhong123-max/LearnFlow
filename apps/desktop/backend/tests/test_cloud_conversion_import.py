import hashlib
import json
from types import SimpleNamespace
import httpx
import pytest
from app.core.config import settings
from app.services.cloud_conversion_import import import_handoff, validate_starter_files, rename_exclusive
from app.services.cloud_device import device_request
from app.services.workspace_files import WorkspaceError

TICKET = 'a' * 43
ROOT_HASH = 'b' * 64


def proposal():
    content = 'name,count\n工单,1\n'
    files = [{'path': 'data/input.csv', 'content': content, 'sha256': hashlib.sha256(content.encode()).hexdigest()}]
    manifest = [{'path': f['path'], 'sha256': f['sha256'], 'size': len(f['content'].encode())} for f in files]
    return {'schema_version': 'learnflow.work-task-conversion.v1', 'learner_id': 7, 'root_hash': ROOT_HASH,
            'candidate': {'project_mode': 'experiment'}, 'starter_files': files,
            'starter_manifest_hash': hashlib.sha256(json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}


def request_payload(parent):
    return {'client_action_id': 'desktop-import-1', 'expected_root_hash': ROOT_HASH, 'confirmed': True, 'parent_path': str(parent)}


@pytest.mark.asyncio
async def test_owned_atomic_idempotent_import_and_account_isolation(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'runtime_dir', str(tmp_path / 'runtime'))
    parent = tmp_path / 'projects'; parent.mkdir()
    cloud, calls = proposal(), []
    def upstream(request):
        calls.append(request)
        if request.url.path == '/api/auth/me': return httpx.Response(200, json={'learner_id': 7})
        if request.url.path == '/api/auth/csrf': return httpx.Response(200, json={'csrf_token': 'csrf'})
        if request.url.path == '/api/vnext-projects/11': return httpx.Response(200, json={'project': {'id': 11}})
        if request.method == 'POST':
            assert json.loads(request.content) == {k: request_payload(parent)[k] for k in ('client_action_id', 'expected_root_hash', 'confirmed')}
            assert request.headers['X-CSRF-Token'] == 'csrf'
            return httpx.Response(200, json={**cloud, 'project_id': 11, 'project_tutor': {'session_id': 9}})
        return httpx.Response(200, json=cloud)
    async with httpx.AsyncClient(base_url='https://learn.example', transport=httpx.MockTransport(upstream)) as client:
        session = SimpleNamespace(client=client, learner_id=7, csrf='')
        response = await import_handoff(session, 'https://learn.example', TICKET, json.dumps(request_payload(parent)).encode())
        assert response.status_code == 200, response.body
        result = json.loads(response.body)
        assert result['project_id'] == 11 and result['learning_evidence'] is False
        file = parent / 'LearnFlow-project-11/data/input.csv'
        assert file.read_text() == cloud['starter_files'][0]['content']
        file.write_text('user edit')
        replay = await import_handoff(session, 'https://learn.example', TICKET, json.dumps(request_payload(parent)).encode())
        assert replay.status_code == 200 and file.read_text() == 'user edit'
        assert (await device_request(session, 'https://learn.example', 11, 'workspace', 'tree', 'GET', b'')).status_code == 200
        assert (await device_request(session, 'https://other.example', 11, 'workspace', 'tree', 'GET', b'')).status_code == 404
        session.learner_id = 8
        assert (await import_handoff(session, 'https://learn.example', TICKET, json.dumps(request_payload(parent)).encode())).status_code == 401
    assert not list(parent.glob('.learnflow-import-*'))
    assert not any(TICKET in p.read_text() for p in (tmp_path / 'runtime').rglob('*.json'))
    assert not any(str(parent) in request.content.decode() for request in calls)


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['unconfirmed', 'wrong_account', 'expired', 'hash', 'manifest', 'root', 'symlink', 'occupied', 'unsupported'])
async def test_rejects_before_local_write(tmp_path, monkeypatch, failure):
    monkeypatch.setattr(settings, 'runtime_dir', str(tmp_path / 'runtime'))
    parent = tmp_path / 'projects'; parent.mkdir()
    data, cloud = request_payload(parent), proposal()
    if failure == 'unconfirmed': data['confirmed'] = False
    if failure == 'wrong_account': cloud['learner_id'] = 8
    if failure == 'hash': cloud['starter_files'][0]['content'] = 'tampered'
    if failure == 'manifest': cloud['starter_manifest_hash'] = 'c' * 64
    if failure == 'root': cloud['root_hash'] = 'c' * 64
    if failure == 'unsupported': cloud['schema_version'] = 'unknown'
    if failure == 'symlink':
        alias = tmp_path / 'alias'; alias.symlink_to(parent, target_is_directory=True); data['parent_path'] = str(alias)
    if failure == 'occupied':
        target = parent / 'LearnFlow-project-11'; target.mkdir(); (target / 'existing.txt').write_text('keep')
    def upstream(request):
        if request.url.path == '/api/auth/me': return httpx.Response(200, json={'learner_id': 7})
        if request.url.path == '/api/auth/csrf': return httpx.Response(200, json={'csrf_token': 'csrf'})
        if request.url.path == '/api/vnext-projects/11': return httpx.Response(200, json={'project': {'id': 11}})
        if failure == 'expired': return httpx.Response(410, json={})
        return httpx.Response(200, json={**cloud, 'project_id': 11})
    async with httpx.AsyncClient(base_url='https://learn.example', transport=httpx.MockTransport(upstream)) as client:
        response = await import_handoff(SimpleNamespace(client=client, learner_id=7, csrf=''), 'https://learn.example', TICKET, json.dumps(data).encode())
        assert response.status_code in {400, 409, 410, 422}, response.body
    assert not list(parent.glob('**/input.csv'))
    assert not list(parent.glob('.learnflow-import-*'))
    if failure == 'occupied': assert (parent / 'LearnFlow-project-11/existing.txt').read_text() == 'keep'


@pytest.mark.parametrize('path', ['../evil', '/absolute', 'a/../../evil', '.env', '.git/config', '.learnflow/x', 'a\\evil', 'C:evil', 'CON.txt', 'a//b', 'a/./b'])
def test_rejects_unsafe_files(path):
    data = proposal(); data['starter_files'][0]['path'] = path
    with pytest.raises(WorkspaceError): validate_starter_files(data['starter_files'], data['starter_manifest_hash'])


def test_atomic_publish_never_replaces_existing_directory(tmp_path):
    staging = tmp_path / 'staging'; staging.mkdir(); (staging / 'new').write_text('new')
    existing = tmp_path / 'existing'; existing.mkdir()
    with pytest.raises(WorkspaceError): rename_exclusive(staging, existing)
    assert existing.is_dir() and not list(existing.iterdir()) and (staging / 'new').is_file()


@pytest.mark.asyncio
async def test_interrupted_metadata_save_recovers_published_directory(tmp_path, monkeypatch):
    from app.services import cloud_conversion_import as service
    monkeypatch.setattr(settings, 'runtime_dir', str(tmp_path / 'runtime'))
    parent = tmp_path / 'projects'; parent.mkdir()
    cloud = proposal()
    def upstream(request):
        if request.url.path == '/api/auth/me': return httpx.Response(200, json={'learner_id': 7})
        return httpx.Response(200, json={**cloud, 'project_id': 11})
    original_save = service.save
    def fail_metadata(path, value):
        if path.name == 'binding.json': raise OSError('simulated disk failure')
        original_save(path, value)
    async with httpx.AsyncClient(base_url='https://learn.example', transport=httpx.MockTransport(upstream)) as client:
        session = SimpleNamespace(client=client, learner_id=7, csrf='csrf')
        monkeypatch.setattr(service, 'save', fail_metadata)
        assert (await import_handoff(session, 'https://learn.example', TICKET, json.dumps(request_payload(parent)).encode())).status_code == 409
        assert (parent / 'LearnFlow-project-11/data/input.csv').is_file()
        monkeypatch.setattr(service, 'save', original_save)
        assert (await import_handoff(session, 'https://learn.example', TICKET, json.dumps(request_payload(parent)).encode())).status_code == 200
