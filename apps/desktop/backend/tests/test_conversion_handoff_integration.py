"""Real shared cloud API -> authenticated relay -> device import contract.

The network transport is substituted; candidate generation, tickets, ownership,
formal project materialization, JS preview validation, hashes and filesystem
publication all execute their production implementations against isolated data.
"""
import asyncio
from datetime import datetime, timedelta
import hashlib
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select, func

from app.core.config import settings
from app.db.database import async_session
from app.models.learning import AgentSession, LearningTask
from app.models.project import Project
from app.services.cloud_conversion_import import import_handoff
from app.services.cloud_device import device_request
from learnflow_core.work_task_conversion_models import WorkTaskConversionTicket as Ticket
from test_work_task_conversions import client, create, brief, generate, handoff, key
from test_user_isolation import registration


def validate_desktop_preview(url, preview, learner_id):
    source = Path(__file__).resolve().parents[2] / 'frontend/src/desktop-conversion.ts'
    script = "import fs from 'node:fs';import { conversionTicketFromUrl,validateConversionPreview } from " + json.dumps(source.as_uri()) + ";const data=JSON.parse(fs.readFileSync(0,'utf8'));if(!conversionTicketFromUrl(data.url))throw Error('native-compatible ticket required');const value=await validateConversionPreview(data.preview,data.learner);process.stdout.write(JSON.stringify({mode:value.candidate.project_mode,root_hash:value.root_hash}));"
    result = subprocess.run(['node', '--experimental-strip-types', '--input-type=module', '-e', script],
        input=json.dumps({'url': url, 'preview': preview, 'learner': learner_id}), text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


async def import_through_actual_cloud(cloud, token, owner, parent, root_hash, calls, *, expected_status=200):
    async def transport(request):
        calls.append((request.method, request.url.path, request.content))
        # The TestClient keeps the real cloud auth cookie and talks to the actual
        # API. The sidecar still has to validate account, CSRF, ticket and project.
        response = await asyncio.to_thread(cloud.request, request.method, request.url.path,
            content=request.content, headers={k: v for k, v in request.headers.items()
                if k.lower() in {'content-type', 'x-csrf-token'}})
        return httpx.Response(response.status_code, content=response.content,
                              headers={'content-type': 'application/json'})
    async with httpx.AsyncClient(base_url='https://learn.example', transport=httpx.MockTransport(transport)) as connection:
        session = SimpleNamespace(client=connection, learner_id=owner, csrf='')
        request = {'client_action_id': 'desktop-' + hashlib.sha256(token.encode()).hexdigest(),
                   'expected_root_hash': root_hash, 'confirmed': True, 'parent_path': str(parent)}
        result = await import_handoff(session, 'https://learn.example', token, json.dumps(request).encode())
        assert result.status_code == expected_status, result.body
        if result.status_code == 200:
            content = json.loads(result.body)
            tree = await device_request(session, 'https://learn.example', content['project_id'],
                                        'workspace', 'tree', 'GET', b'')
            assert tree.status_code == 200, tree.body
            return content
        return json.loads(result.body)


@pytest.mark.parametrize('mode', ['experiment', 'practice'])
def test_real_handoff_materializes_navigation_sources_and_preserves_local_edits(client, monkeypatch, tmp_path, mode):
    monkeypatch.setattr(settings, 'role_package_launch_secret', 'integration-handoff-secret-' * 3)
    monkeypatch.setattr(settings, 'runtime_dir', str(tmp_path / 'runtime'))
    parent = tmp_path / 'projects'; parent.mkdir()
    note = {'type': 'user_note', 'id': 'intake-note', 'label': '用户确认的客户工单要求'}
    draft, _ = create(client, source_refs=[note]); draft = brief(client, draft)
    generated, _ = generate(client, draft, mode=mode)
    assert generated['state'] == 'generated', generated
    launch, _ = handoff(client, generated)
    token = launch['desktop_url'].split('ticket=')[1]
    preview = client.get('/api/work-task-conversions/handoff/' + token).json()
    owner = preview['learner_id']
    verified_note = next(ref for ref in preview['source_refs'] if ref['id'] == note['id'])
    assert all(verified_note[k] == v for k, v in note.items())
    assert token.startswith('wt_') and len(token) == 46
    assert preview['root_hash'] == generated['root_hash'] == launch['root_hash']
    assert preview['candidate']['design']['readiness'] == 'ready'
    assert preview['root_hash'] != preview['candidate']['root_hash'] != preview['candidate']['design']['root_hash']
    assert validate_desktop_preview(launch['desktop_url'], preview, owner)['mode'] == mode
    assert preview['project_id'] is None and not preview['consumed']
    assert 'assessment' not in json.dumps(preview['candidate']['design']['stages'])
    calls = []
    result = asyncio.run(import_through_actual_cloud(client, token, owner, parent, preview['root_hash'], calls))
    project_id = result['project_id']
    assert result['navigation'] == {'kind': 'project', 'path': f'/projects/{project_id}'}
    assert result['project_tutor']['session_id'] > 0
    folder = Path(result['root_path'])
    for file in preview['starter_files']:
        assert (folder / file['path']).read_text() == file['content']
    workspace = client.get(f'/api/vnext-projects/{project_id}').json()
    assert workspace['project']['project_mode'] == mode
    assert workspace['project_tutor']['session_id'] == result['project_tutor']['session_id']
    workflow = client.get(f'/api/vnext-projects/{project_id}/workflow').json()
    assert len(workflow['milestones']) == len(preview['candidate']['design']['stages'])
    assert workflow['case_ref']['root_hash'] == preview['candidate']['design']['root_hash']
    assert 'compiled_design' not in workflow['case_ref']
    async def inspect():
        async with async_session() as db:
            session = await db.get(AgentSession, result['project_tutor']['session_id'])
            context = session.context_summary['work_task_conversion']
            assert context['root_hash'] == preview['root_hash'] and verified_note in context['source_refs']
            tasks = list(await db.scalars(select(LearningTask).where(LearningTask.project_id == project_id)))
            assert tasks and all(verified_note in task.source_refs for task in tasks)
            return await db.scalar(select(func.count(Project.id)))
    count = asyncio.run(inspect())
    editable = folder / 'observations.md'; editable.write_text('用户已经写下的观察')
    replay = asyncio.run(import_through_actual_cloud(client, token, owner, parent, preview['root_hash'], calls))
    assert replay['project_id'] == project_id and editable.read_text() == '用户已经写下的观察'
    assert asyncio.run(inspect()) == count
    assert not any(str(parent).encode() in body for _, _, body in calls)
    assert not any(token in path.read_text() for path in (tmp_path / 'runtime').rglob('*.json'))


def test_expired_ticket_reissue_resumes_same_project_after_failed_local_publish(client, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, 'role_package_launch_secret', 'integration-handoff-secret-' * 3)
    monkeypatch.setattr(settings, 'runtime_dir', str(tmp_path / 'runtime'))
    parent = tmp_path / 'projects'; parent.mkdir()
    draft, _ = create(client); draft = brief(client, draft); draft, _ = generate(client, draft)
    first, _ = handoff(client, draft); token = first['desktop_url'].split('ticket=')[1]
    preview = client.get('/api/work-task-conversions/handoff/' + token).json()
    owner = preview['learner_id']
    # Cloud consume succeeds but local files have not yet been created (crash/network recovery).
    created = client.post('/api/work-task-conversions/handoff/' + token, json={
        'client_action_id': key(), 'expected_root_hash': preview['root_hash'], 'confirmed': True}).json()
    async def expire():
        async with async_session() as db:
            ticket = await db.scalar(select(Ticket).where(Ticket.token_hash == hashlib.sha256(token.encode()).hexdigest()))
            ticket.expires_at = datetime.utcnow() - timedelta(seconds=1)
            await db.commit()
    asyncio.run(expire())
    asyncio.run(import_through_actual_cloud(client, token, owner, parent, preview['root_hash'], [], expected_status=410))
    reissued, _ = handoff(client, draft); replacement = reissued['desktop_url'].split('ticket=')[1]
    recovered = asyncio.run(import_through_actual_cloud(client, replacement, owner, parent, preview['root_hash'], []))
    assert recovered['project_id'] == created['project_id']
    assert recovered['project_tutor']['session_id'] == created['project_tutor']['session_id']


def test_wrong_account_is_denied_before_consume_and_account_restore_keeps_ticket(client, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, 'role_package_launch_secret', 'integration-handoff-secret-' * 3)
    monkeypatch.setattr(settings, 'runtime_dir', str(tmp_path / 'runtime'))
    parent = tmp_path / 'projects'; parent.mkdir()
    accounts = client.get('/api/dev/accounts').json()
    owner_account = next(account for account in accounts if account['username'] == 'legacy-demo')
    draft, _ = create(client); draft = brief(client, draft); draft, _ = generate(client, draft)
    launch, _ = handoff(client, draft); token = launch['desktop_url'].split('ticket=')[1]
    owner = client.get('/api/auth/me').json()['learner_id']
    foreign = client.post('/api/auth/register', json=registration('handoff_' + key()[:12], 'Other learner', '独立测试账号'))
    assert foreign.status_code == 200, foreign.text
    foreign_owner = client.get('/api/auth/me').json()['learner_id']
    try:
        calls = []
        asyncio.run(import_through_actual_cloud(client, token, foreign_owner, parent, draft['root_hash'], calls, expected_status=404))
        assert not any(method == 'POST' for method, _, _ in calls)
        assert not list(parent.iterdir())
    finally:
        assert client.post(f"/api/dev/accounts/{owner_account['id']}/login").status_code == 200
    assert client.get('/api/work-task-conversions/handoff/' + token).json()['consumed'] is False
    result = asyncio.run(import_through_actual_cloud(client, token, owner, parent, draft['root_hash'], []))
    assert result['status'] == 'imported'
