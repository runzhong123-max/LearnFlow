#!/usr/bin/env python3
"""Describe the frozen full/2900 supplement; emit no original question/answer text."""
import gzip
import hashlib
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
import statistics
import sys

ROOT = Path('/Users/a1-6/LearnFlow')
OUT = Path(__file__).parent
sys.path.insert(0, str(ROOT / 'scripts'))
import audit_education_episode_freshness as freshness
sys.path.insert(0, str(ROOT / 'evals/education_memory_v2'))
from components import packet_tokens


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def counts(values):
    return {str(k): n for k, n in Counter(values).items()}


def applicable_latest(row, indexes):
    scope = row['packet'].get('scope') or {}
    if scope.get('mode') != 'checkpoint' or any(not freshness.integer(scope.get(k)) for k in ('learner_id', 'project_id', 'checkpoint_id')):
        return None, 'query_scope_not_explicit_checkpoint'
    if (row['packet'].get('manifest', {}).get('query_plan') or {}).get('temporal') != 'current':
        return None, 'query_not_declared_current'
    current = [e for e in indexes['events'].values()
               if e.get('event_type') == 'vnext_teaching_input_received' and e.get('source') == 'vnext'
               and e.get('client_event_id') in (f"current-{row['case_id']}", f"{scope['learner_id']}:current-{row['case_id']}")
               and all(freshness.same_id(e.get(k), scope.get(k)) for k in ('learner_id', *freshness.SCOPE))]
    if len(current) != 1 or freshness.timestamp(current[0].get('occurred_at')) is None:
        return None, 'missing_unique_current_input_time_receipt'
    at = freshness.timestamp(current[0]['occurred_at'])
    eligible = []
    for event in indexes['events'].values():
        if event.get('event_type') in freshness.ASSESSMENTS:
            reference, error = freshness.valid_assessment(event, indexes, scope, at)
            if reference:
                eligible.append(reference)
    if not eligible:
        return None, 'no_valid_assessment_applicable_to_query'
    return max(eligible, key=lambda e: (freshness.timestamp(e['occurred_at']), e['event_id'])), None


def main():
    metadata_path = OUT / 'run-metadata.json'
    metadata = json.loads(metadata_path.read_text())
    if metadata['status'] != 'completed':
        raise RuntimeError('All shards must finish successfully before summary')
    inputs = {str(metadata_path): sha(metadata_path), str(Path(__file__)): sha(Path(__file__)),
              str(Path(freshness.__file__)): sha(Path(freshness.__file__)),
              str(ROOT / 'evals/education_memory_v2/components.py'): sha(ROOT / 'evals/education_memory_v2/components.py')}
    rows = []; formations = []; manifests = []; snapshots = {}; actual = []; errors = 0
    for shard in sorted(OUT.glob('education-0[0-3]')):
        for name in ('trials.jsonl', 'formation.jsonl', 'manifest.json', 'summary.json', 'raw.jsonl.gz', 'errors.jsonl'):
            path = shard / name
            inputs[str(path)] = sha(path)
        rows.extend(json.loads(l) for l in (shard / 'trials.jsonl').open() if l.strip())
        formations.extend(json.loads(l) for l in (shard / 'formation.jsonl').open() if l.strip())
        manifests.append(json.loads((shard / 'manifest.json').read_text()))
        errors += sum(1 for line in (shard / 'errors.jsonl').open() if line.strip())
        with gzip.open(shard / 'raw.jsonl.gz', 'rt') as stream:
            for line in stream:
                row = json.loads(line)
                if row.get('kind') == 'formation':
                    if row['case_id'] in snapshots:
                        raise ValueError('Duplicate formation snapshot')
                    snapshots[row['case_id']] = freshness.state_indexes(row['state'])
                elif row.get('plan') is not None and row.get('packet') is not None:
                    actual.append(row)
    expected = {c for m in manifests for c in m['selected_case_ids']}
    keys = {(r['case_id'], r['variant'], r['budget'], r['repeat']) for r in rows}
    if len(rows) != 1584 or len(keys) != 1584 or keys != {(c, 'full', 2900, 0) for c in expected}:
        raise ValueError('Incomplete or unexpected full/2900 conditions')
    if len(formations) != 1584 or len(snapshots) != 1584 or len(actual) != 1584:
        raise ValueError('Incomplete formation or actual packet/plan coverage')
    groups = defaultdict(list)
    for r in rows:
        groups[r['pattern']].append(r)
    checks = defaultdict(Counter); formed_counts = Counter(); gaps = Counter()
    for f in formations:
        formed_counts.update(f['counts'])
        gaps.update(g['reason'] for g in f['formation_delivery_gaps'])
        for check in f['checks']:
            checks[check['name']][str(check['passed'])] += 1
    invariant_names = ('budget', 'pre_ablation_budget_valid', 'component_intervention', 'current_controls_identical',
        'no_human_raw_memory', 'no_premature_completion', 'verify_required', 'episode_source_chain',
        'teaching_decision_source_trace', 'teaching_guidance_scope_source_expiry', 'source_excerpts',
        'visible_event_sources', 'visible_memory_scope')
    sums = {k: sum(r['metrics'].get(k) or 0 for r in rows) for k in (
        'source_fact_evidence_delivered_assessment_topic_numerator', 'source_fact_evidence_delivered_assessment_topic_denominator',
        'attributed_evidence_delivered_assessment_topic_numerator', 'attributed_evidence_delivered_assessment_topic_denominator',
        'source_fact_evidence_delivered_raw_statement_numerator', 'source_fact_evidence_delivered_raw_statement_denominator',
        'component_episodes_eligible', 'component_episodes_selected', 'component_episodes_budget_omitted',
        'component_episodes_limit_omitted', 'component_episodes_fact_limit_omitted')}
    actions = Counter(); episode_outcomes = Counter(); latest_outcomes = Counter(); latest_na = Counter()
    failed_cases = []; freshness_results = Counter(); independent_budget_pass = 0; decision_cases = practice_cases = episode_cases = 0
    for row in actual:
        packet, plan = row['packet'], row['plan']
        ds = plan.get('teaching_decisions') or []
        acts = [d.get('action') for d in ds]
        actions.update(acts); decision_cases += bool(ds)
        practice_cases += any(a in freshness.PRACTICE_ACTIONS for a in acts)
        episodes = packet.get('learning_episodes') or []; episode_cases += bool(episodes)
        for episode in episodes:
            o = episode.get('outcome') or {}
            episode_outcomes[str((o.get('correct'), o.get('assistance_level'), o.get('independent')))] += 1
        estimate = packet_tokens(packet)
        independent_budget_pass += estimate == packet['manifest']['token_estimate'] and estimate <= 2900
        indexes = snapshots[row['case_id']]
        latest, reason = applicable_latest(row, indexes)
        audit = freshness.audit_condition(row, indexes)
        freshness_results[(audit['status'], audit['reason'])] += 1
        if latest is None:
            latest_na[reason] += 1
            continue
        latest_outcomes[str((latest['outcome']['correct'], latest['outcome']['assistance_level'], latest['reference_action']))] += 1
        if latest['outcome']['correct'] is False:
            actual_diagnose = [d for d in ds if d.get('action') == 'diagnose_first_error']
            failed_cases.append({'case_id': row['case_id'], 'family_id': row['family_id'], 'pattern': row['pattern'],
                'latest_event_id': latest['event_id'], 'latest_attempt_id': latest['attempt_id'],
                'actual_actions': acts, 'diagnose_emitted': bool(actual_diagnose),
                'diagnose_cites_latest': bool(actual_diagnose) and any(latest['event_id'] in (d.get('source_event_ids') or []) for d in actual_diagnose),
                'freshness_status': audit['status'], 'freshness_reason': audit['reason'],
                'episode_count': len(episodes), 'episode_budget_omitted': (packet.get('retrieval_diagnostics', {}).get('episodes') or {}).get('budget_omitted')})
    result = {'schema': 'learnflow.default-budget-descriptive-summary.v1', 'descriptive_supplement': True,
        'not_part_of_formal_ablation_matrix': True, 'created_at': datetime.now(timezone.utc).isoformat(),
        'conditions': len(rows), 'cases': len(expected), 'formation_cases': len(formations),
        'budget': 2900, 'variant': 'full', 'repetitions': 1, 'errors': errors,
        'started_at': metadata['started_at'], 'ended_at': metadata['ended_at'],
        'source_drift': metadata['source_drift'], 'manifests_changed_sources': [m['changed_sources'] for m in manifests],
        'blocked_network_attempts': sum(m['blocked_network_attempts'] for m in manifests),
        'formed_counts': dict(formed_counts), 'formation_checks': dict(checks), 'formation_delivery_gap_reasons': dict(gaps),
        'invariants': {k: counts(r['metrics'].get(k) for r in rows) for k in invariant_names},
        'independent_budget_pass': independent_budget_pass, 'probe_and_episode_sums': sums,
        'episode_fact_limit_NA': sum(r['metrics'].get('component_episodes_fact_limit_omitted') is None for r in rows),
        'episode_cases': episode_cases, 'episode_outcomes': dict(episode_outcomes),
        'actual_action_counts': dict(actions), 'any_actual_decision_cases': decision_cases, 'actual_practice_action_cases': practice_cases,
        'latest_applicable_outcomes': dict(latest_outcomes), 'latest_applicable_NA': dict(latest_na),
        'latest_failed': {'denominator': len(failed_cases), 'diagnose_emitted': sum(r['diagnose_emitted'] for r in failed_cases),
            'diagnose_cites_latest': sum(r['diagnose_cites_latest'] for r in failed_cases),
            'by_pattern': dict(Counter(r['pattern'] for r in failed_cases)), 'cases': failed_cases},
        'actual_action_freshness': [{'status': k[0], 'reason': k[1], 'count': v} for k, v in sorted(freshness_results.items())],
        'minutes_constraints': {pattern: {'conditions': len(members), 'check': counts(r['metrics'].get('actual_plan_minutes') for r in members),
            'estimated_minutes': counts(r['plan_estimated_minutes'] for r in members)} for pattern, members in groups.items()
            if any(r['metrics'].get('actual_plan_minutes') is not None for r in members)},
        'mean_token_estimate': statistics.mean(r['packet_token_estimate'] for r in rows), 'inputs': inputs,
        'interpretation': ['Same frozen synthetic and author-seen cases; no new gold or cases, and no LoCoMo run.',
            'Full checkpoint_tutor at default budget 2900 is a descriptive supplement, not an added arm in the formal 12x2 ablation.',
            'Latest valid native assessment uses source/attempt/fact scope and query-time validation from the separately tested freshness v2 audit; timestamp ties use Event ID.',
            'No actual practice action is NA for action freshness, but still retained in the latest-failed coverage denominator.',
            'Episode candidates and assessment-topic probes are different units even when totals coincide.',
            'Teacher ratings and actual student learning outcomes remain unmeasured; action coverage is not educational effectiveness.']}
    if any(sha(Path(p)) != digest for p, digest in inputs.items()):
        raise RuntimeError('An input changed during summary')
    output = OUT / 'descriptive-summary.json'
    with output.open('x') as stream:
        json.dump(result, stream, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False)
        stream.write('\n')
    print(json.dumps({'summary': str(output), 'sha256': sha(output), 'conditions': len(rows),
        'latest_failed': len(failed_cases), 'diagnose_emitted': sum(r['diagnose_emitted'] for r in failed_cases),
        'independent_budget_pass': independent_budget_pass}))


if __name__ == '__main__':
    main()
