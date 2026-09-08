"""Independent adversarial read-layer cases, separate from the ablation templates."""
import asyncio
from dataclasses import replace
from datetime import datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from app.db.database import Base
import app.models  # noqa: F401
from app.models.learning import (
    EvidenceEvent, KernelMutation, KernelState, Learner, MemoryClaim,
    MemoryEdge, MemoryFact, MemoryModule, MemoryNode,
)
from app.models.project import Project
from app.services.five_kernel_context import (
    CONTEXT_POLICIES, RETRIEVAL_VERSION, _token_estimate, build_five_kernel_context,
)
from app.services.architecture_registry import KERNEL_NAMES


async def exercise(build, *, query='quasar', subjects=('concept:quasar',), budget=2800, max_items=12):
    engine = create_async_engine('sqlite+aiosqlite:///:memory:')
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            db.add_all([Learner(id=i, key=f'retrieval-{i}') for i in (1, 2)])
            db.add_all([Project(id=i, learner_id=1 if i < 3 else 2, name=f'project-{i}') for i in (1, 2, 3)])
            db.add_all([KernelState(learner_id=1, kernel_name=k, short_term={}, long_term={}, version=1)
                        for k in KERNEL_NAMES])
            await db.flush()
            expected = await build(db)
            await db.flush()
            kwargs = dict(learner_id=1, project_id=1,
                          policy=replace(CONTEXT_POLICIES['project_tutor'], token_budget=budget, max_items=max_items),
                          query=query, subject_keys=subjects)
            first = await build_five_kernel_context(db, **kwargs)
            second = await build_five_kernel_context(db, **kwargs)
            assert first['snapshot_id'] == second['snapshot_id']
            assert first['manifest']['retrieval_version'] == RETRIEVAL_VERSION
            body = dict(heads=first['kernel_heads'], items=first['items'], paths=first['relation_paths'],
                        personal_concept_graph=first['personal_concept_graph'],
                        adaptation_directives=first['adaptation_directives'], teaching_guidance=first['teaching_guidance'])
            assert _token_estimate(body) == first['manifest']['token_estimate'] <= budget
            return first, expected
    finally:
        await engine.dispose()


async def node(db, text, *, kind='fact', subject='concept:quasar', kernel='knowledge',
               learner=1, project=1, status='active', age=0, salience=.5, grade='observed', payload=None):
    n = MemoryNode(learner_id=learner, project_id=project, node_type=kind, kernel_name=kernel,
                   subject_key=subject, subject_type='concept', subject_id=subject.split(':')[-1],
                   text=text, status=status, salience=salience,
                   occurred_at=datetime(2026, 1, 1) - timedelta(days=age), payload=payload or {})
    db.add(n)
    await db.flush()
    if kind == 'fact':
        e = EvidenceEvent(learner_id=learner, event_type='fixture', source='test', payload={})
        db.add(e)
        await db.flush()
        m = KernelMutation(learner_id=learner, event_id=e.id, kernel_name=kernel, patch={})
        db.add(m)
        await db.flush()
        db.add(MemoryFact(node_id=n.id, source_event_id=e.id, source_mutation_id=m.id,
                          fact_ordinal=0, predicate='attempt', evidence_grade=grade,
                          project_id=project, object_value={'statement': text}))
    return n


async def summary(db, text, facts, *, subject='concept:quasar'):
    m = await node(db, text, kind='module', subject=subject)
    c = await node(db, text, kind='claim', subject=subject)
    db.add(MemoryModule(node_id=m.id, summary=text, time_start=datetime(2025, 1, 1),
                        time_end=datetime(2026, 1, 1), input_fingerprint=f'module-{m.id}',
                        evidence_fact_ids=[f.id for f in facts]))
    await db.flush()
    db.add(MemoryClaim(node_id=c.id, module_node_id=m.id, claim_ordinal=0,
                       predicate='exposure', verification_status='self_reported'))
    for f in facts:
        db.add(MemoryEdge(learner_id=1, source_node_id=f.id, target_node_id=c.id, relation_type='SUPPORTS'))
    return m, c


def test_hot_unrelated_claim_does_not_displace_old_specific_fact():
    async def build(db):
        wanted = await node(db, 'quasar calibration needs a fresh instrument reading', age=400, salience=.05)
        await summary(db, 'gardening completed successfully', [], subject='concept:gardening')
        return wanted.id
    packet, expected = asyncio.run(exercise(build, max_items=1, budget=1800))
    assert [i['id'] for i in packet['items']] == [expected]
    assert 'gardening' not in str(packet)
    assert all(not h['summary'] for k, h in packet['kernel_heads'].items() if k != 'human')


@pytest.mark.parametrize('budget', [1800, 2300, 2800])
def test_dependency_and_history_survive_dense_summary_edges(budget):
    async def build(db):
        root = await node(db, 'quasar current return position', kernel='structure', salience=1)
        dependency = await node(db, 'Check instrument gain before proceeding', subject='concept:gain', age=400, grade='verified')
        old = await node(db, 'Earlier position, explicitly replaced', kernel='structure', status='superseded')
        for relation, a, b in [('BLOCKS', dependency, root), ('SUPERSEDES', root, old)]:
            db.add(MemoryEdge(learner_id=1, source_node_id=a.id, target_node_id=b.id, relation_type=relation))
        distractors = [await node(db, f'quasar background {i}', salience=.1) for i in range(90)]
        await summary(db, 'quasar broad background', distractors)
        return root.id, dependency.id, old.id
    packet, (root, dependency, old) = asyncio.run(exercise(build, budget=budget))
    assert root in {i['id'] for i in packet['items']}
    # A dependency must survive even if a correction path also exists.
    assert any(p['relation'] == 'BLOCKS' and p['source']['id'] == dependency for p in packet['relation_paths'])
    assert old not in {i['id'] for i in packet['items']}
    for p in packet['relation_paths']:
        for side in ('source', 'target'):
            if p[side]['id'] == dependency:
                assert p[side]['evidence_grade'] == 'verified'
                assert p[side]['source_event_id'] in packet['manifest']['evidence_ids']


def test_identical_module_claim_dedup_keeps_attempt_grades_and_times():
    async def build(db):
        a = await node(db, 'quasar attempt succeeded with a worked example', age=10, grade='observed')
        b = await node(db, 'quasar attempt succeeded without help on a new input', age=2, grade='verified')
        m, c = await summary(db, 'quasar has two recorded attempts; independence differs', [a, b])
        return a.id, b.id, m.id, c.id
    packet, (a, b, m, c) = asyncio.run(exercise(build, budget=5600))
    items = {i['id']: i for i in packet['items']}
    assert len({m, c} & items.keys()) == 1
    assert {a, b} <= items.keys()
    assert items[a]['detail']['evidence_grade'] == 'observed'
    assert items[b]['detail']['evidence_grade'] == 'verified'
    assert items[a]['occurred_at'] != items[b]['occurred_at']
    assert packet['omitted']['duplicate_summary_filtered'] == 1


def test_similar_summaries_with_different_tails_are_not_deduplicated():
    async def build(db):
        m, c = await summary(db, 'quasar ' + 'shared prefix ' * 90, [])
        m.text += 'module-specific exception'
        c.text += 'claim-specific qualification'
        return {m.id, c.id}
    packet, expected = asyncio.run(exercise(build, budget=5600))
    assert expected <= {i['id'] for i in packet['items']}


def test_rare_lexical_match_survives_more_than_240_recent_topic_records():
    async def build(db):
        target = await node(db, 'quasar spectrometer calibration failed at the ultraviolet band', age=800, salience=.05)
        for i in range(270):
            await node(db, f'quasar ordinary observation number {i}')
        return target.id
    packet, target = asyncio.run(exercise(build, query='Quasar SPECTROMETER ultraviolet', subjects=(), max_items=1))
    assert packet['items'][0]['id'] == target


def test_paths_cannot_bypass_ownership_sensitive_or_status_filters():
    async def build(db):
        root = await node(db, 'quasar return position')
        for kwargs in [dict(learner=2, project=3), dict(project=2), dict(kernel='human'),
                       dict(status='retracted'), dict(payload={'answer': 'SECRET'}),
                       dict(status='transient')]:
            secret = await node(db, 'DO_NOT_DISCLOSE', subject='concept:secret', **kwargs)
            db.add(MemoryEdge(learner_id=1, source_node_id=secret.id, target_node_id=root.id, relation_type='BLOCKS'))
        return root.id
    packet, root = asyncio.run(exercise(build))
    assert root in {i['id'] for i in packet['items']}
    assert 'DO_NOT_DISCLOSE' not in str(packet)
    assert packet['relation_paths'] == []


def test_unmatched_query_does_not_fill_packet_with_hot_background():
    async def build(db):
        await summary(db, 'gardening observation', [], subject='concept:gardening')
    packet, _ = asyncio.run(exercise(build, query='spectrometer', subjects=()))
    assert packet['items'] == []
    assert packet['relation_paths'] == []
    assert packet['omitted']['irrelevant_filtered'] > 0
