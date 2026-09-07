"""Cloud device engineering: real temporary files and mocked CLI processes only."""
import asyncio
import json
import os
from pathlib import Path
import signal
import sys
from types import SimpleNamespace
import httpx
import pytest
import pytest_asyncio
from app.core.config import settings
from app.services import cloud_agent_broker as agents
from app.services import cloud_device


class MockAdapter:
    def __init__(self):
        self.starts, self.processes = [], []
        self.mode, self.available, self.cancelled = 'write', True, 0

    async def probe(self, profile):
        return {'available': self.available, 'authenticated': self.available, 'version': 'test-only'}

    async def start(self, profile, workspace, prompt):
        self.starts.append((workspace, prompt))
        modes = {
            'write': "from pathlib import Path; Path('main.c').write_text('int main(void){return 1;}'); print('{\"type\":\"test\",\"status\":\"passed\"}', flush=True)",
            'delete': "from pathlib import Path; Path('main.c').unlink(); print('{}')",
            'move': "from pathlib import Path; Path('main.c').rename('renamed.c'); print('{}')",
            'sleep': "import time; print('{\"type\":\"started\"}', flush=True); time.sleep(30)",
            'output': "print('x'*200000, flush=True)",
            'protected': "from pathlib import Path; Path('.env').write_text('secret'); Path('private.lflecture').write_text('bad'); Path('main.c').write_text('safe'); print('{}')",
            'multi': "from pathlib import Path; Path('main.c').write_text('first'); Path('other.c').write_text('second'); print('{}')",
            'nested': "from pathlib import Path; Path('nested').mkdir(); Path('nested/new.c').write_text('new'); print('{}')",
        }
        process = await asyncio.create_subprocess_exec(sys.executable, '-c', modes[self.mode], cwd=workspace,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, start_new_session=True)
        self.processes.append(process)
        return process

    def parse_event(self, raw):
        try:
            return json.loads(raw)
        except ValueError:
            return {'type': 'output', 'text': raw}

    async def cancel(self, process):
        self.cancelled += 1
        if process and process.returncode is None:
            os.killpg(process.pid, signal.SIGKILL)
            await process.wait()

    def collect_result(self, events, return_code):
        return {'return_code': return_code, 'tests': events, 'summary': 'mock finished'}


@pytest_asyncio.fixture
async def env(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'runtime_dir', str(tmp_path / 'runtime'))
    async def forbid_evidence(*args, **kwargs):
        raise AssertionError('Device engineering cannot create learning evidence')
    monkeypatch.setattr(agents.broker, 'record_event', forbid_evidence)
    adapter = MockAdapter()
    monkeypatch.setattr(agents.broker, 'adapter_for', lambda profile: adapter)
    root = tmp_path / 'project'; root.mkdir()
    (root / 'main.c').write_text('int main(void){return 0;}')
    (root / '.env').write_text('never-copy-this')
    (root / '.git').mkdir(); (root / '.git' / 'private-history').write_text('never-copy-history')
    calls = []
    auth = {'allowed': True, 'session_project': 11, 'session_checkpoint': 3}
    def cloud(request):
        calls.append(request)
        assert request.method == 'GET', 'No task, output, files, or learning writes go to cloud'
        assert not request.content
        if not auth['allowed']: return httpx.Response(401, json={})
        if request.url.path == '/api/auth/me': return httpx.Response(200, json={'learner_id': 7})
        if request.url.path == '/api/vnext-projects/11': return httpx.Response(200, json={'roadmap': {'checkpoints': [{'id': 3}]}})
        if request.url.path == '/api/agent/sessions/5': return httpx.Response(200, json={'project_id': auth['session_project'], 'checkpoint_id': auth['session_checkpoint']})
        return httpx.Response(404, json={})
    async with httpx.AsyncClient(base_url='https://learn.example', transport=httpx.MockTransport(cloud)) as client:
        session = SimpleNamespace(client=client, learner_id=7)
        async def call(action, method='GET', payload=None, *, origin='https://learn.example', area='local-agent'):
            return await cloud_device.device_request(session, origin, 11, area, action, method, json.dumps(payload or {}).encode())
        await call('link', 'POST', {'root_path': str(root), 'client_request_id': 'link'}, area='workspace')
        storage = Path(settings.runtime_dir) / 'cloud-devices' / cloud_device.digest(['https://learn.example', 7, 11])
        profile = await call('profiles', 'POST', {'name': 'existing CLI', 'executable_path': '/already/installed/codex', 'client_request_id': 'profile1'})
        assert profile.status_code == 200, profile.body
        yield SimpleNamespace(call=call, root=root, storage=storage, adapter=adapter, auth=auth, calls=calls, session=session)
        for key, task in list(agents._tasks.items()):
            if key[0].startswith(str(tmp_path)):
                task.cancel(); await asyncio.gather(task, return_exceptions=True)


async def preview(env, key='task1', **extra):
    response = await env.call('runs/preview', 'POST', {'task_type': 'bug_fix', 'goal': 'Fix and test this code',
        'checkpoint_id': 3, 'session_id': 5, 'client_request_id': key, **extra})
    assert response.status_code == 200, response.body
    return json.loads(response.body)


async def confirm(env, run, key='confirm1'):
    response = await env.call(f"runs/{run['id']}/confirm", 'POST', {'snapshot_hash': run['snapshot_hash'], 'confirm_run': True, 'idempotency_key': key})
    assert response.status_code == 200, response.body
    return json.loads(response.body)


async def finished(env, run_id=1):
    for _ in range(300):
        response = await env.call(f'runs/{run_id}')
        assert response.status_code == 200, response.body
        run = json.loads(response.body)
        if run['status'] not in {'queued', 'running'}: return run
        await asyncio.sleep(.01)
    pytest.fail('test CLI did not finish')


def apply_payload(run, key='apply1', **extra):
    return {'snapshot_hash': run['snapshot_hash'], 'result_hash': run['result_hash'],
            'confirm_apply': True, 'idempotency_key': key, **extra}


@pytest.mark.asyncio
async def test_preview_two_confirmations_snapshot_idempotency_and_no_learning_write(env):
    run = await preview(env)
    assert not env.adapter.starts
    assert run['learning_evidence'] is False
    assert run['manifest']['included'].keys() == {'main.c'}
    assert (await preview(env))['id'] == run['id']
    assert (await env.call('runs/preview', 'POST', {'goal': 'different', 'client_request_id': 'task1'})).status_code == 409
    assert (await env.call('runs/1/confirm', 'POST', {'snapshot_hash': run['snapshot_hash'], 'idempotency_key': 'confirm1'})).status_code == 422
    await confirm(env, run); await confirm(env, run)
    complete = await finished(env)
    assert complete['status'] == 'completed', complete
    assert len(env.adapter.starts) == 1
    assert complete['changed_files'][0]['operation'] == 'write'
    assert (env.root / 'main.c').read_text() == 'int main(void){return 0;}'
    workspace, prompt = env.adapter.starts[0]
    assert workspace != env.root and 'LearnFlow Tutor' in prompt
    assert not (workspace / '.env').exists()
    assert not (workspace / '.git' / 'private-history').exists()
    events = json.loads((await env.call('runs/1/events')).body)
    assert events['next_sequence'] >= 4
    assert any(event['event_type'] == 'output' for event in events['events'])
    bad = apply_payload(complete); bad.pop('confirm_apply')
    assert (await env.call('runs/1/apply', 'POST', bad)).status_code == 422
    assert (await env.call('runs/1/apply', 'POST', apply_payload(complete))).status_code == 200
    assert (await env.call('runs/1/apply', 'POST', apply_payload(complete))).status_code == 200
    assert (env.root / 'main.c').read_text() == 'int main(void){return 1;}'
    assert not (env.root / '.learnflow').exists()
    assert (env.storage / 'agent-runs/1/apply-backup.json').exists()
    assert all(request.method == 'GET' for request in env.calls)


@pytest.mark.asyncio
async def test_scopes_and_authorities_are_revalidated_on_every_operation(env):
    assert (await env.call('runs/preview', 'POST', {'goal': 'fix code', 'checkpoint_id': 999, 'client_request_id': 'bad'})).status_code == 404
    run = await preview(env)
    env.auth['session_project'] = 22
    assert (await env.call('runs/1')).status_code == 409
    assert (await env.call('runs/1/confirm', 'POST', {'snapshot_hash': run['snapshot_hash'], 'confirm_run': True, 'idempotency_key': 'bad'})).status_code == 409
    assert not env.adapter.starts
    env.auth['session_project'] = 11; env.auth['allowed'] = False
    assert (await env.call('profiles')).status_code == 401
    env.auth['allowed'] = True
    assert (await env.call('runs/1', origin='https://other.example')).status_code == 404
    env.session.learner_id = 8
    assert (await env.call('runs/1')).status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['source', 'snapshot', 'expiry', 'task'])
async def test_confirmation_rejects_drift_and_expired_preview(env, change):
    run = await preview(env)
    if change == 'source': (env.root / 'main.c').write_text('changed externally')
    elif change == 'snapshot': (env.storage / 'agent-runs/1/worktree/main.c').write_text('changed snapshot')
    else:
        state = agents._load(env.storage)
        if change == 'expiry': state['runs'][0]['expires_at'] = 0
        else: state['runs'][0]['goal'] = 'task changed after preview'
        agents._save(env.storage, state)
    result = await env.call('runs/1/confirm', 'POST', {'snapshot_hash': run['snapshot_hash'], 'confirm_run': True, 'idempotency_key': 'x'})
    assert result.status_code == 409, result.body
    assert not env.adapter.starts


@pytest.mark.asyncio
async def test_background_cancel_does_not_hold_device_global_lock(env):
    env.adapter.mode = 'sleep'; run = await preview(env); await confirm(env, run)
    for _ in range(200):
        if env.adapter.processes: break
        await asyncio.sleep(.01)
    assert env.adapter.processes
    assert (await asyncio.wait_for(env.call('tree', area='workspace'), timeout=1)).status_code == 200
    assert (await asyncio.wait_for(env.call('runs/1/cancel', 'POST', {'idempotency_key': 'cancel1'}), timeout=1)).status_code == 200
    for _ in range(200):
        if env.adapter.processes[0].returncode is not None: break
        await asyncio.sleep(.01)
    assert env.adapter.processes[0].returncode is not None
    assert (await finished(env))['status'] == 'canceled'
    assert len(env.adapter.starts) == 1


@pytest.mark.asyncio
async def test_output_limit_kills_process_and_restart_never_reexecutes(env, monkeypatch):
    monkeypatch.setattr(settings, 'local_agent_max_output_bytes', 1024)
    env.adapter.mode = 'output'; run = await preview(env); await confirm(env, run)
    result = await finished(env)
    assert result['status'] == 'output_limited', result
    assert env.adapter.cancelled
    state = agents._load(env.storage); state['runs'][0].update(status='running', process_epoch='old-process'); agents._save(env.storage, state)
    recovered = json.loads((await env.call('runs/1')).body)
    assert recovered['status'] == 'interrupted'
    assert len(env.adapter.starts) == 1


@pytest.mark.asyncio
async def test_apply_hash_drift_and_protected_files(env):
    env.adapter.mode = 'protected'; run = await preview(env); await confirm(env, run)
    complete = await finished(env)
    assert complete['status'] == 'completed', complete
    assert [item['path'] for item in complete['changed_files']] == ['main.c']
    assert (env.root / '.env').read_text() == 'never-copy-this'
    (env.root / 'main.c').write_text('user kept editing')
    assert (await env.call('runs/1/apply', 'POST', apply_payload(complete))).status_code == 409
    assert (env.root / 'main.c').read_text() == 'user kept editing'
    assert not (env.root / 'private.lflecture').exists()


@pytest.mark.asyncio
@pytest.mark.parametrize('mode,confirmation', [('delete', 'confirmed_deletions'), ('move', 'confirmed_moves')])
async def test_delete_and_move_require_individual_confirmation(env, mode, confirmation):
    env.adapter.mode = mode; run = await preview(env); await confirm(env, run)
    complete = await finished(env)
    assert complete['status'] == 'completed', complete
    assert (await env.call('runs/1/apply', 'POST', apply_payload(complete))).status_code == 400
    response = await env.call('runs/1/apply', 'POST', apply_payload(complete, **{confirmation: ['main.c']}))
    assert response.status_code == 200, response.body
    assert not (env.root / 'main.c').exists()
    if mode == 'move': assert (env.root / 'renamed.c').exists()


@pytest.mark.asyncio
async def test_apply_rolls_back_whole_batch_on_write_failure(env, monkeypatch):
    (env.root / 'other.c').write_text('original other')
    env.adapter.mode = 'multi'; run = await preview(env); await confirm(env, run)
    complete = await finished(env)
    original = agents._atomic_write
    calls = 0
    def fail(path, content):
        nonlocal calls
        if path.parent == env.root:
            calls += 1
            if calls == 2: raise OSError('simulated disk failure')
        original(path, content)
    monkeypatch.setattr(agents, '_atomic_write', fail)
    response = await env.call('runs/1/apply', 'POST', apply_payload(complete))
    assert response.status_code == 409, response.body
    assert (env.root / 'main.c').read_text() == 'int main(void){return 0;}'
    assert (env.root / 'other.c').read_text() == 'original other'


@pytest.mark.asyncio
async def test_nested_new_files_result_hash_and_confirm_key_conflicts(env):
    env.adapter.mode = 'nested'
    run = await preview(env); await confirm(env, run)
    complete = await finished(env)
    assert complete['status'] == 'completed', complete
    assert not (env.root / 'nested').exists()
    wrong = apply_payload(complete); wrong['result_hash'] = '0' * 64
    assert (await env.call('runs/1/apply', 'POST', wrong)).status_code == 409
    assert (await env.call('runs/1/cancel', 'POST', {'idempotency_key': 'confirm1'})).status_code == 409
    response = await env.call('runs/1/apply', 'POST', apply_payload(complete))
    assert response.status_code == 200, response.body
    assert (env.root / 'nested/new.c').read_text() == 'new'


@pytest.mark.asyncio
async def test_symlink_apply_target_is_rejected(env):
    run = await preview(env); await confirm(env, run)
    complete = await finished(env)
    outside = env.root.parent / 'outside.c'; outside.write_text('outside')
    (env.root / 'main.c').unlink(); (env.root / 'main.c').symlink_to(outside)
    response = await env.call('runs/1/apply', 'POST', apply_payload(complete))
    assert response.status_code == 403, response.body
    assert outside.read_text() == 'outside'


@pytest.mark.asyncio
async def test_timeout_and_unavailable_cli_fail_without_writeback(env):
    env.adapter.available = False
    denied = await env.call('runs/preview', 'POST', {'goal': 'test unavailable CLI', 'client_request_id': 'unavailable'})
    assert denied.status_code == 409 and json.loads(denied.body)['detail']['code'] == 'agent_unavailable'
    assert not env.adapter.starts
    env.adapter.available = True; env.adapter.mode = 'sleep'
    run = await preview(env, key='task2')
    state = agents._load(env.storage)
    state['runs'][0]['profile_snapshot']['timeout_seconds'] = .02
    state['runs'][0]['snapshot_hash'] = agents._run_snapshot_hash(state['runs'][0])
    run['snapshot_hash'] = state['runs'][0]['snapshot_hash']
    agents._save(env.storage, state)
    await confirm(env, run, key='confirm2')
    result = await finished(env)
    assert result['status'] == 'timed_out', result
    assert (env.root / 'main.c').read_text() == 'int main(void){return 0;}'


@pytest.mark.asyncio
async def test_profile_put_recovers_wrong_path_and_preserves_existing_preview(env):
    first = await preview(env)
    old_snapshot = agents._load(env.storage)['runs'][0]['profile_snapshot'].copy()
    async def probe(profile):
        ok = profile.executable_path in {'/correct/codex', None}
        return {'available': ok, 'authenticated': ok, 'message': 'ready' if ok else 'invalid CLI path'}
    env.adapter.probe = probe
    bad = {'name': 'existing CLI', 'executable_path': '/wrong/codex', 'enabled': True, 'client_request_id': 'update-bad'}
    response = await env.call('profiles/1', 'PUT', bad)
    assert response.status_code == 200, response.body
    assert json.loads(response.body)['last_probe']['available'] is False
    denied = await env.call('runs/preview', 'POST', {'goal': 'test after wrong path', 'client_request_id': 'task-wrong'})
    assert denied.status_code == 409
    corrected = {**bad, 'executable_path': '/correct/codex', 'client_request_id': 'update-good'}
    response = await env.call('profiles/1', 'PUT', corrected)
    assert response.status_code == 200, response.body
    assert json.loads(response.body)['last_probe']['authenticated'] is True
    assert (await env.call('profiles/1', 'PUT', corrected)).status_code == 200
    assert (await env.call('profiles/1', 'PUT', {**corrected, 'enabled': False})).status_code == 409
    second = await preview(env, key='task-corrected')
    state = agents._load(env.storage)
    assert state['runs'][0]['profile_snapshot'] == old_snapshot
    assert state['runs'][1]['profile_snapshot']['executable_path'] == '/correct/codex'
    await confirm(env, second)
    assert (await finished(env, second['id']))['status'] == 'completed'
    # Reuse the same profile name and clear an obsolete path by omitting it.
    automatic = await env.call('profiles/1', 'PUT', {'name': 'existing CLI', 'client_request_id': 'update-auto'})
    assert automatic.status_code == 200
    assert json.loads(automatic.body)['executable_path'] is None
    assert json.loads((await env.call(f"runs/{first['id']}")).body)['snapshot_hash'] == first['snapshot_hash']


@pytest.mark.asyncio
async def test_preview_skips_unavailable_profile_and_refreshes_login_status(env):
    async def probe(profile):
        return {'available': True, 'authenticated': profile.name != 'not logged in'}
    env.adapter.probe = probe
    response = await env.call('profiles', 'POST', {'name': 'not logged in', 'priority': 0, 'client_request_id': 'profile2'})
    assert response.status_code == 200
    run = await preview(env)
    assert run['profile_id'] == 1
    env.adapter.probe = lambda profile: asyncio.sleep(0, result={'available': True, 'authenticated': True})
    second = await preview(env, key='login-updated')
    assert second['profile_id'] == 2
    disabled = await env.call('profiles/2', 'PUT', {'name': 'not logged in', 'enabled': False, 'client_request_id': 'disable'})
    assert disabled.status_code == 200
    third = await preview(env, key='disabled')
    assert third['profile_id'] == 1
