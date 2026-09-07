"""Stage support remains scoped, replayable and separate from learner mastery."""
import asyncio
import uuid
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from app.main import app
from app.db.database import async_session
from app.models.project import Project, ProjectWorkflowSubmission
from app.models.learning import EvidenceEvent, KernelMutation, Learner
from app.services.project_workflows import get_stage_assistance, request_stage_assistance


def key():
    return uuid.uuid4().hex


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as client:
        account = next(item for item in client.get('/api/dev/accounts').json() if item['username'] == 'legacy-demo')
        assert client.post(f"/api/dev/accounts/{account['id']}/login").status_code == 200
        yield client


def project(client, mode='experiment'):
    response = client.post('/api/vnext-projects', json={'name': '分工与帮助 ' + key(), 'objective': '学生练习核心逻辑，导师提供工程支撑', 'project_mode': mode})
    assert response.status_code == 200, response.text
    pid = response.json()['project']['id']
    args = {'client_action_id': key()}
    if mode == 'practice':
        case = client.get('/api/practice-cases').json()['cases'][0]
        args.update(case_id=case['id'], case_version=case['version'], case_root_hash=case['root_hash'])
    workflow = client.post(f'/api/vnext-projects/{pid}/workflow/initialize', json=args)
    assert workflow.status_code == 200, workflow.text
    return pid, workflow.json()


def path(pid, cp):
    return f'/api/vnext-projects/{pid}/checkpoints/{cp}/assistance'


def choose(client, pid, cp, mode, revision=0, action=None):
    return client.post(path(pid, cp), json={'client_action_id': action or key(), 'expected_revision': revision, 'mode': mode})


def deliver(client, pid, cp):
    return client.post(f'/api/vnext-projects/{pid}/checkpoints/{cp}/deliver', json={
        'client_action_id': key(), 'answers': {'deliverable': '程序与复现记录', 'prediction': '固定输入输出'},
        'artifact_refs': [], 'assistance_level': 'independent'})


def test_case_hash_and_current_stage_responsibilities_are_compatible(client):
    case = client.get('/api/practice-cases').json()['cases'][0]
    assert case['version'] == '1.0.0'
    assert case['root_hash'] == '2637d7127db08ce2849a9246fa777da9a27bb963d928bd17c75e94490367d185'
    pid, workflow = project(client, 'practice')
    first, second, last = workflow['milestones']
    assert first['support_version'] == 'learnflow.stage-support.v1'
    assert first['student_tasks'] and first['mentor_support'] and first['shared_tasks']
    assert first['assistance_guidance'] is None
    assert {item['path'] for item in first['related_files']} == {'README.md', 'input.csv'}
    for later in (second, last):
        assert later['related_files'] == later['student_tasks'] == later['mentor_support'] == later['shared_tasks'] == []
        assert later['assistance'] is None
        assert later['assistance_guidance'] is None
    context = client.get(f'/api/vnext-projects/{pid}/agent-context').json()
    assert context['project_workflow']['milestones'][0]['student_tasks'] == first['student_tasks']
    assert context['project_workflow']['milestones'][1]['related_files'] == []
    assert 'workbench' not in context['project_workflow']


def test_help_modes_persist_with_separate_revision_and_replay(client):
    pid, workflow = project(client)
    cp = workflow['milestones'][0]['checkpoint_id']
    assert client.get(path(pid, cp)).json() == {'mode': 'direction', 'revision': 0, 'execution_mode': 'read_only'}
    revision = 0
    for mode in ('direction', 'steps', 'pseudocode', 'implementation', 'direction'):
        action = key()
        result = choose(client, pid, cp, mode, revision, action)
        assert result.status_code == 200, result.text
        value = result.json()
        assert value['assistance']['execution_mode'] == ('workspace_write' if mode == 'implementation' else 'read_only')
        assert value['assistance']['revision'] > revision
        assert value['workflow']['revision'] == workflow['revision']
        assert value['guidance']['body']
        restored = client.get(f'/api/vnext-projects/{pid}/workflow').json()['milestones']
        assert restored[0]['assistance_guidance'] == {
            'mode': mode, 'body': value['guidance']['body'], 'revision': value['assistance']['revision']}
        assert all(stage['assistance_guidance'] is None for stage in restored[1:])
        context = client.get(f'/api/vnext-projects/{pid}/agent-context').json()['project_workflow']
        assert context['milestones'][0]['assistance_guidance'] == restored[0]['assistance_guidance']
        assert choose(client, pid, cp, mode, revision, action).json()['assistance'] == value['assistance']
        assert choose(client, pid, cp, 'steps' if mode != 'steps' else 'direction', revision, action).status_code == 409
        assert choose(client, pid, cp, mode, revision).status_code == 409
        revision = value['assistance']['revision']
    assert client.get(path(pid, cp)).json()['revision'] == revision
    accepted = deliver(client, pid, cp)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()['milestones'][0]['submission']['assistance_level'] == 'hint'
    finished = client.get(f'/api/vnext-projects/{pid}/workflow').json()['milestones'][0]
    assert finished['assistance'] is None
    assert finished['student_tasks'] == workflow['milestones'][0]['student_tasks']
    assert finished['assistance_guidance'] == restored[0]['assistance_guidance']
    assert client.get(path(pid, cp)).status_code == 409
    async def inspect():
        async with async_session() as db:
            events = list(await db.scalars(select(EvidenceEvent).where(EvidenceEvent.project_id == pid, EvidenceEvent.event_type == 'project_assistance_requested')))
            assert len(events) == 5
            assert {event.payload['mode'] for event in events} == {'direction', 'steps', 'pseudocode', 'implementation'}
            assert all(event.payload['implementation_performed'] is False for event in events)
            assert await db.scalar(select(func.count(KernelMutation.id)).where(KernelMutation.event_id.in_([event.id for event in events]))) == 0
    asyncio.run(inspect())


def test_implementation_selection_does_not_claim_implementation_occurred(client):
    pid, workflow = project(client)
    cp = workflow['milestones'][0]['checkpoint_id']
    result = choose(client, pid, cp, 'implementation')
    assert result.status_code == 200, result.text
    async def inspect():
        async with async_session() as db:
            row = await db.scalar(select(ProjectWorkflowSubmission).where(ProjectWorkflowSubmission.project_id == pid, ProjectWorkflowSubmission.kind == 'assistance'))
            assert row.feedback['guidance_delivered'] is False
            assert row.feedback['implementation_performed'] is False
    asyncio.run(inspect())
    accepted = deliver(client, pid, cp).json()['milestones'][0]['submission']
    assert accepted['assistance_level'] == 'independent'
    assert accepted['feedback']['mastery_inference'] is False


def test_legacy_hint_preserves_contract_and_is_part_of_live_policy(client):
    pid, workflow = project(client)
    cp = workflow['milestones'][0]['checkpoint_id']
    url = f'/api/vnext-projects/{pid}/checkpoints/{cp}/hint'
    body = {'client_action_id': key(), 'level': 2}
    first = client.post(url, json=body)
    assert first.status_code == 200, first.text
    result = first.json()
    assert result['hint']['level'] == 2 and result['hint']['body']
    assert result['assistance']['mode'] == 'steps'
    assert client.get(path(pid, cp)).json() == result['assistance']
    assert client.post(url, json=body).json()['hint'] == result['hint']
    assert len(result['workflow']['milestones'][0]['hints_used']) == 1
    assert result['workflow']['milestones'][0]['assistance_guidance'] == {
        'mode': 'steps', 'revision': result['assistance']['revision'], 'body': result['hint']['body']}
    implementation = choose(client, pid, cp, 'implementation', result['assistance']['revision'])
    assert implementation.status_code == 200
    restored = client.get(f'/api/vnext-projects/{pid}/workflow').json()['milestones'][0]
    assert restored['assistance_guidance'] == {
        'mode': 'implementation', 'revision': implementation.json()['assistance']['revision'],
        'body': implementation.json()['guidance']['body']}
    assert restored['hints_used'] == result['workflow']['milestones'][0]['hints_used']
    assert deliver(client, pid, cp).json()['milestones'][0]['submission']['assistance_level'] == 'hint'


def test_scope_locked_stage_and_closed_payload_are_rejected(client):
    pid, workflow = project(client)
    other, second_workflow = project(client)
    cp, locked, _ = [stage['checkpoint_id'] for stage in workflow['milestones']]
    foreign = second_workflow['milestones'][0]['checkpoint_id']
    assert client.get(path(pid, locked)).status_code == 409
    assert choose(client, pid, locked, 'implementation').status_code == 409
    assert client.get(path(pid, foreign)).status_code == 404
    assert choose(client, pid, foreign, 'implementation').status_code == 404
    assert client.post(path(pid, cp), json={'mode': 'implementation', 'client_action_id': key(), 'expected_revision': 0, 'execution_mode': 'workspace_write'}).status_code == 422
    assert choose(client, pid, cp, 'unknown').status_code == 422
    async def foreign_project():
        async with async_session() as db:
            learner = Learner(key=key(), display_name='Another learner')
            db.add(learner)
            await db.flush()
            row = Project(learner_id=learner.id, name='private')
            db.add(row)
            await db.commit()
            return row.id
    private = asyncio.run(foreign_project())
    assert client.get(path(private, cp)).status_code == 404
    assert choose(client, private, cp, 'implementation').status_code == 404


def test_concurrent_help_change_rejects_stale_writer_without_duplicate_events(client):
    pid, workflow = project(client)
    cp = workflow['milestones'][0]['checkpoint_id']
    async def concurrent():
        async def update(mode):
            async with async_session() as db:
                row = await db.get(Project, pid)
                try:
                    result = await request_stage_assistance(db, row, cp, {'client_action_id': key(), 'expected_revision': 0, 'mode': mode})
                    await db.commit()
                    return result['assistance']
                except HTTPException as error:
                    await db.rollback()
                    return error.status_code
        results = await asyncio.gather(update('steps'), update('implementation'))
        assert results.count(409) == 1
        async with async_session() as db:
            row = await db.get(Project, pid)
            live = await get_stage_assistance(db, row, cp)
            assert live in results
            assert await db.scalar(select(func.count(ProjectWorkflowSubmission.id)).where(ProjectWorkflowSubmission.project_id == pid, ProjectWorkflowSubmission.kind == 'assistance')) == 1
    asyncio.run(concurrent())


def test_prior_assisted_delivery_does_not_become_independent_on_retry(client):
    pid, workflow = project(client)
    cp = workflow['milestones'][0]['checkpoint_id']
    first = client.post(f'/api/vnext-projects/{pid}/checkpoints/{cp}/deliver', json={
        'client_action_id': key(), 'answers': {}, 'artifact_refs': [], 'assistance_level': 'together'})
    assert first.status_code == 200
    assert first.json()['milestones'][0]['submission']['feedback']['accepted'] is False
    repeated = deliver(client, pid, cp)
    assert repeated.status_code == 200, repeated.text
    stage = repeated.json()['milestones'][0]
    assert stage['submission']['assistance_level'] == 'together'
    assert stage['assistance'] is None
