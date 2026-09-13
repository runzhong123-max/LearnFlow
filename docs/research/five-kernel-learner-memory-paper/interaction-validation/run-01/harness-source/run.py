"""Freeze before native execution; never overwrite runs or discard failures."""
import argparse
import asyncio
from datetime import datetime,timezone
import gzip
import hashlib
import importlib.metadata
import json
from pathlib import Path
import subprocess
import sys
from .native import run_case
from .verifier import verify


def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def write(path,obj):path.write_text(json.dumps(obj,ensure_ascii=False,sort_keys=True,indent=2)+'\n')


def source_hashes(repo):
    paths=[]
    for root in ('backend/app','packages/learning-core/src','evals/five_kernel_interactions'):
        paths.extend(p for p in (repo/root).rglob('*') if p.is_file() and p.suffix in {'.py','.md','.json'}
                     and not {'runs','__pycache__','.pytest_cache'} & set(p.relative_to(repo).parts))
    paths.append(repo/'evals/education_memory_counterfactual/formation.py')
    return {str(p.relative_to(repo)):sha(p) for p in sorted(set(paths))}


def aggregate(cases,raw):
    if len(raw)!=len(cases) or len({r['case_id'] for r in raw})!=len(cases) or {r['case_id'] for r in raw}!={c['case_id'] for c in cases}:
        raise ValueError('case_completeness_failure')
    mapping={r['case_id']:r for r in raw};scores=[verify(c,mapping[c['case_id']]) for c in cases]
    groups={}
    for purpose in sorted({c['purpose'] for c in cases}):
        rows=[s for s in scores if s['purpose']==purpose]
        groups[purpose]={'total':len(rows),'passed':sum(s['passed'] for s in rows),'failed_case_ids':[s['case_id'] for s in rows if not s['passed']]}
    return {'kind':'authored_native_business_interaction_validation','total':len(cases),'passed':sum(s['passed'] for s in scores),
        'execution_complete_count':sum(r.get('status')=='executed' for r in raw),
        'infrastructure_error_count':sum(r.get('status')=='infrastructure_error' for r in raw),
        'incomplete_operation_case_count':sum(r.get('status')=='executed_with_errors' for r in raw),
        'groups':groups,'scores':scores,'native_counts':{k:sum(s['counts'][k] for s in scores) for k in ('events','attempts','schedules','mutations','facts','nodes')},
        'case_assertions':sum(len(s['checks']) for s in scores),'null_session_assessment_count':sum(s['known_null_session_grade_count'] for s in scores),
        'limitations':['14 authored scenarios, not an empirical long-tail population',
            'No human learning benefit, teacher rating, LLM comparison, UI or HTTP middleware evaluation',
            'Validated variants are fixed author-computed closed-choice metadata, not independently validated transfer difficulty',
            'Native review/assessment lacks session field; path API is learner-global',
            'Safety challenge long-term invalidation is a predeclared author criterion, not an existing product guarantee']}


async def execute(args):
    repo=args.repo.resolve();out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
    cases=json.loads((repo/'evals/five_kernel_interactions/cases.json').read_text())
    freeze={'schema':'five-kernel-interactions.freeze.v1','at':datetime.now(timezone.utc).isoformat(),
        'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),
        'python':sys.version,'executable':sys.executable,
        'dependencies':{name:importlib.metadata.version(name) for name in ('sqlalchemy','aiosqlite','fastapi','pydantic')},
        'source_hashes':source_hashes(repo),'case_ids':[c['case_id'] for c in cases],
        'status':'frozen_before_native_execution'}
    write(out/'freeze.json',freeze)
    # Preserve the complete exact harness for any diagnostic/reproduction run.
    snapshot=out/'harness-source';snapshot.mkdir()
    for name,digest in freeze['source_hashes'].items():
        if name.startswith('evals/five_kernel_interactions/'):
            (snapshot/Path(name).name).write_bytes((repo/name).read_bytes())
    raw=[]
    with gzip.open(out/'native.jsonl.gz','wt',encoding='utf-8') as f:
        for case in cases:
            row=await run_case(case,repo);raw.append(row);f.write(json.dumps(row,ensure_ascii=False,sort_keys=True,default=str)+'\n');f.flush()
            print(json.dumps({'case_id':case['case_id'],'execution_status':row['status']}),flush=True)
    result=aggregate(cases,raw)
    with gzip.open(out/'native.jsonl.gz','rt',encoding='utf-8') as f:reopened=[json.loads(x) for x in f]
    result['reverification_equal']=aggregate(cases,reopened)=={k:v for k,v in result.items() if k!='reverification_equal'}
    result['source_unchanged']=source_hashes(repo)==freeze['source_hashes'];result['frozen_head']=freeze['head']
    write(out/'aggregate.json',result)
    lines=['# 五核业务对象交互验证','',f"最终 {result['passed']}/{result['total']} 个案例通过。所有失败均保留。",
        f"源码冻结无变化：{result['source_unchanged']}；原始字节重开复算一致：{result['reverification_equal']}。",
        f"业务步骤完整执行 {result['execution_complete_count']}/{result['total']}；基础设施错误 {result['infrastructure_error_count']}；含未完成操作的案例 {result['incomplete_operation_case_count']}。",'',
        '| 类别 | 通过/分母 | 未通过案例 |','|---|---:|---|']
    for k,g in result['groups'].items():lines.append(f"| {k} | {g['passed']}/{g['total']} | {', '.join(g['failed_case_ids']) or '无'} |")
    lines+=['',f"实际原生行：{result['native_counts']}；无 session 的真实评估事件 {result['null_session_assessment_count']} 条。",'',
        '## 失败明细','']
    for s in result['scores']:
        if s['passed']:continue
        lines+=[f"- {s['case_id']}：来源门 {s['chain_errors']}；字段失败 "+json.dumps([x for x in s['checks'] if not x['passed']],ensure_ascii=False)]
    lines+=['','## 限制','',*['- '+x for x in result['limitations']]]
    (out/'REPORT.md').write_text('\n'.join(lines)+'\n')
    write(out/'artifact-manifest.json',{'files':{str(p.relative_to(out)):sha(p) for p in sorted(out.rglob('*')) if p.is_file()}})
    print(json.dumps({'output':str(out),'passed':result['passed'],'total':result['total'],'source_unchanged':result['source_unchanged'],'reverification_equal':result['reverification_equal']}))
    if not result['source_unchanged'] or not result['reverification_equal']:return 2
    return 0 if result['execution_complete_count']==len(cases) else 3


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--repo',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    raise SystemExit(asyncio.run(execute(parser.parse_args())))
