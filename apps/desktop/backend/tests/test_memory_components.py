"""Read-side component interventions keep ownership and controls intact."""
import asyncio
from dataclasses import replace

import pytest

from app.services.five_kernel_context import CONTEXT_POLICIES
from learnflow_core.memory_query import bm25_scores, plan_query
from test_memory_long_tail import exercise, item_ids
from test_memory_retrieval_budget import node


def test_bm25_uses_rare_literal_terms_and_reports_bounded_pool():
    documents = {i: 'calibration routine background' for i in range(300)}
    documents[900] = 'foxglove boundary unresolved'
    scores, audit = bm25_scores(plan_query('calibration foxglove'), documents)
    assert scores[900] > scores[0]
    assert audit['documents'] == audit['matched'] == 301
    assert audit['truncated_documents'] == 0
    assert bm25_scores(plan_query('unknownsignal'), documents)[0] == {}


def test_rare_literal_channel_reaches_beyond_combined_window_and_is_removable():
    async def build(db):
        wanted = await node(db, 'foxglove boundary unresolved', subject='concept:botany', age=400)
        for i in range(310):
            await node(db, f'calibration routine background {i}', subject='concept:instrument', age=1)
        return wanted.id
    full, expected = asyncio.run(exercise(build, query='calibration foxglove', max_items=1))
    disabled, old_expected = asyncio.run(exercise(build, query='calibration foxglove', max_items=1,
                                                 component_options={'enable_bm25': False}))
    assert expected in item_ids(full)
    assert old_expected not in item_ids(disabled)
    assert full['retrieval_diagnostics']['components']['bm25']['selected'] == 1
    assert disabled['retrieval_diagnostics']['components']['bm25']['matched'] == 0
    assert full['retrieval_diagnostics']['channels']['literal']['truncated'] is True
    assert 'bm25' not in disabled['retrieval_diagnostics']['channels']


@pytest.mark.parametrize('flag,query,text,component', [
    ('enable_aliases', '传输控制协议', 'TCP retransmission preserves the sequence range.', 'aliases'),
    ('enable_fuzzy', 'deadlcok', 'Deadlock detection is still unresolved.', 'fuzzy'),
])
def test_query_component_switch_is_scoped_not_a_recent_history_truncation(flag, query, text, component):
    async def build(db):
        return (await node(db, text, subject='concept:transport', age=500)).id
    full, expected = asyncio.run(exercise(build, query=query))
    disabled, _ = asyncio.run(exercise(build, query=query, component_options={flag: False}))
    assert expected in item_ids(full)
    assert disabled['items'] == []
    assert full['retrieval_diagnostics']['components'][component]['activated'] > 0
    assert disabled['retrieval_diagnostics']['components'][component]['activated'] == 0


def test_bm25_pool_does_not_observe_foreign_or_sensitive_vocabulary():
    async def build(db):
        await node(db, 'foxglove visible constraint', subject='concept:visible')
        await node(db, 'foxglove privateforeign', learner=2, project=3)
        await node(db, 'foxglove hiddenanswer', payload={'correct_answer': 'hiddenanswer'})
    packet, _ = asyncio.run(exercise(build, query='foxglove'))
    assert packet['retrieval_diagnostics']['components']['bm25']['documents'] == 1
    assert 'privateforeign' not in str(packet) and 'hiddenanswer' not in str(packet)


@pytest.mark.parametrize('field,value', [('enable_bm25', 'false'), ('enable_episodes', 1),
                                        ('max_episodes', -1), ('max_episode_facts', 0)])
def test_component_configuration_is_typed_and_bounded(field, value):
    with pytest.raises(ValueError):
        replace(CONTEXT_POLICIES['project_tutor'], **{field: value})
