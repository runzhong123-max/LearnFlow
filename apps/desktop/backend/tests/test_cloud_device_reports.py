import json
from types import SimpleNamespace

import httpx
import pytest

from app.services.cloud_device_reports import publish_run_report


@pytest.fixture(autouse=True)
def report_provenance(monkeypatch):
    from app.services import cloud_agent_broker
    calls = []
    value = {"schema_version": "learnflow.engineering-provenance.v1", "authority": "device_reported",
             "independent_completion_verified": False, "assisted": False, "runs": [], "truncated": False}
    def provenance(storage, manifest):
        calls.append((storage, manifest))
        return json.loads(json.dumps(value))
    # Allows these report tests to run against the isolated pre-integration tree.
    monkeypatch.setattr(cloud_agent_broker, 'engineering_provenance', provenance, raising=False)
    return SimpleNamespace(value=value, calls=calls)


@pytest.mark.asyncio
async def test_report_is_explicit_idempotent_and_does_not_upload_source_or_logs(tmp_path):
    secret_log = 'private source and environment output'
    run = {"id": 1, "action": "run", "status": "completed", "snapshot_hash": "a" * 64,
           "request": {"checkpoint_id": 9}, "manifest": [{"path": "main.c", "sha256": "b" * 64, "size": 10}],
           "result": {"steps": [{"name": "run", "exit_code": 0, "stdout": secret_log, "stderr": secret_log}]}}
    (tmp_path / 'binding.json').write_text(json.dumps({"runs": [run]}))
    uploads = []

    def upstream(request):
        if request.url.path == '/api/auth/csrf':
            return httpx.Response(200, json={"csrf_token": "csrf"})
        assert request.headers['x-csrf-token'] == 'csrf'
        uploads.append(json.loads(request.content))
        return httpx.Response(200, json={"report_id": 71, "artifact_ref": {"kind": "device_report", "ref": "71", "revision": "c" * 64}, "mastery_inference": False})

    async with httpx.AsyncClient(base_url='https://learn.example', transport=httpx.MockTransport(upstream)) as client:
        session = SimpleNamespace(client=client, csrf='')
        body = {"checkpoint_id": 9, "client_action_id": "report-1", "confirm_share": True}
        denied = await publish_run_report(session, 3, tmp_path, 1, json.dumps({**body, "confirm_share": False}).encode())
        assert denied.status_code == 422 and not uploads
        wrong_scope = await publish_run_report(session, 3, tmp_path, 1, json.dumps({**body, "checkpoint_id": 10}).encode())
        assert wrong_scope.status_code == 409 and not uploads
        first = await publish_run_report(session, 3, tmp_path, 1, json.dumps(body).encode())
        second = await publish_run_report(session, 3, tmp_path, 1, json.dumps(body).encode())
        assert first.status_code == second.status_code == 200
        assert first.body == second.body and len(uploads) == 1
        assert secret_log not in json.dumps(uploads)
        assert uploads[0]['steps'] == [{"name": "run", "exit_code": 0}]
        assert json.loads(first.body)['mastery_inference'] is False
        other_device = tmp_path / 'second-device'
        other_device.mkdir()
        (other_device / 'binding.json').write_text(json.dumps({"runs": [run]}))
        third = await publish_run_report(session, 3, other_device, 1, json.dumps(body).encode())
        assert third.status_code == 200 and len(uploads) == 2
        assert uploads[0]['client_action_id'] != uploads[1]['client_action_id']


@pytest.mark.asyncio
async def test_only_successful_real_runs_can_be_reported(tmp_path):
    session = SimpleNamespace(client=None)
    body = json.dumps({"checkpoint_id": 9, "client_action_id": "report-2", "confirm_share": True}).encode()
    for action, status, steps in [('build', 'completed', [{"exit_code": 0}]), ('run', 'running', []), ('run', 'completed', []), ('run', 'completed', [{"exit_code": 1}])]:
        (tmp_path / 'binding.json').write_text(json.dumps({"runs": [{"id": 1, "action": action, "status": status, "result": {"steps": steps}}]}))
        result = await publish_run_report(session, 3, tmp_path, 1, body)
        assert result.status_code == 409


@pytest.mark.asyncio
async def test_file_report_binds_displayed_version_and_omits_file_body(tmp_path):
    import hashlib
    from app.services.cloud_device_reports import publish_file_report
    root = tmp_path / 'project'
    root.mkdir()
    content = 'private design document'
    (root / 'README.md').write_text(content)
    storage = tmp_path / 'device'
    storage.mkdir()
    (storage / 'binding.json').write_text(json.dumps({"root": str(root)}))
    uploads = []
    def upstream(request):
        uploads.append(json.loads(request.content))
        return httpx.Response(200, json={"artifact_ref": {"kind": "device_report", "ref": "72", "revision": "c" * 64}})
    async with httpx.AsyncClient(base_url='https://learn.example', transport=httpx.MockTransport(upstream)) as client:
        session = SimpleNamespace(client=client, csrf='csrf')
        request = {"checkpoint_id": 9, "client_action_id": "file-report-1", "confirm_share": True,
                   "files": [{"path": "README.md", "sha256": hashlib.sha256(content.encode()).hexdigest()}]}
        first = await publish_file_report(session, 3, storage, json.dumps(request).encode())
        assert first.status_code == 200
        assert uploads[0]['action'] == 'files' and uploads[0]['steps'] == [] and uploads[0]['exit_code'] is None
        assert content not in json.dumps(uploads)
        (root / 'README.md').write_text('new content')
        stale = await publish_file_report(session, 3, storage, json.dumps(request).encode())
        assert stale.status_code == 409 and len(uploads) == 1
        request['files'][0]['path'] = '../binding.json'
        denied = await publish_file_report(session, 3, storage, json.dumps(request).encode())
        assert denied.status_code != 200 and len(uploads) == 1


def completed_run():
    return {"id": 1, "action": "run", "status": "completed", "checkpoint_id": 9, "snapshot_hash": "a" * 64,
            "manifest": [{"path": "main.c", "sha256": "b" * 64, "size": 10}],
            "result": {"steps": [{"name": "run", "exit_code": 0}]}}


def add_assistance(provenance):
    provenance.value.update(assisted=True, runs=[{
        'run_id': 21, 'checkpoint_id': 8, 'status': 'applied', 'snapshot_hash': 'c' * 64, 'result_hash': 'd' * 64,
        'assistance_policy': {'mode': 'implementation', 'revision': 2, 'execution_mode': 'workspace_write'},
        'association': 'exact_files', 'matching_paths': ['main.c'],
    }])


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['http_status', 'timeout'])
async def test_failed_upload_retry_pins_first_provenance_and_rejects_source_change(tmp_path, report_provenance, failure):
    from app.services.cloud_device import digest
    run = completed_run()
    (tmp_path / 'binding.json').write_text(json.dumps({'runs': [run]}))
    add_assistance(report_provenance)
    uploads = []
    def upstream(request):
        payload = json.loads(request.content)
        pending = json.loads((tmp_path / 'reported-runs.json').read_text())['stable-report']
        assert pending['payload'] == payload and pending['fingerprint'] == digest(payload)
        uploads.append(payload)
        if len(uploads) == 1:
            assert 'result' not in pending
            if failure == 'timeout':
                raise httpx.ReadTimeout('Response lost after possible commit', request=request)
            return httpx.Response(503, json={'detail': 'retry'})
        return httpx.Response(200, json={'report_id': 71, 'mastery_inference': False})
    async with httpx.AsyncClient(base_url='https://learn.example', transport=httpx.MockTransport(upstream)) as client:
        session = SimpleNamespace(client=client, csrf='csrf')
        body = json.dumps({'checkpoint_id': 9, 'client_action_id': 'stable-report', 'confirm_share': True}).encode()
        first = await publish_run_report(session, 3, tmp_path, 1, body)
        assert first.status_code == 503
        # A later run must neither overwrite old provenance nor create a 409.
        report_provenance.value['runs'][0]['result_hash'] = 'e' * 64
        report_provenance.value['runs'][0]['run_id'] = 22
        second = await publish_run_report(session, 3, tmp_path, 1, body)
        assert second.status_code == 200 and uploads[0] == uploads[1]
        assert len(report_provenance.calls) == 1
        assert uploads[0]['engineering_provenance']['runs'][0]['run_id'] == 21
        assert uploads[0]['engineering_provenance']['independent_completion_verified'] is False
        assert not any(key in json.dumps(uploads) for key in ['stdout', 'stderr', 'source_code', 'commands'])
        third = await publish_run_report(session, 3, tmp_path, 1, body)
        assert third.body == second.body and len(uploads) == 2
        wrong_project = await publish_run_report(session, 4, tmp_path, 1, body)
        assert wrong_project.status_code == 409
        run['manifest'][0]['sha256'] = 'f' * 64
        (tmp_path / 'binding.json').write_text(json.dumps({'runs': [run]}))
        assert (await publish_run_report(session, 3, tmp_path, 1, body)).status_code == 409
        assert len(uploads) == 2


@pytest.mark.asyncio
async def test_old_successful_journal_replays_without_attaching_later_provenance(tmp_path, report_provenance, monkeypatch):
    from app.services.cloud_device import digest
    from app.services import cloud_agent_broker
    (tmp_path / 'binding.json').write_text(json.dumps({'runs': [completed_run()]}))
    uploads = []
    def upstream(request):
        uploads.append(json.loads(request.content))
        return httpx.Response(200, json={'report_id': 71})
    async with httpx.AsyncClient(base_url='https://learn.example', transport=httpx.MockTransport(upstream)) as client:
        session = SimpleNamespace(client=client, csrf='csrf')
        body = json.dumps({'checkpoint_id': 9, 'client_action_id': 'old-report', 'confirm_share': True}).encode()
        await publish_run_report(session, 3, tmp_path, 1, body)
        old_payload = {key: value for key, value in uploads[0].items() if key != 'engineering_provenance'}
        # This is the exact successful journal format written before this feature.
        (tmp_path / 'reported-runs.json').write_text(json.dumps({'old-report': {'fingerprint': digest(old_payload), 'result': {'report_id': 71}}}))
        def broken(*_):
            raise ValueError('A later unrelated agent journal cannot invalidate an old receipt')
        monkeypatch.setattr(cloud_agent_broker, 'engineering_provenance', broken)
        result = await publish_run_report(session, 3, tmp_path, 1, body)
        assert result.status_code == 200 and json.loads(result.body)['report_id'] == 71
        assert len(uploads) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['broken_journal', 'invalid_source'])
async def test_invalid_provenance_fails_closed_before_network(tmp_path, report_provenance, monkeypatch, kind):
    from app.services import cloud_agent_broker
    (tmp_path / 'binding.json').write_text(json.dumps({'runs': [completed_run()]}))
    if kind == 'broken_journal':
        def broken(*_):
            raise ValueError('cannot parse local provenance')
        monkeypatch.setattr(cloud_agent_broker, 'engineering_provenance', broken)
    else:
        report_provenance.value['source_code'] = 'must never upload this'
    session = SimpleNamespace(client=None, csrf='csrf')
    body = json.dumps({'checkpoint_id': 9, 'client_action_id': 'bad-source', 'confirm_share': True}).encode()
    result = await publish_run_report(session, 3, tmp_path, 1, body)
    assert result.status_code == 409
    assert not (tmp_path / 'reported-runs.json').exists()


@pytest.mark.asyncio
async def test_file_report_failure_keeps_selected_versions_and_original_provenance(tmp_path, report_provenance):
    import hashlib
    from app.services.cloud_device_reports import publish_file_report
    root = tmp_path / 'project'; root.mkdir()
    content = 'int main() { return 0; }'
    (root / 'main.c').write_text(content)
    storage = tmp_path / 'device'; storage.mkdir()
    (storage / 'binding.json').write_text(json.dumps({'root': str(root)}))
    add_assistance(report_provenance)
    uploads = []
    def upstream(request):
        uploads.append(json.loads(request.content))
        return httpx.Response(503 if len(uploads) == 1 else 200, json={'report_id': 72})
    async with httpx.AsyncClient(base_url='https://learn.example', transport=httpx.MockTransport(upstream)) as client:
        session = SimpleNamespace(client=client, csrf='csrf')
        body = json.dumps({'checkpoint_id': 9, 'client_action_id': 'file-retry', 'confirm_share': True,
                           'files': [{'path': 'main.c', 'sha256': hashlib.sha256(content.encode()).hexdigest()}]}).encode()
        assert (await publish_file_report(session, 3, storage, body)).status_code == 503
        report_provenance.value.update(assisted=False, runs=[])
        assert (await publish_file_report(session, 3, storage, body)).status_code == 200
        assert uploads[0] == uploads[1] and uploads[0]['engineering_provenance']['assisted'] is True
        assert len(report_provenance.calls) == 1
        assert report_provenance.calls[0][1] == uploads[0]['manifest']
        assert content not in json.dumps(uploads)
