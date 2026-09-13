"""Read-side upgrades preserve the authoritative assessment and safety boundaries."""
import asyncio
from dataclasses import replace

import pytest

from app.services.five_kernel_context import CONTEXT_POLICIES
from learnflow_core.planning_guidance import compile_planning_guidance
from test_memory_episodes import native_case
from test_memory_long_tail import exercise, item_ids
from test_memory_retrieval_budget import node


def test_compact_episode_keeps_assistance_and_current_action_with_one_sourced_observation():
    full, _ = asyncio.run(native_case(budget=6500))
    compact, _ = asyncio.run(native_case(budget=6500, enable_compact_episodes=True))
    assert len(compact['learning_episodes']) == 1
    episode = compact['learning_episodes'][0]
    assert len(episode['observations']) == 1
    assert len(full['learning_episodes'][0]['observations']) > 1
    assert episode['outcome'] == full['learning_episodes'][0]['outcome']
    assert episode['task'] == full['learning_episodes'][0]['task']
    assert 'observation_limit_applied' in episode['limitations']
    assert episode['source_fact_ids'] == [episode['observations'][0]['fact_id']]
    controls = compile_planning_guidance({'practice': {'learning_episodes': [episode]}})
    assert controls['practice_feedback'] == 'supported_success'
    assert controls['decisions'][0]['mastery_inference'] is False


def test_corpus_reader_filters_ownership_answer_and_human_before_index():
    async def build(db):
        wanted = await node(db, 'quasar legitimate retrieval target', subject='concept:quasar')
        await node(db, 'quasar foreign_scope_secret', learner=2, project=3)
        await node(db, 'quasar hidden_answer_secret', payload={'correct_answer': 'hidden_answer_secret'})
        await node(db, 'quasar human_private_secret', kernel='human')
        return wanted.id
    packet, wanted = asyncio.run(exercise(build, query='quasar',
        component_options={'candidate_mode': 'corpus_bm25'}))
    assert wanted in item_ids(packet)
    assert packet['retrieval_diagnostics']['components']['corpus']['documents'] == 1
    assert not any(s in str(packet) for s in ('foreign_scope_secret', 'hidden_answer_secret', 'human_private_secret'))


@pytest.mark.parametrize('value', ['remote', '', None, 1])
def test_candidate_mode_is_closed(value):
    with pytest.raises(ValueError):
        replace(CONTEXT_POLICIES['project_tutor'], candidate_mode=value)


def test_verified_source_string_keeps_blocker_text_without_a_synthetic_prefix():
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    guide = {'kernel': 'knowledge', 'slot': 'current_blocker', 'evidence_kind': 'self_reported_gap',
             'status': 'active', 'source_event_id': 42, 'policy_version': 'teaching-guidance.v2',
             'occurred_at': (now - timedelta(minutes=1)).isoformat(), 'lifetime': 'session',
             'expires_at': (now + timedelta(hours=1)).isoformat()}
    row = {'id': 8, 'text': 'Only a serial run passed; concurrent behavior is unverified.',
           'detail': {'source_event_id': 42, 'predicate': 'short_term.knowledge_gap',
                      'source_text': {'source_kind': 'fact_object_value'}}}
    result = compile_planning_guidance({'knowledge': {'teaching_guidance': [guide],
                                        'relevant_evidence': [row]}}, now=now)
    assert result['blocker_detail'] == row['text']
    row['detail']['source_event_id'] = 99
    mismatch = compile_planning_guidance({'knowledge': {'teaching_guidance': [guide],
                                          'relevant_evidence': [row]}}, now=now)
    assert 'blocker_detail' not in mismatch
