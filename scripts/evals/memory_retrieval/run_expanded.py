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

import run_ablation as v1
from expanded_fixture import make_fixture
VERSION = 'learnflow-memory-ablation.v2.0'
VARIANTS = v1.VARIANTS
NOW = v1.NOW
digest = v1.digest
visible_segments = v1.visible_segments
prepare_variant = v1.prepare_variant
percentile = v1.percentile


def score_packet(packet, case, metadata):
    result = v1.score_packet(packet, case, metadata)
    violations = set(result['violations'])
    serialized = json.dumps(packet, ensure_ascii=False)
    if any(span in serialized for span in case.get('forbidden', [])):
        violations.add('forbidden_content_anywhere')
    for node_id, body, channel, status in visible_segments(packet):
        node = metadata.get(str(node_id), {})
        if case.get('checkpoint_id') and node.get('checkpoint_id') not in (None, case['checkpoint_id']):
            violations.add('checkpoint_leak')
    result['violations'] = sorted(violations)
    if case['family'].startswith('uncovered'):
        result['empty_on_uncovered'] = not result['observed_units']
    # Evidence credit remains limited to attributed original text in items/heads/paths.
    # Attachments are separately audited, not silently treated as attributed evidence.
    return result


def aggregate(results):
    def group(keys):
        groups = defaultdict(list)
        for r in results:
            groups[tuple(r[k] for k in keys)].append(r)
        out = []
        for values, rows in sorted(groups.items()):
            result = dict(zip(keys, values))
            result['queries'] = len(rows)
            for key in ('coverage', 'precision', 'complete', 'adaptation_ok', 'empty_on_uncovered', 'tokens_estimate'):
                valid = [r[key] for r in rows if r[key] is not None]
                result[key] = statistics.mean(valid) if valid else None
                result[key+'_denominator'] = len(valid)
            timing = [t for r in rows for t in r['latency_ms']]
            result.update(latency_median_ms=statistics.median(timing), latency_p95_ms=percentile(timing,.95),
                violation_queries=sum(bool(r['violations']) for r in rows),
                budget_failures=sum(not r['budget_ok'] for r in rows),
                unstable_queries=sum(not r['repeat_stable'] for r in rows))
            out.append(result)
        return out
    return group(('budget','variant')), {
        'by_family':group(('budget','variant','family')),
        'by_cohort':group(('budget','variant','cohort')),
        'by_history':group(('budget','variant','history_size'))}


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
        with (output/'queries.jsonl').open('w') as stream, (output/'packets.jsonl').open('w') as packets:
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
                                session_id=case['session_id'], checkpoint_id=case.get('checkpoint_id'), query=case['query'], subject_keys=case['subject_keys'])
                            timings.append((time.perf_counter()-start)*1000)
                            scored = score_packet(packet, case, fixture['nodes'])
                            fingerprints.append(json.dumps(packet, sort_keys=True, ensure_ascii=False))
                            packets.write(json.dumps({'case_id':case['id'], 'budget':budget, 'variant':variant, 'repetition':_, 'packet':packet},ensure_ascii=False)+'\n')
                            await db.rollback()
                scored = score_packet(packet, case, fixture['nodes'])
                row = {'case_id': case['id'], 'trajectory': case['trajectory'], 'family': case['family'],
                    'variant': variant, 'budget': budget, 'policy': case['policy'], 'cohort':case['cohort'], 'history_size':case['history_size'], **scored,
                    'latency_ms': timings, 'tokens_estimate': packet['manifest']['token_estimate'],
                    'item_count': len(packet['items']), 'path_count': len(packet['relation_paths']),
                    'budget_ok': packet['manifest']['token_estimate'] <= budget,
                    'repeat_stable': len(set(fingerprints)) == 1,
                    'selected_ids': [v['id'] for v in packet['items']]}
                results.append(row)
                stream.write(json.dumps(row, ensure_ascii=False)+'\n')
                if counter % 100 == 0:
                    print(f'progress {counter}/{len(jobs)} query conditions', flush=True)
    finally:
        runtime.datetime = datetime
        for engine, _ in pairs.values():
            await engine.dispose()
    return results


def run(args):
    global VARIANTS
    if args.full_only: VARIANTS = ('full',)
    started = datetime.utcnow().isoformat()+'Z'
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError('Choose a fresh output directory; existing results are immutable.')
    host = args.host.resolve()
    sys.path.insert(0, str(host))
    sys.path.insert(0, str(args.repo.resolve()/'packages/learning-core/src'))
    source = args.repo.resolve()/'packages/learning-core/src/learnflow_core/five_kernel_context.py'
    seeds = [101,102] if args.pilot else list(range(2001,2001+args.trajectories))
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
            hashes = {'runtime':digest(source), 'harness':digest(__file__), 'protocol':digest(Path(__file__).with_name('PROTOCOL_V2.md')), 'fixture_builder':digest(Path(__file__).with_name('expanded_fixture.py')), 'v1_helper':digest(Path(__file__).with_name('run_ablation.py')), 'concept_graph':digest(host/'app/services/personal_concept_graph.py'), 'registry_core':digest(args.repo.resolve()/'packages/learning-core/src/learnflow_core/registry_core.py'),
                      'host_models':digest(host/'app/models/learning.py')}
            assert Path(runtime.__file__).resolve()==source.resolve(), 'Wrong runtime import'
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
                'summary':summary,'breakdowns':deltas, 'started_at':started, 'ended_at':datetime.utcnow().isoformat()+'Z', 'command':sys.argv, 'runtime_path':str(runtime.__file__)}
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
    parser.add_argument('--trajectories',type=int,default=6)
    parser.add_argument('--repetitions',type=int,default=2)
    parser.add_argument('--budgets',type=int,nargs='+',default=[1800,2800,5600])
    parser.add_argument('--full-only',action='store_true')
    parser.add_argument('--pilot',action='store_true')
    args=parser.parse_args()
    if not 1 <= args.trajectories <= 12 or not 1 <= args.repetitions <= 10 or min(args.budgets)<1000:
        parser.error('trajectories 1..12, repetitions 1..10, budgets >=1000')
    run(args)
