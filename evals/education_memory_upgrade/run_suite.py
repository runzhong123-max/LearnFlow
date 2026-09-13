#!/usr/bin/env python3
"""Freeze and execute disjoint upgrade conditions, then audit all retained outputs."""
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

V2 = Path(__file__).resolve().parents[1] / 'education_memory_v2'
sys.path.insert(0, str(V2))
from components import UPGRADE_PRESETS, UPGRADE_VARIANTS, UPGRADE_VERSION
from frozen_sources import verify_education_source
from locomo import SOURCE_SHA256, extract_conversations, question_manifest


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def source_hashes(repo):
    roots = ['evals/education_memory_upgrade', 'evals/education_memory_v2',
             'packages/learning-core/src/learnflow_core', 'backend/app']
    paths = set()
    for root in roots:
        for path in (repo/root).rglob('*'):
            relative_parts = path.relative_to(repo/root).parts
            if path.suffix not in ('.py', '.md') or '__pycache__' in relative_parts:
                continue
            # Experiment outputs grow during execution and are not executable
            # sources. Keep this exclusion scoped to eval roots: a real product
            # module named runs must still participate in source-drift checks.
            if root.startswith('evals/') and {'runs', 'results'}.intersection(relative_parts):
                continue
            paths.add(path)
    paths.add(repo/'scripts/audit_education_episode_freshness.py')
    return {str(p.relative_to(repo)): sha(p) for p in sorted(paths)}



def model_snapshot(path):
    """Read and hash only the public, pinned inference artifact allow-list."""
    if path is None:
        return {"status": "not_configured", "files": {}}
    root=Path(path).resolve()
    manifest_path=root/'learnflow_snapshot_manifest.json'
    metadata=json.loads(manifest_path.read_text())
    allowed={'model.safetensors','pytorch_model.bin','config.json','tokenizer.json','tokenizer_config.json',
             'special_tokens_map.json','vocab.txt','sentence_bert_config.json','modules.json','1_Pooling/config.json','README.md'}
    expected=metadata.get('files')
    if (metadata.get('model_id')!='thenlper/gte-small' or metadata.get('revision')!='17e1f347d17fe144873b1201da91788898c639cd'
            or not isinstance(expected,dict) or not {'config.json','tokenizer.json','model.safetensors'}<=expected.keys()
            or not expected.keys()<=allowed):
        raise ValueError('Model snapshot does not match the frozen public inference identity')
    actual={name:sha(root/name) for name in sorted(expected)}
    if actual!=expected:
        raise ValueError('Model file hash mismatch')
    return {**metadata,'path':str(root),'status':'verified_local_files_not_model_execution',
            'snapshot_manifest_sha256':sha(manifest_path),'files':actual,
            'expected_runtime_identity':'88d0602e36126d904c5d4e15dbca817aee0e282abff8dc22a8d7b994473abe55'}


def build_plan(args):
    repo, out = args.repo.resolve(), args.output.resolve()
    dataset = repo/'evals/computing_learner_profile'
    frozen = verify_education_source(dataset)
    cases = [json.loads(x) for x in (dataset/'data/cases.jsonl').read_text().splitlines()]
    corpus = json.loads(args.locomo_data.read_text())
    if sha(args.locomo_data) != SOURCE_SHA256:
        raise ValueError('LoCoMo hash differs from frozen source')
    conversations = extract_conversations(corpus)
    questions = question_manifest(corpus, conversations)
    families = sorted({row['family_id'] for row in cases})
    conv_ids = sorted(row['conversation_id'] for row in conversations)
    if (len(cases), len(families), len(conversations), len(questions)) != (1584, 72, 10, 1986):
        raise ValueError('Unexpected frozen corpus size')
    python = (args.python or repo/'backend/venv/bin/python').absolute()
    if not python.exists():
        raise FileNotFoundError('An existing Python environment is required; no installation is attempted')
    jobs = []
    for track, clusters, shards, data, cluster_key in (
            ('education', families, args.education_shards, cases, 'family_id'),
            ('locomo', conv_ids, args.locomo_shards, questions, 'conversation_id')):
        for shard in range(shards):
            selected = clusters[shard::shards]
            ids = sorted(row['case_id'] for row in data if row[cluster_key] in selected)
            name = f'{track}-{shard:02d}'
            command = [str(python), str(repo/f'evals/education_memory_v2/{track}.py'),
                       '--repo', str(repo), '--output', str(out/name), '--variants', *args.variants,
                       '--budgets', *map(str, args.budgets), '--repetitions', '1']
            if track == 'education':
                command.append('--save-packets')
            else:
                command += ['--host', str(repo/'backend'), '--dataset', str(args.locomo_data.resolve())]
            for cluster in selected:
                command += ['--family' if track == 'education' else '--conversation-id', cluster]
            jobs.append({'id': name, 'track': track, 'clusters': selected, 'case_ids': ids,
                         'expected_conditions': len(ids)*len(args.variants)*len(args.budgets), 'command': command})
    model=model_snapshot(args.model_path)
    if any(UPGRADE_PRESETS[v].get('candidate_mode')=='hybrid' for v in args.variants) and model['status']=='not_configured':
        raise ValueError('Hybrid matrix requires a verified pinned local model')
    return {'schema': UPGRADE_VERSION, 'status': 'planned', 'started_at': datetime.now(timezone.utc).isoformat(),
            'source_commit': subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip(),
            'source_hashes': source_hashes(repo), 'education_manifest_sha256': sha(dataset/'data/manifest.json'),
            'education_data_hashes': frozen['files'], 'locomo_sha256': SOURCE_SHA256,
            'variants': args.variants, 'preset_overrides': {v: UPGRADE_PRESETS[v] for v in args.variants},
            'budgets': args.budgets, 'repetitions': 1, 'workers': args.workers,
            'semantic_model': model,
            'cpu_count': os.cpu_count(), 'python': str(python), 'python_version': subprocess.check_output([str(python),'--version'],text=True).strip(),
            'conditions_expected': {track: sum(j['expected_conditions'] for j in jobs if j['track']==track)
                                    for track in ('education', 'locomo')},
            'timing_caveat': ('Single worker; actual elapsed time is descriptive, not controlled hardware inference.' if args.workers==1
                              else 'Concurrent shards share resources; elapsed time is confounded by contention and cannot rank performance.'),
            'jobs': jobs, 'bootstrap_repetitions': args.bootstrap, 'teacher_review': 'pending',
            'no_pooled_track_score': True}


def execute(plan, repo, out):
    waiting = list(plan['jobs'])
    active = []
    plan['status'] = 'running'
    started = time.perf_counter()
    try:
        while waiting or active:
            while waiting and len(active) < plan['workers']:
                job = waiting.pop(0)
                log = (out/(job['id']+'.log')).open('x')
                job['started_at'] = datetime.now(timezone.utc).isoformat()
                env=dict(os.environ)
                if plan['semantic_model'].get('path'):
                    env['LEARNFLOW_MEMORY_EMBEDDING_MODEL_PATH']=plan['semantic_model']['path']
                process = subprocess.Popen(job['command'], cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT)
                active.append((job, process, log, time.perf_counter()))
                print(f"started {job['id']} conditions={job['expected_conditions']} pid={process.pid}", flush=True)
            for item in list(active):
                job, process, log, job_started = item
                if process.poll() is not None:
                    log.close()
                    job.update(exit_code=process.returncode, wall_seconds=time.perf_counter()-job_started,
                               ended_at=datetime.now(timezone.utc).isoformat())
                    active.remove(item)
                    print(f"finished {job['id']} exit={process.returncode}", flush=True)
            write(out/'suite.json', plan)
            if active:
                time.sleep(.2)
    except BaseException:
        for job, process, log, _ in active:
            process.terminate()
            process.wait()
            log.close()
            job['exit_code'] = process.returncode
        plan['status'] = 'interrupted'
        raise
    finally:
        current = source_hashes(repo)
        try:
            current_model=model_snapshot(plan['semantic_model'].get('path'))
            plan['model_source_unchanged']=current_model==plan['semantic_model']
        except Exception as exc:
            plan['model_source_unchanged']=False
            plan['model_audit_error']=f'{type(exc).__name__}: {exc}'
        plan['source_drift'] = sorted(k for k in set(plan['source_hashes']) | set(current)
                                      if plan['source_hashes'].get(k) != current.get(k))
        plan['wall_seconds'] = time.perf_counter()-started
        plan['ended_at'] = datetime.now(timezone.utc).isoformat()
        if plan['status'] != 'interrupted':
            plan['status'] = 'completed' if not plan['source_drift'] and plan['model_source_unchanged'] and all(j.get('exit_code')==0 for j in plan['jobs']) else 'failed'
        write(out/'suite.json', plan)
    return plan['status'] == 'completed'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--locomo-data', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--python', type=Path)
    parser.add_argument('--model-path', type=Path, default=os.environ.get('LEARNFLOW_MEMORY_EMBEDDING_MODEL_PATH'),
                        help='Existing pinned local inference model; only public inference files are hashed')
    parser.add_argument('--variants', nargs='+', choices=UPGRADE_VARIANTS, default=list(UPGRADE_VARIANTS))
    parser.add_argument('--budgets', nargs='+', type=int, default=[1800,3200])
    parser.add_argument('--education-shards', type=int, default=1)
    parser.add_argument('--locomo-shards', type=int, default=1)
    parser.add_argument('--workers', type=int, default=1)
    parser.add_argument('--bootstrap', type=int, default=2000)
    parser.add_argument('--plan-only', action='store_true', help='Freeze commands and hashes without running a condition')
    args = parser.parse_args()
    if not 1<=args.education_shards<=72 or not 1<=args.locomo_shards<=10 or not 1<=args.workers<=8:
        parser.error('Require 1..72 education shards, 1..10 LoCoMo shards and 1..8 workers')
    if args.budgets != [1800,3200] or len(set(args.variants))!=len(args.variants) or args.bootstrap<100:
        parser.error('Frozen budgets must be 1800 3200; variants unique; bootstrap>=100')
    plan = build_plan(args)
    if args.model_path:
        os.environ['LEARNFLOW_MEMORY_EMBEDDING_MODEL_PATH']=str(args.model_path.resolve())
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    (out/'PROTOCOL.md').write_bytes(Path(__file__).with_name('PROTOCOL.md').read_bytes())
    write(out/'suite.json', plan)
    if args.plan_only:
        print(json.dumps({'status':'planned_only_not_executed','conditions_expected':plan['conditions_expected'],'output':str(out)}))
        return 0
    if not execute(plan, args.repo.resolve(), out):
        return 1
    from report import audit_and_report
    audit_and_report(out, bootstrap=args.bootstrap)
    return 0


if __name__ == '__main__':
    sys.exit(main())
