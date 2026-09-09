#!/usr/bin/env python3
"""Run independent, disjoint corpus shards; retain failures and exact commands."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--locomo-data', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--education-shards', type=int, default=4)
    parser.add_argument('--locomo-shards', type=int, default=2)
    args = parser.parse_args()
    if not 1 <= args.education_shards <= 8 or not 1 <= args.locomo_shards <= 10:
        parser.error('invalid shard count')
    repo, out = args.repo.resolve(), args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    source = repo/'evals/joint_memory'
    dataset = repo/'evals/computing_learner_profile/data'
    cases = [json.loads(x) for x in (dataset/'cases.jsonl').read_text().splitlines()]
    families = sorted({x['family_id'] for x in cases})
    corpus = json.loads(args.locomo_data.read_text())
    conversations = sorted(x['sample_id'] for x in corpus)
    if len(cases) != 1584 or len(families) != 72 or len(corpus) != 10:
        raise ValueError('unexpected frozen corpus size')
    from fetch_locomo import SHA256
    if sha(args.locomo_data) != SHA256:
        raise ValueError('LoCoMo hash differs from protocol')
    python = repo/'backend/venv/bin/python'
    if not python.exists():
        raise FileNotFoundError('Use the existing backend runtime; no implicit package installation')
    jobs = []
    for shard in range(args.education_shards):
        selected = families[shard::args.education_shards]
        name = f'education-{shard:02d}'
        command = [str(python), str(source/'education.py'), '--repo', str(repo), '--output', str(out/name),
                   '--budgets', '1800', '3200', '--repetitions', '1', '--save-packets']
        for family in selected:
            command.extend(['--family', family])
        jobs.append({'id': name, 'track': 'education', 'families': selected, 'command': command,
                     'expected_cases': sum(c['family_id'] in selected for c in cases)})
    for shard in range(args.locomo_shards):
        selected = conversations[shard::args.locomo_shards]
        name = f'locomo-{shard:02d}'
        command = [str(python), str(source/'locomo.py'), '--repo', str(repo), '--host', str(repo/'backend'),
                   '--dataset', str(args.locomo_data.resolve()), '--output', str(out/name),
                   '--variants', 'full', 'recent_facts', 'no_memory', '--budgets', '1800', '3200',
                   '--repetitions', '1']
        for conversation in selected:
            command.extend(['--conversation-id', conversation])
        jobs.append({'id': name, 'track': 'locomo', 'conversations': selected, 'command': command,
                     'expected_cases': sum(len(c['qa']) for c in corpus if c['sample_id'] in selected)})
    frozen = sorted(p for p in source.iterdir() if p.suffix in {'.py', '.md'})
    product_roots = ['packages/learning-core/src/learnflow_core', 'backend/app/services',
                     'backend/app/api', 'backend/app/models', 'backend/app/db', 'backend/app/core']
    frozen += sorted({p for root in product_roots for p in (repo/root).rglob('*.py')})
    hashes = {str(p.relative_to(repo)): sha(p) for p in frozen}
    manifest = {'schema': 'learnflow-joint-memory-suite.v1',
                'started_at': datetime.now(timezone.utc).isoformat(),
                'source_commit': subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip(),
                'source_hashes': hashes, 'education_manifest_sha256': sha(dataset/'manifest.json'),
                'locomo_sha256': SHA256, 'conditions_expected': {'education': 19008, 'locomo': 11916},
                'jobs': jobs, 'cpu_count': os.cpu_count(), 'timing_caveat': 'Independent processes run concurrently; latency is descriptive, not a controlled performance ranking.'}
    write(out/'suite.json', manifest)
    processes = []
    for job in jobs:
        log = (out/(job['id']+'.log')).open('x')
        process = subprocess.Popen(job['command'], cwd=repo, stdout=log, stderr=subprocess.STDOUT)
        processes.append((job, process, log))
        print(f"started {job['id']} cases={job['expected_cases']} pid={process.pid}", flush=True)
    while processes:
        for item in list(processes):
            job, process, log = item
            status = process.poll()
            if status is not None:
                log.close()
                job['exit_code'] = status
                job['finished_at'] = datetime.now(timezone.utc).isoformat()
                processes.remove(item)
                write(out/'suite.json', manifest)
                print(f"finished {job['id']} exit={status}", flush=True)
        if processes:
            time.sleep(.5)
    manifest['ended_at'] = datetime.now(timezone.utc).isoformat()
    manifest['source_drift'] = [name for name, expected in hashes.items() if sha(repo/name) != expected]
    manifest['all_processes_succeeded'] = all(job['exit_code'] == 0 for job in jobs)
    write(out/'suite.json', manifest)
    if manifest['source_drift'] or not manifest['all_processes_succeeded']:
        print('Run incomplete or source changed; inspect suite.json and retained shard artifacts.', flush=True)
        return 1
    print(f'All shards completed: {out}', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
