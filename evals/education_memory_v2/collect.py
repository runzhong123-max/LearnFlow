#!/usr/bin/env python3
"""Verify complete shard coverage and export compact, text-free evidence metrics."""
from __future__ import annotations
import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path

from analyze import analyze, read_rows, validate_rows


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')


def write_gzip(path, rows):
    # Reproducible compression header; raw upstream conversation text is excluded.
    with path.open('xb') as raw:
        with gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as compressed:
            for row in rows:
                compressed.write((json.dumps(row, ensure_ascii=False, sort_keys=True, allow_nan=False)+'\n').encode())


def locate(root, stem):
    for name in (stem, stem+'.gz'):
        if (root/name).exists():
            return root/name
    raise FileNotFoundError(f'missing {root/stem}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--locomo-data', type=Path, required=True)
    args = parser.parse_args()
    run, repo = args.run.resolve(), args.repo.resolve()
    suite = json.loads((run/'suite.json').read_text())
    if not suite.get('all_processes_succeeded') or suite.get('source_drift'):
        raise ValueError('suite incomplete or changed during measurement')
    if sha(args.locomo_data) != suite['locomo_sha256']:
        raise ValueError('external dataset changed')
    cases = read_rows(repo/'evals/computing_learner_profile/data/cases.jsonl')
    corpus = json.loads(args.locomo_data.read_text())
    expected = {'education': {c['case_id'] for c in cases},
                'locomo': {f"{c['sample_id']}:q{i:04d}" for c in corpus for i in range(len(c['qa']))}}
    variants = suite['variants']
    budgets = suite['budgets']
    rows = {'education': [], 'locomo': []}
    formation, artifacts, job_summaries, errors = [], {}, [], []
    for job in suite['jobs']:
        folder = run/job['id']
        trials = locate(folder, 'trials.jsonl')
        chunk = read_rows(trials)
        rows[job['track']].extend(chunk)
        artifacts[str(trials.relative_to(run))] = sha(trials)
        raw_summary = json.loads((folder/'summary.json').read_text())
        duplicate_breakdowns = {'formation', 'by_family_split_pattern', 'by_domain_pattern', 'summary_by_category'}
        job_summaries.append({'id': job['id'], 'summary': {
            key: value for key, value in raw_summary.items() if key not in duplicate_breakdowns}})
        for path in sorted(folder.iterdir()):
            if path.is_file():
                artifacts[str(path.relative_to(run))] = sha(path)
        for path in (folder/'errors.jsonl', folder/'errors.jsonl.gz'):
            if path.exists():
                errors.extend({'shard': job['id'], 'error': item} for item in read_rows(path))
        if job['track'] == 'education':
            formation.extend(read_rows(locate(folder, 'formation.jsonl')))
    for track, items in rows.items():
        validate_rows(items, 'family_id' if track == 'education' else 'conversation_id')
        wanted = {(case, budget, variant) for case in expected[track]
                  for budget in budgets for variant in variants[track]}
        observed = {(r['case_id'], r['budget'], r['variant']) for r in items}
        if wanted != observed:
            raise ValueError(f'{track}: missing={len(wanted-observed)}, unexpected={len(observed-wanted)}')
    if Counter(r['case_id'] for r in formation) != Counter({key: 1 for key in expected['education']}):
        raise ValueError('formation coverage is incomplete or duplicated')
    errors.extend({'track': 'locomo', 'case_id': r['case_id'], 'error': r.get('diagnostics')}
                  for r in rows['locomo'] if r.get('scoring_status') == 'execution_error_not_scored')
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    for track, items in rows.items():
        public = []
        keep = ('case_id', 'family_id', 'domain', 'pattern', 'split', 'conversation_id', 'category',
                'variant', 'budget', 'metrics', 'scoring_status', 'scoring_group', 'annotation_errors',
                'adapter_gap_count', 'current_control_hash', 'current_request_sha256', 'semantic_hash',
                'content_sha256', 'execution', 'component_diagnostics')
        for row in sorted(items, key=lambda r: (r['case_id'], r['budget'], r['variant'])):
            public.append({key: row[key] for key in keep if key in row})
        path = out/(track+'-trials.jsonl.gz')
        write_gzip(path, public)
        result = analyze(public, track)
        result['trials_sha256'] = sha(path)
        write_json(out/(track+'-analysis.json'), result)
    formation_public = []
    for row in formation:
        allowed = ('case_id', 'family_id', 'domain', 'pattern', 'split', 'metrics', 'checks', 'unscored',
                   'adapter_gaps', 'counts', 'node_type_counts', 'current_event_ids', 'actual_assistance_counts',
                   'exposure_formation', 'worker_processed', 'formation_delivery_gap')
        formation_public.append({key: row[key] for key in allowed if key in row})
    write_gzip(out/'education-formation.jsonl.gz', sorted(formation_public, key=lambda r: r['case_id']))
    write_json(out/'suite.json', suite)
    write_json(out/'shard-summaries.json', job_summaries)
    write_json(out/'evidence-manifest.json', {'schema': 'learnflow-education-memory-evidence.v2',
        'raw_run_directory': str(run), 'raw_artifact_sha256': artifacts,
        'full_coverage_verified': True, 'execution_errors': errors,
        'interpretation': 'Raw traces remain local. These published metrics omit upstream dialogue/question/answer text. Product misses remain scored; annotation and adapter gaps are explicit.'})
    print(json.dumps({'output': str(out), 'education_conditions': len(rows['education']),
                      'locomo_conditions': len(rows['locomo']), 'execution_errors': len(errors)}, ensure_ascii=False))
    if errors:
        raise RuntimeError('Infrastructure/driver failures retained; do not report a clean evaluation')


if __name__ == '__main__':
    main()
