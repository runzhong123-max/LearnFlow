#!/usr/bin/env python3
"""Isolated retrieval-component ablation; no LLM, network or production DB."""
from __future__ import annotations

import argparse
import asyncio
from collections import defaultdict
from contextlib import nullcontext
from dataclasses import replace
from datetime import datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

VERSION = 'learnflow-memory-ablation.v1.1'
VARIANTS = ('full', 'no_kernel_routing', 'facts_only', 'no_relations', 'no_head_cache', 'recent_facts')
NOW = datetime(2026, 9, 8, 4, 0, 0)
TOPICS = ['反向传播', '事务隔离', '递归调用', '注意力机制', '哈希冲突', '缓存一致性',
          '向量检索', '线程同步', '类型推断', '网络拥塞', '编译优化', '梯度下降']


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def visible_segments(packet):
    """Inspect actual rendered text, not evidence IDs or hidden payload annotations."""
    segments = []
    for item in packet.get('items', []):
        segments.append((item['id'], item.get('text', ''), 'item', item.get('status', 'active')))
    for head in packet.get('kernel_heads', {}).values():
        refs = list(dict.fromkeys(sum((head.get(k, []) for k in
                    ('focus_refs', 'alert_refs', 'working_refs', 'stable_refs')), [])))
        for ref in refs[:3]:
            segments.append((ref, head.get('summary', ''), 'head', 'active'))
    for path in packet.get('relation_paths', []):
        for side in ('source', 'target'):
            endpoint = path[side]
            segments.append((endpoint['id'], endpoint.get('text', ''), 'path', endpoint.get('status', 'active')))
    return segments


def score_packet(packet, case, metadata):
    """Gold semantic units have explicit supported text spans in this fixed fixture."""
    observed, historical, violations = set(), set(), set()
    for node_id, body, channel, status in visible_segments(packet):
        node = metadata.get(str(node_id))
        if not node:
            violations.add('unknown_node')
            continue
        if node['learner_id'] != case['learner_id'] or node['project_id'] not in (None, case['project_id']):
            violations.add('scope_leak')
        if node['kernel'] == 'human':
            violations.add('human_raw_leak')
        if node['sensitive']:
            violations.add('answer_leak')
        is_history = channel == 'path' and status == 'superseded' and node['status'] == 'superseded'
        if node['status'] not in ('active', 'transient', 'legacy') and not is_history:
            violations.add('inactive_as_current')
        if node.get('expires_at') and node['expires_at'] <= case['at']:
            violations.add('expired_node')
        for unit, span in node['units'].items():
            if span in body:
                (historical if is_history else observed).add(unit)
    for item in packet.get('items', []):
        node = metadata.get(str(item['id']), {})
        if node.get('node_type') == 'fact' and item.get('detail', {}).get('evidence_grade') != node.get('grade'):
            violations.add('evidence_grade_changed')
    required = set(case['required'])
    matched = observed & required
    directives = packet.get('adaptation_directives', [])
    pace = [row for row in directives if row.get('kind') == 'pace']
    adaptation_ok = None
    if case.get('adaptation') == 'slower':
        adaptation_ok = any('放慢节奏' in row.get('instruction', '') for row in pace)
    elif case.get('adaptation') == 'none':
        adaptation_ok = not pace
    return {
        'coverage': len(matched) / len(required) if required else None,
        'precision': len(matched) / len(observed) if observed and required else (0.0 if required else None),
        'complete': required <= observed if required else None,
        'required_units': sorted(required), 'hit_units': sorted(matched),
        'missed_units': sorted(required - observed), 'unexpected_units': sorted(observed - required),
        'historical_units': sorted(historical), 'observed_units': sorted(observed),
        'adaptation_ok': adaptation_ok, 'violations': sorted(violations),
        'empty_on_uncovered': not observed if case['family'] == 'uncovered' else None,
    }


async def make_fixture(path, seeds):
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    import app.models
    from app.db.database import Base
    from app.models.learning import (Learner, AgentSession, EvidenceEvent, KernelMutation,
        KernelState, MemoryNode, MemoryFact, MemoryModule, MemoryClaim, MemoryEdge)
    from app.models.project import Project
    from app.services.five_kernel_context import KERNEL_NAMES

    engine = create_async_engine(f'sqlite+aiosqlite:///{path}')
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    metadata, cases, counts = {}, [], defaultdict(int)
    async with sessions() as db:
        for index, seed in enumerate(seeds):
            rng = random.Random(seed)
            learner, project, foreign, session = index + 1, 2 * index + 1, 2 * index + 2, index + 1
            topic = TOPICS[index % len(TOPICS)]
            db.add(Learner(id=learner, key=f'ablation-{seed}', display_name=f'合成学习者 {index + 1}'))
            db.add_all([Project(id=p, learner_id=learner, name=f'隔离项目 {p}') for p in (project, foreign)])
            db.add(AgentSession(id=session, learner_id=learner, project_id=project, session_type='project'))
            for kernel in KERNEL_NAMES:
                short = {}
                if kernel == 'human':
                    short = {'pace_adjustment': 'slower', 'adaptation_source': 'explicit_current_context',
                             'adaptation_scope': {'project_id': project, 'checkpoint_id': None, 'session_id': session},
                             'transient_expires_at': (NOW + timedelta(hours=8)).isoformat()}
                db.add(KernelState(learner_id=learner, kernel_name=kernel, short_term=short,
                                   long_term={}, version=1, confidence=.7))
            await db.flush()
            ordinal = 0
            ids = {}

            def fact(key, kernel, subject, statement, *, status='active', grade='self_reported',
                     age=10, scope=None, salience=.45, padding='', sensitive=False):
                nonlocal ordinal
                ordinal += 1
                identifier = (index + 1) * 10000 + ordinal
                pid = scope if scope is not None else project
                stamp = NOW - timedelta(days=age, seconds=ordinal)
                body = statement + padding
                db.add(EvidenceEvent(id=identifier, learner_id=learner, project_id=pid,
                    session_id=session if pid == project else None, event_type='synthetic_projection_fixture',
                    source='fixture', payload={'statement': body}, provenance={'synthetic': True},
                    occurred_at=stamp, created_at=stamp, learner_seq=ordinal))
                db.add(KernelMutation(id=identifier, learner_id=learner, event_id=identifier,
                    kernel_name=kernel, patch={'fixture': True}))
                db.add(MemoryNode(id=identifier, learner_id=learner, project_id=pid,
                    session_id=session if pid == project else None, node_type='fact', kernel_name=kernel,
                    subject_key=f'topic:{subject}', subject_type='topic', subject_id=subject,
                    memory_kind='observation', text=body, status=status, salience=salience,
                    payload={'key': 'answer' if sensitive else 'observation'}, occurred_at=stamp, created_at=stamp))
                db.add(MemoryFact(node_id=identifier, source_event_id=identifier, source_mutation_id=identifier,
                    fact_ordinal=0, predicate='short_term.observation', object_value=body,
                    evidence_grade=grade, project_id=pid, session_id=session if pid == project else None))
                metadata[str(identifier)] = {'learner_id': learner, 'project_id': pid, 'kernel': kernel,
                    'node_type': 'fact', 'grade': grade, 'status': status, 'sensitive': sensitive,
                    'units': {f'{seed}:{key}': statement}}
                ids[key] = identifier
                counts['facts'] += 1
                return identifier

            def edge(left, right, relation):
                db.add(MemoryEdge(learner_id=learner, source_node_id=left, target_node_id=right,
                    relation_type=relation, created_at=NOW, origin='deterministic', confidence=1.0))
                counts['edges'] += 1

            def summary(key, kernel, subject, fact_keys):
                nonlocal ordinal
                ordinal += 1
                module_id = (index + 1) * 10000 + ordinal
                ordinal += 1
                claim_id = (index + 1) * 10000 + ordinal
                sources = [ids[k] for k in fact_keys]
                units = {unit: span for src in sources for unit, span in metadata[str(src)]['units'].items()}
                body = '；'.join(units.values())
                for identifier, kind in ((module_id, 'module'), (claim_id, 'claim')):
                    db.add(MemoryNode(id=identifier, learner_id=learner, project_id=project,
                        session_id=session, node_type=kind, kernel_name=kernel,
                        subject_key=f'topic:{subject}', subject_type='topic', subject_id=subject,
                        memory_kind='observation', text=body, status='active', salience=.5,
                        payload={}, occurred_at=NOW-timedelta(days=1), created_at=NOW-timedelta(days=1)))
                    metadata[str(identifier)] = {'learner_id': learner, 'project_id': project,
                        'kernel': kernel, 'node_type': kind, 'status': 'active', 'sensitive': False, 'units': units}
                db.add(MemoryModule(node_id=module_id, summary=body, time_start=NOW-timedelta(days=30),
                    time_end=NOW-timedelta(days=1), input_fingerprint=f'{seed}-{key}',
                    evidence_fact_ids=sources, delta_fact_ids=sources, policy_version='fixture-lossless-v1'))
                db.add(MemoryClaim(node_id=claim_id, module_node_id=module_id, claim_ordinal=0,
                    predicate='exposure_record', value={'statement': body}, verification_status='self_reported'))
                for src in sources:
                    edge(src, module_id, 'CONSOLIDATED_INTO')
                    edge(src, claim_id, 'SUPPORTS')
                counts['modules'] += 1
                counts['claims'] += 1

            fact('old', 'knowledge', f'{topic}旧问题', f'此前明确记录：{topic}的边界条件还需用反例验证。', age=90)
            fact('goal_old', 'value', f'{topic}方向', '历史方向是学术研究，后来已被新的确认取代。', status='superseded', age=40)
            fact('goal_new', 'value', f'{topic}方向', f'已确认当前目标：用{topic}完成可演示的工程作品。', age=2)
            edge(ids['goal_new'], ids['goal_old'], 'SUPERSEDES')
            bundle = []
            for j, item in enumerate(['定义', '边界', '反例', '复杂度', '实现', '调试', '验证', '迁移']):
                key = f'bundle{j}'
                bundle.append(key)
                fact(key, 'knowledge', f'{topic}复盘', f'{topic}复盘第{j+1}项：{item}需要再做一次独立检查。',
                     age=20+j, padding=' 这条原始记录还保留了当轮练习的过程、材料来源和讨论上下文。' * (6 + rng.randrange(4)))
            summary('bundle', 'knowledge', f'{topic}复盘', bundle)
            fact('bridge_root', 'structure', f'{topic}返回', f'上次学习{topic}暂停在综合应用，保留当前返回位置。', age=20)
            fact('bridge_neighbor', 'knowledge', '局部验证', '继续前需要先验证输入维度的对应关系。', age=70, salience=.1)
            edge(ids['bridge_neighbor'], ids['bridge_root'], 'BLOCKS')
            fact('practice_k', 'knowledge', f'{topic}实践', f'{topic}实践中仍需验证异常分支的判断依据。', grade='verified', age=15)
            fact('practice_p', 'practice', f'{topic}实践', f'{topic}实践的正式提交在无提示条件下通过了边界用例。', grade='verified', age=14)
            fact('design_k', 'knowledge', f'{topic}讲解', f'设计{topic}讲解时应先处理学习者明确提出的术语缺口。', age=13)
            fact('design_s', 'structure', f'{topic}讲解', f'{topic}讲解的下一步是连接到已选定的基础章节。', age=12)
            fact('assisted', 'practice', f'{topic}辅助', f'{topic}第一次尝试有步骤提示，结果只说明受助完成。', grade='observed', age=8)
            fact('independent', 'practice', f'{topic}辅助', f'{topic}第二次是不同输入的无提示验证，记录独立成功。', grade='verified', age=7)
            fact('scope', 'structure', f'{topic}项目', f'当前项目的{topic}下一步是完成最小演示。', age=4)
            fact('withdrawn', 'knowledge', f'{topic}纠正', '已经撤回的旧记录：该概念可以忽略边界条件。', status='retracted', age=25)
            fact('correction', 'knowledge', f'{topic}纠正', f'最新纠正：{topic}必须明确检查边界条件。', grade='corrected', age=3)
            fact('human_private', 'human', f'{topic}支持', '仅供隔离测试的人因原话，不能进入深读上下文。', age=1, salience=.9)
            fact('hidden_answer', 'knowledge', f'{topic}实践', '仅供隔离测试的隐藏答案，不可向 Tutor 展示。', sensitive=True, age=1, salience=1)
            for j in range(14):
                kernel = ('structure', 'value')[j % 2]
                fact(f'collision_p{j}', kernel, f'{topic}实践', f'{topic}实践相关背景{j+1}：记录导航或兴趣，未提供提交结果。',
                     age=.2+rng.random(), salience=.55+rng.random()*.2)
                fact(f'collision_d{j}', 'practice', f'{topic}讲解', f'{topic}讲解相关运行{j+1}：保存了另一次工具操作的过程。',
                     age=.2+rng.random(), salience=.55+rng.random()*.2)
            for j in range(55 + rng.randrange(20)):
                kernel = ('structure', 'knowledge', 'value', 'practice')[j % 4]
                fact(f'local{j}', kernel, f'其他学习单元{j}', f'同项目其他记录{j+1}：完成资料整理并标记待讨论问题。',
                     age=rng.random(), salience=.3+rng.random()*.4)
            for j in range(270 + rng.randrange(40)):
                fact(f'foreign{j}', ('knowledge', 'practice')[j % 2], f'{topic}项目',
                     f'其他项目的{topic}计划{j+1}，与当前项目没有任务关系。', age=rng.random(), scope=foreign, salience=.9)
            fact('recent', 'structure', f'{topic}当前', f'刚刚确认：下一次从{topic}的小规模实验继续。', age=.001)
            await db.flush()

            def case(family, query, keys, *, policy='project_tutor', subject=None, hour=0, adaptation=None):
                cases.append({'id': f'{seed}-{family}', 'trajectory': seed, 'family': family,
                    'learner_id': learner, 'project_id': project, 'session_id': session,
                    'query': query, 'subject_keys': [f'topic:{subject}'] if subject else [], 'policy': policy,
                    'required': [f'{seed}:{key}' for key in keys],
                    'at': (NOW+timedelta(hours=hour)).isoformat(), 'adaptation': adaptation})
            case('old_anchor', f'上次学{topic}时有什么还没验证？', ['old'], subject=f'{topic}旧问题')
            case('corrected_goal', f'现在围绕{topic}确认的目标是什么？', ['goal_new'], subject=f'{topic}方向')
            case('summary_bundle', f'请恢复{topic}复盘的八项待验证内容。', bundle, subject=f'{topic}复盘')
            case('dependency_bridge', f'从{topic}的暂停位置回来，还需要先处理什么？', ['bridge_root','bridge_neighbor'], subject=f'{topic}返回')
            case('practice_routing', f'核对{topic}实践的知识缺口与独立提交证据。', ['practice_k','practice_p'], policy='practice_validation', subject=f'{topic}实践')
            case('design_routing', f'准备{topic}讲解时，应该解释什么并连接到哪里？', ['design_k','design_s'], policy='learning_design', subject=f'{topic}讲解')
            case('assistance', f'{topic}的两次完成分别获得了多少帮助？', ['assisted','independent'], policy='practice_validation', subject=f'{topic}辅助')
            case('scope', f'我当前项目里{topic}的下一步是什么？', ['scope'], subject=f'{topic}项目')
            case('human_current', '现在应该使用什么节奏支持我？', [], adaptation='slower')
            case('human_expired', '过去的临时节奏要求是否还有效？', [], hour=10, adaptation='none')
            case('withdrawal', f'{topic}原来的说法撤回后最新纠正是什么？', ['correction'], subject=f'{topic}纠正')
            case('uncovered', '我此前对星际航行推进器留下了什么学习证据？', [], subject='星际航行推进器')
            case('recent_control', f'刚才确定从{topic}哪里继续？', ['recent'], subject=f'{topic}当前')
            case('mixed_control', f'从{topic}当前实验继续时，应同时记住之前的哪个待验证问题？', ['old','recent'])
            cases[-1]['subject_keys'] = [f'topic:{topic}旧问题', f'topic:{topic}当前']
        await db.commit()
    await engine.dispose()
    return {'seeds': seeds, 'cases': cases, 'nodes': metadata, 'counts': dict(counts)}


async def prepare_variant(path, variant, fixture, runtime):
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    engine = create_async_engine(f'sqlite+aiosqlite:///{path}')
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as db:
        if variant in ('facts_only', 'recent_facts'):
            await db.execute(text('DELETE FROM memory_claims'))
            await db.execute(text('DELETE FROM memory_modules'))
            await db.execute(text("DELETE FROM memory_nodes WHERE node_type != 'fact'"))
        if variant == 'recent_facts':
            await db.execute(text('''DELETE FROM memory_nodes WHERE id NOT IN (
              SELECT id FROM (SELECT id, ROW_NUMBER() OVER (
              PARTITION BY learner_id, project_id ORDER BY occurred_at DESC, id DESC) AS rn
              FROM memory_nodes WHERE status IN ('active', 'transient', 'legacy')) WHERE rn <= 24)'''))
            await db.execute(text('DELETE FROM memory_facts WHERE node_id NOT IN (SELECT id FROM memory_nodes)'))
        await db.execute(text('''DELETE FROM memory_edges WHERE source_node_id NOT IN
            (SELECT id FROM memory_nodes) OR target_node_id NOT IN (SELECT id FROM memory_nodes)'''))
        # Derived caches are warmed once per variant; measured queries roll back refreshes.
        for learner in range(1, len(fixture['seeds'])+1):
            await runtime.ensure_kernel_heads(db, learner)
        await db.commit()
    return engine, sessions


async def run_queries(base, fixture, output, repetitions, budgets, runtime):
    from sqlalchemy import text
    results, snapshots, pairs = [], {}, {}
    Frozen = type('FrozenDatetime', (datetime,), {'utcnow': classmethod(lambda cls: NOW)})
    runtime.datetime = Frozen
    async def uncached(db, learner_id):
        return [await runtime.refresh_kernel_head(db, learner_id, name) for name in runtime.KERNEL_NAMES]
    try:
        for variant in VARIANTS:
            path = base.with_name(f'{variant}.db')
            shutil.copyfile(base, path)
            pairs[variant] = await prepare_variant(path, variant, fixture, runtime)
        jobs = [(case, budget, variant) for case in fixture['cases'] for budget in budgets for variant in VARIANTS]
        random.Random(20260908).shuffle(jobs)
        with (output/'queries.jsonl').open('w') as stream:
            for counter, (case, budget, variant) in enumerate(jobs, 1):
                at = datetime.fromisoformat(case['at'])
                Frozen.utcnow = classmethod(lambda cls, value=at: value)
                policy = replace(runtime.CONTEXT_POLICIES[case['policy']], token_budget=budget)
                if variant == 'no_kernel_routing':
                    policy = replace(policy, deep_kernels=runtime.KERNEL_NAMES)
                if variant == 'no_relations':
                    policy = replace(policy, max_paths=0)
                timings, packet, fingerprints = [], None, []
                manager = patch.object(runtime, 'ensure_kernel_heads', uncached) if variant == 'no_head_cache' else nullcontext()
                with manager:
                    for _ in range(repetitions):
                        async with pairs[variant][1]() as db:
                            start = time.perf_counter()
                            packet = await runtime.build_five_kernel_context(db,
                                learner_id=case['learner_id'], policy=policy, project_id=case['project_id'],
                                session_id=case['session_id'], query=case['query'], subject_keys=case['subject_keys'])
                            timings.append((time.perf_counter()-start)*1000)
                            scored = score_packet(packet, case, fixture['nodes'])
                            fingerprints.append(json.dumps({'score': scored, 'segments': visible_segments(packet)}, sort_keys=True, ensure_ascii=False))
                            await db.rollback()
                scored = score_packet(packet, case, fixture['nodes'])
                row = {'case_id': case['id'], 'trajectory': case['trajectory'], 'family': case['family'],
                    'variant': variant, 'budget': budget, 'policy': case['policy'], **scored,
                    'latency_ms': timings, 'tokens_estimate': packet['manifest']['token_estimate'],
                    'item_count': len(packet['items']), 'path_count': len(packet['relation_paths']),
                    'budget_ok': packet['manifest']['token_estimate'] <= budget,
                    'repeat_stable': len(set(fingerprints)) == 1,
                    'selected_ids': [v['id'] for v in packet['items']]}
                results.append(row)
                stream.write(json.dumps(row, ensure_ascii=False)+'\n')
                if case['trajectory'] == fixture['seeds'][0]:
                    snapshots[f"{case['id']}:{budget}:{variant}"] = packet
                if counter % 100 == 0:
                    print(f'progress {counter}/{len(jobs)} query conditions', flush=True)
    finally:
        runtime.datetime = datetime
        for engine, _ in pairs.values():
            await engine.dispose()
    (output/'packets-audit.json').write_text(json.dumps(snapshots, ensure_ascii=False, indent=2))
    return results


def percentile(values, fraction):
    values = sorted(values)
    return values[round((len(values)-1)*fraction)] if values else None


def aggregate(results):
    grouped = defaultdict(list)
    for row in results:
        grouped[(row['budget'], row['variant'])].append(row)
    summary = []
    for (budget, variant), rows in sorted(grouped.items()):
        def mean(key):
            values = [row[key] for row in rows if row[key] is not None]
            return statistics.mean(values) if values else None
        latency = [item for row in rows for item in row['latency_ms']]
        summary.append({'budget': budget, 'variant': variant, 'queries': len(rows),
            'coverage': mean('coverage'), 'precision': mean('precision'), 'complete': mean('complete'),
            'adaptation_accuracy': mean('adaptation_ok'), 'empty_on_uncovered': mean('empty_on_uncovered'),
            'tokens_mean': mean('tokens_estimate'), 'latency_median_ms': statistics.median(latency),
            'latency_p95_ms': percentile(latency,.95), 'violation_queries': sum(bool(row['violations']) for row in rows),
            'budget_failures': sum(not row['budget_ok'] for row in rows),
            'unstable_queries': sum(not row['repeat_stable'] for row in rows)})
    deltas = []
    for budget in sorted({row['budget'] for row in results}):
        for variant in VARIANTS[1:]:
            for metric in ('coverage', 'precision', 'tokens_estimate'):
                per = defaultdict(list)
                base = {row['case_id']: row for row in results if row['budget']==budget and row['variant']=='full'}
                for row in results:
                    if row['budget']!=budget or row['variant']!=variant or row[metric] is None:
                        continue
                    per[row['trajectory']].append(row[metric]-base[row['case_id']][metric])
                values = [statistics.mean(items) for items in per.values()]
                rng = random.Random(12345)
                draws = [statistics.mean(rng.choices(values, k=len(values))) for _ in range(2000)]
                deltas.append({'budget':budget,'variant':variant,'metric':metric,
                    'paired_delta_vs_full':statistics.mean(values), 'synthetic_bootstrap_95':[percentile(draws,.025),percentile(draws,.975)],
                    'trajectory_count':len(values)})
    return summary, deltas


def run(args):
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if (output/'summary.json').exists():
        raise ValueError('Choose a fresh output directory; existing results are immutable.')
    host = args.host.resolve()
    sys.path.insert(0, str(host))
    source = args.repo.resolve()/'packages/learning-core/src/learnflow_core/five_kernel_context.py'
    seeds = [101,102] if args.pilot else list(range(1001,1001+args.trajectories))
    attempted_network, opened_db = [], set()
    with tempfile.TemporaryDirectory(prefix='learnflow-component-ablation-') as tmp:
        root = Path(tmp).resolve()
        previous = {key:os.environ.get(key) for key in ('DATABASE_URL','LLM_API_KEY','MEMORY_AUTO_SYNTHESIS_ENABLED')}
        os.environ.update(DATABASE_URL=f'sqlite+aiosqlite:///{root}/configured.db', LLM_API_KEY='', MEMORY_AUTO_SYNTHESIS_ENABLED='false')
        guard_active = [True]
        def audit(event, values):
            if not guard_active[0]:
                return
            if event == 'socket.connect':
                attempted_network.append(str(values[1]))
                raise RuntimeError('Network disabled for this offline experiment')
            if event == 'sqlite3.connect':
                name = str(values[0])
                if name != ':memory:':
                    resolved = Path(name).resolve()
                    if not resolved.is_relative_to(root):
                        raise RuntimeError('SQLite access outside disposable experiment directory')
                    opened_db.add(resolved.name)
        sys.addaudithook(audit)
        try:
            from app.services import five_kernel_context as runtime
            hashes = {'runtime':digest(source), 'harness':digest(__file__), 'protocol':digest(Path(__file__).with_name('PROTOCOL.md')),
                      'host_models':digest(host/'app/models/learning.py')}
            async def execute():
                fixture = await make_fixture(root/'base.db', seeds)
                (output/'fixture-and-gold.json').write_text(json.dumps(fixture,ensure_ascii=False,indent=2))
                results = await run_queries(root/'base.db',fixture,output,args.repetitions,args.budgets,runtime)
                return fixture, results
            fixture, results = asyncio.run(execute())
            if digest(source)!=hashes['runtime'] or digest(host/'app/models/learning.py')!=hashes['host_models']:
                raise RuntimeError('Production source changed during run; do not interpret results')
            summary, deltas = aggregate(results)
            report = {'version':VERSION,'kind':'synthetic_retrieval_component_ablation_not_learning_gain',
                'host':str(host),'python':sys.version,'code_commit':subprocess.check_output(['git','-C',str(args.repo),'rev-parse','HEAD'],text=True).strip(),
                'source_hashes':hashes,'fixture_sha256':digest(output/'fixture-and-gold.json'),
                'pilot':args.pilot,'seeds':seeds,'families':sorted({r['family'] for r in results}),
                'cases':len(fixture['cases']),'conditions':list(VARIANTS),'budgets':args.budgets,'repetitions':args.repetitions,
                'retrieval_calls':len(results)*args.repetitions,'fixture_counts':fixture['counts'],
                'network_attempts':attempted_network,'sqlite_files_opened':sorted(opened_db),
                'summary':summary,'paired_deltas':deltas}
            (output/'summary.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
            import csv
            with (output/'summary.csv').open('w',newline='') as stream:
                writer=csv.DictWriter(stream,fieldnames=list(summary[0]));writer.writeheader();writer.writerows(summary)
            print(json.dumps({'completed':str(output),'cases':len(fixture['cases']),'retrieval_calls':report['retrieval_calls'],
                'fixture_counts':fixture['counts'],'network_attempts':len(attempted_network)},ensure_ascii=False),flush=True)
        finally:
            guard_active[0]=False
            for key,value in previous.items():
                if value is None:os.environ.pop(key,None)
                else:os.environ[key]=value


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[3])
    parser.add_argument('--host',type=Path,default=Path(__file__).resolve().parents[3]/'backend')
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--trajectories',type=int,default=12)
    parser.add_argument('--repetitions',type=int,default=3)
    parser.add_argument('--budgets',type=int,nargs='+',default=[2800,5600])
    parser.add_argument('--pilot',action='store_true')
    args=parser.parse_args()
    if not 1 <= args.trajectories <= 12 or not 1 <= args.repetitions <= 10 or min(args.budgets)<1000:
        parser.error('trajectories 1..12, repetitions 1..10, budgets >=1000')
    run(args)
