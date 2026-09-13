"""Freeze, run all native cases, retain failures and independently reverify."""
from __future__ import annotations
import argparse
import asyncio
from collections import Counter
from datetime import datetime,timezone
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import sys

from .native import run_case
from .verifier import verify


def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def source_hashes(repo):
    files=[]
    for sub in ('backend/app','packages/learning-core/src','evals/five_kernel_capabilities'):
        for p in (repo/sub).rglob('*'):
            if p.is_file() and p.suffix in {'.py','.md','.json'} and not {'runs','__pycache__','.pytest_cache'} & set(p.relative_to(repo).parts):
                files.append(p)
    files.append(repo/'evals/education_memory_counterfactual/formation.py')
    return {str(p.relative_to(repo)):digest(p) for p in sorted(set(files))}


def write_json(path,value):path.write_text(json.dumps(value,ensure_ascii=False,indent=2,sort_keys=True)+'\n')


def aggregate(cases,raw):
    if len(raw)!=len(cases) or {r['case_id'] for r in raw}!={c['case_id'] for c in cases}:
        raise ValueError('case_completeness_failure')
    mapping={r['case_id']:r for r in raw}
    scores=[verify(c,mapping[c['case_id']]) for c in cases]
    by={}
    for kernel in ('structure','knowledge','human','value','practice'):
        group=[r for r in scores if r['kernel']==kernel]
        by[kernel]={'passed':sum(r['passed'] for r in group),'total':len(group),
                    'failed_case_ids':[r['case_id'] for r in group if not r['passed']]}
    return {'kind':'authored_native_capability_contract_audit','case_total':len(cases),
        'case_passed':sum(r['passed'] for r in scores),'by_kernel':by,
        'native_counts':{k:sum(r['counts'][k] for r in scores) for k in ('events','attempts','mutations','facts','nodes')},
        'known_scope_gaps':sum(len(r['formation_gaps']) for r in scores),'scores':scores,
        'limitations':['15 authored synthetic cases, not statistical performance estimates',
            'No representation ablation, no traditional memory benchmark, no learning-outcome claims',
            'No LLM or human evaluation; actual deterministic consumer only',
            'Formal concept API has no session parameter; raw gap retained',
            'Learning path API is learner-global, not checkpoint-scoped',
            'Temporary controls intentionally form no Fact; native mutation/state route audited',
            'No positive stable mastery, true transfer, synthesis, long-tail retrieval or full graph quality study']}


async def execute(args):
    repo=args.repo.resolve();out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
    cases=json.loads((repo/'evals/five_kernel_capabilities/cases.json').read_text())
    freeze={'schema':'five-kernel-capabilities.freeze.v1','created_at':datetime.now(timezone.utc).isoformat(),
        'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),
        'source_hashes':source_hashes(repo),'case_ids':[c['case_id'] for c in cases],
        'python':sys.executable,'execution':'sequential_offline_native_memory_database','status':'frozen_before_native_execution'}
    write_json(out/'freeze.json',freeze)
    raw=[]
    with gzip.open(out/'native.jsonl.gz','wt',encoding='utf-8') as stream:
        for case in cases:
            result=await run_case(case,repo);raw.append(result)
            stream.write(json.dumps(result,ensure_ascii=False,sort_keys=True,default=str)+'\n');stream.flush()
            print(json.dumps({'case_id':case['case_id'],'native_status':result['status']},ensure_ascii=False),flush=True)
    result=aggregate(cases,raw)
    result['source_unchanged']=source_hashes(repo)==freeze['source_hashes']
    result['frozen_head']=freeze['head'];result['freeze_sha256']=digest(out/'freeze.json')
    # Reopen bytes and reverify instead of trusting in-memory scoring alone.
    with gzip.open(out/'native.jsonl.gz','rt',encoding='utf-8') as f:reopened=[json.loads(line) for line in f]
    result['reverification_equal']=aggregate(cases,reopened)=={k:v for k,v in result.items() if k not in {'source_unchanged','frozen_head','freeze_sha256'}}
    write_json(out/'aggregate.json',result)
    lines=['# 五核原生能力契约核验结果','',
        f"代码基线 `{freeze['head']}`；{result['case_total']} 个预声明作者合成案例，{result['case_passed']} 个通过。",
        f"源码冻结后未变化：{result['source_unchanged']}；原始字节重开核验一致：{result['reverification_equal']}。",
        '', '| 核 | 通过/案例 | 失败案例 |','|---|---:|---|']
    for k,g in result['by_kernel'].items():lines.append(f"| {k} | {g['passed']}/{g['total']} | {', '.join(g['failed_case_ids']) or '无'} |")
    lines+=['',f"原生行计数：{json.dumps(result['native_counts'],ensure_ascii=False)}。概念 API session 缺口 {result['known_scope_gaps']} 条。",
            '', '所有失败和断言原值均保留在 aggregate.json；完整 Event/Attempt/Mutation/Fact/Node、路径 API 返回、上下文和真实计划保留在 native.jsonl.gz。',
            '', '这是源链与确定性消费者的能力契约核验。通过说明所列具体输入被现有系统正确处理，不证明五核表示最优、通用检索优势或真实学习收益。',
            '', '## 未覆盖与边界','',*['- '+s for s in result['limitations']]]
    (out/'REPORT.md').write_text('\n'.join(lines)+'\n')
    write_json(out/'artifact-manifest.json',{'files':{p.name:digest(p) for p in sorted(out.iterdir()) if p.is_file()}})
    print(json.dumps({'output':str(out),'passed':result['case_passed'],'total':result['case_total'],'source_unchanged':result['source_unchanged']}))
    return 0 if result['source_unchanged'] and result['reverification_equal'] else 2


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--repo',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();return asyncio.run(execute(args))


if __name__=='__main__':raise SystemExit(main())
