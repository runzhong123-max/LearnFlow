#!/usr/bin/env python3
"""Aggregate independent tracks without pooling tasks or inventing missing scores."""
from __future__ import annotations

import argparse
from collections import defaultdict
import gzip
import hashlib
import json
import math
from pathlib import Path
import random
import statistics


def number(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


def read_rows(path):
    path = Path(path)
    opener = gzip.open if path.suffix == '.gz' else open
    with opener(path, 'rt', encoding='utf-8') as stream:
        return [json.loads(line) for line in stream if line.strip()]


def validate_rows(rows, cluster_key):
    seen = set()
    for row in rows:
        for key in ('case_id', cluster_key, 'variant', 'budget', 'metrics'):
            if key not in row:
                raise ValueError(f'missing {key}')
        key = (row['case_id'], row['budget'], row['variant'])
        if key in seen:
            raise ValueError(f'duplicate condition {key}; repeats are not new cases')
        seen.add(key)
        if not isinstance(row['metrics'], dict):
            raise ValueError('metrics must be an object')


def summary(rows, dimensions):
    groups = defaultdict(list)
    for row in rows:
        groups[tuple(row.get(key) for key in dimensions)].append(row)
    out = []
    for values, members in sorted(groups.items(), key=lambda pair: str(pair[0])):
        metrics = {}
        for key in sorted({k for row in members for k in row['metrics']}):
            valid = [row['metrics'].get(key) for row in members if number(row['metrics'].get(key))]
            metrics[key] = {
                'mean': statistics.mean(valid) if valid else None,
                'denominator': len(valid),
                'not_applicable_or_unmeasured': len(members) - len(valid),
            }
        out.append({**dict(zip(dimensions, values)), 'conditions': len(members), 'metrics': metrics})
    return out


def percentile(values, p):
    values = sorted(values)
    position = (len(values) - 1) * p
    lo, hi = math.floor(position), math.ceil(position)
    return values[lo] + (values[hi] - values[lo]) * (position - lo)


def paired_deltas(rows, cluster_key, repetitions=2000):
    """Equal-weight cluster differences; never bootstrap related questions as people."""
    indexed = {(r['case_id'], r['budget'], r['variant']): r for r in rows}
    variants = sorted({r['variant'] for r in rows} - {'full'})
    out = []
    for budget in sorted({r['budget'] for r in rows}):
        base = [r for r in rows if r['variant'] == 'full' and r['budget'] == budget]
        metric_keys = sorted({k for r in base for k in r['metrics']})
        for variant in variants:
            for metric in metric_keys:
                groups = defaultdict(list)
                unmatched = missing = 0
                for left in base:
                    right = indexed.get((left['case_id'], budget, variant))
                    if right is None:
                        unmatched += 1
                        continue
                    if right[cluster_key] != left[cluster_key]:
                        raise ValueError('paired rows have different cluster identities')
                    a, b = left['metrics'].get(metric), right['metrics'].get(metric)
                    if not number(a) or not number(b):
                        missing += 1
                        continue
                    groups[left[cluster_key]].append(float(a) - float(b))
                cluster_values = [statistics.mean(values) for _, values in sorted(groups.items())]
                all_values = [v for values in groups.values() for v in values]
                interval = None
                if len(cluster_values) >= 2:
                    seed = int(hashlib.sha256(f'20260908:{budget}:{variant}:{metric}'.encode()).hexdigest()[:16], 16)
                    rng = random.Random(seed)
                    distribution = [statistics.mean(rng.choices(cluster_values, k=len(cluster_values)))
                                    for _ in range(repetitions)]
                    interval = [percentile(distribution, .025), percentile(distribution, .975)]
                out.append({'budget': budget, 'comparison': f'full-minus-{variant}', 'metric': metric,
                            'paired_cases': len(all_values), 'clusters': len(cluster_values),
                            'cluster_equal_weight_delta': statistics.mean(cluster_values) if cluster_values else None,
                            'case_weighted_delta': statistics.mean(all_values) if all_values else None,
                            'cluster_bootstrap_95_interval': interval,
                            'unmatched_full_cases': unmatched, 'unmeasured_pairs': missing,
                            'bootstrap_repetitions': repetitions if interval else 0})
    return out


def analyze(rows, track, bootstrap=2000):
    cluster = 'family_id' if track == 'education' else 'conversation_id'
    validate_rows(rows, cluster)
    dimensions = ['split', 'pattern', 'domain', 'family_id'] if track == 'education' else ['category', 'conversation_id', 'annotation_status']
    return {
        'schema': 'learnflow-education-memory-analysis.v2', 'track': track,
        'conditions': len(rows), 'cases': len({r['case_id'] for r in rows}),
        'cluster_unit': cluster, 'clusters': len({r[cluster] for r in rows}),
        'overall': summary(rows, ['budget', 'variant']),
        'breakdowns': {key: summary(rows, ['budget', 'variant', key]) for key in dimensions
                       if any(key in row for row in rows)},
        'paired_cluster_deltas': paired_deltas(rows, cluster, bootstrap),
        'interpretation': 'Tracks stay separate. Null is not a pass. Intervals describe this fixed corpus under equal cluster weighting, not population or leaderboard inference. Metric directions differ; positive delta is not universally better.',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--track', choices=['education', 'locomo'], required=True)
    parser.add_argument('--trials', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--bootstrap', type=int, default=2000)
    args = parser.parse_args()
    if args.bootstrap < 100:
        parser.error('use at least 100 bootstrap resamples')
    result = analyze(read_rows(args.trials), args.track, args.bootstrap)
    result['trials_sha256'] = hashlib.sha256(args.trials.read_bytes()).hexdigest()
    with args.output.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')
    print(json.dumps({k: result[k] for k in ['track', 'cases', 'clusters', 'conditions']}))


if __name__ == '__main__':
    main()
