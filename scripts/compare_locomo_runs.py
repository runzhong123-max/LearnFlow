#!/usr/bin/env python3
"""Read-only comparison of two completed LoCoMo runs; output contains no QA text."""
import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
from pathlib import Path
import statistics


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def key(row):
    return row['case_id'], row['variant'], row['budget']


def read_run(root):
    trials = {}; packets = {}; summaries = []; inputs = []
    for shard in sorted(root.glob('locomo-*')):
        if not shard.is_dir():
            continue
        trial_path = shard / 'trials.jsonl'
        if not trial_path.exists():
            trial_path = shard / 'trials.jsonl.gz'
        summary_path, packet_path = shard / 'summary.json', shard / 'packets.jsonl.gz'
        for path in (trial_path, summary_path, packet_path):
            inputs.append({'path': str(path.absolute()), 'sha256': sha(path)})
        summary = json.loads(summary_path.read_text())
        summaries.append(summary)
        opener = gzip.open if trial_path.suffix == '.gz' else open
        with opener(trial_path, 'rt', encoding='utf-8') as stream:
            for line in stream:
                row = json.loads(line)
                if key(row) in trials:
                    raise ValueError('Duplicate trial condition')
                trials[key(row)] = row
        with gzip.open(packet_path, 'rt', encoding='utf-8') as stream:
            for line in stream:
                row = json.loads(line)
                if key(row) in packets:
                    raise ValueError('Duplicate packet condition; only one repetition expected')
                p = row['packet']
                fields = ('enable_episodes', 'max_episodes', 'max_episode_facts', 'enable_bm25',
                          'enable_aliases', 'enable_fuzzy', 'enable_temporal', 'enable_summary_boost')
                body = {'heads': p.get('kernel_heads', {}), 'items': p.get('items', []),
                        'paths': p.get('relation_paths', []),
                        'personal_concept_graph': p.get('personal_concept_graph', {}),
                        'adaptation_directives': p.get('adaptation_directives', []),
                        'teaching_guidance': p.get('teaching_guidance', []),
                        'learning_episodes': p.get('learning_episodes', []),
                        'retrieval_diagnostics': p.get('retrieval_diagnostics', {}),
                        'component_policy': {f: (p.get('manifest', {}).get('policy', {}) or {}).get(f) for f in fields}}
                packets[key(row)] = hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    if set(packets) != set(trials):
        raise ValueError('Trial/packet coverage differs')
    return trials, packets, summaries, inputs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--old-run', type=Path, required=True)
    parser.add_argument('--new-run', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    old, oldp, olds, old_inputs = read_run(args.old_run)
    new, newp, news, new_inputs = read_run(args.new_run)
    common = set(old) & set(new)
    metric_diff = Counter(); top_diff = Counter(); groups = defaultdict(list)
    latency_diff = 0
    for k in sorted(common):
        a, b = old[k], new[k]
        for name in set(a['metrics']) | set(b['metrics']):
            if a['metrics'].get(name) != b['metrics'].get(name):
                if name == 'latency_ms':
                    latency_diff += 1
                else:
                    metric_diff[name] += 1
        for name in set(a) | set(b):
            if name not in ('metrics', 'repetition_latency_ms') and a.get(name) != b.get(name):
                top_diff[name] += 1
    for r in new.values():
        groups[(r['budget'], r['variant'])].append(r)
    table = []
    for (budget, variant), members in sorted(groups.items()):
        main = [r for r in members if r['category'] in (1, 2, 4) and r['scoring_status'] == 'valid']
        multi = [r for r in main if r['category'] == 1]
        table.append({'budget': budget, 'variant': variant, 'conditions': len(members),
            'scoring_status': dict(Counter(r['scoring_status'] for r in members)),
            'main_n': len(main), 'main_full_text_recall': statistics.mean(r['metrics']['full_text_recall'] for r in main),
            'main_complete_numerator': sum(r['metrics']['full_evidence_complete'] for r in main),
            'multi_hop_n': len(multi), 'multi_hop_complete_numerator': sum(r['metrics']['full_evidence_complete'] for r in multi),
            'budget_pass': sum(r['metrics']['budget_ok'] is True for r in members),
            'attribution_errors': sum(r['metrics']['attribution_error_count'] for r in members)})
    inputs = old_inputs + new_inputs
    unchanged = all(sha(Path(row['path'])) == row['sha256'] for row in inputs)
    result = {'schema': 'learnflow.locomo-run-comparison.v1', 'post_hoc_audit': True,
        'old_run': str(args.old_run.absolute()), 'new_run': str(args.new_run.absolute()),
        'old_conditions': len(old), 'new_conditions': len(new), 'common_conditions': len(common),
        'old_only': len(set(old) - set(new)), 'new_only': len(set(new) - set(old)),
        'independent_packet_hash_matches_recorded_old': sum(oldp[k] == r['content_sha256'] for k, r in old.items()),
        'independent_packet_hash_matches_recorded_new': sum(newp[k] == r['content_sha256'] for k, r in new.items()),
        'independent_packet_payload_unchanged': sum(oldp[k] == newp[k] for k in common),
        'non_latency_metric_difference_counts': dict(metric_diff), 'non_timing_trial_field_difference_counts': dict(top_diff),
        'latency_metric_changed_conditions': latency_diff,
        'old_shards_source_unchanged': [s['source_unchanged'] for s in olds],
        'new_shards_source_unchanged': [s['source_unchanged'] for s in news],
        'new_source_maps_identical_across_shards': len({json.dumps(s['source_hashes'], sort_keys=True) for s in news}) == 1,
        'new_network_attempts': [s['isolation']['network_attempts'] for s in news],
        'new_actual_retrieval_calls': sum(s['actual_retrieval_calls'] for s in news),
        'new_execution_error_conditions': sum(r['scoring_status'] == 'execution_error_not_scored' for r in new.values()),
        'new_shards': [{'conditions': s['conditions'], 'questions': s['selected_questions'],
                        'conversations': s['selected_conversation_ids']} for s in news],
        'groups': table, 'inputs': inputs, 'inputs_unchanged': unchanged,
        'script_sha256': sha(Path(__file__)),
        'method': 'Match case_id/variant/budget. Compare all metric fields except latency_ms and every trial field except metrics/repetition_latency_ms. Independently reconstruct and hash the exact charged packet body, including delivered text, paths, diagnostics and component policy; compare both to recorded fingerprints and across runs.',
        'limitations': ['Only one repetition per condition; this is a cross-run consistency audit, not a repeated-trial variance estimate.',
                        'Latency and job timings are descriptive and differ with shard concurrency.',
                        'No generated QA answer accuracy or actual learner benefit is measured.']}
    if not unchanged:
        raise ValueError('An input changed during audit')
    with args.output.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
        stream.write('\n')
    print(json.dumps({k: result[k] for k in ('new_conditions', 'common_conditions', 'independent_packet_payload_unchanged', 'independent_packet_hash_matches_recorded_old', 'independent_packet_hash_matches_recorded_new', 'non_latency_metric_difference_counts', 'non_timing_trial_field_difference_counts')}))
    print(json.dumps({'output': str(args.output.absolute()), 'sha256': sha(args.output)}))


if __name__ == '__main__':
    main()
