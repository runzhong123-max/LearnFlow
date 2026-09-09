"""Black-box memory retrieval regressions, separate from benchmark templates.

All nodes are disposable fixtures. Assertions check returned evidence and
source reconstruction, not exact node IDs, scores, or accidental ranking ties.
"""
import asyncio
from dataclasses import replace
from datetime import datetime, timedelta
import hashlib

import pytest
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from app.db.database import Base
import app.models  # noqa: F401
from app.models.learning import KernelState, Learner, MemoryEdge
from app.models.project import Project
from app.services.architecture_registry import KERNEL_NAMES
from app.services.five_kernel_context import CONTEXT_POLICIES, _token_estimate, build_five_kernel_context
from test_memory_retrieval_budget import node, summary


async def exercise(build, *, query, subjects=(), budget=2800, max_items=12,
                   max_hops=2, max_paths=6, deep_kernels=None, component_options=None):
    engine = create_async_engine('sqlite+aiosqlite:///:memory:')
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            db.add_all([Learner(id=i, key=f'long-tail-{i}') for i in (1, 2)])
            db.add_all([Project(id=i, learner_id=1 if i < 3 else 2, name=f'project-{i}') for i in (1, 2, 3)])
            db.add_all([KernelState(learner_id=1, kernel_name=k, short_term={}, long_term={}, version=1)
                        for k in KERNEL_NAMES])
            await db.flush()
            expected = await build(db)
            await db.flush()
            policy_options = dict(token_budget=budget, max_items=max_items,
                                  max_paths=max_paths, max_hops=max_hops)
            policy_options.update(component_options or {})
            if deep_kernels is not None:
                policy_options['deep_kernels'] = deep_kernels
            kwargs = dict(learner_id=1, project_id=1,
                          policy=replace(CONTEXT_POLICIES['project_tutor'], **policy_options),
                          query=query, subject_keys=subjects)
            first = await build_five_kernel_context(db, **kwargs)
            second = await build_five_kernel_context(db, **kwargs)
            assert first['snapshot_id'] == second['snapshot_id']
            body = dict(heads=first['kernel_heads'], items=first['items'], paths=first['relation_paths'],
                        personal_concept_graph=first['personal_concept_graph'],
                        adaptation_directives=first['adaptation_directives'], teaching_guidance=first['teaching_guidance'],
                        learning_episodes=first['learning_episodes'], retrieval_diagnostics=first['retrieval_diagnostics'],
                        component_policy={k:v for k,v in first['manifest']['policy'].items()
                            if k.startswith('enable_') or k in ('max_episodes','max_episode_facts')})
            assert _token_estimate(body) == first['manifest']['token_estimate'] <= budget
            return first, expected
    finally:
        await engine.dispose()


def item_ids(packet):
    return {item['id'] for item in packet['items']}


def path_ids(packet):
    return {path[side]['id'] for path in packet['relation_paths'] for side in ('source', 'target')}


@pytest.mark.parametrize('query,text', [
    ('transmission control protocol', 'TCP 在丢包后重传同一个序列段。'),
    ('传输控制协议', 'TCP window accounting remains unresolved.'),
    ('schedulr', 'Scheduler queue fairness has not been independently verified.'),
    ('deadlcok', 'Deadlock detection missed the reverse acquisition order.'),
])
def test_alias_and_unique_typo_retrieve_actual_evidence(query, text):
    async def build(db):
        wanted = await node(db, text, subject='concept:transport', age=400, salience=.05)
        await node(db, 'Gardening observations are plentiful.', subject='concept:gardening', salience=1)
        return wanted.id
    packet, expected = asyncio.run(exercise(build, query=query))
    assert expected in item_ids(packet)
    assert packet['manifest']['direct_memory_evidence'] is True
    assert 'Gardening observations' not in str(packet)


@pytest.mark.parametrize('query,texts', [
    ('parzer', ['parser', 'parker']),  # Two equally close corrections: reject both.
    ('tcp2', ['tcp']),  # Version/identifier characters must not become an alias.
    ('schedxxer', ['scheduler']),  # Two edits are outside the correction contract.
    ('tcp_socket', ['tcp']),
])
def test_probe_overlap_and_ambiguous_identifiers_are_not_evidence(query, texts):
    async def build(db):
        for text in texts:
            await node(db, text, subject='concept:unrelated')
    packet, _ = asyncio.run(exercise(build, query=query))
    assert packet['items'] == []
    assert packet['relation_paths'] == []
    assert packet['manifest']['direct_memory_evidence'] is False


def test_long_original_tail_and_distant_qualification_are_reconstructable():
    qualifier = '仅单线程环境完成，并发行为未验证。'
    target = 'pulserail 在异步取消后留下句柄泄漏。'
    original = qualifier + '这一段保存过程备注和检查参数。' * 100 + target
    async def build(db):
        return (await node(db, original, subject='concept:cancellation')).id
    packet, expected = asyncio.run(exercise(build, query='pulserail', max_items=1))
    item = next(i for i in packet['items'] if i['id'] == expected)
    assert target in item['text'] and qualifier in item['text']
    assert len(item['text']) <= 640
    source = item['detail']['source_text']
    assert source['sha256'] == hashlib.sha256(original.encode('utf-8')).hexdigest()
    assert source['chars'] == len(original)
    assert source['truncated'] is True
    assert source.get('qualifier_spans_omitted', 0) == 0
    ranges = source['ranges']
    assert ranges and all(0 <= a < b <= len(original) for a, b in ranges)
    assert all(left[1] < right[0] for left, right in zip(ranges, ranges[1:]))
    assert ' … '.join(original[a:b] for a, b in ranges) == item['text']


@pytest.mark.parametrize('query,expected_names,max_items', [
    ('最初 photometry 测量记录', {'earliest'}, 1),
    ('当前 photometry 测量记录', {'current'}, 1),
    ('photometry 测量历史', {'earliest', 'current'}, 4),
])
def test_active_fact_time_diversity_survives_over_300_recent_records(query, expected_names, max_items):
    async def build(db):
        old = await node(db, 'photometry 测量日志：最初曝光标定尚未完成。',
                         subject='concept:photometry', age=800, salience=.05)
        for i in range(304):
            await node(db, f'photometry 测量日志：常规观测样本 {i}。',
                       subject='concept:photometry', age=1 + i / 10, salience=.5)
        current = await node(db, 'photometry 测量日志：当前曝光参数已独立校准。',
                             subject='concept:photometry', age=0, salience=.5, grade='verified')
        return {'earliest': old.id, 'current': current.id}
    packet, ids = asyncio.run(exercise(build, query=query, max_items=max_items))
    assert {ids[name] for name in expected_names} <= item_ids(packet)
    assert all(item['status'] == 'active' for item in packet['items'])
    if max_items == 1:
        assert len(packet['items']) == 1


def test_weak_only_query_does_not_turn_unrelated_hot_graph_into_evidence():
    async def build(db):
        first = await node(db, 'Gardening 学习记录已经存档。', subject='concept:gardening')
        other = await node(db, '陶艺学习的记录和证据。', subject='concept:pottery')
        db.add(MemoryEdge(learner_id=1, source_node_id=other.id, target_node_id=first.id, relation_type='BLOCKS'))
        await summary(db, '学习记录和证据已经汇总。', [first], subject='concept:gardening')
    packet, _ = asyncio.run(exercise(build, query='请查看我的学习记录和证据'))
    assert packet['items'] == [] and packet['relation_paths'] == []
    assert packet['manifest']['direct_memory_evidence'] is False


@pytest.mark.parametrize('query', ['heliostat 并发验证限制', '汇总 heliostat 所有记录'])
def test_summary_does_not_erase_the_original_concurrency_exception(query):
    async def build(db):
        fact = await node(db, 'heliostat 压测仅单线程通过，并发未验证。', subject='concept:heliostat')
        module, claim = await summary(db, 'heliostat 压测已完成。', [fact], subject='concept:heliostat')
        return fact.id, {module.id, claim.id}
    packet, (fact, summaries) = asyncio.run(exercise(build, query=query, budget=5600))
    assert fact in item_ids(packet)
    assert any('仅单线程通过，并发未验证' in i['text'] for i in packet['items'])
    if query.startswith('汇总'):
        assert summaries & item_ids(packet)
    assert len(summaries & item_ids(packet)) <= 1  # Same-version duplicate only.


async def dependency_chain(db):
    root = await node(db, 'heliocore 起点', kernel='structure', subject='concept:heliocore')
    near = await node(db, '接口清单需要先确认。', kernel='structure', subject='concept:interfaces')
    far = await node(db, '签字归档是先决条件。', kernel='structure', subject='concept:signoff', grade='verified')
    third = await node(db, '第三层原始凭证。', kernel='structure', subject='concept:receipts')
    for a, b, relation in [(near, root, 'BLOCKS'), (far, near, 'BLOCKS'),
                           (third, far, 'BLOCKS'), (root, near, 'ENABLES'), (near, near, 'BLOCKS')]:
        db.add(MemoryEdge(learner_id=1, source_node_id=a.id, target_node_id=b.id, relation_type=relation))
    return root.id, near.id, far.id, third.id


@pytest.mark.parametrize('max_hops', [0, 1, 2])
def test_explicit_hop_control_follows_edges_without_remote_query_words(max_hops):
    packet, (root, near, far, third) = asyncio.run(exercise(
        dependency_chain, query='heliocore', max_items=1, max_hops=max_hops, budget=5600))
    assert item_ids(packet) == {root}
    if max_hops == 0:
        assert packet['relation_paths'] == []
        return
    assert near in path_ids(packet)
    assert (far in path_ids(packet)) is (max_hops == 2)
    assert third not in path_ids(packet)
    for path in packet['relation_paths']:
        route = path['via_node_ids']
        assert path['root_anchor_id'] == root == route[0]
        assert len(route) == len(set(route)) == path['hop'] + 1
        assert 1 <= path['hop'] <= max_hops
        assert {path['source']['id'], path['target']['id']} == set(route[-2:])
    if max_hops == 2:
        remote = next(p for p in packet['relation_paths'] if far in {p['source']['id'], p['target']['id']})
        assert remote['hop'] == 2 and remote['via_node_ids'] == [root, near, far]
        assert any(p['hop'] == 1 and set(p['via_node_ids']) == {root, near} for p in packet['relation_paths'])


@pytest.mark.parametrize('budget', [1800, 2800])
def test_complete_two_hop_chain_is_fitted_inside_context_budget(budget):
    packet, (root, near, far, third) = asyncio.run(exercise(
        dependency_chain, query='heliocore', max_items=1, max_hops=2, budget=budget))
    assert {root, near, far} <= path_ids(packet)
    assert third not in path_ids(packet)
    assert packet['manifest']['token_estimate'] <= budget


def test_second_hop_reapplies_kernel_scope_status_and_sensitive_filters():
    async def build(db):
        root, near, far, third = await dependency_chain(db)
        for index, kwargs in enumerate([
            dict(kernel='human'), dict(kernel='practice'), dict(project=2), dict(learner=2, project=3),
            dict(status='retracted'), dict(payload={'answer': 'HIDDEN_EXPECTED_VALUE'}),
        ]):
            args = dict(kernel='structure', subject=f'concept:restricted-{index}')
            args.update(kwargs)
            private = await node(db, f'SECRET_SECOND_HOP_{index}', **args)
            db.add(MemoryEdge(learner_id=1, source_node_id=private.id, target_node_id=near, relation_type='BLOCKS'))
        return root, near, far, third
    packet, (_, _, far, _) = asyncio.run(exercise(
        build, query='heliocore', max_items=1, budget=5600, deep_kernels=('structure', 'knowledge')))
    assert far in path_ids(packet)
    assert 'SECRET_SECOND_HOP' not in str(packet)
    assert 'HIDDEN_EXPECTED_VALUE' not in str(packet)
    assert all(p[side]['kernel'] in {'structure', 'knowledge'} for p in packet['relation_paths'] for side in ('source', 'target'))


def test_same_relation_edge_window_preserves_old_and_recent_neighborhoods():
    async def build(db):
        root = await node(db, 'heliocore 起点', kernel='structure', subject='concept:heliocore')
        old, recent = set(), set()
        for i in range(96):
            neighbor = await node(db, f'前置审批条目 {i}。', kernel='structure', subject=f'concept:approval-{i}')
            db.add(MemoryEdge(learner_id=1, source_node_id=neighbor.id, target_node_id=root.id,
                              relation_type='BLOCKS', created_at=datetime(2024, 1, 1) + timedelta(days=i)))
            if i < 8:
                old.add(neighbor.id)
            if i >= 88:
                recent.add(neighbor.id)
        return old, recent
    packet, (old, recent) = asyncio.run(exercise(
        build, query='heliocore', max_items=1, max_hops=1, max_paths=6, budget=5600))
    assert old & path_ids(packet)
    assert recent & path_ids(packet)
    assert len(packet['relation_paths']) <= 6
    assert all(path['relation'] == 'BLOCKS' and path['hop'] == 1 for path in packet['relation_paths'])


def test_history_edges_do_not_starve_a_different_dependency_kind():
    async def build(db):
        root = await node(db, 'heliocore 当前安排', kernel='structure', subject='concept:heliocore')
        dependency = await node(db, '仪器接地需要先验证。', kernel='structure',
                                subject='concept:grounding', age=800, salience=.05)
        db.add(MemoryEdge(learner_id=1, source_node_id=dependency.id, target_node_id=root.id,
                          relation_type='BLOCKS', created_at=datetime(2020, 1, 1)))
        history = set()
        for i in range(12):
            old = await node(db, f'此前安排版本 {i}。', kernel='structure', status='superseded',
                             subject=f'concept:previous-position-{i}')
            history.add(old.id)
            db.add(MemoryEdge(learner_id=1, source_node_id=root.id, target_node_id=old.id,
                              relation_type='SUPERSEDES', created_at=datetime(2025, 1, 1) + timedelta(days=i)))
        return root.id, dependency.id, history
    packet, (root, dependency, history) = asyncio.run(exercise(
        build, query='heliocore', max_items=1, max_hops=1, max_paths=2, budget=2800))
    assert item_ids(packet) == {root}
    assert dependency in path_ids(packet)
    assert any(p['relation'] == 'BLOCKS' and p['source']['id'] == dependency
               for p in packet['relation_paths'])
    assert any(p['relation'] == 'SUPERSEDES' and p['target']['id'] in history
               for p in packet['relation_paths'])
    assert not history & item_ids(packet)
    assert len(packet['relation_paths']) <= 2


def test_five_extendable_branches_expose_the_four_branch_limit_and_omission():
    async def build(db):
        root = await node(db, 'heliocore 分支起点', kernel='structure', subject='concept:heliocore')
        near_ids, far_ids = set(), set()
        for i in range(5):
            near = await node(db, f'接口签核分组 {i}。', kernel='structure', subject=f'concept:signoff-{i}')
            far = await node(db, f'归档凭证分组 {i}。', kernel='structure', subject=f'concept:receipt-{i}')
            near_ids.add(near.id)
            far_ids.add(far.id)
            db.add_all([
                MemoryEdge(learner_id=1, source_node_id=near.id, target_node_id=root.id, relation_type='BLOCKS'),
                MemoryEdge(learner_id=1, source_node_id=far.id, target_node_id=near.id, relation_type='BLOCKS'),
            ])
        return root.id, near_ids, far_ids
    packet, (root, near_ids, far_ids) = asyncio.run(exercise(
        build, query='heliocore', max_items=1, max_hops=2, max_paths=12, budget=12000))
    graph = packet['manifest']['graph']
    assert graph['second_hop_branches_per_root'] == 4
    assert graph['second_hop_branches_omitted'] == 1
    assert graph['window_truncated'] is True
    assert near_ids <= path_ids(packet)
    assert len(far_ids & path_ids(packet)) == 4
    second = [p for p in packet['relation_paths'] if p['hop'] == 2]
    assert len({p['via_node_ids'][1] for p in second}) == 4
    assert all(p['root_anchor_id'] == root for p in second)


@pytest.mark.parametrize('invalid', [
    {'status': 'retracted'},
    {'payload': {'answer': 'HIDDEN_BRIDGE_VALUE'}},
    {'project': 2},
    {'kernel': 'practice'},
])
def test_invalid_intermediate_cannot_bridge_to_an_otherwise_allowed_far_node(invalid):
    async def build(db):
        root = await node(db, 'heliocore 起点', kernel='structure', subject='concept:heliocore')
        valid_near = await node(db, '合规接口已定位。', kernel='structure', subject='concept:valid-interface')
        valid_far = await node(db, '原始签核待取回。', kernel='structure', subject='concept:valid-signoff')
        bridge_args = dict(kernel='structure', subject='concept:invalid-bridge')
        bridge_args.update(invalid)
        bridge = await node(db, 'INVALID_BRIDGE_NOTE', **bridge_args)
        far = await node(db, 'UNREACHABLE_FAR_NOTE', kernel='structure', subject='concept:public-receipt')
        for a, b in [(valid_near, root), (valid_far, valid_near), (bridge, root), (far, bridge)]:
            db.add(MemoryEdge(learner_id=1, source_node_id=a.id, target_node_id=b.id, relation_type='BLOCKS'))
        return root.id, valid_far.id, bridge.id, far.id
    packet, (root, valid_far, bridge, far) = asyncio.run(exercise(
        build, query='heliocore', max_items=1, max_hops=2, budget=5600,
        deep_kernels=('structure', 'knowledge')))
    assert item_ids(packet) == {root}
    assert valid_far in path_ids(packet)
    assert {bridge, far}.isdisjoint(item_ids(packet) | path_ids(packet))
    assert 'INVALID_BRIDGE_NOTE' not in str(packet)
    assert 'UNREACHABLE_FAR_NOTE' not in str(packet)
    assert 'HIDDEN_BRIDGE_VALUE' not in str(packet)


@pytest.mark.parametrize('target_case', ['other_project', 'other_learner', 'sensitive', 'expired', 'excluded_kernel', 'allowed'])
def test_hidden_update_target_cannot_change_visible_source_ranking_or_reasons(target_case):
    def scenario(with_edge):
        async def build(db):
            source = await node(db, 'heliocore 当前测量结果。', kernel='structure',
                                subject='concept:source-reading', salience=.3)
            competitor = await node(db, 'heliocore 当前测量结果。', kernel='structure',
                                    subject='concept:other-reading', salience=.7)
            target_args = dict(kernel='structure', subject='concept:previous-reading', status='superseded')
            target_args.update({
                'other_project': {'project': 2},
                'other_learner': {'learner': 2, 'project': 3},
                'sensitive': {'payload': {'answer': 'HIDDEN_CORRECTION_TARGET'}},
                'excluded_kernel': {'kernel': 'practice'},
            }.get(target_case, {}))
            target = await node(db, '先前仪器读数。', **target_args)
            if target_case == 'expired':
                target.valid_to = datetime(2020, 1, 1)
            if with_edge:
                db.add(MemoryEdge(learner_id=1, source_node_id=source.id,
                                  target_node_id=target.id, relation_type='SUPERSEDES'))
            return source.id, competitor.id
        return build
    options = dict(query='heliocore', max_items=2, max_hops=0,
                   deep_kernels=('structure', 'knowledge'))
    baseline, (baseline_source, _) = asyncio.run(exercise(scenario(False), **options))
    connected, (connected_source, _) = asyncio.run(exercise(scenario(True), **options))
    before = next(i for i in baseline['items'] if i['id'] == baseline_source)['retrieval']
    after = next(i for i in connected['items'] if i['id'] == connected_source)['retrieval']
    assert 'current_correction_anchor' not in before['reasons']
    if target_case == 'allowed':
        assert 'current_correction_anchor' in after['reasons']
        assert after['score'] > before['score']
    else:
        # Compare computed source identities and returned subjects, never fixed IDs
        # or an assumed ranking order. An invisible target conveys no valid boost.
        assert after == before
        assert [i['subject']['key'] for i in connected['items']] == [i['subject']['key'] for i in baseline['items']]
        assert 'current_correction_anchor' not in after['reasons']
