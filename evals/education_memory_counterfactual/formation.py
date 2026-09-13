"""Execute native formation in an offline child with an in-memory database.

Public form_case never modifies the caller's environment, settings or database.
Only infrastructure/question fixture rows are inserted directly. Attempts go
through the concept submission API; memory rows go through registered events.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import redirect_stdout
from datetime import datetime, timezone
import hashlib
import importlib
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import traceback

VERSION='learnflow.education-counterfactual.formation.v1'


def _child_environment():
    env=os.environ.copy()
    env.update(DATABASE_URL='sqlite+aiosqlite:///:memory:', LLM_API_KEY='',
        OPENAI_API_KEY='',ANTHROPIC_API_KEY='',GOOGLE_API_KEY='',GEMINI_API_KEY='',
        EMBEDDING_API_KEY='',VISION_API_KEY='',MEMORY_AUTO_SYNTHESIS_ENABLED='false',
        MEMORY_WORKER_EMBEDDED='false',PYTHONDONTWRITEBYTECODE='1')
    return env


async def form_case(case: dict, repo: Path) -> dict:
    """Native formation, isolated from parent credentials and app singletons."""
    process=await asyncio.create_subprocess_exec(sys.executable,str(Path(__file__).resolve()),
        '--worker','--repo',str(Path(repo).resolve()),stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,env=_child_environment())
    stdout,stderr=await process.communicate(json.dumps(case,ensure_ascii=False).encode())
    if process.returncode:
        return {'schema':VERSION,'case_id':case['case_id'],'at':case['at'],'status':'formation_error',
                'scope':{},'receipts':[],'formation_gaps':[{'reason':'worker_error','exit_code':process.returncode,
                'stderr':stderr.decode(errors='replace')}],**{key:[] for key in
                ('events','attempts','mutations','facts','nodes','states','learners','projects','roadmaps','checkpoints','sessions','questions')}}
    result=json.loads(stdout)
    result['worker']={'exit_code':process.returncode,'stderr':stderr.decode(errors='replace'),
                      'python':sys.executable,'isolated_credentials':True}
    return result


class ClockMeta(type):
    def __instancecheck__(cls,value):return isinstance(value,datetime)


class Clock(datetime,metaclass=ClockMeta):
    current=datetime(2026,9,1,12)
    @classmethod
    def utcnow(cls):return cls.current
    @classmethod
    def now(cls,tz=None):return cls.current if tz is None else cls.current.replace(tzinfo=timezone.utc).astimezone(tz)


def _time(value):return datetime.fromisoformat(value.replace('Z','+00:00')).astimezone(timezone.utc).replace(tzinfo=None)


async def _native_form(case: dict, repo: Path) -> dict:
    sys.path[:0]=[str(repo/'backend'),str(repo/'packages/learning-core/src')]
    import app.models
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
    from app.db.database import Base
    from app.models.learning import Learner,AgentSession,LearningAttempt,EvidenceEvent,KernelMutation,KernelState,MemoryFact,MemoryNode
    from app.models.project import Project,Roadmap,Checkpoint,ConceptQuestion
    from app.api import phase3,learner_state
    from app.services import learning_runtime
    for name in ('dynamic_practice','progress','review','remediation','profile','teaching_guidance',
                 'memory_graph','learning_continuity','learning_task_runtime'):
        try:importlib.import_module('app.services.'+name)
        except ModuleNotFoundError as exc:
            if exc.name!='app.services.'+name:raise
    expected=repo/'packages/learning-core/src/learnflow_core/learning_runtime.py'
    if Path(learning_runtime.__file__).resolve()!=expected.resolve():raise RuntimeError('incorrect_product_source_loaded')
    patched={}
    def freeze(at):
        Clock.current=_time(at)
        for name,module in list(sys.modules.items()):
            if name.startswith(('app.','learnflow_core.')) and getattr(module,'datetime',None) is datetime:
                patched[name]=module;module.datetime=Clock
    engine=create_async_engine('sqlite+aiosqlite:///:memory:')
    receipts=[];gaps=[];scopes={};question_map={}
    tables={'events':EvidenceEvent,'attempts':LearningAttempt,'mutations':KernelMutation,
            'facts':MemoryFact,'nodes':MemoryNode,'states':KernelState,'learners':Learner,
            'projects':Project,'roadmaps':Roadmap,'checkpoints':Checkpoint,'sessions':AgentSession}
    try:
        async with engine.begin() as conn:await conn.run_sync(Base.metadata.create_all)
        factory=async_sessionmaker(engine,expire_on_commit=False)
        async with factory() as db:
            learner=Learner(key=case['case_id'],display_name='合成机制案例');db.add(learner);await db.flush()
            for name in ('target','foreign_project'):
                project=Project(learner_id=learner.id,name=case['topic']['label']+' '+name);db.add(project);await db.flush()
                roadmap=Roadmap(project_id=project.id,raw_json={});db.add(roadmap);await db.flush()
                cp=Checkpoint(roadmap_id=roadmap.id,title=case['topic']['label'],order=1,prerequisites=[],learning_status='in_progress');db.add(cp);await db.flush()
                session=AgentSession(learner_id=learner.id,project_id=project.id,checkpoint_id=cp.id,session_type='checkpoint');db.add(session);await db.flush()
                scopes[name]={'learner_id':learner.id,'project_id':project.id,'checkpoint_id':cp.id,'session_id':session.id}
            oracle=case['question']['oracle']
            if oracle['exit_code']!=0 or hashlib.sha256(oracle['program'].encode()).hexdigest()!=oracle['program_sha256'] or hashlib.sha256(oracle['stdout'].encode()).hexdigest()!=oracle['stdout_sha256']:
                raise ValueError('invalid_executed_oracle_receipt')
            if json.loads(oracle['stdout'])!=json.loads(oracle['correct_response']):
                raise ValueError('oracle_answer_not_bound_to_execution_stdout')
            options=[oracle['correct_response'],oracle['incorrect_response']]
            for index,step in enumerate(case['steps']):
                if step['op']!='concept_answer':continue
                scope=scopes[step['scope']]
                if (step['scope'],step['item']) in question_map:continue
                # Question order is fixed by hashed identity, independent of side.
                choices=list(options)
                if int(hashlib.sha256((case['family_id']+step['item']).encode()).hexdigest()[:2],16)%2:choices.reverse()
                q=ConceptQuestion(checkpoint_id=scope['checkpoint_id'],question=case['question']['prompt']+'\n'+case['question']['artifact'],
                    options=choices,answer_indexes=[choices.index(oracle['correct_response'])],q_type='single',difficulty='medium',
                    explanation='计算结果由固定程序或SQL实际执行得到；本项为合成封闭选择题。',order=index+1,
                    assessment_meta={'targets':[case['topic']['label']],'concept_key':case['topic']['id'],
                      'family_id':case['family_id'],'source':'executed_oracle_closed_choice_fixture',
                      'oracle_program_sha256':oracle['program_sha256']})
                db.add(q);await db.flush();question_map[(step['scope'],step['item'])]=(q.id,choices)
            await db.commit()
            person=SimpleNamespace(learner=learner)
            for step in case['steps']:
                freeze(step['at']);scope=scopes[step['scope']]
                receipt={'operation_id':step['id'],'op':step['op'],'requested_at':step['at'],
                         'requested_scope':dict(scope),'status':'pending'}
                before=set((await db.execute(select(EvidenceEvent.id))).scalars())
                try:
                    if step['op']=='concept_answer':
                        qid,choices=question_map[(step['scope'],step['item'])]
                        if step['response'] not in choices:raise ValueError('response_not_a_unique_closed_choice')
                        response=await phase3.submit_concept(scope['checkpoint_id'],qid,
                            data={'answer_indexes':[choices.index(step['response'])],
                                  'assistance_level':step['assistance_level'],
                                  'client_submission_id':case['case_id']+':'+step['id']},current=person,db=db)
                        receipt.update(attempt_id=response['attempt_id'],question_id=qid,
                            requested_assistance=step['assistance_level'],adapter='formal_concept_api',
                            submitted_response=step['response'],oracle_expected_correct=step['response']==oracle['correct_response'])
                    elif step['op']=='control_text':
                        response=await learner_state.sync_learner_event(
                            learner_state.LearnerEventRequest(event_type='vnext_teaching_input_received',
                                client_event_id=case['case_id']+':'+step['id'],
                                project_id=scope['project_id'],checkpoint_id=scope['checkpoint_id'],
                                session_id=scope['session_id'],occurred_at=Clock.current,payload={'text':step['text']}),
                            current=person,db=db)
                        receipt.update(event_id=response['event_id'],adapter='formal_learner_input_api',input_text=step['text'])
                    elif step['op']=='native_gap':
                        event=await learning_runtime.record_event(db,**scope,event_type='user_message',source='user',
                            payload={'text':step['text']},provenance={'self_report':True,'harness_native_registered_event':True},
                            client_event_id=case['case_id']+':'+step['id'],occurred_at=Clock.current)
                        await db.commit()
                        receipt.update(event_id=event.id,adapter='native_registered_event_gateway',input_text=step['text'])
                    elif step['op']=='native_self_report':
                        event=await learning_runtime.record_event(db,**scope,
                            event_type='learner_concept_observation_recorded',source='user',
                            payload={'concept_key':case['topic']['id'],'concept_name':case['topic']['label'],
                                'memory_subject_key':'concept:'+case['topic']['id'],'statement':step['text'],
                                'observation_type':'self_report','verification':'unverified','mastery_inference':False},
                            provenance={'self_report':True,'harness_native_registered_event':True},
                            client_event_id=case['case_id']+':'+step['id'],occurred_at=Clock.current)
                        await db.commit()
                        receipt.update(event_id=event.id,adapter='native_registered_event_gateway',input_text=step['text'])
                    else:raise ValueError('unmapped_native_operation:'+step['op'])
                    events=(await db.execute(select(EvidenceEvent).where(EvidenceEvent.id.not_in(before or {-1})))).scalars().all()
                    receipt['event_ids']=[event.id for event in events]
                    grades=[e for e in events if e.event_type=='concept_attempt_evaluated']
                    if step['op']=='concept_answer':
                        if len(grades)!=1:raise ValueError('expected_one_formal_grade_receipt')
                        grade=grades[0]
                        receipt.update(event_id=grade.id,actual_correct=grade.payload.get('correct'),
                            actual_assistance=grade.payload.get('assistance_level'),actual_independent=grade.payload.get('independent'),
                            actual_scope={key:getattr(grade,key) for key in ('learner_id','project_id','checkpoint_id','session_id')})
                        if grade.session_id!=scope['session_id']:
                            gaps.append({'operation_id':step['id'],'reason':'formal_concept_api_has_no_session_parameter',
                                         'actual_session_id':grade.session_id,'requested_session_id':scope['session_id'],
                                         'severity':'known_scope_fidelity_limit'})
                        if grade.payload.get('correct')!=receipt['oracle_expected_correct']:raise ValueError('formal_grader_disagrees_with_executed_oracle')
                    receipt['status']='formed'
                except Exception as exc:
                    await db.rollback();receipt.update(status='formation_error',error=type(exc).__name__+': '+str(exc),traceback=traceback.format_exc())
                    gaps.append({'operation_id':step['id'],'reason':'native_operation_failed','error':receipt['error'],'severity':'error'})
                receipts.append(receipt)
            result={}
            for name,model in tables.items():
                rows=(await db.execute(select(model).order_by(model.id if hasattr(model,'id') else model.node_id))).scalars().all()
                result[name]=[{column.name:getattr(row,column.name).isoformat() if isinstance(getattr(row,column.name),datetime) else getattr(row,column.name)
                               for column in model.__table__.columns} for row in rows]
            qs=(await db.execute(select(ConceptQuestion))).scalars().all()
            result['questions']=[{'id':q.id,'checkpoint_id':q.checkpoint_id,'question':q.question,'q_type':q.q_type,
                'assessment_meta':q.assessment_meta,'answer_data_excluded':True} for q in qs]
            return {'schema':VERSION,'case_id':case['case_id'],'at':case['at'],'scope':scopes['target'],
                'scope_fixtures':scopes,'receipts':receipts,'formation_gaps':gaps,
                'status':'formed' if all(r['status']=='formed' for r in receipts) else 'formed_with_errors',
                'oracle_receipt':oracle,'source_metadata':{'dates':'ISO naive UTC for database fields',
                    'orm_created_at':'Actual ORM defaults may use wall clock; occurrence/submission/evaluation use injected native clock',
                    'state_write_authority':'native_event_reducer_only','database':'sqlite_memory',
                    'question_answers_excluded_from_ownership_table':True},**result}
    finally:
        await engine.dispose()
        for module in patched.values():module.datetime=datetime


def _install_offline_audit():
    counts={'network_attempts':0,'file_database_attempts':0}
    def audit(event,args):
        if event in ('socket.connect','socket.getaddrinfo'):
            counts['network_attempts']+=1;raise RuntimeError('formation_network_forbidden')
        if event=='sqlite3.connect' and str(args[0])!=':memory:':
            counts['file_database_attempts']+=1;raise RuntimeError('formation_file_database_forbidden')
    sys.addaudithook(audit);return counts


async def _export(args):
    cases=[json.loads(line) for line in args.cases.read_text().splitlines()]
    if args.split:cases=[c for c in cases if c['split']==args.split]
    if args.limit is not None:cases=cases[:args.limit]
    args.output.parent.mkdir(parents=True,exist_ok=True)
    failures=0
    with args.output.open('x',encoding='utf-8') as stream:
        for case in cases:
            result=await form_case(case,args.repo)
            failures+=result['status']!='formed'
            stream.write(json.dumps(result,ensure_ascii=False,sort_keys=True,default=str)+'\n');stream.flush()
            print(json.dumps({'case_id':case['case_id'],'status':result['status'],'receipts':len(result['receipts'])}),flush=True)
    return 1 if failures else 0


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--repo',type=Path,required=True)
    parser.add_argument('--cases',type=Path);parser.add_argument('--output',type=Path)
    parser.add_argument('--split',choices=('dev','formal'));parser.add_argument('--limit',type=int)
    parser.add_argument('--worker',action='store_true');args=parser.parse_args()
    if args.worker:
        counts=_install_offline_audit();case=json.load(sys.stdin)
        with redirect_stdout(sys.stderr):result=asyncio.run(_native_form(case,args.repo.resolve()))
        result['offline_audit']=counts;print(json.dumps(result,ensure_ascii=False,default=str));return
    if not args.cases or not args.output:parser.error('--cases and --output required')
    return asyncio.run(_export(args))


if __name__=='__main__':sys.exit(main())
