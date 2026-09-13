"""Native business objects in offline memory DB. No hand-authored learning rows."""
from __future__ import annotations
import argparse
import asyncio
from contextlib import redirect_stdout
from datetime import datetime
import importlib
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace
import traceback


async def run_case(case,repo):
    from evals.education_memory_counterfactual.formation import _child_environment
    p=await asyncio.create_subprocess_exec(sys.executable,str(Path(__file__).resolve()),'--repo',str(repo),
        stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,env=_child_environment())
    stdout,stderr=await p.communicate(json.dumps(case,ensure_ascii=False).encode())
    if p.returncode:return {'case_id':case['case_id'],'status':'infrastructure_error','exit_code':p.returncode,'stderr':stderr.decode(errors='replace')}
    result=json.loads(stdout);result['worker']={'exit_code':p.returncode,'stderr':stderr.decode(errors='replace'),'python':sys.executable};return result


def public_answer(presentation,correct=True):
    public=presentation['payload'];prompt=public.get('prompt','');options=public.get('options',[])
    match=re.search(r'len\(range\((\d+)\)\)',prompt)
    if not match:raise ValueError('unsupported_public_question_expression')
    n=int(match[1])
    if not 0<=n<=100:raise ValueError('fixture_expression_out_of_bounds')
    value=str(len(range(n)))
    if options.count(value)!=1:raise ValueError('public_options_not_unique')
    index=options.index(value) if correct else next(i for i,v in enumerate(options) if v!=value)
    return [index],{'expression':match[0],'computed_value':value,'public_options':options,'submitted_index':index,'requested_correct':correct}


async def native(case,repo):
    sys.path[:0]=[str(repo),str(repo/'backend'),str(repo/'packages/learning-core/src')]
    from evals.education_memory_counterfactual.formation import Clock,_time
    import app.models
    from fastapi import HTTPException
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
    from app.db.database import Base
    from app.models.learning import Learner,AgentSession,LearningAttempt,EvidenceEvent,KernelMutation,KernelState,MemoryFact,MemoryNode,ReviewSchedule,RemediationCase
    from app.models.project import Project,Roadmap,Checkpoint,ConceptQuestion
    from app.api import phase3,learner_state,review
    from app.schemas.review import ReviewSubmitRequest,ReviewActionRequest
    from app.services import learning_runtime,learning_tasks
    from app.services.review import build_review_tutor_context
    from app.services.five_kernel_context import build_five_kernel_context
    from learnflow_core.planning_guidance import compile_planning_guidance
    for name in ('dynamic_practice','progress','review','remediation','profile','teaching_guidance',
                 'memory_graph','learning_continuity','learning_task_runtime'):
        try:importlib.import_module('app.services.'+name)
        except ModuleNotFoundError as exc:
            if exc.name!='app.services.'+name:raise
    if Path(learning_runtime.__file__).resolve()!=(repo/'packages/learning-core/src/learnflow_core/learning_runtime.py').resolve():raise RuntimeError('incorrect_product_source_loaded')
    patched={}
    def freeze(at):
        Clock.current=_time(at)
        for name,module in list(sys.modules.items()):
            if name.startswith(('app.','learnflow_core.')) and getattr(module,'datetime',None) is datetime:
                patched[name]=module;module.datetime=Clock
    def rowdict(row):
        return {c.name:getattr(row,c.name).isoformat() if isinstance(getattr(row,c.name),datetime) else getattr(row,c.name) for c in row.__table__.columns}
    tables={'events':EvidenceEvent,'attempts':LearningAttempt,'schedules':ReviewSchedule,'remediations':RemediationCase,
        'mutations':KernelMutation,'facts':MemoryFact,'nodes':MemoryNode,'states':KernelState,'learners':Learner,
        'projects':Project,'roadmaps':Roadmap,'checkpoints':Checkpoint,'sessions':AgentSession,'questions':ConceptQuestion}
    engine=create_async_engine('sqlite+aiosqlite:///:memory:');receipts=[];scopes={};cache={};sid=None
    try:
        async with engine.begin() as conn:await conn.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine,expire_on_commit=False)() as db:
            learner=Learner(key=case['case_id'],display_name='作者构造业务交互');outsider=Learner(key=case['case_id']+'-outsider',display_name='隔离主体')
            db.add_all([learner,outsider]);await db.flush();owner_id=learner.id;outsider_id=outsider.id
            for name in ('target','foreign_project'):
                project=Project(learner_id=owner_id,name='递归与复习 '+name);db.add(project);await db.flush()
                road=Roadmap(project_id=project.id,raw_json={});db.add(road);await db.flush()
                cp=Checkpoint(roadmap_id=road.id,title='计算边界与检索',order=1,prerequisites=[],learning_status='in_progress');db.add(cp);await db.flush()
                session=AgentSession(learner_id=owner_id,project_id=project.id,checkpoint_id=cp.id,session_type='checkpoint');db.add(session);await db.flush()
                scopes[name]=dict(learner_id=owner_id,project_id=project.id,checkpoint_id=cp.id,session_id=session.id)
            meta={'concept_key':'python-range-length','targets':['python-range-length'],'source':'author_computed_closed_choice'}
            if case['variant']:
                meta['variant']={'type':'concept_choice','validated':True,'prompt':'Python len(range(6)) 的结果是什么？',
                    'options':['5',str(len(range(6)))],'answer_indexes':[1]}
            q=ConceptQuestion(checkpoint_id=scopes['target']['checkpoint_id'],question='Python len(range(3)) 的结果是什么？',
                options=[str(len(range(3))),'4'],answer_indexes=[0],q_type='single',difficulty='easy',order=1,
                explanation='range 的上界不包含，计算元素个数。',assessment_meta=meta)
            db.add(q);await db.flush();qid=q.id;await db.commit();person=SimpleNamespace(learner=learner)
            async def ids(model):return set((await db.execute(select(model.id))).scalars())
            async def snapshot():
                data={'projection':await learning_runtime.get_kernel_projection(db,owner_id)}
                if sid:
                    data.update(review_item=await review.get_review_item(sid,db=db,current=person),
                        review_history=await review.get_review_history(sid,db=db,current=person),
                        review_tutor=await build_review_tutor_context(db,owner_id,sid))
                return data
            async def call(op,request):
                if op=='grade':return await phase3.submit_concept(scopes['target']['checkpoint_id'],qid,data=request,current=person,db=db)
                if op=='review':return await review.submit_review_item(sid,ReviewSubmitRequest(**request),db=db,current=person)
                if op=='defer':return await review.defer_review_item(sid,ReviewActionRequest(**request),db=db,current=person)
                if op=='path_commit':return await learner_state.commit_learning_path_plan(learner_state.LearningPathPlanRequest(**request),current=person,db=db)
                if op=='path_archive':return await learner_state.archive_learning_path_plan('interaction-path',client_event_id=request['client_event_id'],current=person,db=db)
                if op=='control':return await learner_state.sync_learner_event(learner_state.LearnerEventRequest(**request),current=person,db=db)
                if op=='read':return await review.get_review_item(sid,db=db,current=person)
                raise ValueError('unsupported_operation')
            steps=[*case['steps'],{'id':'foreign','op':'control','at':case['at'].replace('12:00','11:55'),
                    'text':'本次优先：异项目私有目标。','scope':'foreign_project'}]
            for spec in steps:
                freeze(spec['at']);before_e=await ids(EvidenceEvent);before_a=await ids(LearningAttempt)
                receipt={'operation_id':spec['id'],'spec':spec,'status':'pending','before':await snapshot()}
                key=case['case_id']+':'+spec['id'];op=spec['op'];scope=scopes[spec.get('scope','target')]
                try:
                    if op=='replay':op,request=cache[spec['request_from']]
                    elif op=='grade':
                        answers,receipt['calculation']=public_answer({'payload':{'prompt':q.question,'options':list(q.options)}},spec['correct'])
                        request={'answer_indexes':answers,'assistance_level':spec['assistance'],'client_submission_id':key}
                    elif op=='review':
                        item=await review.get_review_item(sid,db=db,current=person)
                        status=spec.get('response_status','answered');answers=[]
                        if status=='answered' and not spec.get('empty'):
                            answers,receipt['calculation']=public_answer(item['presentation'],spec.get('correct',True))
                        request={'expected_version':item['version'],'presentation_version':item['presentation']['version'],
                            'response_status':status,'answer_indexes':answers,'assistance_level':spec.get('assistance','none'),'client_submission_id':key}
                    elif op=='defer':
                        item=await review.get_review_item(sid,db=db,current=person)
                        request={'expected_version':item['version'],'client_event_id':key}
                    elif op=='path_commit':request={'plan_id':'interaction-path','title':'学习与复习路径',
                        'objective':'完成可评测项目' if spec['revision']==1 else '完成含消融实验的项目',
                        'horizon':'6 个月','target_node_ids':['agent-engineering'],
                        'route_node_ids':['python-programming','machine-learning','agent-engineering'],
                        'milestone_node_ids':['machine-learning'],'evidence_quote':'我确认这条学习路径','client_event_id':key}
                    elif op=='path_archive':request={'client_event_id':key}
                    elif op=='control':request={'event_type':'vnext_teaching_input_received','client_event_id':key,
                        'project_id':scope['project_id'],'checkpoint_id':scope['checkpoint_id'],'session_id':scope['session_id'],
                        'occurred_at':Clock.current,'payload':{'text':spec['text']}}
                    elif op=='read':request={}
                    else:raise ValueError('unmapped_operation')
                    cache[spec['id']]=(op,request);receipt['request']=request;receipt['executed_operation']=op
                    response=await call(op,request);receipt.update(response=response,http_status=200,status='executed')
                    if op=='grade':sid=response.get('review_schedule_id')
                except HTTPException as exc:
                    await db.rollback();await db.refresh(learner);await db.refresh(q)
                    receipt.update(http_status=exc.status_code,error=str(exc.detail),status='expected_rejection' if exc.status_code==spec.get('expected_http') else 'unexpected_rejection')
                except Exception as exc:
                    await db.rollback();await db.refresh(learner);await db.refresh(q)
                    receipt.update(status='execution_error',error=repr(exc),traceback=traceback.format_exc())
                receipt['new_event_ids']=sorted((await ids(EvidenceEvent))-before_e)
                receipt['new_attempt_ids']=sorted((await ids(LearningAttempt))-before_a)
                receipt['new_event_count']=len(receipt['new_event_ids']);receipt['new_attempt_count']=len(receipt['new_attempt_ids'])
                receipt['after']=await snapshot();receipts.append(receipt)
            freeze(case['at']);scope=scopes['target'];objective='检索与复习边界分析，推进学习路径'
            context=await learning_tasks._scoped_planner_context(db,**scope,objective=objective)
            obs=await snapshot();obs.update(packet=await build_five_kernel_context(db,**scope,policy='checkpoint_tutor',query=objective),
                planner_context=context,compiled=compile_planning_guidance(context,now=case['at']),
                plan=learning_tasks._fallback_plan(title='复习与学习',objective=objective,origin_kind='checkpoint',estimated_minutes=35,learner_context=context))
            obs['path_overlay']=learner_state._path_overlay(obs['projection'])
            isolation={'schedule_id':sid,'outsider_id':outsider_id,'applicable':sid is not None}
            if sid:
                try:
                    await review.get_review_item(sid,db=db,current=SimpleNamespace(learner=SimpleNamespace(id=outsider_id)))
                    isolation['http_status']=200
                except HTTPException as exc:isolation['http_status']=exc.status_code
                isolation['tutor_context']=await build_review_tutor_context(db,outsider_id,sid)
            await db.commit();data={}
            for name,model in tables.items():
                data[name]=[rowdict(r) for r in (await db.execute(select(model).order_by(model.id if hasattr(model,'id') else model.node_id))).scalars()]
            return {'case_id':case['case_id'],'status':'executed' if all(r['status'] in {'executed','expected_rejection'} for r in receipts) else 'executed_with_errors',
                'scope':scope,'scope_fixtures':scopes,'at':case['at'],'receipts':receipts,'observation':obs,'isolation':isolation,**data}
    finally:
        await engine.dispose()
        for module in patched.values():module.datetime=datetime


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--repo',type=Path,required=True);args=parser.parse_args()
    sys.path.insert(0,str(args.repo))
    from evals.education_memory_counterfactual.formation import _install_offline_audit
    offline=_install_offline_audit()
    with redirect_stdout(sys.stderr):result=asyncio.run(native(json.load(sys.stdin),args.repo.resolve()))
    result['offline_audit']=offline;print(json.dumps(result,ensure_ascii=False,default=str))
