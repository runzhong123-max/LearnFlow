"""Isolated API/database coverage for project composition and device-report boundaries."""
import asyncio
import uuid
import pytest
from fastapi.testclient import TestClient
from fastapi import HTTPException
from sqlalchemy import select, func
from app.main import app
from app.db.database import async_session
from app.models.project import Project
from app.models.learning import AgentSession, Learner, LearningTask, EvidenceEvent, KernelMutation
from learnflow_core.project_guidance import confirm


def key(): return uuid.uuid4().hex


@pytest.fixture(scope='module')
def client():
    with TestClient(app) as client:
        account=next(item for item in client.get('/api/dev/accounts').json() if item['username']=='legacy-demo')
        assert client.post(f"/api/dev/accounts/{account['id']}/login").status_code==200
        yield client


def prepare(client, **changes):
    body={'client_action_id':key(),'project_mode':'experiment','name':'SAT 约束实验','objective':'比较两种算法的结果与边界',
          'expected_outcome':'程序与记录','project_brief':{'deliverables':['C 程序'],'constraints':['固定输入'],'success_criteria':['输出满足约束']},**changes}
    response=client.post('/api/project-guidance/prepare',json=body)
    assert response.status_code==200,response.text
    return response.json(),body


def promote(client,candidate):
    body={'client_action_id':key(),'expected_root_hash':candidate['root_hash'],'confirmed':True}
    response=client.post(f"/api/project-guidance/{candidate['candidate_id']}/confirm",json=body)
    assert response.status_code==200,response.text
    return response.json(),body


def deliver(client,pid,cp,answers,refs=None):
    return client.post(f'/api/vnext-projects/{pid}/checkpoints/{cp}/deliver',json={'client_action_id':key(),'answers':answers,'artifact_refs':refs or [],'assistance_level':'independent'})


def report_body(cp,**changes):
    return {'schema_version':'learnflow.device-report.v1','client_action_id':key(),'checkpoint_id':cp,'action':'run','status':'completed',
        'snapshot_hash':'a'*64,'exit_code':0,'summary':'设备报告运行退出成功','manifest':[{'path':'main.c','sha256':'b'*64,'size':25}],
        'steps':[{'name':'run','exit_code':0,'stdout':'ok'}],**changes}


def test_origin_preserved_atomic_confirmation_idempotency_and_zero_target(client):
    original=client.post('/api/vnext-projects',json={'name':'原始项目','objective':'讨论实验目标'}).json()
    source={'type':'conversation','id':'original-chat','session_id':original['project_tutor']['session_id'],'sheet_id':'main'}
    candidate,request=prepare(client,source_refs=[source])
    assert client.post('/api/project-guidance/prepare',json=request).json()['candidate_id']==candidate['candidate_id']
    assert client.post('/api/project-guidance/prepare',json={**request,'name':'different'}).status_code==409
    result,body=promote(client,candidate)
    assert result['created'] and result['source_refs']==[source]
    assert result['workspace']['project']['project_mode']=='experiment'
    assert len(result['workflow']['milestones'])==3 and len(result['workflow']['workbench']['papers'])==2
    assert result['session_id']==result['workspace']['project_tutor']['session_id']
    url=f"/api/project-guidance/{candidate['candidate_id']}/confirm"
    repeated=client.post(url,json={**body,'client_action_id':key()}).json()
    assert not repeated['created'] and repeated['project_id']==result['project_id']
    assert client.post(url,json={**body,'expected_root_hash':'0'*64}).status_code==409
    assert client.post(url,json={**body,'confirmed':False}).status_code==422
    assert client.post(url,json={**body,'confirmed':1}).status_code==422
    async def inspect():
        async with async_session() as db:
            tasks=list(await db.scalars(select(LearningTask).where(LearningTask.project_id==result['project_id'])))
            assert len(tasks)==3 and all(source in task.source_refs for task in tasks)
            events=list(await db.scalars(select(EvidenceEvent).where(EvidenceEvent.event_type.in_({'project_guidance_prepared','project_guidance_confirmed'}))))
            events=[e for e in events if e.payload.get('candidate_id')==candidate['candidate_id']]
            assert len(events)==2
            assert await db.scalar(select(func.count(KernelMutation.id)).where(KernelMutation.event_id.in_([e.id for e in events])))==0
    asyncio.run(inspect())


def test_foreign_session_candidate_and_missing_origin_session_denied(client):
    async def seed():
        async with async_session() as db:
            learner=Learner(key='project-other-' + key(), display_name='Other project learner');db.add(learner);await db.flush()
            session=AgentSession(learner_id=learner.id,session_type='global',status='active',title='private');db.add(session);await db.commit()
            return learner.id,session.id
    learner,session=asyncio.run(seed())
    body={'client_action_id':key(),'project_mode':'experiment','name':'private experiment','objective':'private goal','source_refs':[{'type':'conversation','id':'private','session_id':session}]}
    assert client.post('/api/project-guidance/prepare',json=body).status_code==404
    assert client.post('/api/project-guidance/prepare',json={**body,'source_refs':[{'type':'conversation','id':'unbound'}]}).status_code==422
    candidate,_=prepare(client)
    async def reject():
        async with async_session() as db:
            with pytest.raises(HTTPException) as error:
                await confirm(db,learner,candidate['candidate_id'],{'confirmed':True,'expected_root_hash':candidate['root_hash'],'client_action_id':key()})
            assert error.value.status_code==404
    asyncio.run(reject())


def test_practice_requires_fixed_case_hides_future_materials(client):
    body={'client_action_id':key(),'project_mode':'practice','name':'自定义企业任务','objective':'新员工跟着完成'}
    response=client.post('/api/project-guidance/prepare',json=body)
    assert response.status_code==422 and response.json()['detail']['code']=='practice_case_selection_required'
    case=client.get('/api/practice-cases').json()['cases'][0]
    args={'project_mode':'practice','name':case['title'],'objective':case['summary'],'case_id':case['id'],'case_version':case['version'],'case_root_hash':case['root_hash']}
    assert client.post('/api/project-guidance/prepare',json={**body,**args,'case_root_hash':'0'*64}).status_code==409
    candidate,_=prepare(client,**args)
    assert 'stages' not in candidate['candidate']['case_ref']
    result,_=promote(client,candidate)
    stages=result['workflow']['milestones']
    assert stages[0]['materials'] and not stages[1]['materials'] and not stages[2]['materials']
    context=client.get(f"/api/vnext-projects/{result['project_id']}/agent-context",params={'session_id':result['session_id']}).json()
    assert context['project_workflow']['project_mode']=='practice'
    assert context['project_workflow']['milestones'][1]['materials']==[]
    assert 'validator' not in str(context['project_workflow'])


def test_device_reports_operational_delivery_never_complete_formal_learning(client):
    candidate,_=prepare(client);project,_=promote(client,candidate)
    pid=project['project_id'];first,second,last=[item['checkpoint_id'] for item in project['workflow']['milestones']]
    body=report_body(second);path=f'/api/vnext-projects/{pid}/device-reports'
    response=client.post(path,json=body);assert response.status_code==200,response.text
    report=response.json()
    assert report['authority']=='device_reported' and report['validation']=='structure_and_ownership_only' and report['mastery_inference'] is False
    assert client.post(path,json=body).json()['report_id']==report['report_id']
    assert client.post(path,json={**body,'summary':'changed'}).status_code==409
    assert deliver(client,pid,first,{'deliverable':'程序和报告','prediction':'输出保持固定'}).status_code==200
    accepted=deliver(client,pid,second,{'observation':'符合预测','explanation':'仍需评审'},[report['artifact_ref']])
    assert accepted.status_code==200,accepted.text
    assert accepted.json()['milestones'][1]['status']=='accepted'
    assert accepted.json()['milestones'][1]['submission']['feedback']['mastery_inference'] is False
    assert client.get(f'/api/vnext-projects/{pid}').json()['roadmap']['checkpoints'][1]['learning_task']['status']!='completed'
    assert deliver(client,pid,last,{'conclusion':'交付','next_experiment':'改变条件'},[report['artifact_ref']]).status_code==422
    async def inspect():
        async with async_session() as db:
            events=list(await db.scalars(select(EvidenceEvent).where(EvidenceEvent.project_id==pid,EvidenceEvent.event_type.in_({'project_device_report_recorded','project_delivery_submitted'}))))
            assert await db.scalar(select(func.count(KernelMutation.id)).where(KernelMutation.event_id.in_([e.id for e in events])))==0
    asyncio.run(inspect())


def test_device_report_scope_stale_failure_and_untrusted_fields(client):
    candidate,_=prepare(client);one,_=promote(client,candidate)
    candidate,_=prepare(client);two,_=promote(client,candidate)
    pid=one['project_id'];cp=one['workflow']['milestones'][1]['checkpoint_id'];path=f'/api/vnext-projects/{pid}/device-reports'
    assert client.post(path,json=report_body(two['workflow']['milestones'][0]['checkpoint_id'])).status_code==404
    assert client.post(path,json=report_body(cp,mastery=True)).status_code==422
    assert client.post(path,json=report_body(cp,manifest=[{'path':'../private','sha256':'b'*64,'size':1}])).status_code==422
    assert client.post(path,json=report_body(cp,exit_code=1)).status_code==422
    failed=client.post(path,json=report_body(cp,status='failed',exit_code=1,steps=[])).json()
    first=one['workflow']['milestones'][0]['checkpoint_id'];deliver(client,pid,first,{'deliverable':'程序','prediction':'预测'})
    assert deliver(client,pid,cp,{'observation':'失败','explanation':'原因'},[failed['artifact_ref']]).status_code==422
    good=client.post(path,json=report_body(cp)).json()
    assert deliver(client,pid,cp,{'observation':'结果','explanation':'原因'},[{**good['artifact_ref'],'revision':'0'*64}]).status_code==409
    assert client.get(f"/api/vnext-projects/{two['project_id']}/device-reports/{good['report_id']}").status_code==404


def test_concurrent_confirmation_creates_one_project_and_failed_composition_rolls_back(client, monkeypatch):
    candidate,_=prepare(client)
    async def concurrent():
        async def once():
            async with async_session() as db:
                row=await db.scalar(select(EvidenceEvent.learner_id).where(EvidenceEvent.payload['candidate_id'].as_string()==candidate['candidate_id']))
                result=await confirm(db,row,candidate['candidate_id'],{'confirmed':True,'expected_root_hash':candidate['root_hash'],'client_action_id':key()})
                await db.commit()
                return result
        results=await asyncio.gather(once(),once())
        assert {item['created'] for item in results}=={True,False}
        assert len({item['project_id'] for item in results})==1
    asyncio.run(concurrent())
    candidate,_=prepare(client)
    from learnflow_core import project_guidance as service
    async def broken(*args,**kwargs):
        raise RuntimeError('test composition failure')
    monkeypatch.setattr(service,'initialize_workflow',broken)
    with pytest.raises(RuntimeError,match='test composition failure'):
        promote(client,candidate)
    async def inspect():
        from learnflow_core.project_guidance_models import ProjectGuidanceCandidate
        async with async_session() as db:
            row=await db.get(ProjectGuidanceCandidate,candidate['candidate_id'])
            assert row.project_id is None
            projects=list(await db.scalars(select(Project)))
            assert not any((p.project_brief or {}).get('guidance_candidate_id')==row.id for p in projects)
    asyncio.run(inspect())


def test_project_columns_migrate_additively_in_isolated_database(tmp_path,monkeypatch):
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy import text
    from app.db import database
    async def migrate():
        engine=create_async_engine(f'sqlite+aiosqlite:///{tmp_path / "legacy.db"}')
        async with engine.begin() as conn:
            await conn.run_sync(database.Base.metadata.create_all)
            await conn.execute(text('ALTER TABLE projects DROP COLUMN project_mode'))
            await conn.execute(text('ALTER TABLE projects DROP COLUMN project_brief'))
            await conn.execute(text("INSERT INTO projects (id,name,project_kind,visibility) VALUES (42,'retained project','apprenticeship','visible')"))
        monkeypatch.setattr(database,'engine',engine)
        await database._ensure_columns()
        await database._ensure_columns()
        async with engine.connect() as conn:
            row=(await conn.execute(text('SELECT name,project_mode,project_brief FROM projects WHERE id=42'))).one()
            assert tuple(row)==('retained project','learning','{}')
        await engine.dispose()
    asyncio.run(migrate())


def test_device_file_digest_can_be_delivered_but_is_not_a_successful_run(client):
    candidate,_=prepare(client); project,_=promote(client,candidate)
    pid=project['project_id']; first,second,_=[row['checkpoint_id'] for row in project['workflow']['milestones']]
    path=f'/api/vnext-projects/{pid}/device-reports'
    body=report_body(first,action='files',exit_code=None,steps=[],summary='README 和程序的文件摘要')
    assert client.post(path,json={**body,'exit_code':0}).status_code==422
    assert client.post(path,json={**body,'status':'failed'}).status_code==422
    assert client.post(path,json={**body,'steps':[{'name':'source','exit_code':0}]}).status_code==422
    assert client.post(path,json={**body,'manifest':[]}).status_code==422
    response=client.post(path,json=body); assert response.status_code==200,response.text
    report=response.json()
    assert report['report']['action']=='files' and report['mastery_inference'] is False
    ordinary=deliver(client,pid,first,{'deliverable':'程序文件','prediction':'固定输出'},[report['artifact_ref']])
    assert ordinary.status_code==200 and ordinary.json()['milestones'][0]['status']=='accepted'
    next_report=client.post(path,json=report_body(second,action='files',exit_code=None,steps=[])).json()
    outcome=deliver(client,pid,second,{'observation':'文件已保存','explanation':'需要运行'},[next_report['artifact_ref']])
    assert outcome.status_code==200,outcome.text
    feedback=outcome.json()['milestones'][1]['submission']['feedback']
    assert feedback['accepted'] is False
    assert next(check for check in feedback['checks'] if check['key']=='run')['passed'] is False
    assert feedback['mastery_inference'] is False
    assert client.post(path,json=report_body(second,exit_code=None)).status_code==422


def test_long_project_brief_remains_complete_and_saveable_with_full_verify_report(client):
    lines=[f'{index:02d}' + '正文' * 599 for index in range(12)]
    candidate,_=prepare(client,name='长' * 255,objective='目' * 2000,expected_outcome='果' * 1200,
        project_brief={key:lines for key in ('deliverables','constraints','success_criteria')})
    result,_=promote(client,candidate)
    workflow=result['workflow']; papers=workflow['workbench']['papers']
    assert len(papers)==3
    assert all(len(row['title'])<=200 and len(row['body'])<=30000 for row in papers)
    content=''.join(row['body'] for row in papers if row['kind']=='note')
    assert all(content.count(line)==3 for line in lines)
    saved=client.put(f"/api/vnext-projects/{result['project_id']}/workbench",json={
        'client_action_id':key(),'expected_revision':workflow['revision'],'workbench':workflow['workbench']})
    assert saved.status_code==200,saved.text
    body=report_body(workflow['milestones'][1]['checkpoint_id'],action='verify',
        steps=[{'name':'build' if index==0 else f'case {index}','exit_code':0} for index in range(9)])
    url=f"/api/vnext-projects/{result['project_id']}/device-reports"
    accepted=client.post(url,json=body)
    assert accepted.status_code==200,accepted.text
    assert len(accepted.json()['report']['steps'])==9
    assert client.post(url,json={**body,'client_action_id':key(),'steps':body['steps']+[{'name':'excess','exit_code':0}]}).status_code==422


def test_device_report_preserves_bounded_provenance_and_legacy_retry_hash(client):
    candidate, _ = prepare(client)
    result, _ = promote(client, candidate)
    pid = result['project_id']
    checkpoint = result['workflow']['milestones'][0]['checkpoint_id']
    path = f'/api/vnext-projects/{pid}/device-reports'
    legacy = report_body(checkpoint)
    saved = client.post(path, json=legacy)
    assert saved.status_code == 200
    assert 'engineering_provenance' not in saved.json()['report']
    repeated = client.post(path, json={**legacy, 'engineering_provenance': None})
    assert repeated.status_code == 200 and repeated.json()['artifact_ref'] == saved.json()['artifact_ref']
    provenance = {'schema_version': 'learnflow.engineering-provenance.v1', 'authority': 'device_reported',
                  'independent_completion_verified': False, 'assisted': True, 'truncated': False,
                  'runs': [{'run_id': 1, 'checkpoint_id': checkpoint, 'status': 'applied',
                            'snapshot_hash': 'a' * 64, 'result_hash': 'b' * 64,
                            'assistance_policy': {'mode': 'implementation', 'revision': 2, 'execution_mode': 'workspace_write'},
                            'association': 'exact_files', 'matching_paths': ['main.c']}]}
    body = report_body(checkpoint, engineering_provenance=provenance)
    uploaded = client.post(path, json=body)
    assert uploaded.status_code == 200
    value = uploaded.json()
    assert value['report']['engineering_provenance'] == provenance
    assert value['mastery_inference'] is False and value['validation'] == 'structure_and_ownership_only'
    assert client.get(f"{path}/{value['report_id']}").json()['report']['engineering_provenance'] == provenance
    assert client.post(path, json=body).json()['artifact_ref'] == value['artifact_ref']
    body['engineering_provenance']['runs'][0]['result_hash'] = 'c' * 64
    assert client.post(path, json=body).status_code == 409
