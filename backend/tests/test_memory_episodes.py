"""Native-entry episodes and adversarial read projection boundaries.

Corruptions below deliberately model invalid stored links in disposable DBs;
they are not an alternative production writer or evidence-formation benchmark.
"""
import asyncio
from dataclasses import replace
from datetime import datetime, timedelta
import hashlib
import json
import math
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.database import Base
import app.models  # noqa: F401
from app.models.learning import AgentSession, EvidenceEvent, KernelMutation, Learner, LearningAttempt, MemoryArchive, MemoryFact, MemoryNode
from app.models.project import Checkpoint, ConceptQuestion, Project, Roadmap
from app.services.five_kernel_context import CONTEXT_POLICIES, build_five_kernel_context
from learnflow_core.api.phase3 import submit_concept


def independent_budget(packet):
    values = dict(heads=packet['kernel_heads'], items=packet['items'], paths=packet['relation_paths'],
                  personal_concept_graph=packet['personal_concept_graph'],
                  adaptation_directives=packet['adaptation_directives'], teaching_guidance=packet['teaching_guidance'],
                  learning_episodes=packet['learning_episodes'], retrieval_diagnostics=packet['retrieval_diagnostics'],
                  component_policy={k: v for k, v in packet['manifest']['policy'].items()
                                    if k.startswith('enable_') or k in ('max_episodes', 'max_episode_facts')})
    return max(1, math.ceil(len(json.dumps(values, ensure_ascii=False, sort_keys=True, default=str)) / 3.2))


async def native_case(change=None, *, assistance='guided', budget=6500, compare_episode_off=False, **options):
    engine = create_async_engine('sqlite+aiosqlite:///:memory:')
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            learner = Learner(key='episode-native')
            other = Learner(key='episode-other')
            db.add_all([learner, other])
            await db.flush()
            project = Project(learner_id=learner.id, name='Calibration')
            db.add(project)
            await db.flush()
            roadmap = Roadmap(project_id=project.id)
            db.add(roadmap)
            await db.flush()
            checkpoint = Checkpoint(roadmap_id=roadmap.id, title='Calibration', order=1)
            db.add(checkpoint)
            await db.flush()
            question = ConceptQuestion(checkpoint_id=checkpoint.id, question='Explain quasar calibration limits.',
                options=['sealed_correct_candidate', 'sealed_wrong_candidate'], answer_indexes=[0],
                explanation='sealed_teacher_explanation', q_type='single', order=1)
            db.add(question)
            await db.flush()
            result = await submit_concept(checkpoint.id, question.id,
                data={'answer_indexes': [0], 'assistance_level': assistance, 'client_submission_id': 'native-episode'},
                current=SimpleNamespace(learner=learner), db=db)
            attempt = await db.get(LearningAttempt, result['attempt_id'])
            event = (await db.execute(select(EvidenceEvent).where(
                EvidenceEvent.event_type == 'concept_attempt_evaluated'))).scalar_one()
            context = SimpleNamespace(learner=learner, other=other, project=project, checkpoint=checkpoint,
                                      question=question, attempt=attempt, event=event)
            if change:
                await change(db, context)
                await db.flush()
            policy = replace(CONTEXT_POLICIES['project_tutor'], token_budget=budget, **options)
            packet = await build_five_kernel_context(db, learner_id=learner.id, project_id=project.id,
                checkpoint_id=checkpoint.id, policy=policy, query='quasar calibration')
            assert independent_budget(packet) == packet['manifest']['token_estimate'] <= budget
            if compare_episode_off:
                context.disabled_packet = await build_five_kernel_context(db, learner_id=learner.id,
                    project_id=project.id, checkpoint_id=checkpoint.id,
                    policy=replace(policy, enable_episodes=False), query='quasar calibration')
            return packet, context
    finally:
        await engine.dispose()


def test_native_assisted_episode_has_checked_chain_and_no_grader_answers():
    packet, context = asyncio.run(native_case())
    assert len(packet['learning_episodes']) == 1
    episode = packet['learning_episodes'][0]
    assert episode['schema_version'] == 'learnflow.learning-episode.v1'
    assert episode['attempt_id'] == context.attempt.id
    assert episode['outcome'] == {'correct': True, 'assistance_level': 'guided', 'independent': False}
    assert episode['task']['canonical_item_id'] is None
    assert episode['task']['attempt_kind'] == 'original'
    assert episode['scope']['session_id'] is None
    assert episode['occurred_at'] == context.event.occurred_at.isoformat()
    assert episode['source_event_ids'] == [context.event.id]
    assert 'source_session_unavailable' in episode['limitations']
    assert episode['observations']
    assert all(o['kernel'] != 'human' and o['source_event_id'] == context.event.id for o in episode['observations'])
    assert set(episode['source_fact_ids']) == {o['fact_id'] for o in episode['observations']}
    for secret in ('sealed_correct_candidate', 'sealed_wrong_candidate', 'sealed_teacher_explanation'):
        assert secret not in json.dumps(packet)


def test_missing_independence_and_assistance_stay_unknown():
    async def change(db, c):
        c.event.payload = {k: v for k, v in c.event.payload.items() if k not in ('independent', 'assistance_level')}
    packet, _ = asyncio.run(native_case(change, assistance='none'))
    episode = packet['learning_episodes'][0]
    assert episode['outcome']['independent'] is None
    assert episode['outcome']['assistance_level'] is None
    assert {'independence_not_recorded', 'assistance_not_recorded'} <= set(episode['limitations'])


@pytest.mark.parametrize('corruption,reason', [
    ('event_item', 'attempt_item_mismatch'), ('attempt_item', 'attempt_item_mismatch'),
    ('event_project', 'attempt_scope_mismatch'), ('attempt_learner', 'untrusted_attempt_link'),
    ('event_source', 'untrusted_attempt_link'), ('receipt', 'unbound_assessment_receipt'),
    ('result', 'attempt_outcome_mismatch'), ('assistance', 'attempt_assistance_mismatch'),
    ('independent', 'contradictory_independence'), ('unevaluated', 'attempt_not_evaluated'),
    ('deleted_project', 'attempt_scope_mismatch'), ('archived_checkpoint', 'attempt_scope_mismatch'),
])
def test_forged_association_or_unevaluated_attempt_cannot_form_episode(corruption, reason):
    async def change(db, c):
        p = dict(c.event.payload)
        if corruption == 'event_item': p['item_id'] = c.question.id + 1000
        elif corruption == 'attempt_item': c.attempt.item_id += 1000
        elif corruption == 'event_project': c.event.project_id = None
        elif corruption == 'attempt_learner': c.attempt.learner_id = c.other.id
        elif corruption == 'event_source': c.event.source = 'untrusted_adapter'
        elif corruption == 'receipt': c.event.client_event_id = 'forged-receipt'
        elif corruption == 'result': c.attempt.result = {'correct': False}
        elif corruption == 'assistance': p['assistance_level'] = 'none'
        elif corruption == 'independent': p['independent'] = True
        elif corruption == 'unevaluated': c.attempt.status = 'started'; c.attempt.evaluated_at = None
        elif corruption == 'deleted_project': c.project.visibility = 'deleted'
        elif corruption == 'archived_checkpoint': c.checkpoint.archived = True
        c.event.payload = p
    packet, _ = asyncio.run(native_case(change))
    assert packet['learning_episodes'] == []
    assert packet['retrieval_diagnostics']['episodes']['rejected'][reason] >= 1


def test_no_neighbor_id_association_for_unrelated_fact():
    async def change(db, c):
        db.add(MemoryNode(learner_id=c.learner.id, project_id=c.project.id, checkpoint_id=c.checkpoint.id,
            node_type='fact', kernel_name='knowledge', subject_key='concept:quasar',
            text='nearby_unlinked_fact quasar calibration', payload={}, status='active'))
    packet, _ = asyncio.run(native_case(change))
    assert 'nearby_unlinked_fact' not in json.dumps(packet['learning_episodes'])


@pytest.mark.parametrize('corruption', ['mutation', 'scope', 'human', 'answer', 'answer_tail', 'expired', 'future', 'archived', 'archive_path'])
def test_episode_every_member_reapplies_chain_scope_answer_and_visibility_filters(corruption):
    async def change(db, c):
        # Corrupt every otherwise legitimate sibling, so no hidden member can
        # be reintroduced through a still-valid same-attempt neighbor.
        links = list((await db.execute(select(MemoryNode, MemoryFact).join(MemoryFact)
            .where(MemoryFact.source_event_id == c.event.id))).all())
        for node, fact in links:
            if corruption == 'mutation':
                mutation = await db.get(KernelMutation, fact.source_mutation_id)
                mutation.status = 'rejected'
            elif corruption == 'scope': fact.session_id = 909090
            elif corruption == 'human': node.kernel_name = 'human'
            elif corruption == 'answer':
                fact.object_value = {'nested': {'correct_answer': 'sealed_hidden_answer'}}
                node.text = 'quasar calibration sealed_hidden_answer'
            elif corruption == 'answer_tail':
                fact.object_value = {'nested': [{}] * 24 + [{'hidden_answer': 'sealed_hidden_answer'}]}
                node.text = 'quasar calibration sealed_hidden_answer'
            elif corruption == 'expired': node.valid_to = datetime.utcnow() - timedelta(days=1)
            elif corruption == 'future': node.valid_from = datetime.utcnow() + timedelta(days=1)
            elif corruption == 'archived': node.status = 'archived'
            elif corruption == 'archive_path':
                node.payload = {**(node.payload or {}), 'key': 'archived_episode', 'scope': 'short_term'}
        if corruption == 'archive_path':
            for kernel in {node.kernel_name for node, _ in links}:
                db.add(MemoryArchive(learner_id=c.learner.id, kernel_name=kernel,
                    memory_scope='short_term', memory_key='archived_episode', status='archived'))
    packet, _ = asyncio.run(native_case(change))
    assert packet['learning_episodes'] == []
    assert 'sealed_hidden_answer' not in json.dumps(packet)


@pytest.mark.parametrize('foreign', [False, True])
def test_real_event_session_ownership_is_validated_and_global_session_is_allowed(foreign):
    async def change(db, c):
        session = AgentSession(learner_id=c.other.id if foreign else c.learner.id, session_type='global')
        db.add(session)
        await db.flush()
        c.event.session_id = session.id
        for node, fact in (await db.execute(select(MemoryNode, MemoryFact).join(MemoryFact)
                .where(MemoryFact.source_event_id == c.event.id))).all():
            node.session_id = fact.session_id = session.id
    packet, c = asyncio.run(native_case(change))
    if foreign:
        assert packet['learning_episodes'] == []
        assert packet['retrieval_diagnostics']['episodes']['rejected']['event_session_mismatch'] > 0
    else:
        assert packet['learning_episodes'][0]['scope']['session_id'] == c.event.session_id


def test_episode_preserves_long_fact_qualifiers_or_declares_omission():
    originals = {}
    async def change(db, c):
        nodes = list((await db.execute(select(MemoryNode).join(MemoryFact)
            .where(MemoryFact.source_event_id == c.event.id, MemoryNode.kernel_name == 'knowledge'))).scalars())
        for node in nodes:
            node.text = '仅在受助条件下通过，不能推断独立掌握。' + '过程记录。' * 120 + 'quasar calibration尚未完成迁移验证。'
            originals[node.id] = node.text
    packet, _ = asyncio.run(native_case(change, max_episode_facts=2))
    episode = packet['learning_episodes'][0]
    assert packet['retrieval_diagnostics']['episodes']['fact_window_truncated'] is True
    assert 'source_candidate_window_truncated' in episode['limitations']
    for observation in episode['observations']:
        if observation['fact_id'] not in originals:
            continue
        original = originals[observation['fact_id']]
        source = observation['source_text']
        assert source['sha256'] == hashlib.sha256(original.encode()).hexdigest()
        assert ' … '.join(original[a:b] for a, b in source['ranges']) == observation['text']
        assert ('仅在受助条件下通过' in observation['text'] or source.get('qualifier_spans_omitted', 0) > 0)


def test_episode_component_off_does_not_delete_other_controls_or_source_facts():
    full, context = asyncio.run(native_case(compare_episode_off=True))
    disabled = context.disabled_packet
    assert full['learning_episodes'] and not disabled['learning_episodes']
    assert disabled['items']
    assert full['teaching_guidance'] == disabled['teaching_guidance']
    assert disabled['retrieval_diagnostics']['episodes']['enabled'] is False


@pytest.mark.parametrize('budget', [1800, 2400, 3200])
def test_episode_and_new_metadata_share_real_packet_budget(budget):
    packet, _ = asyncio.run(native_case(budget=budget))
    assert independent_budget(packet) <= budget
    for episode in packet['learning_episodes']:
        assert episode['outcome']['independent'] is False
        assert episode['source_fact_ids'] and episode['observations'] and episode['limitations']
    stats = packet['retrieval_diagnostics']['episodes']
    assert stats['selected'] + stats['budget_omitted'] + stats['limit_omitted'] == stats['eligible']
