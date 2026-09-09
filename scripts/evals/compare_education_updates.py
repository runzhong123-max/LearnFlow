#!/usr/bin/env python3
"""Compare educational runs without changing their scenarios or verifier."""
import argparse
from collections import Counter
import json
import hashlib
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).with_name("education_memory")))
from verifier import judge


def read(path):
    return json.loads(path.read_text())


def claim_identities(snapshot):
    facts = {row['id']: row for row in snapshot['observed']['facts']}
    claims = {row['id']: row for row in snapshot['observed']['claims']}
    events = {row['id']: row for row in snapshot['observed']['events']}
    identities, active = {}, set()

    def normalize(value):
        if isinstance(value, dict):
            return {key: {'claim_identity': claim_identity(item)} if key == 'claim_id' and isinstance(item, int)
                    else normalize(item) for key, item in value.items()}
        if isinstance(value, list):
            return [normalize(item) for item in value]
        return value

    def fact_identity(fact_id):
        fact = facts[fact_id]
        event = events[fact['event']]
        prefix, separator, body = fact['text'].partition(':')
        try:
            normalized_text = [prefix, normalize(json.loads(body))] if separator else fact['text']
        except (ValueError, TypeError):
            normalized_text = fact['text']
        return [fact['event'], event['event_type'], event['occurred_at'], fact['kernel'],
                fact['predicate'], fact['grade'], normalize(fact['object']), normalized_text]

    def claim_identity(node_id):
        if node_id in identities:
            return identities[node_id]
        if node_id in active:
            raise ValueError(f"Cyclic Claim provenance: {snapshot['id']}/{node_id}")
        active.add(node_id)
        claim = claims[node_id]
        evidence = [fact_identity(fact_id) for fact_id in claim['evidence_fact_ids']]
        signature = json.dumps([claim['text'], claim['verification_status'],
                                sorted(evidence, key=lambda value: json.dumps(value, sort_keys=True))],
                               ensure_ascii=False, sort_keys=True)
        identity = hashlib.sha256(signature.encode()).hexdigest()
        if identity in identities.values():
            raise ValueError(f"Ambiguous Claim identity: {snapshot['id']}")
        identities[node_id] = identity
        active.remove(node_id)
        return identity

    for node_id in claims:
        claim_identity(node_id)
    return identities


def gold(check, identities=None):
    value = {key: value for key, value in check.items() if key not in {'actual', 'passed'}}
    if value.get('path') == ['claims'] and 'id' in value.get('fields', {}) and identities is not None:
        # Database node IDs shift when the fixed product stops writing a Fact.
        # Compare the actual unique Claim content and evidence provenance instead;
        # preserve status, operation, expected fields and raw scoring unchanged.
        value['fields'] = {**value['fields'], 'id': identities[value['fields']['id']]}
    return value


def paired_checks(before, after, identity, transitions, claim_maps=(None, None)):
    if [gold(c, claim_maps[0]) for c in before] != [gold(c, claim_maps[1]) for c in after]:
        raise ValueError(f'Changed gold or check order: {identity}')
    for check in before + after:
        if judge({"actual": check["actual"]}, {**check, "path": ["actual"]})["passed"] != check["passed"]:
            raise ValueError(f"Stored check failed recomputation: {identity}")
    for left, right in zip(before, after):
        if left['passed'] != right['passed']:
            transitions.append({**identity, 'check': left['name'],
                'before': left['passed'], 'after': right['passed']})


def compare(before, after):
    result = {'before_directory': str(before), 'after_directory': str(after), 'hosts': {}}
    for host in ('web', 'desktop'):
        old, new = before / host, after / host
        manifests = [read(folder / 'manifest.json') for folder in (old, new)]
        for manifest in manifests:
            if manifest['status'] != 'completed' or manifest['source_changes'] or manifest['blocked_network_attempts']:
                raise ValueError(f'Invalid formal run: {host}')
        for name in ('run.py', 'verifier.py', 'PROTOCOL.md', 'test_verifier.py'):
            key = f'scripts/evals/education_memory/{name}'
            if manifests[0]['source_hashes'][key] != manifests[1]['source_hashes'][key]:
                raise ValueError(f'Changed experiment source: {key}')
        arguments = [{k: v for k, v in m['arguments'].items() if k != 'output'} for m in manifests]
        if arguments[0] != arguments[1] or manifests[0]['clock'] != manifests[1]['clock']:
            raise ValueError(f'Changed protocol arguments/clock: {host}')
        snaps = [{s['id']: s for s in read(folder / 'snapshots.json')} for folder in (old, new)]
        if snaps[0].keys() != snaps[1].keys():
            raise ValueError(f'Missing or added observation points: {host}')
        formation = []
        claim_mapping = []
        for key, left in snaps[0].items():
            right = snaps[1][key]
            for field in ('name', 'family', 'learner', 'domain', 'at', 'query', 'delivery_gold', 'planning_gold'):
                if left[field] != right[field]:
                    raise ValueError(f'Changed snapshot protocol: {host}/{key}/{field}')
            maps = (claim_identities(left), claim_identities(right))
            paired_checks(left['formation'], right['formation'], {'snapshot': key}, formation, maps)
            for snapshot in (left, right):
                for check in snapshot['formation']:
                    actual = judge(snapshot['observed'], check)
                    if actual['passed'] != check['passed'] or actual['actual'] != check['actual']:
                        raise ValueError(f'Formation differs from observed state: {key}')
            for check in left['formation']:
                if check.get('path') == ['claims'] and 'id' in check.get('fields', {}):
                    old_id = check['fields']['id']
                    new_ids = [node for node, signature in maps[1].items() if signature == maps[0][old_id]]
                    if len(new_ids) != 1:
                        raise ValueError(f'Missing/ambiguous paired Claim: {key}')
                    claim_mapping.append({'snapshot': key, 'before_id': old_id, 'after_id': new_ids[0],
                                          'content_and_source_signature': maps[0][old_id]})
        rows = []
        for folder in (old, new):
            indexed = {}
            for line in (folder / 'trials.jsonl').read_text().splitlines():
                row = json.loads(line)
                key = (row['snapshot'], row['variant'], row['budget'], row['repeat'])
                if key in indexed:
                    raise ValueError(f'Duplicate trial: {host}/{key}')
                indexed[key] = row
            rows.append(indexed)
        for indexed, manifest, snapshots in zip(rows, manifests, snaps):
            expected = {(snapshot, variant, budget, repeat) for snapshot in snapshots
                for variant in ('full', 'facts_only', 'recent_facts', 'no_relations', 'no_guidance', 'no_head_cache', 'no_memory')
                for budget in manifest['arguments']['budgets']
                for repeat in range(manifest['arguments']['repetitions'])}
            if indexed.keys() != expected:
                raise ValueError(f'Incomplete Cartesian trial matrix: {host}')
        if rows[0].keys() != rows[1].keys():
            raise ValueError(f'Trial matrix differs: {host}')
        transitions = []
        for key, left in rows[0].items():
            right = rows[1][key]
            if left['family'] != right['family']:
                raise ValueError(f'Changed family: {key}')
            for layer in ('delivery', 'planning'):
                changes = []
                paired_checks(left['scores'][layer], right['scores'][layer],
                    dict(zip(('snapshot', 'variant', 'budget', 'repeat'), key), layer=layer), changes)
                if key[-1] == 0:
                    transitions.extend(changes)
        counts = Counter((c['variant'], c['budget'], c['layer'], 'gained' if c['after'] else 'lost') for c in transitions)
        result['hosts'][host] = {
            'before_revision': manifests[0]['git_head'], 'after_revision': manifests[1]['git_head'],
            'identical_experiment_files': 4, 'equivalent_snapshot_gold': len(snaps[0]), 'claim_id_mapping': claim_mapping,
            'paired_trials': len(rows[0]), 'formation_transitions': formation,
            'primary_transitions': transitions,
            'transition_counts': [{'variant': k[0], 'budget': k[1], 'layer': k[2], 'direction': k[3], 'count': v}
                                  for k, v in sorted(counts.items())],
        }
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('before', type=Path)
    parser.add_argument('after', type=Path)
    args = parser.parse_args()
    result = compare(args.before.resolve(), args.after.resolve())
    output = args.after / 'paired-update.json'
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({host: {k: v for k, v in data.items() if k not in {'primary_transitions', 'formation_transitions'}}
                      for host, data in result['hosts'].items()}, ensure_ascii=False, indent=2))
