"""Control policy regressions: rules and the real evidence gateway."""
from copy import deepcopy
from datetime import timedelta
import json

import pytest

from learnflow_core.teaching_guidance import (
    CONTROL_POLICY_LIMITS, SUPPORTED_GUIDANCE_VERSIONS,
    diagnose_teaching_guidance, reduce_teaching_guidance,
)
from test_teaching_guidance_rules import NOW, apply, event, read


def diagnose(states, **kwargs):
    return diagnose_teaching_guidance(states, project_id=kwargs.get('project', 1),
        checkpoint_id=kwargs.get('checkpoint', 2), session_id=kwargs.get('session', 10),
        now=kwargs.get('at', NOW), input_event=kwargs.get('input_event'))


@pytest.mark.parametrize('text', [
    '这一次只有10分钟', '本轮只有10分钟', '接下来只有十分钟',
    '这些字符不是字素簇。但这一次只有10分钟。',
    '调度假设需要另行检查。本轮只有10分钟。',
    '他说今天只有40分钟，但这一次只有10分钟。',
    '“我今天只有40分钟”，但本轮只有10分钟。',
    '```text\n我今天只有40分钟\n```\n接下来只有10分钟。',
    '如果执行失败就回滚，但这一次只有10分钟。',
])
def test_independent_current_request_is_extracted_from_its_own_segment(text):
    entries = read(apply({}, event(text)))
    budget = next(entry for entry in entries if entry['slot'] == 'time_budget')
    assert budget['minutes'] == 10
    start, end = budget['source_span']
    assert '10分钟' in text[start:end] or '十分钟' in text[start:end]
    assert budget['source_scope'] == budget['application_scope'] == budget['scope']


@pytest.mark.parametrize('text', [
    '他说，我今天只有10分钟。', '如果任务失败，我这次只有10分钟。',
    '他们本轮只有10分钟。', '同事这一次只有10分钟。',
    '“本轮只有10分钟', '```python\n# 本轮只有10分钟',
    '`本轮只有10分钟`', '这一次只有10分钟？', '以后用Python示例？',
    '我有一个问题。只有10分钟是否足够？',
    '本轮不是只有10分钟', '别先学递归',
])
def test_reported_conditional_quoted_question_and_negated_requests_are_inert(text):
    assert read(apply({}, event(text))) == []


def window_text(deadline='2026-09-06T10:00:00+00:00'):
    return f'今天只有10分钟，请拆成小步；这个临时安排只持续到 {deadline}。'


def test_explicit_window_preserves_source_and_exact_project_checkpoint_across_sessions():
    incoming = event(window_text())
    states = apply({}, incoming)
    before = deepcopy(states)
    budget = next(item for item in read(states, session=11, at=NOW + timedelta(hours=25)) if item['slot'] == 'time_budget')
    assert budget['lifetime'] == 'project_window'
    assert budget['expires_at'] == '2026-09-06T10:00:00+00:00'
    assert budget['source_scope'] == {'project_id': 1, 'checkpoint_id': 2, 'session_id': 10}
    assert budget['application_scope'] == {'project_id': 1, 'checkpoint_id': 2, 'session_id': None}
    start, end = budget['deadline_source_span']
    assert incoming.payload['text'][start:end] == '2026-09-06T10:00:00+00:00'
    for scope in ({'project': None}, {'project': 9}, {'checkpoint': None}, {'checkpoint': 9}):
        assert read(states, session=11, **scope) == []
    assert read(states, session=11, at=NOW + timedelta(hours=26)) == []
    assert states == before
    assert reduce_teaching_guidance(incoming, states) == {}


@pytest.mark.parametrize('deadline,reason', [
    ('2026-09-06T10:00:00', 'deadline_timezone_missing'),
    ('明天', 'deadline_requires_explicit_timezone_iso'),
    ('2026-09-05T07:59:00Z', 'deadline_not_future'),
    ('2026-09-13T08:00:01Z', 'deadline_exceeds_policy_window'),
    ('2026-09-31T10:00:00Z', 'deadline_invalid_iso'),
    ('2026-09-06T10:00:00Z 或 2026-09-07T10:00:00Z', 'conflicting_deadlines'),
])
def test_invalid_explicit_window_has_uncertain_metadata_and_no_default_budget(deadline, reason):
    incoming = event(window_text(deadline))
    states = apply({}, incoming)
    assert not any(item['slot'] == 'time_budget' for item in read(states))
    result = diagnose(states, input_event=incoming)
    assert any(item['reason'] == reason for item in result['diagnostics'])
    assert '10分钟' not in json.dumps(result, ensure_ascii=False)
    assert all(not state['long_term'] for state in states.values())


def test_explicit_max_window_is_inclusive_and_no_deadline_stays_eight_hours():
    assert CONTROL_POLICY_LIMITS['default_session_hours'] == 8
    assert CONTROL_POLICY_LIMITS['max_explicit_window_hours'] == 168
    states = apply({}, event(window_text('2026-09-12T08:00:00Z')))
    assert any(item['slot'] == 'time_budget' for item in read(states, session=11, at=NOW + timedelta(hours=167)))
    default = read(apply({}, event('本轮只有10分钟')))[0]
    assert default['expires_at'] == (NOW + timedelta(hours=8)).isoformat()
    assert default['lifetime'] == 'session'


def test_window_cannot_be_acquired_without_source_project_or_session():
    states = apply({}, event(window_text(), project=None, checkpoint=None))
    assert not any(item['slot'] == 'time_budget' for item in read(states, project=None, checkpoint=None))
    assert diagnose(states, project=None, checkpoint=None)['counts']['uncertain'] >= 1
    assert reduce_teaching_guidance(event(window_text(), session=None), {}) == {}


def test_unrelated_dataset_timestamp_is_not_a_control_deadline():
    states = apply({}, event('本轮只有10分钟。样本截止 2026-09-06T10:00:00Z。'))
    assert next(item for item in read(states) if item['slot'] == 'time_budget')['lifetime'] == 'session'


def test_legacy_v1_read_is_unchanged_and_malformed_expiry_fails_closed():
    states = apply({}, event('今天只有10分钟'))
    entry = states['human']['short_term']['teaching_directives'][0]
    entry['policy_version'] = 'teaching-guidance.v1'
    for name in ('source_scope', 'application_scope', 'parser_version', 'source_span'):
        entry.pop(name)
    before = deepcopy(states)
    assert 'teaching-guidance.v1' in SUPPORTED_GUIDANCE_VERSIONS
    assert read(states)[0]['policy_version'] == 'teaching-guidance.v1'
    assert read(states, session=11) == []
    assert states == before
    entry['expires_at'] = 'bad-date'
    assert read(states) == []
    assert diagnose(states)['counts']['uncertain'] == 1
    assert entry['expires_at'] == 'bad-date'


@pytest.mark.parametrize('mutation', [
    {'application_scope': {'project_id': 2, 'checkpoint_id': 2, 'session_id': None}},
    {'source_scope': {'project_id': 1, 'checkpoint_id': 3, 'session_id': 10}},
    {'expiry_basis': 'model_guess'}, {'expires_at': '2027-09-06T10:00:00Z'},
    {'expires_at': '2026-09-06T10:00:00'},
])
def test_corrupt_v2_window_never_widens_its_application(mutation):
    states = apply({}, event(window_text()))
    entry = next(item for item in states['human']['short_term']['teaching_directives'] if item['slot'] == 'time_budget')
    entry.update(mutation)
    assert not any(item['slot'] == 'time_budget' for item in read(states, session=11))
    assert diagnose(states, session=11)['counts']['uncertain'] >= 1


def test_goal_replacement_return_anchor_and_cancellation_do_not_change_long_term_goals():
    states = {'value': {'short_term': {}, 'long_term': {'goals': ['成为数据库工程师']}}}
    states = apply(states, event('我这个阶段的目标是完成索引调优。之后请带我回到事务隔离。'))
    assert next(item for item in read(states) if item['slot'] == 'current_priority')['requested_priority'] == '完成索引调优'
    assert next(item for item in read(states) if item['slot'] == 'return_anchor')['requested_anchor'] == '事务隔离'
    states = apply(states, event('当前目标改为分析锁等待', event_id=2, at=NOW + timedelta(seconds=1)))
    assert next(item for item in read(states, at=NOW + timedelta(seconds=1)) if item['slot'] == 'current_priority')['requested_priority'] == '分析锁等待'
    states = apply(states, event('不要这样', event_id=3, at=NOW + timedelta(seconds=2)))
    assert not next(item for item in read(states, at=NOW + timedelta(seconds=2)) if item['slot'] == 'current_priority').get('cancelled')
    states = apply(states, event('取消当前目标。取消本次返回安排。', event_id=4, at=NOW + timedelta(seconds=3)))
    assert all(item['cancelled'] for item in read(states, at=NOW + timedelta(seconds=3)))
    assert states['value']['long_term']['goals'] == ['成为数据库工程师']
    assert diagnose(states, at=NOW + timedelta(seconds=3))['counts']['cancelled'] == 2


def test_latest_cancellation_beats_an_older_local_override_and_delayed_event():
    states = apply({}, event('以后代码示例优先用Python'))
    states = apply(states, event('这次示例用Java', event_id=2, at=NOW + timedelta(seconds=1)))
    states = apply(states, event('以后不用Python示例了', event_id=3, at=NOW + timedelta(seconds=2)))
    selected = read(states, at=NOW + timedelta(seconds=2))
    assert len(selected) == 1 and selected[0]['cancelled'] is True
    assert selected[0]['source_event_id'] == 3
    assert reduce_teaching_guidance(event('以后代码示例优先用Rust', event_id=1), states) == {}


def test_equal_timestamp_lower_event_id_cannot_clear_new_gap_or_turn_control():
    states = apply({}, event('这一步没懂。这次回答简短', event_id=12))
    states = apply(states, event('我明白了', event_id=9))
    assert next(item for item in read(states) if item['slot'] == 'current_blocker')['evidence_kind'] == 'self_reported_gap'
    assert any(item['slot'] == 'response_length' for item in read(states))


def test_diagnostics_distinguish_statuses_with_no_human_text_and_are_read_only():
    states = apply({}, event('今天只有10分钟'))
    states = apply(states, event('本轮只有2分钟', event_id=2, at=NOW + timedelta(seconds=1)))
    original = deepcopy(states)
    current = diagnose(states, at=NOW + timedelta(seconds=1))
    assert current['counts']['superseded'] == 1
    assert current['selected_event_ids'] == [2]
    assert diagnose(states, session=11)['counts']['scope_mismatch'] == 2
    assert diagnose(states, at=NOW + timedelta(hours=9))['counts']['expired'] == 2
    assert diagnose({}, input_event=event('事务有哪些性质'))['status'] == 'no_request'
    assert diagnose({}, input_event=event('“今天只有10分钟”'))['status'] == 'uncertain'
    assert '10分钟' not in json.dumps(current, ensure_ascii=False)
    assert 'instruction' not in json.dumps(current)
    assert states == original
    mismatch = diagnose({}, input_event=event('今天只有10分钟', session=99))
    assert mismatch['status'] == 'scope_mismatch'
    assert 'source_event_id' not in json.dumps(mismatch)


def test_real_sync_gateway_keeps_window_source_scope_and_authority_chain():
    import asyncio
    import uuid
    from fastapi.testclient import TestClient
    from sqlalchemy import select
    from app.main import app
    from app.db.database import async_session
    from app.models.learning import EvidenceEvent, KernelMutation, KernelState, MemoryFact
    from learnflow_core.teaching_guidance import select_teaching_guidance
    from test_immediate_teaching_context import register
    from test_education_memory_policy import seed_scope

    with TestClient(app) as client:
        learner_id, _ = register(client)
        scope = asyncio.run(seed_scope(learner_id=learner_id))
        raw = window_text()
        payload = {'event_type': 'vnext_teaching_input_received',
            'session_id': scope['session_id'], 'occurred_at': NOW.isoformat(),
            'client_event_id': 'control-v2-' + uuid.uuid4().hex,
            'payload': {'text': raw, 'minutes': 99, 'application_scope': {'project_id': 999}}}
        saved = client.post('/api/learner-state/events', json=payload)
        assert saved.status_code == 200, saved.text
        event_id = saved.json()['event_id']
        assert client.post('/api/learner-state/events', json=payload).json() == saved.json()
        assert client.post('/api/learner-state/events', json={**payload,
            'payload': {'text': '本轮只有2分钟'}}).status_code == 409

        async def audit():
            async with async_session() as db:
                original = await db.get(EvidenceEvent, event_id)
                assert original.payload == {'text': raw}
                assert original.learner_id == learner_id
                assert (original.project_id, original.checkpoint_id, original.session_id) == (
                    scope['project_id'], scope['checkpoint_id'], scope['session_id'])
                mutations = list((await db.execute(select(KernelMutation).where(KernelMutation.event_id == event_id))).scalars())
                assert mutations and all(mutation.kernel_name == 'human' for mutation in mutations)
                rows = list((await db.execute(select(KernelState).where(KernelState.learner_id == learner_id))).scalars())
                states = {row.kernel_name: {'short_term': row.short_term, 'long_term': row.long_term} for row in rows}
                selected = select_teaching_guidance(states, project_id=scope['project_id'],
                    checkpoint_id=scope['checkpoint_id'], session_id=scope['session_id'] + 1000,
                    now=NOW + timedelta(hours=25))
                budget = next(item for item in selected if item['slot'] == 'time_budget')
                assert budget['minutes'] == 10 and budget['source_event_id'] == event_id
                assert budget['source_scope']['session_id'] == scope['session_id']
                assert budget['application_scope']['session_id'] is None
                # The control projection is authority-derived, but Human text is
                # deliberately not transformed into a long-term memory Fact.
                assert not list((await db.execute(select(MemoryFact).where(MemoryFact.source_event_id == event_id))).scalars())
        asyncio.run(audit())
        register(client)
        assert client.post('/api/learner-state/events', json={**payload,
            'client_event_id': 'foreign-' + uuid.uuid4().hex}).status_code == 404


def test_goal_window_and_return_anchor_are_bounded_with_invalid_deadline_diagnostics():
    states = apply({}, event('本轮优先完成二叉树遍历；这个目标有效至2026-09-06T10:00:00Z。'))
    assert next(item for item in read(states, session=11) if item['slot'] == 'current_priority')['lifetime'] == 'project_window'
    states = apply({}, event('之后请带我回到接口隔离；这个安排有效至2026-09-06T10:00:00Z。'))
    assert next(item for item in read(states, session=11) if item['slot'] == 'return_anchor')['lifetime'] == 'project_window'
    states = apply({}, event('之后请带我回到接口隔离；这个安排有效至明天。'))
    assert read(states) == []
    assert diagnose(states)['diagnostics'][0]['kernel'] == 'structure'


def test_window_does_not_bind_another_budget_and_question_limit_is_bounded():
    states = apply({}, event('本轮只有10分钟；接下来只有2分钟，这个安排有效至2026-09-06T10:00:00Z。'))
    entry = next(item for item in read(states) if item['slot'] == 'time_budget')
    assert entry['minutes'] == 2 and entry['lifetime'] == 'project_window'
    report = diagnose({}, input_event=event('“今天只有10分钟”\n' * 200))
    assert len(report['diagnostics']) <= CONTROL_POLICY_LIMITS['max_diagnostics']
    assert '10分钟' not in json.dumps(report, ensure_ascii=False)


@pytest.mark.parametrize('initial,cancellation,slot', [
    ('本轮只有10分钟', '取消这个项目的临时时间预算安排', 'time_budget'),
    ('当前优先完成拓扑排序', '取消该临时优先事项', 'current_priority'),
    ('之后请带我回到约束求解', '取消该临时返回安排', 'return_anchor'),
])
def test_explicit_window_cancellation_inherits_original_expiry_and_never_revives(initial, cancellation, slot):
    states = apply({}, event(initial + '；这个安排有效至2026-09-06T10:00:00Z。'))
    original = next(item for item in read(states) if item['slot'] == slot)
    cancel = event(cancellation, event_id=2, session=11, at=NOW + timedelta(hours=2))
    states = apply(states, cancel)
    tombstone = next(item for item in read(states, session=99, at=NOW + timedelta(hours=25)) if item['slot'] == slot)
    assert tombstone['cancelled'] is True
    assert tombstone['source_event_id'] == 2
    assert tombstone['cancelled_window_source_event_id'] == 1
    assert tombstone['expires_at'] == original['expires_at']
    assert tombstone['expiry_basis'] == 'inherited_cancelled_window'
    assert tombstone['source_scope']['session_id'] == 11
    assert tombstone['application_scope'] == original['application_scope']
    assert read(states, session=99, at=NOW + timedelta(hours=26)) == []
    assert reduce_teaching_guidance(cancel, states) == {}
    assert reduce_teaching_guidance(event(initial + '；这个安排有效至2026-09-06T10:00:00Z。', event_id=1), states) == {}


@pytest.mark.parametrize('scope', [{'project': 9}, {'checkpoint': 9}, {'project': None, 'checkpoint': None}])
def test_window_cancellation_cannot_cross_project_checkpoint_or_create_global_scope(scope):
    states = apply({}, event(window_text()))
    states = apply(states, event('取消这个项目的临时时间预算安排', event_id=2,
        session=11, at=NOW + timedelta(hours=2), **scope))
    budget = next(item for item in read(states, session=99, at=NOW + timedelta(hours=3)) if item['slot'] == 'time_budget')
    assert budget['minutes'] == 10 and not budget.get('cancelled')
    assert budget['source_event_id'] == 1


def test_expired_window_cancellation_does_not_renew_and_local_cancel_stays_local():
    states = apply({}, event(window_text()))
    local = apply(states, event('取消预算', event_id=2, session=11, at=NOW + timedelta(hours=1)))
    assert next(item for item in read(local, session=11, at=NOW + timedelta(hours=2)) if item['slot'] == 'time_budget')['cancelled']
    assert next(item for item in read(local, session=99, at=NOW + timedelta(hours=2)) if item['slot'] == 'time_budget')['minutes'] == 10
    expired = apply(states, event('取消这个项目的临时时间预算安排', event_id=3, session=11, at=NOW + timedelta(hours=27)))
    assert read(expired, session=99, at=NOW + timedelta(hours=27)) == []
    assert any(item['reason'] == 'no_matching_project_window' for item in diagnose(expired, session=11, at=NOW + timedelta(hours=27))['diagnostics'])


def test_input_and_segment_limits_are_explicit_metadata_only():
    for text, reason in [('字' * 4100, 'input_limit'), ('一般内容。' * 100, 'segment_limit')]:
        report = diagnose({}, input_event=event(text))
        assert report['status'] == 'uncertain'
        assert any(item['reason'] == reason for item in report['diagnostics'])
        assert len(report['diagnostics']) <= CONTROL_POLICY_LIMITS['max_diagnostics']
        assert text not in json.dumps(report, ensure_ascii=False)


@pytest.mark.parametrize('text', ['他本轮只有20分钟；我只有10分钟', '"本轮只有40分钟\n接下来只有10分钟', '`本轮只有40分钟\n这一次只有10分钟'])
def test_separate_sentence_after_report_or_unclosed_inline_quote_keeps_self_request(text):
    budget = next(item for item in read(apply({}, event(text))) if item['slot'] == 'time_budget')
    assert budget['minutes'] == 10


def test_corrupt_session_expiry_cannot_gain_a_longer_window():
    states = apply({}, event('本轮只有10分钟'))
    states['human']['short_term']['teaching_directives'][0]['expires_at'] = (NOW + timedelta(hours=9)).isoformat()
    assert read(states) == []
    assert diagnose(states)['diagnostics'][0]['reason'] == 'invalid_session_expiry'
