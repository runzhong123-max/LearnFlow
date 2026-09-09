"""Newest-first episode selection; synthetic size probes are not chain tests.

The native cases below separately form every observation through submit_concept
and the production EvidenceEvent/reducer/Mutation/Fact chain in isolated SQLite.
"""
import asyncio
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.services import five_kernel_context as context_service
from app.services import learning_tasks
from learnflow_core import planning_guidance
from learnflow_core.api.phase3 import submit_concept
from test_memory_episodes import independent_budget, native_case


def candidate(event_id, *, attempt_id, at, size=0, assisted=False):
    return {'schema_version': 'learnflow.learning-episode.v1', 'attempt_id': attempt_id,
        'occurred_at': at.isoformat(), 'source_event_ids': [event_id],
        'source_fact_ids': [event_id], 'source_mutation_ids': [event_id],
        'anchor_fact_ids': [event_id],
        'scope': {'learner_id': 1, 'project_id': 1, 'checkpoint_id': 1, 'session_id': None},
        'task': {'item_type': 'concept', 'item_id': 1, 'attempt_kind': 'retry' if assisted else 'original'},
        'outcome': {'correct': True, 'assistance_level': 'guided' if assisted else 'none', 'independent': not assisted},
        'observations': [{'fact_id': event_id, 'kernel': 'practice', 'text': 'projection-size-only ' + 'x' * size,
            'source_event_id': event_id, 'source_mutation_id': event_id}],
        'limitations': ['synthetic_packet_budget_probe_not_source_validation']}


@pytest.mark.parametrize('newest_size,expected', [(12000, []), (0, [20])])
def test_budget_admits_only_newest_prefix_never_short_older_success(monkeypatch, newest_size, expected):
    # Inject at the validated-candidate boundary to isolate pack admission. These
    # IDs/text are fixture data, not claims about production evidence formation.
    at = datetime.now(timezone.utc) - timedelta(hours=1)
    newest = candidate(20, attempt_id=1, at=at, size=newest_size, assisted=True)
    old = candidate(10, attempt_id=99, at=at - timedelta(minutes=1))
    async def candidates(*args, **kwargs):
        return deepcopy([newest, old]), {'events_scanned': 2, 'eligible': 2, 'selected': 0, 'budget_omitted': 0}
    monkeypatch.setattr(context_service, 'collect_learning_episodes', candidates)
    packet, _ = asyncio.run(native_case(budget=1800, max_episodes=1))
    assert [max(e['source_event_ids']) for e in packet['learning_episodes']] == expected
    stats = packet['retrieval_diagnostics']['episodes']
    assert stats['selected'] + stats['budget_omitted'] + stats['limit_omitted'] == 2
    if not expected:
        assert stats['budget_omitted'] == 2 and stats['limit_omitted'] == 0
    assert independent_budget(packet) == packet['manifest']['token_estimate'] <= 1800


def test_same_timestamp_feedback_uses_event_order_not_attempt_allocation_order():
    at = datetime.now(timezone.utc) - timedelta(minutes=1)
    old = candidate(30, attempt_id=900, at=at)
    newest = candidate(31, attempt_id=2, at=at, assisted=True)
    for rows in ([old, newest], [newest, old]):
        controls = planning_guidance.compile_planning_guidance({'practice': {'learning_episodes': rows}})
        assert controls['practice_feedback'] == 'supported_success'
        assert controls['decisions'][0]['source_event_ids'] == [31]
        assert controls['sources'][0]['attempt_id'] == 2


async def retry(db, context):
    result = await submit_concept(context.checkpoint.id, context.question.id,
        data={'answer_indexes': [0], 'assistance_level': 'guided', 'client_submission_id': 'freshness-guided-retry'},
        current=SimpleNamespace(learner=context.learner), db=db)
    context.new_attempt_id = result['attempt_id']


@pytest.mark.parametrize('budget', [1800, 3200])
def test_native_retry_freshness_survives_packet_budget_and_real_planner(monkeypatch, budget):
    # Expire only transient guidance by moving the read clock; assessment and
    # source Fact timestamps remain exactly those written by native grading.
    read_at = datetime.now(timezone.utc) + timedelta(hours=9)
    class ReadClock(datetime):
        @classmethod
        def utcnow(cls):
            return read_at.replace(tzinfo=None)
        @classmethod
        def now(cls, tz=None):
            return read_at.astimezone(tz) if tz else read_at.replace(tzinfo=None)
    monkeypatch.setattr(context_service, 'datetime', ReadClock)
    monkeypatch.setattr(planning_guidance, 'datetime', ReadClock)
    packet, context = asyncio.run(native_case(retry, assistance='none', budget=budget, max_episode_facts=4))
    assert packet['teaching_guidance'] == []
    episodes = packet['learning_episodes']
    assert episodes
    assert episodes[0]['attempt_id'] == context.new_attempt_id
    assert episodes[0]['outcome'] == {'correct': True, 'assistance_level': 'guided', 'independent': False}
    assert episodes[0]['task']['attempt_kind'] == 'retry'
    assert context.attempt.id != context.new_attempt_id
    if budget == 1800:
        assert len(episodes) == 1
    else:
        assert [e['attempt_id'] for e in episodes] == [context.new_attempt_id, context.attempt.id]
    assert independent_budget(packet) == packet['manifest']['token_estimate'] <= budget
    # This is the same scoped episode channel the production planner consumes.
    plan = learning_tasks._fallback_plan(title='Calibration', objective='quasar calibration',
        origin_kind='conversation', estimated_minutes=30,
        learner_context={'practice': {'learning_episodes': episodes}})
    assert plan['teaching_constraints']['practice_feedback'] == 'supported_success'
    decision = next(row for row in plan['teaching_decisions'] if row['action'] == 'fade_support_then_independent_probe')
    assert decision['source_event_ids'] == episodes[0]['source_event_ids']
    assert all(row['mastery_inference'] is False for row in plan['teaching_decisions'])
    assert any('逐步撤除提示' in phase.get('purpose', '') for phase in plan['phases'])
    assert any('记录显示这次尝试在支持下完成' in phase.get('purpose', '') for phase in plan['phases'])
    assert not any(phrase in phase.get('purpose', '') for phase in plan['phases']
                   for phrase in ('本次已有独立成功', '本次在支持下完成', '本次通过'))


def test_nine_hour_old_native_independent_success_is_described_as_a_record(monkeypatch):
    read_at = datetime.now(timezone.utc) + timedelta(hours=9)
    class ReadClock(datetime):
        @classmethod
        def utcnow(cls):
            return read_at.replace(tzinfo=None)
        @classmethod
        def now(cls, tz=None):
            return read_at.astimezone(tz) if tz else read_at.replace(tzinfo=None)
    monkeypatch.setattr(context_service, 'datetime', ReadClock)
    monkeypatch.setattr(planning_guidance, 'datetime', ReadClock)
    packet, context = asyncio.run(native_case(assistance='none', budget=3200))
    assert packet['teaching_guidance'] == []
    assert packet['learning_episodes'][0]['attempt_id'] == context.attempt.id
    plan = learning_tasks._fallback_plan(title='Calibration', objective='quasar calibration',
        origin_kind='conversation', estimated_minutes=30,
        learner_context={'practice': {'learning_episodes': packet['learning_episodes']}})
    assert plan['teaching_constraints']['practice_feedback'] == 'independent_success'
    assert any('记录中有一次明确的独立成功' in phase.get('purpose', '') for phase in plan['phases'])
    assert not any(phrase in phase.get('purpose', '') for phase in plan['phases']
                   for phrase in ('本次已有独立成功', '本次在支持下完成', '本次通过'))
    assert any('这仍不等于稳定掌握' in phase.get('purpose', '') for phase in plan['phases'])
