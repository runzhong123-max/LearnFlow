#!/usr/bin/env python3
"""Recompute counts and paired outcomes from immutable educational trial logs."""
import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import json
from pathlib import Path
import statistics

from verifier import judge, stable_json


def load(path):
    return json.loads(path.read_text())


def analyze(root):
    result={'hosts':{},'paired_differences':[]}
    paired={}
    csv_rows=[]
    for host in ('web','desktop'):
        folder=root/host
        manifest=load(folder/'manifest.json')
        if manifest['status']!='completed' or manifest['source_changes'] or manifest['blocked_network_attempts']:
            raise ValueError(f'Invalid source/network/run status: {host}')
        for name,expected in manifest['source_hashes'].items():
            if hashlib.sha256((folder/'source'/name).read_bytes()).hexdigest()!=expected:
                raise ValueError(f'Source archive mismatch: {host}/{name}')
        snapshots=load(folder/'snapshots.json')
        rows=[json.loads(line) for line in (folder/'trials.jsonl').read_text().splitlines()]
        counts=Counter((r['snapshot'],r['variant'],r['budget'],r['repeat']) for r in rows)
        if any(value!=1 for value in counts.values()):raise ValueError('Duplicate trial IDs')
        expected=len(snapshots)*7*len(manifest['arguments']['budgets'])*manifest['arguments']['repetitions']
        if len(rows)!=expected:raise ValueError(f'Incomplete trial matrix: {host}')
        for row in rows:
            for layer in ('delivery','planning'):
                for c in row['scores'][layer]:
                    if judge({'actual':c['actual']},{**c,'path':['actual']})['passed']!=c['passed']:
                        raise ValueError('Stored verifier result cannot be recomputed')
        by_condition=defaultdict(list)
        for row in rows:
            by_condition[(row['snapshot'],row['variant'],row['budget'])].append(row)
        unstable=[key for key,values in by_condition.items() if len({r['semantic_hash'] for r in values})!=1]
        primary=[r for r in rows if r['repeat']==0]
        paired[host]={(r['snapshot'],r['variant'],r['budget']):r for r in primary}
        family=[]
        for (name,variant,budget),values in _group(primary,lambda r:(r['family'],r['variant'],r['budget'])).items():
            for layer in ('delivery','planning'):
                checks=[c for r in values for c in r['scores'][layer]]
                if not checks:continue
                out={'host':host,'family':name,'variant':variant,'budget':budget,'layer':layer,
                    'passed':sum(c['passed'] for c in checks),'total':len(checks)}
                family.append(out);csv_rows.append(out)
        aggregate=[]
        for (variant,budget),values in _group(primary,lambda r:(r['variant'],r['budget'])).items():
            checks=[c for r in values for c in r['scores']['delivery']]
            positive=[c for c in checks if c['op'] in {'some','evidence'}]
            negative=[c for c in checks if c['op'] not in {'some','evidence'}]
            plans=[c for r in values for c in r['scores']['planning']]
            aggregate.append({'variant':variant,'budget':budget,
                'delivery_positive':[sum(c['passed'] for c in positive),len(positive)],
                'delivery_negative':[sum(c['passed'] for c in negative),len(negative)],
                'planning':[sum(c['passed'] for c in plans),len(plans)],
                'latency_median_ms':statistics.median(r['latency_ms'] for r in values),
                'packet_characters_mean':statistics.mean(r['packet_characters'] for r in values),
                'budget_failures':sum(not r['budget_ok'] for r in values),
                'audit_violations':sum(bool(r['violations']) for r in values)})
        last={s['learner']:s for s in snapshots}
        formation=[c for s in snapshots for c in s['formation']]
        result['hosts'][host]={'source_revision':manifest['git_head'],'snapshot_count':len(snapshots),'trial_count':len(rows),
            'formation':[sum(c['passed'] for c in formation),len(formation)],
            'formation_failures':[{'snapshot':s['id'],'check':c['name']} for s in snapshots for c in s['formation'] if not c['passed']],
            'measured_last_states':{key:sum(s['observed'][key] for s in last.values()) for key in
                ['event_count','mutation_count','fact_count','attempt_count','module_count','claim_count']},
            'repeat_instability':unstable,'aggregate':aggregate,'families':family,
            'raw_checks_recomputed':sum(len(r['scores'][layer]) for r in rows for layer in ('delivery','planning'))}
    for key,left in paired['web'].items():
        right=paired['desktop'].get(key)
        # Source registry strings/audit IDs can differ across hosts. Compare
        # declared educational outcomes separately from full semantic hashes.
        left_outcomes={layer:[c['passed'] for c in left['scores'][layer]] for layer in ('delivery','planning')}
        right_outcomes={layer:[c['passed'] for c in right['scores'][layer]] for layer in ('delivery','planning')} if right else None
        if left_outcomes!=right_outcomes:result['paired_differences'].append(key)
    result['semantic_hash_differences']=sum(r['semantic_hash']!=paired['desktop'][key]['semantic_hash'] for key,r in paired['web'].items())
    result['paired_condition_count']=len(paired['web'])
    (root/'derived-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    with (root/'scenario-results.csv').open('w',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=list(csv_rows[0]));writer.writeheader();writer.writerows(csv_rows)
    return result


def _group(rows,key):
    result=defaultdict(list)
    for row in rows:result[key(row)].append(row)
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('directory',type=Path)
    args=parser.parse_args();result=analyze(args.directory)
    print(stable_json({host:{key:data[key] for key in ['snapshot_count','trial_count','formation']} for host,data in result['hosts'].items()}))
    print('paired outcome differences:',len(result['paired_differences']))
