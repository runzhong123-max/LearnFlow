"""Behavioral checks for the same persistent handoff projection in both hosts."""
import asyncio
import json
import uuid
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app.db.database import async_session
from app.main import app
from app.models.learning import AgentMessage, AgentSession
from app.models.project import Project
from app.services.tutor_service import _generate_tutor_reply
from learnflow_core.work_task_conversion_context import MAX_CONTEXT_CHARS, conversion_context_projection


def handoff(scope):
    return {"schema_version": "learnflow.work-task-conversion.v1", "conversion_id": "wc_contexttest",
        "root_hash": "a" * 64, "scope": scope,
        "brief": {"task_title": "库存数据导入", "task_description": "解析SKU与数量并生成导入报告",
            "acceptance_criteria": ["重复记录保留首条", "负数不得入库"], "constraints": ["只使用授权数据"],
            "work_context": "同一固定客户数据版本", "deliverable": "导入验收报告"},
        "candidate": {"candidate_id": "wcc_contexttest", "root_hash": "b" * 64, "project_mode": "learning",
            "learning_candidate": {"task": {"steps": [
                {"id": "s1", "title": "校验数据", "action": "检查输入"},
                {"id": "s2", "title": "UNSELECTED_STEP", "action": "不应进入范围"},
                {"id": "s3", "title": "生成报告", "action": "记录验收结果"}]},
                "private_tests": "PRIVATE_TESTS_DO_NOT_SEND", "starter_files": "FULL_FILES_DO_NOT_SEND"}},
        "selected_step_ids": ["s1", "s3"], "unresolved_questions": ["尚未选择资料"],
        "source_refs": [{"type": "role_task", "role_title": "数据实施",
            "package_ref": {"packageId": "role-pack", "packageVersion": "1.3.0", "snapshotId": "snapshot-fixed", "rootHash": "c" * 64},
            "task_ref": {"nodeId": "work-2", "kind": "task", "summary": "FULL_SOURCE_DO_NOT_SEND"},
            "secret": "SECRET_DO_NOT_SEND"}]}


@pytest.fixture
def setup():
    with TestClient(app) as client:
        response = client.post('/api/auth/register', json={
            'username': 'ctx' + uuid.uuid4().hex[:12], 'password': 'handoff-context-4826',
            'display_name': 'Context test', 'education_stage': 'undergraduate',
            'background': '初次学习', 'focus_areas': ['数据库'], 'weekly_hours': 6,
            'preferred_modes': ['practice'], 'career_goal': '', 'career_goal_status': 'exploring'})
        assert response.status_code == 200, response.text
        learner_id = response.json()['learner_id']
        async def seed():
            async with async_session() as db:
                project = Project(learner_id=learner_id, name='Context project')
                other = Project(learner_id=learner_id, name='Other project')
                session = AgentSession(learner_id=learner_id, session_type='global', status='active')
                unrelated = AgentSession(learner_id=learner_id, session_type='global', status='active')
                db.add_all([project, other, session, unrelated])
                await db.flush()
                scope = dict(learner_id=learner_id, session_id=session.id, project_id=None, checkpoint_id=None)
                session.context_summary = {'work_task_conversion': handoff(scope)}
                db.add(AgentMessage(session_id=session.id, role='user', content='OLD_CANDIDATE_MARKER', created_at=datetime(2020, 1, 1)))
                db.add_all([AgentMessage(session_id=session.id, role='assistant' if i % 2 else 'user',
                    content=f'历史消息 {i}', created_at=datetime(2021, 1, 1, 0, 0, i)) for i in range(25)])
                await db.commit()
                return session.id, unrelated.id, project.id, other.id, scope
        yield client, learner_id, *asyncio.run(seed())


def test_workspace_context_is_scoped_and_survives_old_history(setup):
    client, learner_id, session_id, unrelated_id, project_id, _, scope = setup
    endpoint = '/api/learner-state/agent-workspace-context'
    response = client.get(endpoint, params={'session_id': session_id})
    assert response.status_code == 200, response.text
    context = response.json()['work_task_conversion']
    assert context['scope'] == scope
    assert context['root_hash'] == 'a' * 64
    assert [item['id'] for item in context['selected_steps']] == ['s1', 's3']
    assert context['source_refs'][0]['package_ref']['rootHash'] == 'c' * 64
    assert context['unresolved_questions'] == ['尚未选择资料']
    assert context['mastery_inference'] is False and context['read_only'] is True
    serialized = json.dumps(context)
    for secret in ('PRIVATE_TESTS', 'FULL_FILES', 'FULL_SOURCE', 'SECRET_DO_NOT_SEND', 'UNSELECTED_STEP'):
        assert secret not in serialized
    assert client.get(endpoint, params={'session_id': unrelated_id}).json()['work_task_conversion'] is None
    assert client.get(endpoint).json()['work_task_conversion'] is None
    assert client.get(endpoint, params={'session_id': session_id, 'project_id': project_id}).status_code == 404
    assert client.get(endpoint, params={'session_id': session_id, 'checkpoint_id': 999999999}).status_code == 404
    client.post('/api/auth/logout')
    other = client.post('/api/auth/register', json={
        'username': 'other' + uuid.uuid4().hex[:12], 'password': 'handoff-context-4826', 'display_name': 'Other',
        'education_stage': 'undergraduate', 'background': '初次学习', 'focus_areas': ['数据库'],
        'weekly_hours': 6, 'preferred_modes': ['practice']})
    assert other.status_code == 200, other.text
    assert client.get(endpoint, params={'session_id': session_id}).status_code == 404


def test_moving_session_to_another_owned_project_does_not_reassign_handoff(setup):
    client, _, session_id, _, project_id, _, _ = setup
    async def move():
        async with async_session() as db:
            session = await db.get(AgentSession, session_id)
            session.project_id = project_id
            session.session_type = 'project'
            await db.commit()
    asyncio.run(move())
    response = client.get('/api/learner-state/agent-workspace-context', params={'session_id': session_id, 'project_id': project_id})
    assert response.status_code == 200, response.text
    assert response.json()['work_task_conversion'] is None


def test_projection_is_bounded_and_marks_omissions():
    scope = dict(learner_id=1, session_id=3, project_id=None, checkpoint_id=None)
    value = handoff(scope)
    value['brief']['task_title'] = '长' * 10000
    value['source_refs'] *= 20
    value['unresolved_questions'] *= 20
    projected = conversion_context_projection(value, scope)
    assert len(json.dumps(projected, ensure_ascii=False, separators=(',', ':'))) <= MAX_CONTEXT_CHARS
    assert projected['omitted']['sources'] >= 12
    assert projected['omitted']['text_characters'] > 0
    assert projected['omitted']['unresolved_questions'] == 8
    assert projected['detail_ref']['expected_root_hash'] == value['root_hash']
    assert conversion_context_projection({**value, 'schema_version': 'unsupported'}, scope) is None
    value['brief']['task_title'] = '\x00' * 10000
    value['candidate']['learning_candidate']['task']['steps'][0]['action'] = '\\' * 10000
    assert len(json.dumps(conversion_context_projection(value, scope), ensure_ascii=False, separators=(',', ':'))) <= MAX_CONTEXT_CHARS


def test_native_provider_receives_bounded_handoff_after_18_messages(setup, monkeypatch):
    _, _, session_id, _, _, _, _ = setup
    calls = []
    class Model:
        def __init__(self, **kwargs):
            pass
        async def ainvoke(self, messages):
            calls.append(messages)
            return type('Reply', (), {'content': '我们继续检查固定数据版本中的输入与报告。'})()
    monkeypatch.setattr('app.services.tutor_service.ChatOpenAI', Model)
    monkeypatch.setattr('app.services.tutor_service.settings.llm_api_key', 'isolated-test-placeholder')
    async def turn():
        async with async_session() as db:
            session = await db.get(AgentSession, session_id)
            return await _generate_tutor_reply(db, session, workflow_instruction='继续讨论来源')
    asyncio.run(turn())
    assert calls
    system = str(calls[0][0].content)
    all_content = '\n'.join(str(item.content) for item in calls[0])
    assert 'work_task_conversion' not in system
    assert 'OLD_CANDIDATE_MARKER' not in all_content
    assert 'UNSELECTED_STEP' not in all_content
    assert 'PRIVATE_TESTS_DO_NOT_SEND' not in all_content
    assert 'snapshot-fixed' in all_content and 'a' * 64 in all_content
    for requirement in ('解析SKU与数量并生成导入报告', '重复记录保留首条', '负数不得入库', '只使用授权数据'):
        assert requirement in all_content
    assert any(item.type == 'human' and '<work_task_conversion_context>' in str(item.content) for item in calls[0])


def test_legacy_handoff_requires_exact_authoritative_binding(setup):
    client, learner_id, session_id, _, _, _, scope = setup
    from learnflow_core.work_task_conversion_models import WorkTaskConversion
    async def legacy():
        async with async_session() as db:
            session = await db.get(AgentSession, session_id)
            value = handoff(scope)
            value.pop('scope')
            value['conversion_id'] = 'wc_' + uuid.uuid4().hex
            session.context_summary = {'work_task_conversion': value}
            row = WorkTaskConversion(id=value['conversion_id'], learner_id=learner_id,
                client_action_id=uuid.uuid4().hex, request_hash='d'*64, root_hash=value['root_hash'],
                original_input='旧转换', session_id=session_id, project_id=None, brief=value['brief'])
            db.add(row)
            await db.commit()
            return row.id
    conversion_id = asyncio.run(legacy())
    endpoint = '/api/learner-state/agent-workspace-context'
    assert client.get(endpoint, params={'session_id':session_id}).json()['work_task_conversion']['root_hash'] == 'a'*64
    async def alter():
        async with async_session() as db:
            row = await db.get(WorkTaskConversion, conversion_id)
            row.root_hash = 'e'*64
            await db.commit()
    asyncio.run(alter())
    assert client.get(endpoint, params={'session_id':session_id}).json()['work_task_conversion'] is None


def test_domain_draft_retains_its_unresolved_authoring_boundary():
    scope = dict(learner_id=1, session_id=3, project_id=None, checkpoint_id=None)
    value = handoff(scope)
    value['candidate'] = {'candidate_id':'wcc_draft', 'root_hash':'b'*64, 'project_mode':'practice',
        'design': {'readiness':'needs_domain_authoring', 'can_materialize':False,
            'proposed_phases':[{'title':'确认现场条件', 'target_deliverable':'环境清单'}],
            'missing_validation':['独立验收器'],
            'constraint_review':[{'requirement':'生产环境约束尚未核对','status':'needs_domain_review'}],
            'private_tests':'PRIVATE_DO_NOT_SEND'}}
    projected = conversion_context_projection(value, scope)
    assert projected['design_readiness'] == 'needs_domain_authoring'
    assert projected['selected_steps'][0]['title'] == '确认现场条件'
    assert '独立验收器' in projected['unresolved_questions']
    assert '生产环境约束尚未核对' in projected['unresolved_questions']
    assert 'PRIVATE_DO_NOT_SEND' not in json.dumps(projected)


def test_maintained_reviews_and_user_requirements_precede_generated_step_budget():
    scope = dict(learner_id=1, session_id=3, project_id=None, checkpoint_id=None)
    value = handoff(scope)
    # Shape produced by the maintained compiler's _parameters() review records.
    value['candidate'] = {'candidate_id':'wcc_maintained', 'root_hash':'b'*64, 'project_mode':'practice',
        'design': {'readiness':'ready', 'stages':[
            {'key':f's{i}', 'title':'阶段说明'*1000, 'objective':'生成说明'*1000} for i in range(12)],
            'acceptance_review':[
                {'input_field':'acceptance_criteria','input_index':0,'input_text':'重复记录保留首条','status':'applied'},
                {'input_field':'acceptance_criteria','input_index':1,'input_text':'验收报告必须由业务人员复核',
                 'status':'requires_domain_review','clauses':[{'text':'不应重复完整审核对象','status':'requires_domain_review'}]}],
            'constraint_review':[
                {'input_field':'constraints','input_index':0,'input_text':'生产环境需要变更窗口','status':'requires_domain_review'},
                {'requirement':'旧草案还需补充领域素材','status':'needs_domain_review'}]}}
    projected = conversion_context_projection(value, scope)
    assert projected['task_description'] == value['brief']['task_description']
    assert projected['acceptance_criteria'] == value['brief']['acceptance_criteria']
    assert projected['constraints'] == value['brief']['constraints']
    assert '验收报告必须由业务人员复核' in projected['unresolved_questions']
    assert '生产环境需要变更窗口' in projected['unresolved_questions']
    assert '旧草案还需补充领域素材' in projected['unresolved_questions']
    assert '重复记录保留首条' not in projected['unresolved_questions']
    assert [step['id'] for step in projected['selected_steps']] == [f's{i}' for i in range(12)]
    assert projected['omitted']['text_characters'] > 0
    assert len(json.dumps(projected, ensure_ascii=False, separators=(',', ':'))) <= MAX_CONTEXT_CHARS
    assert '不应重复完整审核对象' not in json.dumps(projected, ensure_ascii=False)


def test_escaped_requirements_cannot_spend_the_reserved_overview_budget():
    scope = dict(learner_id=1, session_id=3, project_id=None, checkpoint_id=None)
    value = handoff(scope)
    value['brief']['acceptance_criteria'] = ['<'*1000]*12
    value['brief']['constraints'] = [chr(92)*1000]*12
    projected = conversion_context_projection(value, scope)
    assert projected['task_description'] == value['brief']['task_description']
    assert projected['work_context'] == value['brief']['work_context']
    assert projected['deliverable'] == value['brief']['deliverable']
    assert projected['omitted']['text_characters'] > 0
    assert len(json.dumps(projected, ensure_ascii=False, separators=(',', ':'))) <= MAX_CONTEXT_CHARS
