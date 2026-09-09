#!/usr/bin/env python3
"""Frozen v2 regression replay with multi-file provenance and separate edge probes."""
import argparse
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import run_expanded as runner

VERSION = 'learnflow-memory-long-tail.v1.1'

def source_hashes(repo, host):
    paths = set((repo/'packages/learning-core/src/learnflow_core').rglob('*.py'))
    paths.update((host/'app').rglob('*.py'))
    paths.update(Path(__file__).parent.glob('*.py'))
    paths.update(Path(__file__).parent.glob('*.md'))
    return {str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths)}


def run(args):
    repo, host, out = args.repo.resolve(), args.host.resolve(), args.output.resolve()
    # Reserve a fresh directory before the try/finally. A rejected rerun must
    # not overwrite provenance in an earlier evidence bundle, even if empty.
    out.mkdir(parents=True, exist_ok=False)
    before = source_hashes(repo, host)
    original = runner.make_fixture
    if args.mechanism:
        async def fixture(path, seeds):
            data = await original(path, seeds)
            # Only the root has query overlap. No lexical words from near/far
            # targets may silently stand in for the edge mechanism.
            queries = {'two_hop_dependency': '仪器联调', 'dense_edge_window': '密集'}
            data['cases'] = [{**c, 'query': queries[c['family']], 'cohort': 'pure_edge_mechanism'}
                             for c in data['cases'] if c['family'] in queries]
            data['version'] = 'pure-edge-probes.v2'
            return data
        runner.make_fixture = fixture
    original_queries = runner.run_queries
    async def queries(base, fixture, output, repetitions, budgets, runtime):
        policies = runtime.CONTEXT_POLICIES
        if args.hop_limit is not None:
            runtime.CONTEXT_POLICIES = {k: replace(v, max_hops=args.hop_limit) for k, v in policies.items()}
        try:
            return await original_queries(base, fixture, output, repetitions, budgets, runtime)
        finally:
            runtime.CONTEXT_POLICIES = policies
    runner.run_queries = queries
    args.pilot = False
    try:
        runner.run(args)
    finally:
        runner.make_fixture, runner.run_queries = original, original_queries
        after = source_hashes(repo, host)
        provenance = {'version': VERSION, 'source_hashes': before, 'source_unchanged': before == after,
                      'changed_paths': sorted(k for k in before.keys() | after.keys() if before.get(k) != after.get(k)),
                      'code_commit': subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip(),
                      'working_tree': subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain'], text=True).splitlines(),
                      'command': sys.argv, 'mechanism': args.mechanism, 'hop_limit': args.hop_limit}
        if out.exists():
            (out/'source-provenance.json').write_text(json.dumps(provenance, ensure_ascii=False, indent=2))
        if before != after:
            raise RuntimeError('Source or protocol changed during run; results invalid')
    summary_path = out/'summary.json'
    summary = json.loads(summary_path.read_text())
    summary.update(replay_version=VERSION, known_regression_suite=True,
                   kind='synthetic_pure_edge_probe' if args.mechanism else 'synthetic_v2_regression_replay_not_blind_holdout',
                   multi_file_provenance='source-provenance.json', hop_limit=args.hop_limit)
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for key in ('repo', 'host', 'output'):
        p.add_argument('--'+key, type=Path, required=True)
    p.add_argument('--trajectories', type=int, default=6)
    p.add_argument('--repetitions', type=int, default=2)
    p.add_argument('--budgets', type=int, nargs='+', default=[1800, 2800, 5600])
    p.add_argument('--full-only', action='store_true')
    p.add_argument('--mechanism', action='store_true')
    p.add_argument('--hop-limit', type=int, choices=(0, 1, 2))
    args = p.parse_args()
    if not 1 <= args.trajectories <= 12 or not 1 <= args.repetitions <= 10 or min(args.budgets) < 1000:
        p.error('trajectories 1..12, repetitions 1..10, budgets >=1000')
    run(args)
