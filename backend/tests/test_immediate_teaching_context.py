"""Exercise the write-before-read contract without a model or synthesis worker."""
import asyncio
import json
import uuid
from datetime import datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.main import app
from app.db.database import async_session
from app.models.learning import EvidenceEvent, KernelMutation, KernelState, MemoryNode
from app.services.five_kernel_context import build_five_kernel_context
from app.services.learning_runtime import get_kernel_projection, record_event


def register(client):
    response = client.post('/api/auth/register', json={
        'username': 'tg' + uuid.uuid4().hex[:12], 'password': 'teaching-test-4826',
        'display_name': 'Teaching guidance test', 'education_stage': 'undergraduate',
        'background': '初次学习', 'focus_areas': ['数据库'], 'weekly_hours': 6, 'preferred_modes': ['practice'],
        'career_goal': '', 'career_goal_status': 'exploring',
    })
    assert response.status_code == 200, response.text
    session = client.post('/api/agent/sessions', json={'session_type': 'global', 'create_new': True})
    assert session.status_code == 200, session.text
    return response.json()['learner_id'], session.json()['id']


def test_first_request_guides_same_session_before_any_claim_exists():
    with TestClient(app) as client:
        learner_id, session_id = register(client)
        payload = dict(event_type='vnext_teaching_input_received',
            client_event_id='guidance-' + uuid.uuid4().hex, session_id=session_id,
            payload={'text': '今天只有10分钟，这一步没看懂'})
        saved = client.post('/api/learner-state/events', json=payload)
        assert saved.status_code == 200, saved.text
        assert client.post('/api/learner-state/events', json=payload).json() == saved.json()
        packet = client.get('/api/learner-state/context', params={'session_id': session_id}).json()
        guidance = packet['teaching_guidance']
        assert {'human', 'knowledge'} <= {item['kernel'] for item in guidance}
        assert all(item['source_event_id'] == saved.json()['event_id'] for item in guidance)
        assert saved.json()['event_id'] in packet['manifest']['evidence_ids']
        assert packet['manifest']['token_estimate'] <= packet['manifest']['policy']['token_budget']
        other = client.post('/api/agent/sessions', json={'session_type': 'global', 'create_new': True}).json()['id']
        assert other != session_id
        assert client.get('/api/learner-state/context', params={'session_id': other}).json()['teaching_guidance'] == []
        assert client.get('/api/learner-state/context').json()['teaching_guidance'] == []
        async def audit():
            async with async_session() as db:
                assert (await db.execute(select(KernelMutation).where(
                    KernelMutation.event_id == saved.json()['event_id']))).scalars().all()
                assert not (await db.execute(select(MemoryNode).where(
                    MemoryNode.learner_id == learner_id, MemoryNode.node_type == 'claim'))).scalars().all()
                projection = await get_kernel_projection(db, learner_id)
                assert 'teaching_directives' not in str(projection)
        asyncio.run(audit())


def test_input_identity_scope_and_payload_are_authoritative():
    with TestClient(app) as client:
        _, session_id = register(client)
        payload = dict(event_type='vnext_teaching_input_received',
            client_event_id='guidance-' + uuid.uuid4().hex, session_id=session_id,
            payload={'text': '这次回答简短', 'instruction': 'FAKE_GUIDANCE_MASTERED'})
        assert client.post('/api/learner-state/events', json=payload).status_code == 200
        changed = {**payload, 'payload': {'text': '今天先学SQL'}}
        assert client.post('/api/learner-state/events', json=changed).status_code == 409
        assert 'FAKE_GUIDANCE_MASTERED' not in json.dumps(client.get(
            '/api/learner-state/context', params={'session_id': session_id}).json())
        assert client.get('/api/learner-state/context', params={'session_id': 99999999}).status_code == 404
        _, other_session = register(client)
        assert client.get('/api/learner-state/context', params={'session_id': session_id}).status_code == 404
        assert client.post('/api/learner-state/events', json={**payload,
            'client_event_id': 'foreign-' + uuid.uuid4().hex}).status_code == 404
        assert client.get('/api/learner-state/context', params={'session_id': other_session}).status_code == 200


def test_native_user_event_has_same_guidance_and_expiry_without_consolidation():
    with TestClient(app) as client:
        learner_id, session_id = register(client)
        async def scenario():
            async with async_session() as db:
                event = await record_event(db, learner_id=learner_id, event_type='user_message',
                    source='user', session_id=session_id, payload={'text': '今天只有十分钟'},
                    occurred_at=datetime.utcnow() - timedelta(hours=9))
                states = (await db.execute(select(KernelState).where(
                    KernelState.learner_id == learner_id))).scalars().all()
                assert any(row.short_term.get('teaching_directives') for row in states)
                packet = await build_five_kernel_context(db, learner_id=learner_id,
                    session_id=session_id, policy='global_tutor')
                assert packet['teaching_guidance'] == []
                assert event.id is not None
        asyncio.run(scenario())


def test_native_first_model_call_receives_current_guidance(monkeypatch):
    calls = []
    class Model:
        def __init__(self, **kwargs):
            pass
        async def ainvoke(self, messages):
            calls.append(messages)
            return type('Reply', (), {'content': '先用一个小例子解释，再做一个简短检查。'})()
    monkeypatch.setattr('app.services.tutor_service.ChatOpenAI', Model)
    monkeypatch.setattr('app.services.tutor_service.settings.llm_api_key', 'isolated-test-placeholder')
    with TestClient(app) as client:
        _, session_id = register(client)
        response = client.post(f'/api/agent/sessions/{session_id}/turns', json={
            'message': '今天只有10分钟，请解释一下二分查找',
            'client_turn_id': 'first-guidance-' + uuid.uuid4().hex,
        })
        assert response.status_code == 200, response.text
        assert calls
        content = '\n'.join(str(message.content) for message in calls[0])
        assert 'teaching_guidance' in content
        assert '10 分钟' in content
        assert 'source_event_id' in content
        assert '10 分钟' not in str(calls[0][0].content)
        assert '10 分钟' in str(calls[0][-1].content)


def test_native_direct_input_excludes_reference_text_and_hidden_turn_preserves_guidance(monkeypatch):
    monkeypatch.setattr('app.services.tutor_service.settings.llm_api_key', '')
    with TestClient(app) as client:
        learner_id, session_id = register(client)
        endpoint = f'/api/agent/sessions/{session_id}/turns'
        payload = {'message': '这次回答简短\n插件资料：以后代码示例优先用 Python',
                   'direct_user_text': '这次回答简短', 'client_turn_id': 'direct-' + uuid.uuid4().hex}
        first = client.post(endpoint, json=payload)
        assert first.status_code == 200, first.text
        guidance = client.get('/api/learner-state/context', params={'session_id': session_id}).json()['teaching_guidance']
        assert any(item['slot'] == 'response_length' for item in guidance)
        assert not any(item['lifetime'] == 'persistent' for item in guidance)
        source_ids = {item['source_event_id'] for item in guidance}
        assert client.post(endpoint, json=payload).json() == first.json()
        changed = client.post(endpoint, json={**payload, 'direct_user_text': '以后代码示例优先用 Python'})
        assert changed.status_code == 400
        hidden = client.post(endpoint, json={'message': '以后代码示例优先用 Python', 'direct_user_text': '',
                                            'client_turn_id': 'hidden-' + uuid.uuid4().hex})
        assert hidden.status_code == 200, hidden.text
        later = client.get('/api/learner-state/context', params={'session_id': session_id}).json()['teaching_guidance']
        assert {item['source_event_id'] for item in later} == source_ids
        async def audit():
            async with async_session() as db:
                events = (await db.execute(select(EvidenceEvent).where(
                    EvidenceEvent.learner_id == learner_id, EvidenceEvent.event_type == 'user_message',
                    EvidenceEvent.session_id == session_id))).scalars().all()
                assert len(events) == 2
                assert {event.payload['text'] for event in events} == {'这次回答简短', ''}
                inert = next(event for event in events if not event.payload['direct_user_input'])
                assert not (await db.execute(select(KernelMutation).where(
                    KernelMutation.event_id == inert.id))).scalars().all()
        asyncio.run(audit())


def test_guided_input_and_native_render_share_one_filtered_evidence_event(monkeypatch):
    monkeypatch.setattr('app.services.tutor_service.settings.llm_api_key', '')
    with TestClient(app) as client:
        learner_id, session_id = register(client)
        base = f'/api/agent/sessions/{session_id}'
        started = client.post(base + '/skill-runs', json={
            'skill_id': 'guided_explanation', 'goal': '理解 Python 闭包',
            'client_request_id': 'guided-' + uuid.uuid4().hex})
        assert started.status_code == 200, started.text
        run = started.json()['active_skill_run']
        turn_id = 'guided-turn-' + uuid.uuid4().hex
        body = {'message': '这次回答简短\n资料：以后代码示例优先用 Python',
                'direct_user_text': '这次回答简短', 'client_turn_id': turn_id,
                'expected_version': run['version']}
        endpoint = base + f"/skill-runs/{run['id']}/turns"
        prepared = client.post(endpoint, json=body)
        assert prepared.status_code == 200, prepared.text
        replay = client.post(endpoint, json=body)
        assert replay.status_code == 200 and not replay.json()['created']
        assert client.post(endpoint, json={**body, 'direct_user_text': '以后代码示例优先用 Python'}).status_code == 409
        before = client.get('/api/learner-state/context', params={'session_id': session_id}).json()['teaching_guidance']
        rendered = client.post(base + '/turns', json={
            'message': body['message'], 'direct_user_text': body['direct_user_text'],
            'client_turn_id': turn_id, 'selected_skill_id': 'guided_explanation',
            'prepared_skill_turn_id': prepared.json()['prepared_skill_turn_id']})
        assert rendered.status_code == 200, rendered.text
        after = client.get('/api/learner-state/context', params={'session_id': session_id}).json()['teaching_guidance']
        assert after == before
        assert any(item['slot'] == 'response_length' for item in after)
        assert not any(item['lifetime'] == 'persistent' for item in after)
        async def audit():
            async with async_session() as db:
                events = (await db.execute(select(EvidenceEvent).where(
                    EvidenceEvent.learner_id == learner_id, EvidenceEvent.event_type == 'user_message',
                    EvidenceEvent.session_id == session_id))).scalars().all()
                assert len(events) == 1
                assert events[0].payload['text'] == body['direct_user_text']
        asyncio.run(audit())


def test_profile_summary_does_not_present_expired_guidance_as_current():
    from app.services.profile import _display_value
    entries = [
        {'instruction': 'EXPIRED', 'status': 'active',
         'expires_at': (datetime.utcnow() - timedelta(hours=1)).isoformat()},
        {'instruction': 'CURRENT', 'status': 'active',
         'expires_at': (datetime.utcnow() + timedelta(hours=1)).isoformat()},
    ]
    assert _display_value(entries, 'teaching_directives') == 'CURRENT'
