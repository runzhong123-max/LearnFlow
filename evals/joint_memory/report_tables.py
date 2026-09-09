#!/usr/bin/env python3
"""Descriptive report slices from frozen metrics; never regrade product outputs."""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
from analyze import paired_deltas, read_rows, summary, validate_rows


def education_delivery(rows):
    groups = defaultdict(list)
    for row in rows:
        groups[(row['budget'], row['variant'])].append(row)
    output = []
    for (budget, variant), group in sorted(groups.items()):
        metrics = {}
        for kind in ('raw_statement', 'assessment_topic', 'formed_source_fact'):
            for channel in ('attributed_evidence_delivered', 'source_fact_evidence_delivered'):
                prefix = f'{channel}_{kind}'
                numerator = sum(r['metrics'][prefix+'_numerator'] for r in group)
                denominator = sum(r['metrics'][prefix+'_denominator'] for r in group)
                metrics[prefix] = {'numerator': numerator, 'denominator': denominator,
                                   'ratio': numerator / denominator if denominator else None}
        output.append({'budget': budget, 'variant': variant, 'conditions': len(group), 'metrics': metrics})
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--results', required=True, type=Path)
    args = parser.parse_args()
    root = args.results
    education = read_rows(root/'education-trials.jsonl.gz')
    locomo = read_rows(root/'locomo-trials.jsonl.gz')
    formation = read_rows(root/'education-formation.jsonl.gz')
    validate_rows(education, 'family_id')
    validate_rows(locomo, 'conversation_id')
    main_rows = [r for r in locomo if r['scoring_group'] == 'conversation_evidence'
                 and r['scoring_status'] == 'valid']
    if len({r['case_id'] for r in main_rows}) != 1438:
        raise ValueError('Unexpected main LoCoMo denominator; inspect annotations instead of changing it silently')
    pair_metrics = {'source_recall', 'full_text_recall', 'source_complete', 'full_evidence_complete'}
    pair_rows = [{**r, 'metrics': {k: v for k, v in r['metrics'].items() if k in pair_metrics}}
                 for r in main_rows]
    checks = defaultdict(Counter)
    gaps = Counter()
    for row in formation:
        for check in row['checks']:
            checks[check['name']][str(check['passed'])] += 1
        gaps.update(gap['reason'] for gap in row['adapter_gaps'])
    result = {
        'schema': 'learnflow-joint-memory-report-slices.v1',
        'input_sha256': {name: hashlib.sha256((root/name).read_bytes()).hexdigest() for name in
                         ('education-trials.jsonl.gz', 'locomo-trials.jsonl.gz', 'education-formation.jsonl.gz')},
        'method': 'Post-run descriptive slices, no new scoring rules. Main LoCoMo includes valid categories 1/2/4 only; category 3 remains separate. Equal conversation bootstrap uses frozen per-question scores. Education sums two differently strong delivery probes separately, never as teaching quality.',
        'locomo_main_questions': len({r['case_id'] for r in main_rows}),
        'locomo_main': summary(main_rows, ['budget', 'variant']),
        'locomo_main_paired_deltas': paired_deltas(pair_rows, 'conversation_id'),
        'locomo_category_status': summary(locomo, ['budget', 'variant', 'category', 'scoring_status']),
        'education_delivery': education_delivery(education),
        'education_formation_case_checks': dict(checks),
        'education_adapter_gap_operations': dict(gaps),
        'education_formation_counts': dict(sum((Counter(r['counts']) for r in formation), Counter())),
        'education_node_counts': dict(sum((Counter(r['node_type_counts']) for r in formation), Counter())),
        'education_time_constraint': summary([r for r in education if r['metrics']['actual_plan_minutes'] is not None],
                                             ['budget', 'variant', 'pattern']),
    }
    with (root/'report-tables.json').open('x', encoding='utf-8') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')
    print(json.dumps({'education': len(education), 'locomo': len(locomo),
                      'locomo_main_questions': result['locomo_main_questions']}))


if __name__ == '__main__':
    main()
