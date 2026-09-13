"""Real API formation + actual consumers in a credential-free memory-DB child."""
from __future__ import annotations
import argparse
import asyncio
from contextlib import redirect_stdout
from datetime import datetime
import importlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import traceback


async def run_case(case, repo):
    from evals.education_memory_counterfactual.formation import _child_environment
    p=await asyncio.create_subprocess_exec(sys.executable,str(Path(__file__).resolve()),'--repo',str(repo),
        stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,
        env=_child_environment())
    stdout,stderr=await p.communicate(json.dumps(case,ensure_ascii=False).encode())
    if p.returncode:
        return {'case_id':case['case_id'],'status':'infrastructure_error','exit_code':p.returncode,
                'stderr':stderr.decode(errors='replace'),'stdout':stdout.decode(errors='replace')}
    r=json.loads(stdout);r['worker']={'exit_code':p.returncode,'stderr':stderr.decode(errors='replace'),
                                    'python':sys.executable};return r


async def native(case,repo):
    sys.path[:0]=[str(repo),str(repo/'backend'),str(repo/'packages/learning-core/src')]
    from evals.education_memory_counterfactual.formation import Clock,_time
    import app.models
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
    from app.db.database import Base
    from app.models.learning import Learner,AgentSession,LearningAttempt,EvidenceEvent,KernelMutation,KernelState,MemoryFact,MemoryNode
    from app.models.project import Project,Roadmap,Checkpoint,ConceptQuestion
    from app.api import phase3,learner_state
    from app.services import learning_runtime,learning_tasks
    from app.services.five_kernel_context import build_five_kernel_context
    from learnflow_core.planning_guidance import compile_planning_guidance
    for name in ('dynamic_practice','progress','review','remediation','profile','teaching_guidance',
                 'memory_graph','learning_continuity','learning_task_runtime','learning_episodes'):
        try:importlib.import_module('app.services.'+name)
        except ModuleNotFoundError as exc:
            if exc.name!='app.services.'+name:raise
    if Path(learning_runtime.__file__).resolve()!=(repo/'packages/learning-core/src/learnflow_core/learning_runtime.py').resolve():
        raise RuntimeError('incorrect_product_source_loaded')
    patched={}
    def freeze(at):
        Clock.current=_time(at)
        for name,module in list(sys.modules.items()):
            if name.startswith(('app.','learnflow_core.')) and getattr(module,'datetime',None) is datetime:
                patched[name]=module;module.datetime=Clock
    def serialize(row):
        return {c.name:getattr(row,c.name).isoformat() if isinstance(getattr(row,c.name),datetime) else getattr(row,c.name)
                for c in row.__table__.columns}
    engine=create_async_engine('sqlite+aiosqlite:///:memory:')
    tables={'events':EvidenceEvent,'attempts':LearningAttempt,'mutations':KernelMutation,'facts':MemoryFact,
            'nodes':MemoryNode,'states':KernelState,'learners':Learner,'projects':Project,'roadmaps':Roadmap,
            'checkpoints':Checkpoint,'sessions':AgentSession}
    receipts=[];gaps=[];scopes={}
    try:
        async with engine.begin() as conn:await conn.run_sync(Base.metadata.create_all)
        async with async_sessionmaker(engine,expire_on_commit=False)() as db:
            learner=Learner(key=case['case_id'],display_name='合成能力契约案例');db.add(learner);await db.flush()
            for name in ('target','foreign_project'):
                p=Project(learner_id=learner.id,name='递归能力核验 '+name);db.add(p);await db.flush()
                road=Roadmap(project_id=p.id,raw_json={});db.add(road);await db.flush()
                cp=Checkpoint(roadmap_id=road.id,title='递归与计算边界',order=1,prerequisites=[],learning_status='in_progress')
                db.add(cp);await db.flush()
                s=AgentSession(learner_id=learner.id,project_id=p.id,checkpoint_id=cp.id,session_type='checkpoint')
                db.add(s);await db.flush()
                scopes[name]=dict(learner_id=learner.id,project_id=p.id,checkpoint_id=cp.id,session_id=s.id)
            correct=str(len(range(3)))
            q=ConceptQuestion(checkpoint_id=scopes['target']['checkpoint_id'],question='Python len(range(3)) 的结果是什么？',
                options=[correct,'4'],answer_indexes=[0],q_type='single',difficulty='easy',order=1,
                explanation='该固定闭合选择题仅用于执行正式证据链，不衡量真实编程能力。',
                assessment_meta={'concept_key':'recursion-boundary','targets':['递归与计算边界'],
                                 'source':'native_capability_closed_choice_fixture'})
            db.add(q);await db.flush();await db.commit();person=SimpleNamespace(learner=learner)
            steps=[*case['steps'],{'id':'foreign','op':'control','at':'2026-09-01T11:55:00Z',
                    'text':'本次优先：异项目私有目标。','scope':'foreign_project'}]
            for step in steps:
                freeze(step['at']);scope=scopes[step.get('scope','target')]
                before=set((await db.execute(select(EvidenceEvent.id))).scalars())
                receipt={'operation_id':step['id'],'operation':step,'requested_scope':scope,'status':'pending'}
                try:
                    if step['op']=='control':
                        response=await learner_state.sync_learner_event(learner_state.LearnerEventRequest(
                            event_type='vnext_teaching_input_received',client_event_id=case['case_id']+':'+step['id'],
                            project_id=scope['project_id'],checkpoint_id=scope['checkpoint_id'],session_id=scope['session_id'],
                            occurred_at=Clock.current,payload={'text':step['text']}),current=person,db=db)
                        receipt['adapter']='formal_learner_input_api'
                    elif step['op']=='gap':
                        event=await learning_runtime.record_event(db,**scope,event_type='user_message',source='user',
                            payload={'text':step['text']},provenance={'self_report':True,'harness_native_registered_event':True},
                            client_event_id=case['case_id']+':'+step['id'],occurred_at=Clock.current)
                        await db.commit();response={'event_id':event.id};receipt['adapter']='registered_event_gateway'
                    elif step['op']=='grade':
                        response=await phase3.submit_concept(scope['checkpoint_id'],q.id,data={
                            'answer_indexes':[0 if step['correct'] else 1],'assistance_level':step['assistance'],
                            'client_submission_id':case['case_id']+':'+step['id']},current=person,db=db)
                        receipt['adapter']='formal_concept_api'
                    elif step['op']=='path_commit':
                        response=await learner_state.commit_learning_path_plan(learner_state.LearningPathPlanRequest(
                            plan_id='capability-path',title='学习 Agent 工程路径',
                            objective='完成一个可评测的 Agent 项目' if step['revision']==1 else '完成一个含消融实验的 Agent 项目',
                            horizon='6 个月',target_node_ids=['agent-engineering'],
                            route_node_ids=['python-programming','machine-learning','agent-engineering'],
                            milestone_node_ids=['machine-learning','agent-engineering'],
                            evidence_quote='我确认这条路径和目标',client_event_id=case['case_id']+':'+step['id']),current=person,db=db)
                        receipt['adapter']='formal_path_plan_api'
                    elif step['op']=='path_archive':
                        response=await learner_state.archive_learning_path_plan('capability-path',
                            client_event_id=case['case_id']+':'+step['id'],current=person,db=db)
                        receipt['adapter']='formal_path_archive_api'
                    else:raise ValueError('unsupported_operation')
                    receipt['response']=response
                    events=(await db.execute(select(EvidenceEvent).where(EvidenceEvent.id.not_in(before or {-1})))).scalars().all()
                    receipt['event_ids']=[e.id for e in events]
                    grades=[e for e in events if e.event_type=='concept_attempt_evaluated']
                    for e in grades:
                        if e.session_id!=scope['session_id']:
                            gaps.append({'reason':'formal_concept_api_has_no_session_parameter','event_id':e.id,
                                         'requested_session_id':scope['session_id'],'actual_session_id':e.session_id})
                    if step['op'].startswith('path_'):
                        receipt['projection_after']=await learning_runtime.get_kernel_projection(db,learner.id)
                    receipt['status']='formed'
                except Exception as exc:
                    await db.rollback();receipt.update(status='formation_error',error=repr(exc),traceback=traceback.format_exc())
                receipts.append(receipt)
            freeze(case['at'])
            scope=scopes['target'];objective='递归终止条件与边界分析；接下来怎样推进 Agent 工程路径'
            packet=await build_five_kernel_context(db,**scope,policy='checkpoint_tutor',query=objective,
                subject_keys=[f"checkpoint:{scope['checkpoint_id']}"])
            learning_packet=await build_five_kernel_context(db,learner_id=learner.id,policy='learning_plan',query=objective)
            context=await learning_tasks._scoped_planner_context(db,**scope,objective=objective)
            compiled=compile_planning_guidance(context,now=case['at'])
            plan=learning_tasks._fallback_plan(title='递归边界核验',objective=objective,origin_kind='checkpoint',
                estimated_minutes=35,learner_context=context)
            projection=await learning_runtime.get_kernel_projection(db,learner.id)
            observation={'packet':packet,'learning_plan_packet':learning_packet,'planner_context':context,
                'compiled':compiled,'plan':plan,'projection':projection,'path_overlay':learner_state._path_overlay(projection)}
            await db.commit()
            result={}
            for name,model in tables.items():
                rows=(await db.execute(select(model).order_by(model.id if hasattr(model,'id') else model.node_id))).scalars().all()
                result[name]=[serialize(row) for row in rows]
            result['questions']=[serialize(q)]
            return {'case_id':case['case_id'],'status':'formed' if all(r['status']=='formed' for r in receipts) else 'formed_with_errors',
                'scope':scope,'scope_fixtures':scopes,'at':case['at'],'receipts':receipts,'formation_gaps':gaps,
                'observation':observation,'native_source':str(Path(learning_runtime.__file__).resolve()),**result}
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
