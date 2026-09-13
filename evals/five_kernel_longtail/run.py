"""Freeze and run bounded, offline native educational long-tail retrieval."""
import argparse
import asyncio
from collections import defaultdict
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime,timedelta,timezone
import gzip
import hashlib
import inspect
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys
import time
import traceback
from unittest.mock import patch

try:
    from .generate import HISTORIES,BUDGETS,noise,variants
    from .verifier import audit_formation,verify
except ImportError:
    from generate import HISTORIES,BUDGETS,noise,variants
    from verifier import audit_formation,verify

HERE=Path(__file__).resolve().parent
VERSION='learnflow.native-knowledge-longtail.v1'
READ_AT=datetime(2026,9,1,12)


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def save(path,value):Path(path).write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+'\n')
def line(stream,value):stream.write(json.dumps(value,ensure_ascii=False,sort_keys=True,default=str,allow_nan=False)+'\n');stream.flush()
def sources(repo):
    paths={p for root in (repo/'backend/app',repo/'packages/learning-core/src/learnflow_core',HERE) for p in root.rglob('*') if p.is_file() and p.suffix in ('.py','.md','.jsonl') and 'results' not in p.parts and '__pycache__' not in p.parts}
    return {str(p.resolve()):sha(p) for p in sorted(paths)}
def expected_jobs(rows):
    return {(r['id'],q['id'],h,v,b) for r in rows for q in r['queries'] for h in HISTORIES for v in variants(q) for b in BUDGETS}


class ClockMeta(type):
    def __instancecheck__(self,value):return isinstance(value,datetime)
class Clock(datetime,metaclass=ClockMeta):
    @classmethod
    def utcnow(cls):return READ_AT
    @classmethod
    def now(cls,tz=None):return READ_AT.replace(tzinfo=timezone.utc).astimezone(tz) if tz else READ_AT
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
    repo=args.repo.resolve();out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
    rows=[json.loads(s) for s in (HERE/'data/scenarios.jsonl').read_text().splitlines()]
    assert len(rows)==12 and len({r['id'] for r in rows})==12
    for name,source in [('PROTOCOL.md',HERE/'PROTOCOL.md'),('scenarios.jsonl',HERE/'data/scenarios.jsonl')]:shutil.copyfile(source,out/name)
    manifest={'schema':VERSION,'status':'planned_not_executed','repo':str(repo),'output':str(out),
      'code_commit':subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip(),
      'source_hashes':sources(repo),'data_sha256':sha(out/'scenarios.jsonl'),'protocol_sha256':sha(out/'PROTOCOL.md'),
      'scenario_count':len(rows),'query_count':sum(len(r['queries']) for r in rows),'histories':HISTORIES,'budgets':BUDGETS,
      'expected_conditions':len(expected_jobs(rows)),'condition_order_seed':20260913,'python':sys.executable,'python_version':sys.version,
      'created_at_utc':datetime.now(timezone.utc).isoformat(),'model_required':False,'scope':'native knowledge self-report text retrieval',
      'natural_longtail_frequency_measured':False,'source_changes_candidate_pool':True}
    save(out/'manifest.json',manifest);print(json.dumps({'status':manifest['status'],'conditions':manifest['expected_conditions'],'output':str(out)}))


async def execute_cases(repo,out,manifest,network,model_calls):
    sys.path[:0]=[str(repo/'backend'),str(repo/'packages/learning-core/src')]
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
    import app.models
    from app.db.database import Base
    from app.models.learning import Learner,AgentSession,EvidenceEvent,KernelMutation,KernelState,MemoryFact,MemoryNode,MemoryEdge,MemoryModule,MemoryClaim,LearningAttempt
    from app.models.project import Project,Roadmap,Checkpoint
    from app.services.learning_runtime import record_event
    from app.services import five_kernel_context as core
    from learnflow_core import memory_candidates
    assert Path(core.__file__).resolve()==repo/'packages/learning-core/src/learnflow_core/five_kernel_context.py'
    def model_forbidden(*a,**kw):model_calls.append('semantic_encoder');raise RuntimeError('Offline longtail evaluation forbids models')
    tables={'events':EvidenceEvent,'mutations':KernelMutation,'states':KernelState,'facts':MemoryFact,'nodes':MemoryNode,
      'projects':Project,'roadmaps':Roadmap,'checkpoints':Checkpoint,'sessions':AgentSession,'edges':MemoryEdge,'modules':MemoryModule,'claims':MemoryClaim,'attempts':LearningAttempt}
    async def snapshot(db):
        result={}
        for name,model in tables.items():
            values=(await db.execute(select(model))).scalars().all()
            result[name]=[{c.name:getattr(v,c.name).isoformat() if isinstance(getattr(v,c.name),datetime) else getattr(v,c.name) for c in model.__table__.columns} for v in values]
        return result
    async def scope(db,learner,label,project=None,checkpoint=None):
        if project is None:
            project=Project(learner_id=learner.id,name=label);db.add(project);await db.flush()
        if checkpoint is None:
            roadmap=await db.scalar(select(Roadmap).where(Roadmap.project_id==project.id))
            if roadmap is None:roadmap=Roadmap(project_id=project.id);db.add(roadmap);await db.flush()
            checkpoint=Checkpoint(roadmap_id=roadmap.id,title=label,order=1);db.add(checkpoint);await db.flush()
        session=AgentSession(learner_id=learner.id,project_id=project.id,checkpoint_id=checkpoint.id,session_type='checkpoint',title=label);db.add(session);await db.flush()
        return {'learner_id':learner.id,'project_id':project.id,'checkpoint_id':checkpoint.id,'session_id':session.id},project,checkpoint
    rows=[json.loads(s) for s in (out/'scenarios.jsonl').read_text().splitlines()];all_rows=[];rng=random.Random(20260913)
    with (out/'trials.jsonl').open('x') as trials,(out/'errors.jsonl').open('x') as errors,gzip.open(out/'formation.jsonl.gz','xt') as forms,gzip.open(out/'packets.jsonl.gz','xt') as packets,patch.object(memory_candidates,'_load_encoder',model_forbidden):
        for case in rows:
            for history in HISTORIES:
                engine=create_async_engine('sqlite+aiosqlite:///:memory:');formed=None;operations=[];formation=None
                jobs=[(q,v,b) for q in case['queries'] for v in variants(q) for b in BUDGETS];rng.shuffle(jobs)
                try:
                    async with engine.begin() as conn:await conn.run_sync(Base.metadata.create_all)
                    factory=async_sessionmaker(engine,expire_on_commit=False)
                    async with factory() as db:
                        owner=Learner(key=case['id']+'-owner');other=Learner(key=case['id']+'-other');db.add_all([owner,other]);await db.flush()
                        owned,project,checkpoint=await scope(db,owner,case['topic'])
                        foreign_project,_,_=await scope(db,owner,'foreign-project')
                        foreign_checkpoint,_,_=await scope(db,owner,'foreign-checkpoint',project=project)
                        foreign_learner,_,_=await scope(db,other,'foreign-learner')
                        target_events={};foreign_markers=[]
                        async def record(identifier,s,text,at):
                            event=await record_event(db,**s,event_type='user_message',source='user',payload={'text':text},occurred_at=at,client_event_id=f'{case["id"]}-{history}-{identifier}')
                            operations.append({'id':identifier,'scope':dict(s),'text':text,'event_id':event.id,'occurred_at':at.isoformat()})
                            target_events[identifier]=event.id
                        with fixed_clock():
                            for index,(key,text) in enumerate(case['events'].items()):
                                if key!='current':await record(key,owned,text,datetime(2026,6,1,9)+timedelta(minutes=index))
                            for index in range(history):await record(f'noise-{index}',owned,noise(case,index),datetime(2026,8,31,8)+timedelta(minutes=index))
                            for index,(kind,s) in enumerate((('project',foreign_project),('checkpoint',foreign_checkpoint),('learner',foreign_learner))):
                                marker='禁入来源'+kind+'_'+case['id'];foreign_markers.append(marker)
                                text='我不懂'+case['queries'][0]['query']+'。'+marker+'。这个范围有更强词项匹配，但不属于当前学习现场。'
                                await record('foreign-'+kind,s,text,datetime(2026,9,1,10)+timedelta(minutes=index))
                            if 'current' in case['events']:await record('current',owned,case['events']['current'],datetime(2026,9,1,11))
                            await db.commit()
                        formed=await snapshot(db);formation=audit_formation(formed,operations,owned)
                        line(forms,{'scenario_id':case['id'],'family':case['family'],'history':history,'scope':owned,'operations':operations,'state':formed,'audit':formation})
                        if not formation['checks_passed']:raise RuntimeError('Formation verification failed: '+str(formation['errors'][:12]))
                    for q,variant,budget in jobs:
                        identity={'scenario_id':case['id'],'query_id':q['id'],'family':case['family'],'history':history,'variant':variant,'budget':budget};started=time.perf_counter();calls=[]
                        try:
                            original=core._node_metadata
                            async def tracked(db,ids):
                                identifiers=list(ids);caller=inspect.currentframe().f_back
                                calls.append({'ids':identifiers,'caller_function':caller.f_code.co_name,'caller_line':caller.f_lineno})
                                return await original(db,identifiers)
                            changes={'token_budget':budget,'enable_source_text':variant.startswith('source')}
                            if '_no_' in variant:changes['enable_'+variant.split('_no_',1)[1]]=False
                            policy=replace(core.CONTEXT_POLICIES['checkpoint_tutor'],**changes)
                            async with factory() as db:
                                with fixed_clock(),patch.object(core,'_node_metadata',tracked):
                                    # Only natural query and actual session coordinates cross
                                    # the production boundary. No gold ids/terms/subjects.
                                    packet=await core.build_five_kernel_context(db,**owned,query=q['query'],policy=policy)
                                after=await snapshot(db)
                                if after!=formed:raise RuntimeError('Authoritative snapshot changed during read')
                                await db.rollback()
                            target_event=target_events.get(q['target_operation']) if q['target_operation'] else None
                            checked=verify(q,formed,packet,owned,target_event,calls,budget,foreign_markers)
                            row={**identity,'status':'completed','latency_ms':(time.perf_counter()-started)*1000,
                                 'target_event_id':target_event,'metadata_candidate_calls':calls,
                                 'retrieval_diagnostics':packet.get('retrieval_diagnostics'),**checked}
                            line(packets,{**identity,'query':q['query'],'scope':owned,'packet':packet,'target_event_id':target_event})
                        except Exception as exc:
                            row={**identity,'status':'execution_error','checks_passed':False,'errors':[type(exc).__name__+': '+str(exc)],'metrics':{},'traceback':traceback.format_exc()};line(errors,row)
                        line(trials,row);all_rows.append(row)
                except Exception as exc:
                    for q,v,b in jobs:
                        identity={'scenario_id':case['id'],'query_id':q['id'],'family':case['family'],'history':history,'variant':v,'budget':b}
                        if any(all(row[k]==value for k,value in identity.items()) for row in all_rows):continue
                        row={**identity,'status':'formation_error','checks_passed':False,'errors':[type(exc).__name__+': '+str(exc)],'metrics':{},'traceback':traceback.format_exc()};line(errors,row);line(trials,row);all_rows.append(row)
                finally:await engine.dispose()
                print(json.dumps({'scenario_id':case['id'],'history':history,'conditions_finished':len(all_rows),'formation_ok':bool(formation and formation['checks_passed'])}),flush=True)
    return all_rows


def reverify_saved(out):
    """Reopen raw artifacts and re-score without importing product modules."""
    cases=[json.loads(s) for s in (out/'scenarios.jsonl').read_text().splitlines()]
    raw_rows=[json.loads(s) for s in (out/'trials.jsonl').read_text().splitlines()]
    with gzip.open(out/'formation.jsonl.gz','rt') as stream:forms=[json.loads(s) for s in stream]
    with gzip.open(out/'packets.jsonl.gz','rt') as stream:packets=[json.loads(s) for s in stream]
    case_by_id={c['id']:c for c in cases};formed={(r['scenario_id'],r['history']):r for r in forms}
    fields=('scenario_id','query_id','history','variant','budget')
    def key(row):return tuple(row[f] for f in fields)
    packet_map={key(r):r for r in packets};trial_map={key(r):r for r in raw_rows};errors=[]
    expected=expected_jobs(cases)
    if set(trial_map)!=expected or len(trial_map)!=len(raw_rows):errors.append('trial_matrix')
    if set(packet_map)!=expected or len(packet_map)!=len(packets):errors.append('packet_matrix')
    if len(formed)!=len(forms) or set(formed)!={(c['id'],h) for c in cases for h in HISTORIES}:errors.append('formation_matrix')
    for identity,row in formed.items():
        calculated=audit_formation(row['state'],row['operations'],row['scope'])
        if calculated!=row['audit'] or not calculated['checks_passed']:errors.append('formation_audit:'+str(identity))
    for identity,r in trial_map.items():
        raw=packet_map.get(identity);form=formed.get((r['scenario_id'],r['history']))
        if not raw or not form:continue
        case=case_by_id[r['scenario_id']];q=next(q for q in case['queries'] if q['id']==r['query_id'])
        target=next((op['event_id'] for op in form['operations'] if op['id']==q['target_operation']),None)
        if raw.get('query')!=q['query'] or raw.get('scope')!=form['scope'] or raw.get('target_event_id')!=target or r.get('target_event_id')!=target:
            errors.append('input_or_source_binding:'+str(identity));continue
        markers=['禁入来源'+kind+'_'+case['id'] for kind in ('project','checkpoint','learner')]
        checked=verify(q,form['state'],raw['packet'],form['scope'],target,r.get('metadata_candidate_calls',[]),r['budget'],markers)
        if any(r.get(k)!=v for k,v in checked.items()) or not checked['checks_passed']:errors.append('saved_score_or_checks:'+str(identity))
    result={'schema':VERSION,'all_checks_passed':not errors,'errors':errors,'formation_snapshots':len(forms),'raw_packets':len(packets),'trial_rows':len(raw_rows),
      'product_rerun':False,'verifier':'standard-library verifier from saved raw snapshots','expected_conditions':len(expected)}
    save(out/'saved-recheck.json',result);return result


def report(rows,manifest,out):
    cases=[json.loads(s) for s in (out/'scenarios.jsonl').read_text().splitlines()]
    wanted=expected_jobs(cases);actual=[(r['scenario_id'],r['query_id'],r['history'],r['variant'],r['budget']) for r in rows]
    complete=len(actual)==len(set(actual)) and set(actual)==wanted
    intact=complete and all(r['status']=='completed' and r.get('checks_passed') for r in rows) and not manifest.get('source_drift') and not manifest.get('network_attempts') and not manifest.get('model_attempts') and manifest.get('saved_recheck_passed') is True
    metric_names=('target_in_candidate','target_fact_delivered','term_delivered','qualifier_delivered','joint_term_qualifier_delivered','first_item_is_target','strict_empty_on_uncovered','secondary_path_joint_delivered','secondary_path_only_joint_delivered','secondary_target_head_reference')
    groups=defaultdict(list)
    for r in rows:groups[(r['family'],r['query_id'],r['history'],r['budget'],r['variant'])].append(r)
    summary=[]
    for key,rs in sorted(groups.items()):
        values={}
        for metric in metric_names:
            applicable=[]
            for r in rs:
                q=next(q for c in cases if c['id']==r['scenario_id'] for q in c['queries'] if q['id']==r['query_id'])
                applies=bool(q.get('negative')) if metric=='strict_empty_on_uncovered' else bool(q.get('temporal')) if metric=='first_item_is_target' else q['target_operation'] is not None
                if applies:applicable.append(r.get('metrics',{}).get(metric) is True and r.get('checks_passed',False))
            values[metric]={'numerator':sum(applicable),'denominator':len(applicable)}
        summary.append(dict(zip(('family','query_id','history','budget','variant'),key),conditions=len(rs),metrics=values))
    pairs=[];lookup={(r['scenario_id'],r['query_id'],r['history'],r['budget'],r['variant']):r for r in rows}
    for c in cases:
        for q in c['queries']:
            for h in HISTORIES:
                for b in BUDGETS:
                    comparisons=[('default','source')]
                    if q.get('ablation'):comparisons += [(base,base+'_no_'+q['ablation']) for base in ('default','source')]
                    for left,right in comparisons:
                        a=lookup.get((c['id'],q['id'],h,b,left));z=lookup.get((c['id'],q['id'],h,b,right))
                        if not a or not z:continue
                        pairs.append({'scenario_id':c['id'],'query_id':q['id'],'history':h,'budget':b,'left':left,'right':right,
                           'candidate_sets_equal':a.get('candidate_pool_ids')==z.get('candidate_pool_ids'),
                           'metrics':{m:{'left':a.get('metrics',{}).get(m),'right':z.get('metrics',{}).get(m)} for m in metric_names}})
    result={'schema':VERSION,'matrix_complete':complete,'all_integrity_checks_passed':intact,'expected_conditions':len(wanted),'actual_conditions':len(rows),
      'scenario_count':len(cases),'query_count':sum(len(c['queries']) for c in cases),'independent_student_count':0,'status':'valid_descriptive_result' if intact else 'invalid_integrity_failures_no_valid_performance_claim',
      'condition_errors':[{'scenario_id':r['scenario_id'],'query_id':r['query_id'],'history':r['history'],'budget':r['budget'],'variant':r['variant'],'errors':r.get('errors')} for r in rows if not r.get('checks_passed')],
      'by_stratum':summary,'paired_comparisons':pairs,'limits':['native knowledge self-report text only','12 author-written scenarios; no natural long-tail prevalence','3 history lengths and 13 queries are correlated conditions','no LLM QA or learning outcomes','source toggles candidate scan and source metadata; not pure excerpt ablation','default max_items/heads/paths/episodes retained; alternate producers absent','history target content must be in a verified item; heads are not counted as source delivery']}
    save(out/'aggregate.json',result)
    lines=['# 原生知识文本长尾读取验证','',f'状态：{result["status"]}。完成 {len(rows)}/{len(wanted)} 条件；12 个作者编写的教育情境，13 个问题；后续干扰 4/64/256 条。','',
      '默认生产 checkpoint_tutor 与 source 开关对照，预算 1800/3200 为 JSON 字符估算，不是模型 tokens。真实 record_event 形成，模型与网络均禁用。','',
      '下表为固定集合描述性分子/分母；质量失败不删行。完整原文、形成链、候选跟踪和包均随制品保存。完整系统默认五核读取面保留，但本 fixture 实际只激活知识核文本，不能称五核逐核消融。','',
      '|场景族|问题|干扰|预算|配置|目标进候选|目标与限定同包|时序首条正确|无证据严格空|','|---|---|---:|---:|---|---:|---:|---:|---:|']
    def fmt(row,k):
        m=row['metrics'][k];return f'{m["numerator"]}/{m["denominator"]}' if m['denominator'] else 'NA'
    for r in summary:lines.append('|'+ '|'.join(map(str,(r['family'],r['query_id'],r['history'],r['budget'],r['variant'],fmt(r,'target_in_candidate'),fmt(r,'joint_term_qualifier_delivered'),fmt(r,'first_item_is_target'),fmt(r,'strict_empty_on_uncovered'))))+'|')
    lines+=['','## 解释边界','','- source 同时扩大最多 4096 条候选扫描、改变原文和元数据预算，不能将差异独归于分段。','- alias/fuzzy/temporal 只在对应情境关闭；它们是同一生产策略的组件消融，包含该组件候选与排序的整体作用。候选集合是否相同另列，不能假称固定池。','- 词表外表达和歧义词保留失败；强匹配异 learner/project/checkpoint 原文均为污染负控。','- 当前 KernelState 只保留有界历史回执，旧回执淘汰不等于历史 Fact 形成失败；核验完整持久化 mutation 版本序列。','- 这些情况是定向压力条件，不估计真实教育人群的长尾发生率；256 条干扰只是有界数据库历史压力，不证明任意长历史。']
    if not intact:lines+=['','## 完整性失败','',json.dumps(result['condition_errors'],ensure_ascii=False)]
    (out/'REPORT.md').write_text('\n'.join(lines)+'\n');return result


def execute(args):
    out=args.output.resolve();manifest=json.loads((out/'manifest.json').read_text());repo=Path(manifest['repo']);network=[];models=[]
    if manifest['status']!='planned_not_executed' or sources(repo)!=manifest['source_hashes'] or sha(out/'scenarios.jsonl')!=manifest['data_sha256'] or sha(out/'PROTOCOL.md')!=manifest['protocol_sha256']:raise RuntimeError('Frozen input mismatch or run already used')
    os.environ.update(DATABASE_URL='sqlite+aiosqlite:///:memory:',LLM_API_KEY='',OPENAI_API_KEY='',ANTHROPIC_API_KEY='',GOOGLE_API_KEY='',GEMINI_API_KEY='',MEMORY_AUTO_SYNTHESIS_ENABLED='false',PYTHONDONTWRITEBYTECODE='1')
    sys.dont_write_bytecode=True;active=[True]
    def audit(event,args):
        if not active[0]:return
        if event in ('socket.connect','socket.getaddrinfo'):network.append(event);raise RuntimeError('Network forbidden')
        if event=='sqlite3.connect' and str(args[0])!=':memory:':raise RuntimeError('Only in-memory database allowed')
    sys.addaudithook(audit);manifest['status']='running';save(out/'manifest.json',manifest);started=time.perf_counter();rows=[]
    try:rows=asyncio.run(execute_cases(repo,out,manifest,network,models))
    except Exception as exc:
        save(out/'fatal-error.json',{'error':type(exc).__name__+': '+str(exc),'traceback':traceback.format_exc()})
        if (out/'trials.jsonl').exists():rows=[json.loads(s) for s in (out/'trials.jsonl').read_text().splitlines()]
    finally:
        active[0]=False;current=sources(repo);manifest.update(network_attempts=len(network),model_attempts=len(models),elapsed_seconds=time.perf_counter()-started,
          source_drift=sorted(k for k in set(current)|set(manifest['source_hashes']) if current.get(k)!=manifest['source_hashes'].get(k)));save(out/'manifest.json',manifest)
    try:manifest['saved_recheck_passed']=reverify_saved(out)['all_checks_passed']
    except Exception as exc:
        manifest['saved_recheck_passed']=False;save(out/'saved-recheck.json',{'all_checks_passed':False,'error':type(exc).__name__+': '+str(exc),'traceback':traceback.format_exc()})
    result=report(rows,manifest,out);manifest['status']='completed' if result['all_integrity_checks_passed'] else 'completed_with_integrity_failures';manifest['conditions_completed']=len(rows);save(out/'manifest.json',manifest)
    save(out/'artifact-manifest.json',{'schema':VERSION,'files':{str(p.relative_to(out)):sha(p) for p in sorted(out.rglob('*')) if p.is_file() and p.name!='artifact-manifest.json'}})
    print(json.dumps({'status':manifest['status'],'conditions':len(rows),'output':str(out)}));return 0 if result['all_integrity_checks_passed'] else 1


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('mode',choices=('prepare','execute','reverify'));p.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[2]);p.add_argument('--output',type=Path,required=True);args=p.parse_args()
    if args.mode=='prepare':prepare(args)
    elif args.mode=='execute':sys.exit(execute(args))
    else:
        result=reverify_saved(args.output.resolve());print(json.dumps(result));sys.exit(0 if result['all_checks_passed'] else 1)
