"""Pure read-side query rules, independent of ablation gold and stored state."""
import itertools

import pytest

from learnflow_core.memory_query import (
    ALIAS_GROUPS, MAX_FUZZY_TEXTS, MAX_QUERY_CHARS, MAX_TEXT_CHARS, QueryPlan,
    fuzzy_probes, plan_query, resolve_fuzzy, tokenize,
)


def test_unicode_normalization_and_identifiers_are_preserved():
    plan = plan_query('请查 ＲＡＧ、Straße 和 ＣＡＦÉ，HTTP_2')
    assert {'rag', 'strasse', 'café', 'http_2'} <= set(plan.literal_terms)
    assert '检索增强生成' in plan.terms
    assert 'http' not in plan.terms
    assert {'strasse', 'café', 'http_2'} <= tokenize('Straße CAFÉ HTTP_2')
    assert plan.audit['normalization'] == 'unicode_nfkc_casefold_whitespace'


@pytest.mark.parametrize('query', [
    '学习', '记录', '证据', '请查看我的学习记录和证据', '汇总所有学习记录',
    'show me my learning records and evidence', 'what is my learning history?',
])
def test_generic_queries_have_no_topic_evidence(query):
    assert plan_query(query).terms == ()


def test_weak_words_do_not_destroy_technical_compounds():
    assert '学习率' in plan_query('学习率').terms
    assert '证据理论' in plan_query('证据理论').terms
    assert '习率' in plan_query('查看学习率的历史记录').terms
    assert '理论' in plan_query('证据理论的记录').terms
    assert 'records' not in plan_query('database records').terms
    assert 'database' in plan_query('database records').terms


@pytest.mark.parametrize('group', ALIAS_GROUPS)
def test_aliases_expand_bidirectionally_without_expanding_document_meaning(group):
    for alias in group:
        plan = plan_query(alias)
        assert set(group) <= set(plan.terms)
        assert alias in plan.literal_terms
        assert plan.audit['aliases'][0]['concept'] == group[0]
        assert alias in tokenize('Explain ' + alias + ' semantics')
    assert group[0] not in tokenize(group[-1])


def test_alias_boundaries_and_ambiguous_terms_do_not_expand():
    for query in ('scrag', 'tcp_socket', 'apis', 'mvcc2', 'x-rag', 'memory', 'TTL', 'attention', 'index'):
        assert not plan_query(query).audit['aliases']
    plan = plan_query('transmission control protocol')
    assert '传输控制协议' in plan.terms
    assert 'protocol' in plan.literal_terms
    assert '传输控制协议' not in plan.literal_terms


@pytest.mark.parametrize('query,intent,temporal', [
    ('恢复入口', 'fact', 'current'),
    ('测量历史', 'fact', 'history'),
    ('最初未完成的压测', 'fact', 'earliest'),
    ('总结最近 TCP 的全部记录', 'summary', 'current'),
    ('复盘数据库的历次变化', 'summary', 'history'),
    ('first attempt at deadlock detection', 'fact', 'earliest'),
    ('explain the historical scheduler behavior', 'fact', 'history'),
    ('overview of the initial parser implementation', 'summary', 'earliest'),
    ('summary_identifier', 'fact', 'current'),
])
def test_summary_and_time_intent_are_explicit(query, intent, temporal):
    plan = plan_query(query)
    assert (plan.intent, plan.temporal) == (intent, temporal)


@pytest.mark.parametrize('query,correct', [
    ('deadlcok', 'deadlock'),  # Adjacent transposition, unrelated to benchmark semaphore.
    ('schedulr', 'scheduler'),  # Missing character.
    ('threadd', 'thread'),  # Extra character.
    ('parzer', 'parser'),  # Substitution.
])
def test_only_unique_distance_one_candidates_are_added(query, correct):
    initial = plan_query(query)
    resolved = resolve_fuzzy(initial, ['The ' + correct + ' needs review.'])
    assert correct in resolved.terms
    assert resolved.literal_terms == initial.literal_terms == (query,)
    assert resolved.latin_terms == initial.latin_terms
    assert resolved.audit['fuzzy_corrections'] == [dict(original=query, corrected=correct, distance=1,
                                                     basis='unique_scoped_candidate')]
    assert initial.audit['fuzzy_corrections'] == []
    assert any(probe in correct for probe in fuzzy_probes(initial))


def test_exact_original_suppresses_correction_even_when_seen_later():
    plan = resolve_fuzzy(plan_query('planner'), ['planter is available', 'planner is intentional'])
    assert 'planter' not in plan.terms
    assert plan.audit['fuzzy_rejected'] == [{'original': 'planner', 'reason': 'exact_present'}]


def test_ambiguous_and_distant_candidates_are_rejected_independently_of_order():
    original = plan_query('crane')
    first = resolve_fuzzy(original, ['plane', 'crate'])
    second = resolve_fuzzy(original, ['crate', 'plane'])
    # plane is two edits away; crate alone is one edit away.
    assert first.terms == second.terms and 'crate' in first.terms
    ambiguous = resolve_fuzzy(original, ['crate', 'crank'])
    assert ambiguous.terms == original.terms
    assert ambiguous.audit['fuzzy_rejected'][0]['reason'] == 'ambiguous'
    assert ambiguous.audit['fuzzy_rejected'][0]['candidate_count'] == 2
    distant = resolve_fuzzy(plan_query('schedxxer'), ['scheduler'])
    assert distant.audit['fuzzy_corrections'] == []


def test_short_terms_digits_and_identifiers_never_receive_fuzzy_correction():
    for query in ('tcp', 'txp', 'port', 'abc12', 'parser_v', 'http-2', 'naïve'):
        plan = plan_query(query)
        assert fuzzy_probes(plan) == ()
        assert resolve_fuzzy(plan, ['tap port parserv abc13 naive']).audit['fuzzy_corrections'] == []


def test_scan_limits_fail_closed_instead_of_assuming_unique():
    plan = plan_query('deadlcok')
    oversized = resolve_fuzzy(plan, ['deadlock ' + 'x' * MAX_TEXT_CHARS])
    assert oversized.terms == plan.terms and oversized.audit['fuzzy_scan']['truncated']
    too_many = resolve_fuzzy(plan, itertools.chain(['deadlock'], itertools.repeat('', MAX_FUZZY_TEXTS)))
    assert too_many.terms == plan.terms and too_many.audit['fuzzy_scan']['truncated']
    exact_limit = resolve_fuzzy(plan, itertools.chain(['deadlock'], itertools.repeat('', MAX_FUZZY_TEXTS - 1)))
    assert 'deadlock' in exact_limit.terms and not exact_limit.audit['fuzzy_scan']['truncated']


def test_query_and_probe_limits_are_deterministic_and_auditable():
    query = ' '.join('topic' + str(i) for i in range(100)) + ' ' + 'a' * MAX_QUERY_CHARS
    plan = plan_query(query)
    assert len(plan.terms) <= 48 and len(plan.literal_terms) <= 32
    assert plan.audit['query_truncated'] and plan.audit['terms_truncated']
    assert plan == plan_query(query)
    alphabetic = QueryPlan(tuple(), tuple(), tuple('abc' + chr(97 + i) + 'def' for i in range(26)),
                           'fact', 'current', {})
    assert len(fuzzy_probes(alphabetic)) <= 48


def test_fuzzy_result_does_not_promote_alias_or_probe_to_semantic_evidence():
    initial = plan_query('parzer')
    probes = fuzzy_probes(initial)
    result = resolve_fuzzy(initial, ['garbage parade lazer'])
    assert result.terms == initial.terms
    assert not set(probes) & set(result.terms)
    assert result.audit['fuzzy_scan']['uniqueness_scope'] == 'provided_candidates'


def test_aliases_work_next_to_chinese_but_not_identifier_characters():
    assert '传输控制协议' in plan_query('TCP的状态').terms
    assert '多版本并发控制' in plan_query('查看MVCC记录').terms
    assert 'tcp' in tokenize('关于TCP协议')
    for query in ('tcp_service', 'tcp2', 'tcp-service', 'tcpé'):
        assert not plan_query(query).audit['aliases']


def test_repeated_fuzzy_resolution_keeps_the_correction_audit():
    first = resolve_fuzzy(plan_query('deadlcok'), ['deadlock'])
    second = resolve_fuzzy(first, ['deadlock'])
    assert first == second
