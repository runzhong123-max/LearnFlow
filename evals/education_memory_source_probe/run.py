#!/usr/bin/env python3
"""Prepare, freeze, then execute a post-hoc native Fact reading probe."""
import argparse
import asyncio
from collections import defaultdict
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import sys
import time
import traceback
from unittest.mock import patch

from verifier import verify
HERE=Path(__file__).resolve().parent
VERSION='learnflow.native-source-probe.v1'
VARIANTS=('legacy','source');BUDGETS=(1800,3200)

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def save(path,value):Path(path).write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n')
def line(stream,value):stream.write(json.dumps(value,ensure_ascii=False,sort_keys=True,default=str,allow_nan=False)+'\n');stream.flush()
def sources(repo):
    paths={p for base in (repo/'backend/app',repo/'packages/learning-core/src/learnflow_core') for p in base.rglob('*.py')}
    result={str(p.resolve()):sha(p) for p in sorted(paths)}
    result.update({str(p.resolve()):sha(p) for p in sorted(HERE.rglob('*')) if p.is_file() and p.suffix in ('.py','.md','.jsonl') and 'results' not in p.parts})
    return result

class ClockMeta(type):
    def __instancecheck__(self,value):return isinstance(value,datetime)
class Clock(datetime,metaclass=ClockMeta):
    fixed=datetime(2026,9,1,12)
    @classmethod
    def utcnow(cls):return cls.fixed
    @classmethod
    def now(cls,tz=None):return cls.fixed.replace(tzinfo=timezone.utc).astimezone(tz) if tz else cls.fixed
@contextmanager
def fixed_clock():
    changed=[]
    for name,module in list(sys.modules.items()):
        if name.startswith(('app.','learnflow_core.')) and getattr(module,'datetime',None) is datetime:
            changed.append(module);module.datetime=Clock
    try:yield
    finally:
        for module in changed:module.datetime=datetime


def prepare(args):
    out=args.output.resolve();repo=args.repo.resolve();out.mkdir(parents=True,exist_ok=False)
    cases=[json.loads(s) for s in (HERE/'data/cases.jsonl').read_text().splitlines()]
    assert len(cases)==24 and len({c['case_id'] for c in cases})==24
    shutil.copyfile(HERE/'PROTOCOL.md',out/'PROTOCOL.md');shutil.copyfile(HERE/'data/cases.jsonl',out/'cases.jsonl')
    plan={'schema':VERSION,'status':'planned_not_executed','post_hoc':True,'repo':str(repo),'output':str(out),
      'source_hashes':sources(repo),'data_sha256':sha(out/'cases.jsonl'),'protocol_sha256':sha(out/'PROTOCOL.md'),
      'case_ids':[c['case_id'] for c in cases],'variants':VARIANTS,'budgets':BUDGETS,'expected_conditions':96,
      'condition_order_seed':20260913,'python':sys.executable,'python_version':sys.version,
      'created_at_utc':datetime.now(timezone.utc).isoformat(),'model_required':False,'formal03_unchanged':True}
    save(out/'manifest.json',plan);print(json.dumps({'status':plan['status'],'output':str(out),'cases':24,'conditions':96}))


async def execute_cases(repo,out,manifest,network,model_calls):
    sys.path[:0]=[str(repo/'backend'),str(repo/'packages/learning-core/src')]
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
    import app.models
    from app.db.database import Base
    from app.models.learning import Learner,AgentSession,EvidenceEvent,KernelMutation,KernelState,MemoryFact,MemoryNode
    from app.models.project import Project,Roadmap,Checkpoint
    from app.services.learning_runtime import record_event
    from app.services import five_kernel_context as core
    from learnflow_core import memory_candidates
    assert Path(core.__file__).resolve()==repo/'packages/learning-core/src/learnflow_core/five_kernel_context.py'
    def model_forbidden(*a,**kw):model_calls.append('attempt');raise RuntimeError('Probe forbids semantic model execution')
    tables={'events':EvidenceEvent,'mutations':KernelMutation,'states':KernelState,'facts':MemoryFact,'nodes':MemoryNode,'projects':Project,'roadmaps':Roadmap,'checkpoints':Checkpoint,'sessions':AgentSession}
    async def snapshot(db):
        result={}
        for name,model in tables.items():
            rows=(await db.execute(select(model))).scalars().all()
            result[name]=[{column.name:getattr(row,column.name).isoformat() if isinstance(getattr(row,column.name),datetime) else getattr(row,column.name) for column in model.__table__.columns} for row in rows]
        return result
    async def setup_scope(db,learner,label):
        project=Project(learner_id=learner.id,name=label);db.add(project);await db.flush()
        roadmap=Roadmap(project_id=project.id);db.add(roadmap);await db.flush()
        checkpoint=Checkpoint(roadmap_id=roadmap.id,title=label,order=1);db.add(checkpoint);await db.flush()
        session=AgentSession(learner_id=learner.id,project_id=project.id,checkpoint_id=checkpoint.id,session_type='checkpoint',title=label);db.add(session);await db.flush()
        return {'learner_id':learner.id,'project_id':project.id,'checkpoint_id':checkpoint.id,'session_id':session.id}
    cases=[json.loads(s) for s in (out/'cases.jsonl').read_text().splitlines()];all_rows=[];order_rng=random.Random(20260913)
    with (out/'trials.jsonl').open('x') as trials,(out/'errors.jsonl').open('x') as errors,gzip.open(out/'formation.jsonl.gz','xt') as forms,gzip.open(out/'packets.jsonl.gz','xt') as packets,patch.object(memory_candidates,'_load_encoder',model_forbidden):
        for case in cases:
            engine=create_async_engine('sqlite+aiosqlite:///:memory:');formed=None;scope=None;target_id=None
            jobs=[(v,b) for v in VARIANTS for b in BUDGETS];order_rng.shuffle(jobs)
            try:
                async with engine.begin() as conn:await conn.run_sync(Base.metadata.create_all)
                factory=async_sessionmaker(engine,expire_on_commit=False)
                async with factory() as db:
                    people=[Learner(key=case['case_id']+'-owner'),Learner(key=case['case_id']+'-other')];db.add_all(people);await db.flush()
                    scope=await setup_scope(db,people[0],case['topic']);other_project=await setup_scope(db,people[0],'cross-project');other_learner=await setup_scope(db,people[1],'cross-learner')
                    with fixed_clock():
                        for index,(s,text,tag) in enumerate(((scope,case['text'],'target'),(scope,'我不懂另一门课程的练习安排，先记录普通术语清单。','distractor'),(other_project,case['text']+'跨项目禁入标记','foreign-project'),(other_learner,case['text']+'跨学习者禁入标记','foreign-learner'))):
                            event=await record_event(db,**s,event_type='user_message',source='user',payload={'text':text},occurred_at=datetime(2026,9,1,9)+timedelta(minutes=index),client_event_id=case['case_id']+'-'+tag)
                            if tag=='target':target_id=event.id
                        await db.commit()
                    formed=await snapshot(db);line(forms,{'case_id':case['case_id'],'scope':scope,'target_event_id':target_id,'state':formed})
                for variant,budget in jobs:
                    identity={'case_id':case['case_id'],'topic_id':case['topic_id'],'pattern':case['pattern'],'variant':variant,'budget':budget};started=time.perf_counter();calls=[]
                    try:
                        original=core._node_metadata
                        async def tracked(db,identifiers):
                            calls.append(list(identifiers));return await original(db,identifiers)
                        async with factory() as db:
                            policy=replace(core.CONTEXT_POLICIES['checkpoint_tutor'],head_kernels=('knowledge',),deep_kernels=('knowledge',),max_items=4,max_paths=0,enable_episodes=False,token_budget=budget,enable_source_text=variant=='source',candidate_mode='legacy',enable_compact_episodes=False)
                            with fixed_clock(),patch.object(core,'_node_metadata',tracked):
                                packet=await core.build_five_kernel_context(db,**scope,query=case['query'],policy=policy)
                            after=await snapshot(db)
                            if after!=formed:raise RuntimeError('Authoritative snapshot changed during read')
                            await db.rollback()
                        count=packet.get('omitted',{}).get('candidate_count');sets=[sorted(set(c)) for c in calls if len(set(c))==count];candidate_ids=sets[-1] if sets else []
                        checked=verify(case,formed,packet,scope,target_id,candidate_ids,calls,budget)
                        row={**identity,'status':'completed','latency_ms':(time.perf_counter()-started)*1000,'candidate_pool_ids':candidate_ids,'metadata_candidate_calls':calls,**checked}
                        line(packets,{**identity,'packet':packet,'query':case['query'],'target_event_id':target_id})
                    except Exception as exc:
                        row={**identity,'status':'execution_error','checks_passed':False,'errors':[type(exc).__name__+': '+str(exc)],'metrics':{k:False for k in ('target_fact_delivered','term_delivered','qualifier_delivered','joint_term_qualifier_delivered','budget_ok','source_ranges_scope_chain_ok')},'traceback':traceback.format_exc()}
                        line(errors,row)
                    line(trials,row);all_rows.append(row)
            except Exception as exc:
                for variant,budget in jobs:
                    identity={'case_id':case['case_id'],'topic_id':case['topic_id'],'pattern':case['pattern'],'variant':variant,'budget':budget}
                    if any(all(row[k]==v for k,v in identity.items()) for row in all_rows):continue
                    row={**identity,'status':'formation_error','checks_passed':False,'errors':[type(exc).__name__+': '+str(exc)],'metrics':{k:False for k in ('target_fact_delivered','term_delivered','qualifier_delivered','joint_term_qualifier_delivered','budget_ok','source_ranges_scope_chain_ok')},'traceback':traceback.format_exc()};line(errors,row);line(trials,row);all_rows.append(row)
            finally:await engine.dispose()
            print(json.dumps({'case_id':case['case_id'],'conditions_finished':len(all_rows)}),flush=True)
    return all_rows


def report(rows,manifest,out):
    expected={(c,v,b) for c in manifest['case_ids'] for v in VARIANTS for b in BUDGETS};actual={(r['case_id'],r['variant'],r['budget']) for r in rows}
    matrix_ok=len(rows)==len(actual)==96 and actual==expected;indexed={(r['case_id'],r['variant'],r['budget']):r for r in rows};pairs=[]
    for cid in manifest['case_ids']:
        for budget in BUDGETS:
            a=indexed.get((cid,'legacy',budget));b=indexed.get((cid,'source',budget));equal=bool(a and b and a.get('candidate_pool_verified') and b.get('candidate_pool_verified') and a['candidate_pool_ids']==b['candidate_pool_ids'])
            pairs.append({'case_id':cid,'budget':budget,'candidate_sets_equal_and_verified':equal,'joint_delta':int(b['metrics']['joint_term_qualifier_delivered'])-int(a['metrics']['joint_term_qualifier_delivered']) if a and b else None})
    groups=[]
    for budget in BUDGETS:
        for pattern in ('early','tail','split_qualifier'):
            for variant in VARIANTS:
                group=[r for r in rows if (r['budget'],r['pattern'],r['variant'])==(budget,pattern,variant)]
                groups.append({'budget':budget,'pattern':pattern,'variant':variant,'conditions':len(group),'checks_passed':sum(r['checks_passed'] for r in group),'runtime_errors':sum(r['status']!='completed' for r in group),'metrics':{k:{'numerator':sum(bool(r['metrics'][k]) for r in group),'denominator':len(group)} for k in ('target_fact_delivered','term_delivered','qualifier_delivered','joint_term_qualifier_delivered')}})
    result={'schema':VERSION,'post_hoc':True,'formal03_scores_changed':False,'conditions':len(rows),'matrix_complete':matrix_ok,'candidate_pairs':pairs,'groups':groups,'all_checks_passed':matrix_ok and all(r['checks_passed'] for r in rows) and all(p['candidate_sets_equal_and_verified'] for p in pairs),'runtime_errors':sum(r['status']!='completed' for r in rows),'interpretation':'Post-hoc synthetic native Fact source-reader calibration only; no unseen evaluation, teacher judgement, learning gain, natural-language generalization, or addition to the Formal03 ranking.'}
    save(out/'aggregate.json',result)
    lines=['# 原生 Fact 原文读取机制：事后补充探针','',result['interpretation'],'',f"实际条件 {len(rows)}/96；完整矩阵 {matrix_ok}；全部检查通过 {result['all_checks_passed']}；运行错误 {result['runtime_errors']}。",f"同case/预算候选集合等价 {sum(p['candidate_sets_equal_and_verified'] for p in pairs)}/{len(pairs)}。",'','|预算|布局|配置|完整观察与限定同条交付|目标Fact交付|检查通过|','|---|---|---|---|---|---|']
    for g in groups:
        m=g['metrics'];joint=m['joint_term_qualifier_delivered'];target=m['target_fact_delivered'];lines.append(f"|{g['budget']}|{g['pattern']}|{g['variant']}|{joint['numerator']}/{joint['denominator']}|{target['numerator']}/{target['denominator']}|{g['checks_passed']}/{g['conditions']}|")
    lines+=['','观察和限定为作者预写的学习者自述；来源有效不等于稳定掌握。候选集合相等降低扫描范围混杂，但来源元数据/诊断开销仍计入预算。本结果不可并入Formal03排名。',f"网络尝试 {manifest.get('network_attempts')}；模型调用尝试 {manifest.get('model_attempts')}；源码漂移 {manifest.get('source_drift')}。",'']
    (out/'REPORT.md').write_text('\n'.join(lines));return result


def execute(args):
    out=args.output.resolve();manifest=json.loads((out/'manifest.json').read_text());repo=Path(manifest['repo']);network=[];models=[]
    if manifest['status']!='planned_not_executed' or sources(repo)!=manifest['source_hashes'] or sha(out/'cases.jsonl')!=manifest['data_sha256'] or sha(out/'PROTOCOL.md')!=manifest['protocol_sha256']:raise RuntimeError('Frozen source/data/protocol mismatch or output already used')
    os.environ.update(DATABASE_URL='sqlite+aiosqlite:///:memory:',LLM_API_KEY='',OPENAI_API_KEY='',ANTHROPIC_API_KEY='',GOOGLE_API_KEY='',GEMINI_API_KEY='',MEMORY_AUTO_SYNTHESIS_ENABLED='false',PYTHONDONTWRITEBYTECODE='1')
    sys.dont_write_bytecode=True
    active=[True]
    def audit(event,arguments):
        if not active[0]:return
        if event in ('socket.connect','socket.getaddrinfo'):
            network.append(event);raise RuntimeError('Network forbidden for source mechanism probe')
        if event=='sqlite3.connect' and str(arguments[0])!=':memory:':raise RuntimeError('Only disposable in-memory databases allowed')
    sys.addaudithook(audit);manifest['status']='running';save(out/'manifest.json',manifest)
    started=time.perf_counter()
    rows=[]
    try:rows=asyncio.run(execute_cases(repo,out,manifest,network,models))
    except Exception as exc:
        save(out/'fatal-error.json',{'error':type(exc).__name__+': '+str(exc),'traceback':traceback.format_exc()})
        if (out/'trials.jsonl').exists():rows=[json.loads(s) for s in (out/'trials.jsonl').read_text().splitlines()]
    finally:
        active[0]=False;current=sources(repo);manifest.update(network_attempts=len(network),model_attempts=len(models),elapsed_seconds=time.perf_counter()-started,source_drift=sorted(k for k in set(current)|set(manifest['source_hashes']) if current.get(k)!=manifest['source_hashes'].get(k)));save(out/'manifest.json',manifest)
    result=report(rows,manifest,out);manifest['status']='completed' if result['all_checks_passed'] and not network and not models and not manifest['source_drift'] else 'completed_with_failures';manifest['conditions_completed']=len(rows);save(out/'manifest.json',manifest)
    save(out/'artifact-manifest.json',{'schema':VERSION,'files':{str(p.relative_to(out)):sha(p) for p in sorted(out.rglob('*')) if p.is_file() and p.name!='artifact-manifest.json'}})
    print(json.dumps({'status':manifest['status'],'conditions':len(rows),'output':str(out)}));return 0 if manifest['status']=='completed' else 1

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('mode',choices=('prepare','execute'));parser.add_argument('--repo',type=Path,default=Path('/tmp/learnflow-memory-upgrade-20260913'));parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    if args.mode=='prepare':prepare(args)
    else:sys.exit(execute(args))
