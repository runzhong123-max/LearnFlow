#!/usr/bin/env python3
"""Compare every non-timing result and full packet; preserve failed-case evidence."""
import argparse
import csv
import hashlib
import json
from pathlib import Path


def read_rows(root):
    return [json.loads(line) for line in (root/'queries.jsonl').open()]


def key(row):
    return row['case_id'], row['budget'], row['variant']


def main(web, desktop, baseline, output):
    output.mkdir(parents=True, exist_ok=False)
    summaries=[json.loads((p/'summary.json').read_text()) for p in (web,desktop,baseline)]
    assert len({s['fixture_sha256'] for s in summaries})==1, 'Fixture/gold differ'
    wr,dr,br=map(read_rows,(web,desktop,baseline))
    wm,dm={key(r):r for r in wr},{key(r):r for r in dr}
    differences=[]
    for k in sorted(wm.keys()|dm.keys()):
        a={n:v for n,v in wm.get(k,{}).items() if n!='latency_ms'}
        b={n:v for n,v in dm.get(k,{}).items() if n!='latency_ms'}
        if a!=b: differences.append(k)
    packet_differences=0;count=0
    from itertools import zip_longest
    with (web/'packets.jsonl').open() as a,(desktop/'packets.jsonl').open() as b:
        for x,y in zip_longest(a,b):
            count+=1
            if x is None or y is None or json.loads(x)!=json.loads(y):packet_differences+=1
    cache_differences=[]
    for k,r in wm.items():
        if r['variant']!='no_head_cache':continue
        full=wm[(r['case_id'],r['budget'],'full')]
        ignore={'variant','latency_ms'}
        if {n:v for n,v in r.items() if n not in ignore}!={n:v for n,v in full.items() if n not in ignore}:
            cache_differences.append(k)
    result={'fixture_sha256':summaries[0]['fixture_sha256'],'paired_conditions':len(wm),
        'result_differences':differences,'packet_pairs':count,'packet_differences':packet_differences,
        'cache_result_differences':cache_differences,
        'baseline_conditions':len(br),'product_commits':[s['code_commit'] for s in summaries]}
    (output/'audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    failures=[]
    for label,rows in [('web',wr),('desktop',dr),('baseline',br)]:
        for r in rows:
            if (r['complete'] is False or r['violations'] or r['adaptation_ok'] is False
                or r['empty_on_uncovered'] is False or not r['budget_ok'] or not r['repeat_stable']):
                failures.append({'host':label,**r})
    with (output/'failures.jsonl').open('w') as f:
        for r in failures:f.write(json.dumps(r,ensure_ascii=False)+'\n')
    with (output/'all-summary.csv').open('w',newline='') as f:
        rows=[{'host':name,**r} for name,s in zip(('web','desktop','baseline'),summaries) for r in s['summary']]
        writer=csv.DictWriter(f,fieldnames=rows[0]);writer.writeheader();writer.writerows(rows)
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('web','desktop','baseline','output'):p.add_argument('--'+name,type=Path,required=True)
    a=p.parse_args();main(a.web,a.desktop,a.baseline,a.output)
