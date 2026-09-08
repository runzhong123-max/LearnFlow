"""Educational evidence boundaries and deterministic consumption of real guidance.

Assessment tests use the public submission API or record_event gateway. Planner
contexts come from the production event reducer, selector and scoped reader;
no perfect Module/Claim summaries are manufactured for these tests.
"""
import asyncio
from datetime import datetime, timedelta
import json
import re
import uuid
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.database import async_session
from app.main import app
from app.models.learning import AgentSession, EvidenceEvent, KernelMutation, KernelState, Learner, LearningAttempt
from app.models.project import Checkpoint, ConceptQuestion, Project, Roadmap
from app.services.learning_runtime import record_event
from app.services.learning_tasks import _fallback_plan, _scoped_planner_context, generate_learning_task_plan
from app.services.teaching_guidance import select_teaching_guidance


@pytest.fixture(scope='module')
def client():
    with TestClient(app) as api:
        accounts = api.get('/api/dev/accounts')
        assert accounts.status_code == 200
        legacy = next(account for account in accounts.json() if account['username'] == 'legacy-demo')
        assert api.post(f"/api/dev/accounts/{legacy['id']}/login").status_code == 200
        yield api


async def seed_scope(*, learner_id=None, duplicate_questions=False):
    async with async_session() as db:
        if learner_id is None:
            learner = Learner(key='education-policy-' + uuid.uuid4().hex, display_name='Education policy fixture')
            db.add(learner)
            await db.flush()
            learner_id = learner.id
        project = Project(learner_id=learner_id, name='教育约束隔离项目')
        db.add(project)
        await db.flush()
        roadmap = Roadmap(project_id=project.id, raw_json={})
        db.add(roadmap)
        await db.flush()
        checkpoint = Checkpoint(roadmap_id=roadmap.id, title='heliostat 递归终止条件', order=1,
                                prerequisites=[], learning_status='in_progress')
        db.add(checkpoint)
        await db.flush()
        questions = [ConceptQuestion(checkpoint_id=checkpoint.id,
            question='递归调用必须在何处终止？' if duplicate_questions or i == 0 else '处理空输入前首先检查哪一项？',
            options=['终止条件', '界面颜色'], answer_indexes=[0], q_type='single', difficulty='easy',
            explanation='先检查输入与终止条件。', order=i + 1) for i in range(2)]
        db.add_all(questions)
        session = AgentSession(learner_id=learner_id, session_type='checkpoint', project_id=project.id,
                               checkpoint_id=checkpoint.id, title='教育策略测试')
        db.add(session)
        await db.flush()
        result = dict(learner_id=learner_id, project_id=project.id, checkpoint_id=checkpoint.id,
                      session_id=session.id, question_ids=[q.id for q in questions])
        await db.commit()
        return result


async def legacy_learner():
    async with async_session() as db:
        return await db.scalar(select(Learner.id).where(Learner.key == 'local-default'))


async def assessment_state(scope):
    async with async_session() as db:
        knowledge = (await db.execute(select(KernelState).where(
            KernelState.learner_id == scope['learner_id'], KernelState.kernel_name == 'knowledge'))).scalar_one()
        events = list((await db.execute(select(EvidenceEvent).where(
            EvidenceEvent.learner_id == scope['learner_id'],
            EvidenceEvent.checkpoint_id == scope['checkpoint_id'],
            EvidenceEvent.event_type == 'concept_attempt_evaluated').order_by(EvidenceEvent.id))).scalars())
        mutations = list((await db.execute(select(KernelMutation).where(
            KernelMutation.event_id.in_([e.id for e in events])))).scalars())
        return dict(knowledge.short_term or {}), dict(knowledge.long_term or {}), events, mutations


def assert_no_ordinary_stability(scope, short, long):
    statuses = [value['status'] for value in short.get('concept_understanding', {}).values()
                if value.get('checkpoint_id') == scope['checkpoint_id']]
    assert statuses
    assert set(statuses) <= {'verified_once', 'correct_with_support', 'needs_review'}
    assert f"checkpoint:{scope['checkpoint_id']}" not in long.get('mastery', {})


@pytest.mark.parametrize('duplicate_questions', [False, True], ids=['different-items', 'same-question-new-ids'])
def test_public_concept_scores_do_not_promote_checkpoint_stability(client, duplicate_questions):
    scope = asyncio.run(seed_scope(learner_id=asyncio.run(legacy_learner()), duplicate_questions=duplicate_questions))
    for question in scope['question_ids']:
        response = client.post(f"/api/checkpoints/{scope['checkpoint_id']}/concepts/{question}/submit", json={
            'answer_indexes': [0], 'assistance_level': 'none', 'client_submission_id': uuid.uuid4().hex,
        })
        assert response.status_code == 200, response.text
        assert response.json()['correct'] is True
    short, long, events, mutations = asyncio.run(assessment_state(scope))
    assert len(events) == 2
    assert {m.event_id for m in mutations} == {e.id for e in events}
    assert all(e.provenance['grader'] == 'exact_match' for e in events)
    assert_no_ordinary_stability(scope, short, long)


def test_public_repeat_new_submission_id_is_supported_and_replay_is_idempotent(client):
    scope = asyncio.run(seed_scope(learner_id=asyncio.run(legacy_learner())))
    question = scope['question_ids'][0]
    url = f"/api/checkpoints/{scope['checkpoint_id']}/concepts/{question}/submit"
    first = client.post(url, json={'answer_indexes': [0], 'assistance_level': 'none', 'client_submission_id': uuid.uuid4().hex})
    assert first.status_code == 200
    payload = {'answer_indexes': [0], 'assistance_level': 'none', 'client_submission_id': uuid.uuid4().hex}
    repeat = client.post(url, json=payload)
    replay = client.post(url, json=payload)
    assert repeat.status_code == replay.status_code == 200
    assert repeat.json()['attempt_id'] == replay.json()['attempt_id'] != first.json()['attempt_id']
    short, long, events, _ = asyncio.run(assessment_state(scope))
    assert len(events) == 2
    assert events[-1].payload['independent'] is False
    assert short['concept_understanding'][f'item:{question}']['status'] == 'correct_with_support'
    assert_no_ordinary_stability(scope, short, long)


@pytest.mark.parametrize('correct,independent,expected', [(True, True, 'verified_once'), (True, False, 'correct_with_support'), (False, True, 'needs_review')])
def test_same_formal_session_events_keep_attempt_level_evidence(client, correct, independent, expected):
    async def scenario():
        scope = await seed_scope()
        async with async_session() as db:
            for item in scope['question_ids']:
                await record_event(db, **{k: scope[k] for k in ('learner_id', 'project_id', 'checkpoint_id', 'session_id')},
                    event_type='concept_attempt_evaluated', source='assessment',
                    client_event_id='education-grade-' + uuid.uuid4().hex,
                    payload={'item_id': item, 'question': 'heliostat 递归条件', 'correct': correct,
                             'independent': independent, 'assistance_level': 'none' if independent else 'hint'})
            await db.commit()
        return scope
    scope = asyncio.run(scenario())
    short, long, events, _ = asyncio.run(assessment_state(scope))
    assert {e.session_id for e in events} == {scope['session_id']}
    assert all(short['concept_understanding'][f'item:{item}']['status'] == expected for item in scope['question_ids'])
    assert_no_ordinary_stability(scope, short, long)


async def planner_context(specs):
    """Use actual gateway/reducer, selector, and scoped production reader."""
    scope = await seed_scope()
    base = datetime.utcnow() - timedelta(minutes=2)
    async with async_session() as db:
        events = []
        for index, spec in enumerate(specs):
            event_type, payload = spec[:2]
            age_hours = spec[2] if len(spec) > 2 else 0
            payload = dict(payload)
            if event_type == 'concept_attempt_evaluated':
                payload.setdefault('item_id', scope['question_ids'][0])
                payload.setdefault('question', 'heliostat 递归条件')
            events.append(await record_event(db,
                **{k: scope[k] for k in ('learner_id', 'project_id', 'checkpoint_id', 'session_id')},
                event_type=event_type, source='assessment' if event_type == 'concept_attempt_evaluated' else 'user',
                occurred_at=base + timedelta(seconds=index) - timedelta(hours=age_hours),
                client_event_id='education-input-' + uuid.uuid4().hex, payload=payload))
        await db.flush()
        states = {row.kernel_name: {'short_term': dict(row.short_term or {}), 'long_term': dict(row.long_term or {})}
                  for row in (await db.execute(select(KernelState).where(KernelState.learner_id == scope['learner_id']))).scalars()}
        selected = select_teaching_guidance(states, **{k: scope[k] for k in ('project_id', 'checkpoint_id', 'session_id')})
        context = await _scoped_planner_context(db,
            **{k: scope[k] for k in ('learner_id', 'project_id', 'checkpoint_id', 'session_id')},
            objective='heliostat 递归条件')
        copied = [entry for values in context.values() for entry in values.get('teaching_guidance', [])]
        assert {entry['source_event_id'] for entry in copied} <= {entry['source_event_id'] for entry in selected}
        assert all(entry['mastery_inference'] is False for entry in copied)
        assert all(entry['source_event_id'] in {event.id for event in events} for entry in copied)
        await db.commit()
        return context, selected


def plan_args(context):
    return dict(title='heliostat 递归条件', objective='解释终止条件并独立判断一次调用',
                origin_kind='conversation', estimated_minutes=35, learner_context=context)


def phase(plan, kind):
    return next(item for item in plan['phases'] if item['kind'] == kind)


def practice_is_independent_and_required(plan):
    assert phase(plan, 'practice')['required'] is True
    assert phase(plan, 'verify')['required'] is True
    assert re.search('独立|无提示', phase(plan, 'verify')['purpose'])


@pytest.mark.parametrize('minutes', [10, 2])
@pytest.mark.parametrize('entrypoint', ['fallback', 'generate'])
def test_current_time_budget_caps_actual_plan_even_below_five_minutes(client, monkeypatch, minutes, entrypoint):
    context, selected = asyncio.run(planner_context([
        ('vnext_teaching_input_received', {'text': f'今天只有{minutes}分钟'}),
    ]))
    assert next(g for g in selected if g['slot'] == 'time_budget')['minutes'] == minutes
    monkeypatch.setattr('app.services.learning_tasks.settings.llm_api_key', '')
    plan = (_fallback_plan(**plan_args(context)) if entrypoint == 'fallback'
            else asyncio.run(generate_learning_task_plan(**plan_args(context))))
    assert 0 < plan['estimated_minutes'] <= minutes
    practice_is_independent_and_required(plan)


def test_explicit_support_guidance_produces_smaller_teaching_steps(client):
    context, selected = asyncio.run(planner_context([
        ('vnext_human_adaptation_requested', {'signal_kind': 'support_need', 'value': 'reduce_chunk_size', 'explicit': True}),
    ]))
    assert any(g['slot'] == 'support' for g in selected)
    plan = _fallback_plan(**plan_args(context))
    assert re.search('分段|小步|短步|一步|一个.*目标', phase(plan, 'learn')['title'] + phase(plan, 'learn')['purpose'])
    practice_is_independent_and_required(plan)


def test_supported_success_requests_fading_hints_before_independent_check(client):
    context, selected = asyncio.run(planner_context([
        ('concept_attempt_evaluated', {'correct': True, 'independent': False, 'assistance_level': 'hint'}),
    ]))
    assert any(g['evidence_kind'] == 'supported_success' for g in selected)
    plan = _fallback_plan(**plan_args(context))
    assert re.search('撤.*提示|减少.*提示|逐步.*提示', phase(plan, 'practice')['purpose'])
    practice_is_independent_and_required(plan)


def test_resolution_overrides_a_real_older_knowledge_gap_fact(client):
    old_gap = 'heliostat 递归条件我不懂，需要重新认识终止位置'
    context, selected = asyncio.run(planner_context([
        ('user_message', {'text': old_gap}),
        ('vnext_teaching_input_received', {'text': '这个问题已经解决了'}),
    ]))
    assert any(g['evidence_kind'] == 'self_reported_resolution' for g in selected)
    # The context may retain historical source material for audit, but the
    # teaching action must follow the later scoped resolution.
    plan = _fallback_plan(**plan_args(context))
    assert old_gap not in phase(plan, 'learn')['purpose']
    assert re.search('检查|校准|衔接|确认|变式', phase(plan, 'learn')['purpose'])


def test_latest_independent_success_prevents_old_guidance_from_reintroducing_scaffolding(client):
    context, selected = asyncio.run(planner_context([
        ('concept_attempt_evaluated', {'correct': True, 'independent': False, 'assistance_level': 'guided'}),
        ('concept_attempt_evaluated', {'correct': True, 'independent': True, 'assistance_level': 'none'}),
    ]))
    assert [g['evidence_kind'] for g in selected if g['slot'] == 'practice_feedback'] == ['independent_success']
    # Explicitly replay the older projected Fact value into the read-only input:
    # current authoritative guidance must still dominate this stale cache value.
    context.setdefault('practice', {})['assistance_level'] = 'guided'
    plan = _fallback_plan(**plan_args(context))
    assert not re.search('脚手架|撤.*提示|减少.*提示', phase(plan, 'practice')['purpose'])
    practice_is_independent_and_required(plan)


@pytest.mark.parametrize('condition', ['expired', 'cancelled'])
def test_expired_or_cancelled_controls_do_not_change_a_new_plan(client, condition):
    specs = ([('vnext_teaching_input_received', {'text': '今天只有2分钟，这一步没看懂'}, 9)]
             if condition == 'expired' else [
                 ('vnext_teaching_input_received', {'text': '以后讲解慢一点'}),
                 ('vnext_teaching_input_received', {'text': '以后不要讲解慢一点'}),
             ])
    context, selected = asyncio.run(planner_context(specs))
    if condition == 'expired':
        assert selected == []
    else:
        assert any(g.get('cancelled') is True for g in selected)
    plan = _fallback_plan(**plan_args(context))
    clean = _fallback_plan(**plan_args({}))
    assert plan['estimated_minutes'] == clean['estimated_minutes']
    assert [(p['kind'], p['title'], p['purpose']) for p in plan['phases']] == [(p['kind'], p['title'], p['purpose']) for p in clean['phases']]


@pytest.mark.parametrize('model_behavior', ['over_budget_omits_practice', 'timeout'])
def test_online_model_cannot_break_time_support_or_practice_constraints(client, monkeypatch, model_behavior):
    context, selected = asyncio.run(planner_context([
        ('vnext_teaching_input_received', {'text': '今天只有2分钟'}),
        ('vnext_human_adaptation_requested', {'signal_kind': 'support_need', 'value': 'reduce_chunk_size', 'explicit': True}),
        ('concept_attempt_evaluated', {'correct': True, 'independent': False, 'assistance_level': 'hint'}),
    ]))
    assert {'time_budget', 'support', 'practice_feedback'} <= {g['slot'] for g in selected}
    calls = []
    class AdversarialPlanner:
        def __init__(self, **_kwargs):
            pass
        async def ainvoke(self, messages):
            calls.append(messages)
            if model_behavior == 'timeout':
                await asyncio.sleep(1)
            return SimpleNamespace(content=json.dumps({
                'summary': '模型候选安排', 'estimated_minutes': 120,
                'phases': [
                    {'kind': 'learn', 'title': '一次讲完全部内容', 'purpose': '连续完成复杂推导', 'required': False},
                    {'kind': 'verify', 'title': '验收', 'purpose': '看过答案即可', 'required': False},
                ],
            }))
    monkeypatch.setattr('app.services.learning_tasks.ChatOpenAI', AdversarialPlanner)
    monkeypatch.setattr('app.services.learning_tasks.settings.llm_api_key', 'test-placeholder')
    monkeypatch.setattr('app.services.learning_tasks.settings.learning_task_plan_model_budget_seconds', .01)
    plan = asyncio.run(generate_learning_task_plan(**plan_args(context)))
    assert len(calls) == 1
    assert 0 < plan['estimated_minutes'] <= 2
    assert re.search('分段|小步|短步|一步|一个.*目标', phase(plan, 'learn')['title'] + phase(plan, 'learn')['purpose'])
    assert re.search('撤.*提示|减少.*提示|逐步.*提示', phase(plan, 'practice')['purpose'])
    practice_is_independent_and_required(plan)


@pytest.mark.parametrize('assistance_payload,expected', [
    ({}, 'correct_assistance_unknown'),
    ({'independent': True, 'assistance_level': 'guided'}, 'correct_with_support'),
], ids=['missing-assistance', 'assistance-overrides-conflicting-independent-flag'])
def test_unproven_independence_does_not_become_verified_once(client, assistance_payload, expected):
    async def scenario():
        scope = await seed_scope()
        async with async_session() as db:
            await record_event(db, **{k: scope[k] for k in ('learner_id', 'project_id', 'checkpoint_id', 'session_id')},
                event_type='concept_attempt_evaluated', source='assessment',
                client_event_id='education-uncertain-' + uuid.uuid4().hex,
                payload={'item_id': scope['question_ids'][0], 'correct': True, **assistance_payload})
            await db.commit()
        return scope
    scope = asyncio.run(scenario())
    short, long, events, mutations = asyncio.run(assessment_state(scope))
    observed = short['concept_understanding'][f"item:{scope['question_ids'][0]}"]
    assert observed['status'] == expected
    assert f"checkpoint:{scope['checkpoint_id']}" not in long.get('mastery', {})
    assert len(events) == 1 and mutations


@pytest.mark.parametrize('matching_source', [True, False])
def test_current_gap_keeps_specific_evidence_only_from_its_own_event(client, matching_source):
    gap = '我不懂 heliostat 递归终止条件在空输入时怎么判断'
    context, selected = asyncio.run(planner_context([('user_message', {'text': gap})]))
    active = next(g for g in selected if g['slot'] == 'current_blocker')
    assert context['knowledge']['knowledge_gap'] == gap
    assert any(row['detail']['source_event_id'] == active['source_event_id']
               for row in context['knowledge']['relevant_evidence'])
    if not matching_source:
        # Simulate a stale read cache; never alter authoritative events or state.
        for row in context['knowledge']['relevant_evidence']:
            row['detail']['source_event_id'] = -1
    plan = _fallback_plan(**plan_args(context))
    assert (gap in phase(plan, 'learn')['purpose']) is matching_source
    if matching_source:
        assert plan['teaching_constraints']['blocker_evidence']['detail']['source_event_id'] == active['source_event_id']
    else:
        assert 'blocker_evidence' not in plan['teaching_constraints']
