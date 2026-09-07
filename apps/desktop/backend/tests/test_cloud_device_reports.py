import json
from types import SimpleNamespace

import httpx
import pytest

from app.services.cloud_device_reports import publish_run_report


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
