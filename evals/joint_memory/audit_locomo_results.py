#!/usr/bin/env python3
"""Read-only audit of existing LoCoMo trial files; never invoke retrieval or change scores."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import statistics


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def lines(path):
    raw = path.read_bytes()
    # An in-progress writer can leave a partial trailing record. Never score it.
    complete = raw[:raw.rfind(b'\n') + 1]
    return [json.loads(line) for line in complete.splitlines() if line.strip()], {
        'bytes_read': len(raw), 'complete_bytes': len(complete), 'sha256_at_read': sha(raw)}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--run', type=Path, required=True)
    ap.add_argument('--dataset', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    args = ap.parse_args()
    data_raw = args.dataset.read_bytes()
    data = json.loads(data_raw)
    recent, turn_index, turn_counts = {}, {}, {}
    global_id = 0
    for sample in data:
        cid = sample['sample_id']
        conv = sample['conversation']
        turns = []
        sessions = sorted((int(k.split('_')[1]), k) for k in conv
                          if k.startswith('session_') and k.split('_')[1].isdigit() and isinstance(conv[k], list))
        for _, key in sessions:
            stamp = conv[key + '_date_time']
            timestamp = datetime.strptime(stamp, '%I:%M %p on %d %B, %Y')
            for turn in conv[key]:
                global_id += 1
                turns.append((timestamp, global_id, turn['dia_id']))
                turn_index[cid, turn['dia_id']] = {
                    'session_date': timestamp.isoformat(), 'speaker': turn['speaker'],
                    'has_image_caption': bool(turn.get('blip_caption'))}
        recent[cid] = {t[2] for t in sorted(turns)[-24:]}
        turn_counts[cid] = len(turns)
    questions, rows, shards = {}, [], []
    for folder in sorted(p for p in args.run.glob('locomo-*') if p.is_dir()):
        rr, snapshot = lines(folder / 'trials.jsonl')
        qq, _ = lines(folder / 'questions.jsonl')
        rows.extend(rr)
        for q in qq:
            if q['selected_for_run']:
                if q['case_id'] in questions:
                    raise ValueError('overlapping question shards')
                questions[q['case_id']] = q
        shards.append({'id': folder.name, 'rows': len(rr), **snapshot,
                       'summary_exists': (folder / 'summary.json').exists(),
                       'manifest_exists': (folder / 'manifest.json').exists()})
    summaries = [json.loads((args.run / s['id'] / 'summary.json').read_text())
                 for s in shards if s['summary_exists']]
    keys = [(r['case_id'], r['variant'], r['budget']) for r in rows]
    expected = {(cid, v, b) for cid in questions for v in ('full', 'recent_facts', 'no_memory') for b in (1800, 3200)}
    actual = set(keys)
    duplicate_count = len(keys) - len(actual)
    complete = actual == expected and not duplicate_count and all(s['summary_exists'] for s in shards)
    main_rows = [r for r in rows if r['scoring_group'] == 'conversation_evidence' and r['scoring_status'] == 'valid']
    indexed = {(r['case_id'], r['variant'], r['budget']): r for r in main_rows}
    metrics = ('source_recall', 'full_text_recall', 'evidence_precision', 'source_complete', 'full_evidence_complete', 'returned_turn_count')
    tables = []
    for cats in ((1, 2, 4), (1,), (2,), (4,)):
        for budget in (1800, 3200):
            for variant in ('full', 'recent_facts', 'no_memory'):
                members = [r for r in main_rows if r['category'] in cats and r['budget'] == budget and r['variant'] == variant]
                tables.append({'categories': list(cats), 'budget': budget, 'variant': variant, 'conditions': len(members),
                               'means': {m: statistics.mean(float(r['metrics'][m]) for r in members) if members else None for m in metrics}})
    all_categories = []
    for category in (1, 2, 3, 4, 5):
        for budget in (1800, 3200):
            for variant in ('full', 'recent_facts', 'no_memory'):
                members = [r for r in rows if r['category'] == category and r['budget'] == budget and r['variant'] == variant]
                measures = {}
                for m in metrics:
                    values = [float(r['metrics'][m]) for r in members if r['metrics'].get(m) is not None]
                    measures[m] = {'mean': statistics.mean(values) if values else None, 'denominator': len(values)}
                all_categories.append({'category': category, 'budget': budget, 'variant': variant, 'conditions': len(members),
                                       'scoring_status_counts': dict(Counter(r['scoring_status'] for r in members)), 'metrics': measures})
    pairs = []
    for budget in (1800, 3200):
        for variant in ('recent_facts', 'no_memory'):
            for metric in metrics:
                ds, clusters = [], defaultdict(list)
                for r in main_rows:
                    if r['budget'] != budget or r['variant'] != 'full':
                        continue
                    other = indexed.get((r['case_id'], variant, budget))
                    if other:
                        delta = float(r['metrics'][metric]) - float(other['metrics'][metric])
                        ds.append(delta)
                        clusters[r['conversation_id']].append(delta)
                pairs.append({'budget': budget, 'comparison': 'full-minus-' + variant, 'metric': metric,
                              'paired_cases': len(ds), 'wins': sum(x > 0 for x in ds), 'ties': sum(x == 0 for x in ds),
                              'losses': sum(x < 0 for x in ds), 'case_weighted_delta': statistics.mean(ds) if ds else None,
                              'conversation_equal_weight_delta': statistics.mean(statistics.mean(v) for v in clusters.values()) if clusters else None,
                              'per_conversation_delta': {c: statistics.mean(v) for c, v in sorted(clusters.items())}})
    ceilings = []
    for cats in ((1, 2, 4), (1,), (2,), (4,), (3,)):
        qs = [q for q in questions.values() if q['category'] in cats and q['annotation_status'] == 'valid']
        values = [len(set(q['validated_evidence']) & recent[q['conversation_id']]) / len(set(q['validated_evidence'])) for q in qs]
        ceilings.append({'categories': list(cats), 'questions': len(qs), 'any_accessible_gold': sum(v > 0 for v in values),
                         'all_gold_accessible': sum(v == 1 for v in values), 'no_accessible_gold': sum(v == 0 for v in values),
                         'mean_source_recall_accessibility_bound': statistics.mean(values),
                         'evidence_has_image_caption': sum(q['evidence_has_image_caption'] for q in qs)})
    budget_changes = Counter()
    for r in main_rows:
        if r['variant'] == 'full' and r['budget'] == 1800:
            other = indexed.get((r['case_id'], 'full', 3200))
            if other:
                d = other['metrics']['full_text_recall'] - r['metrics']['full_text_recall']
                budget_changes['increase' if d > 0 else 'decrease' if d < 0 else 'tie'] += 1
    examples = []
    for cid in ('conv-26:q0085', 'conv-49:q0088', 'conv-49:q0103', 'conv-49:q0109', 'conv-43:q0026', 'conv-49:q0050'):
        q = questions[cid]
        examples.append({'case_id': cid, 'category': q['category'],
                         'gold_provenance': [{'dia_id': d, **turn_index[q['conversation_id'], d]} for d in q['validated_evidence']],
                         'conditions': [{'variant': r['variant'], 'budget': r['budget'],
                                         'source_recall': r['metrics']['source_recall'], 'full_text_recall': r['metrics']['full_text_recall'],
                                         'returned_turn_count': r['metrics']['returned_turn_count'], 'tokens_estimate': r['metrics']['tokens_estimate'],
                                         'diagnostics': r['diagnostics']} for r in rows if r['case_id'] == cid]})
    out = {'schema': 'locomo-independent-result-audit.v1', 'observed_at': datetime.now(timezone.utc).isoformat(),
           'read_only': True, 'dataset_sha256': sha(data_raw), 'run': str(args.run), 'complete': complete,
           'interpretation': 'Partial files are observational snapshots, not final arm comparisons. Accessibility bounds describe this fixed corpus and last-24 input, not general algorithm capacity. No upstream question/answer/conversation text is reproduced.',
           'shards': shards, 'conditions': len(rows), 'expected_conditions': len(expected),
           'completion_metadata': {'code_commit_at_each_shard_end': [s['code_commit'] for s in summaries],
                                   'same_hashed_sources': len(summaries) == len(shards) and all(s['source_hashes'] == summaries[0]['source_hashes'] for s in summaries),
                                   'source_unchanged_each_shard': [s['source_unchanged'] for s in summaries],
                                   'frozen_read_times': [s['frozen_read_time'] for s in summaries],
                                   'network_attempts_each_shard': [s['isolation']['network_attempts'] for s in summaries]},
           'missing_conditions': len(expected - actual), 'unexpected_conditions': len(actual - expected), 'duplicate_conditions': duplicate_count,
           'scoring_status_counts': dict(Counter(r['scoring_status'] for r in rows)),
           'budget_failures': sum(r['metrics'].get('budget_ok') is not True for r in rows),
           'attribution_errors': sum(r['metrics'].get('attribution_error_count') or 0 for r in rows),
           'clipped_evidence_conditions': sum(bool(r['diagnostics'].get('clipped_evidence')) for r in rows),
           'retrieval_calls': sum(r['execution'] == 'production_retrieval' for r in rows),
           'turn_counts': turn_counts, 'recent24_candidate_accessibility': ceilings,
           'main_tables': tables, 'all_category_tables': all_categories, 'main_paired_directions': pairs,
           'main_full_larger_budget_direction': dict(budget_changes), 'examples_without_upstream_text': examples}
    args.output.write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: out[k] for k in ('complete', 'conditions', 'expected_conditions', 'missing_conditions', 'duplicate_conditions', 'budget_failures', 'attribution_errors')}))


if __name__ == '__main__':
    main()
