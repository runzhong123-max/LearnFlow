"""Operational draft, ownership, provider and handoff integration contracts."""
import asyncio
from datetime import datetime, timedelta
import hashlib
import hmac
import base64
import json
import time
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, func
from app.main import app
from app.core.config import settings
from app.db.database import async_session
from app.models.learning import Learner, AgentSession, AgentMessage, KernelMutation, EvidenceEvent, LearningTask
from app.models.project import Project
from learnflow_core import work_task_conversions as service
from learnflow_core.work_task_conversion_models import WorkTaskConversion as Draft, WorkTaskConversionRevision as Revision, WorkTaskConversionTicket as Ticket
from app.services.xingchen_learning_task_candidates import canonical_hash, LearningTaskIntegrationError
from test_xingchen_learning_task_candidates import _bundle


def key(): return uuid4().hex


@pytest.fixture(scope='module')
def client():
    with TestClient(app) as client:
        account=next(a for a in client.get('/api/dev/accounts').json() if a['username']=='legacy-demo')
        assert client.post(f"/api/dev/accounts/{account['id']}/login").status_code==200
        yield client


def create(client,**changes):
    body={'client_action_id':key(),'original_input':'接手客户 CSV 数据导入工具',**changes}
    response=client.post('/api/work-task-conversions',json=body)
    assert response.status_code==200,response.text
    return response.json(),body


def brief(client,draft):
    data={**draft['brief'],'work_context':'仓库运营的离线测试数据','deliverable':'清洗后的数据与交接说明',
          'acceptance_criteria':['拒绝负数数量并去重'],'constraints':['只使用合成测试数据'],'learner_level':'做过 Python 基础练习'}
    response=client.post(f"/api/work-task-conversions/{draft['id']}/brief",json={
        'client_action_id':key(),'expected_revision':draft['revision'],'brief':data})
    assert response.status_code==200,response.text
    return response.json()


def generate(client,draft,mode='experiment',recipe='data-import-quality'):
    body={'client_action_id':key(),'expected_root_hash':draft['root_hash'],'confirmed':True,'project_mode':mode}
    if mode!='learning': body['design_recipe_id']=recipe
    response=client.post(f"/api/work-task-conversions/{draft['id']}/generate",json=body)
    assert response.status_code==200,response.text
    for _ in range(120):
        result=client.get(f"/api/work-task-conversions/{draft['id']}").json()
        if result['state']!='generating': return result,body
        time.sleep(.02)
    raise AssertionError('generation did not finish')


def handoff(client,draft,action='desktop',**extra):
    data={'client_action_id':key(),'expected_root_hash':draft['root_hash'],'confirmed':True,'action':action,**extra}
    response=client.post(f"/api/work-task-conversions/{draft['id']}/handoff",json=data)
    assert response.status_code==200,response.text
    return response.json(),data


def signed_role(learner_id):
    t=int(time.time())
    payload={'protocol':'role-package-launch.v1','launchId':key(),'subject':f'learnflow:learner:{learner_id}',
        'roleTitle':'数据工程师','source':'role_atlas','issuedAt':t,'expiresAt':t+900,'intent':'work_task_conversion',
        'packageRef':{'packageId':'pkg','packageVersion':'1','snapshotId':'snapshot','rootHash':'a'*64},
        'taskRef':{'nodeId':'task-import','label':'导入仓库数据','summary':'固定列规范化与幂等交付'}}
    body=base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=')
    sig=base64.urlsafe_b64encode(hmac.new(settings.role_package_launch_secret.encode(),body.encode(),hashlib.sha256).digest()).decode().rstrip('=')
    return body+'.'+sig


def test_draft_revisions_idempotency_and_no_hidden_project(client):
    async def count():
        async with async_session() as db: return await db.scalar(select(func.count(Project.id)))
    before=asyncio.run(count());draft,data=create(client)
    assert draft['state']=='draft' and draft['question'] and draft['missing_fields']
    assert client.post('/api/work-task-conversions',json=data).json()['id']==draft['id']
    assert client.post('/api/work-task-conversions',json={**data,'original_input':'different'}).status_code==409
    updated=brief(client,draft)
    assert updated['revision']==2 and updated['root_hash']!=draft['root_hash'] and updated['state']=='ready'
    assert asyncio.run(count())==before
    assert client.post(f"/api/work-task-conversions/{draft['id']}/brief",json={
        'client_action_id':key(),'expected_revision':1,'brief':updated['brief']}).status_code==409
    async def revisions():
        async with async_session() as db:
            rows=list(await db.scalars(select(Revision).where(Revision.conversion_id==draft['id'])))
            assert [r.revision for r in rows]==[1,2]
            assert all(canonical_hash(r.snapshot)==r.root_hash for r in rows)
    asyncio.run(revisions())


def test_source_authenticity_and_owner_isolation(client,monkeypatch):
    draft,_=create(client)
    async def seed():
        async with async_session() as db:
            row=await db.get(Draft,draft['id']);owner=row.learner_id
            other=Learner(key=key(),display_name='other');db.add(other);await db.flush()
            session=AgentSession(learner_id=other.id,session_type='global');db.add(session);await db.commit()
            return owner,other.id,session.id
    owner,other,session=asyncio.run(seed())
    data={'client_action_id':key(),'original_input':'private','source_refs':[{'type':'conversation','id':'x','session_id':session}]}
    assert client.post('/api/work-task-conversions',json=data).status_code==404
    assert client.post('/api/work-task-conversions',json={**data,'source_refs':[{'type':'role_task','verified':True}]}).status_code==422
    async def foreign():
        async with async_session() as db:
            with pytest.raises(Exception) as error: await service.owned(db,other,draft['id'],lock=True)
            assert error.value.status_code==404
    asyncio.run(foreign());monkeypatch.setattr(settings,'role_package_launch_secret','t'*40)
    token=signed_role(owner);a,_=create(client,role_launch_token=token);b,_=create(client,role_launch_token=token)
    assert a['id']==b['id'] and a['source_refs'][0]['task_ref']['nodeId']=='task-import'
    assert token not in json.dumps(a)
    assert client.post('/api/work-task-conversions',json={'client_action_id':key(),'original_input':'x','role_launch_token':signed_role(other)}).status_code==404


def test_clarification_bounded_offline_preserves_original(client,monkeypatch):
    monkeypatch.setattr(settings,'llm_api_key','');draft,_=create(client)
    data={'client_action_id':key(),'expected_revision':draft['revision'],'message':'仓库测试环境的数据导入'}
    response=client.post(f"/api/work-task-conversions/{draft['id']}/messages",json=data)
    assert response.status_code==200,response.text
    result=response.json();assert result['brief']['work_context']==data['message']
    assert result['messages'][-1]['mode']=='offline' and result['original_input']==draft['original_input']
    assert client.post(f"/api/work-task-conversions/{draft['id']}/messages",json=data).json()['revision']==result['revision']
    assert result['question_budget_remaining']==7


def test_generation_ticket_preview_consume_hashes_and_zero_kernel(client,monkeypatch):
    monkeypatch.setattr(settings,'role_package_launch_secret','test-handoff-secret-'*3)
    draft,_=create(client);draft=brief(client,draft);generated,_=generate(client,draft)
    assert generated['state']=='generated',generated
    assert generated['root_hash']!=draft['root_hash']
    assert 'assessment' not in json.dumps(generated['candidate']['design']['stages'])
    ticket,data=handoff(client,generated)
    assert client.post(f"/api/work-task-conversions/{draft['id']}/handoff",json=data).json()==ticket
    token=ticket['desktop_url'].split('ticket=')[1];url='/api/work-task-conversions/handoff/'+token
    preview=client.get(url).json()
    assert not preview['consumed'] and preview['project_id'] is None
    assert preview['starter_manifest_hash']==service.manifest_hash(preview['starter_files'])
    consume={'client_action_id':key(),'expected_root_hash':preview['root_hash'],'confirmed':True}
    assert client.post(url,json={**consume,'expected_root_hash':'b'*64}).status_code==409
    assert client.post(url,json={**consume,'confirmed':1}).status_code==422
    response=client.post(url,json=consume);assert response.status_code==200,response.text
    result=response.json();assert result['project_id'] and result['session_id'] and result['root_hash']==preview['root_hash']
    assert client.post(url,json={**consume,'client_action_id':key()}).json()['project_id']==result['project_id']
    assert client.get(url).json()['consumed']
    async def inspect():
        async with async_session() as db:
            events=list(await db.scalars(select(EvidenceEvent).where(EvidenceEvent.event_type.like('work_task_conversion_%'))))
            events=[e for e in events if e.payload['conversion_id']==draft['id']]
            assert events and all('mastery_unchanged' in e.payload for e in events)
            assert await db.scalar(select(func.count(KernelMutation.id)).where(KernelMutation.event_id.in_([e.id for e in events])))==0
            tickets=list(await db.scalars(select(Ticket).where(Ticket.conversion_id==draft['id'])))
            assert tickets[0].token_hash==hashlib.sha256(token.encode()).hexdigest()
            assert token not in json.dumps([e.payload for e in events])
            messages=list(await db.scalars(select(AgentMessage).where(AgentMessage.session_id==result['session_id'])))
            assert any(m.meta_data.get('work_task_conversion',{}).get('root_hash')==generated['root_hash'] for m in messages)
    asyncio.run(inspect())


def test_global_discuss_has_restorable_chat_and_no_project(client):
    draft,_=create(client);draft=brief(client,draft);draft,_=generate(client,draft,recipe='domain-draft')
    assert draft['candidate']['design']['can_materialize'] is False
    assert client.post(f"/api/work-task-conversions/{draft['id']}/handoff",json={
        'client_action_id':key(),'expected_root_hash':draft['root_hash'],'confirmed':True,'action':'desktop'}).status_code==422
    result,data=handoff(client,draft,'discuss')
    assert result['project_id'] is None and result['navigation']['path'].startswith('/chat/w2l_')
    assert client.post(f"/api/work-task-conversions/{draft['id']}/handoff",json={**data,'client_action_id':key()}).json()['session_id']==result['session_id']
    sessions=client.get('/api/agent/sessions').json()
    assert any(s.get('client_conversation_id')==result['navigation']['path'].split('/')[-1] for s in sessions)


def test_failed_provider_no_fake_success_and_expired_job_retry(client,monkeypatch):
    from learnflow_core import work_task_conversion_provider as provider
    async def fail(*args,**kwargs): raise LearningTaskIntegrationError('provider_not_configured','讯飞工作流尚未配置',status_code=503)
    monkeypatch.setattr(provider,'generate_learning',fail)
    draft,_=create(client);draft=brief(client,draft);result,body=generate(client,draft,mode='learning')
    assert result['state']=='failed' and result['candidate'] is None
    assert result['generation']['error_code']=='provider_not_configured'
    assert client.post(f"/api/work-task-conversions/{draft['id']}/generate",json=body).json()['generation']['id']==result['generation']['id']
    async def expire():
        async with async_session() as db:
            row=await db.get(Draft,draft['id']);row.state='generating';row.generation={**row.generation,'status':'running','lease_expires_at':service.iso(datetime.utcnow()-timedelta(seconds=1))};await db.commit()
    asyncio.run(expire());expired=client.get(f"/api/work-task-conversions/{draft['id']}").json()
    assert expired['generation']['error_code']=='generation_interrupted'
    retry,_=generate(client,expired,mode='learning');assert retry['generation']['id']!=result['generation']['id']


def test_real_provider_pipeline_without_project(client,monkeypatch):
    from app.services import xingchen_learning_task_candidates as x
    class Client:
        async def run(self,request,uid):
            assert request['s']['v'].startswith('brief:') and len(json.dumps(request,ensure_ascii=False))<=500
            return {'content':json.dumps(_bundle('task-test')), 'runId':'test-run'}
    monkeypatch.setattr(x,'XingchenWorkflowClient',Client)
    draft,_=create(client);draft=brief(client,draft);generated,_=generate(client,draft,mode='learning')
    assert generated['state']=='generated',generated
    result,_=handoff(client,generated,'create_project')
    async def inspect():
        async with async_session() as db:
            tasks=list(await db.scalars(select(LearningTask).where(LearningTask.project_id==result['project_id'])))
            assert len(tasks)==1 and len(tasks[0].plan['work_steps'])==3
            assert any(ref['type']=='work_task_conversion' for ref in tasks[0].source_refs)
    asyncio.run(inspect())


def test_concurrent_revision_one_winner(client):
    from concurrent.futures import ThreadPoolExecutor
    draft,_=create(client)
    body={'expected_revision':draft['revision'],'brief':{**draft['brief'],'work_context':'并发任务'}}
    def write(_):
        return client.post(f"/api/work-task-conversions/{draft['id']}/brief",json={**body,'client_action_id':key()}).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(write,range(2)))==[200,409]
    assert client.get(f"/api/work-task-conversions/{draft['id']}").json()['revision']==2


def test_expired_ticket_reissue_reuses_project_and_source_edit_denied(client,monkeypatch):
    monkeypatch.setattr(settings,'role_package_launch_secret','test-handoff-secret-'*3)
    draft,_=create(client);draft=brief(client,draft);draft,_=generate(client,draft)
    first,_=handoff(client,draft);token=first['desktop_url'].split('ticket=')[1]
    payload={'client_action_id':key(),'expected_root_hash':draft['root_hash'],'confirmed':True}
    created=client.post('/api/work-task-conversions/handoff/'+token,json=payload).json()
    async def expire():
        async with async_session() as db:
            ticket=await db.scalar(select(Ticket).where(Ticket.token_hash==hashlib.sha256(token.encode()).hexdigest()))
            ticket.expires_at=datetime.utcnow()-timedelta(seconds=1);await db.commit()
    asyncio.run(expire())
    assert client.get('/api/work-task-conversions/handoff/'+token).status_code==410
    reissued,_=handoff(client,draft);newtoken=reissued['desktop_url'].split('ticket=')[1]
    repeated=client.post('/api/work-task-conversions/handoff/'+newtoken,json=payload)
    assert repeated.status_code==200,repeated.text
    assert repeated.json()['project_id']==created['project_id']
    assert client.post(f"/api/work-task-conversions/{draft['id']}/brief",json={
        'client_action_id':key(),'expected_revision':draft['revision'],'brief':draft['brief']}).status_code==409


def test_llm_grounding_and_access_log_redaction(monkeypatch):
    import logging
    from learnflow_core.work_task_conversion_logging import HandoffTokenFilter
    token='wt_'+'a'*43
    record=logging.LogRecord('uvicorn.access',20,'',0,'%s %s',('GET','/api/work-task-conversions/handoff/'+token),None)
    assert HandoffTokenFilter().filter(record)
    assert token not in record.getMessage() and '[handoff-redacted]' in record.getMessage()
    class Response:
        def raise_for_status(self): pass
        def json(self): return {'choices':[{'message':{'content':json.dumps({'fields':{
            'work_context':{'value':'仓库测试','evidence':'仓库测试'},
            'deliverable':{'value':'发射卫星','evidence':'仓库测试'},
            'learner_level':{'value':'熟练','evidence':'不存在的自述'}}})}}]}
    class Client:
        def __init__(self,**kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self,*args): pass
        async def post(self,*args,**kw): return Response()
    monkeypatch.setattr(settings,'llm_api_key','test-key')
    monkeypatch.setattr(service.httpx,'AsyncClient',Client)
    fields,mode,_=asyncio.run(service.propose_brief([{'role':'user','content':'仓库测试'}],service.Brief().model_dump()))
    assert fields=={'work_context':'仓库测试'} and mode=='online'


def test_discuss_existing_project_replay_preserves_project_scope(client):
    original=client.post('/api/vnext-projects',json={'name':'已有学习项目','objective':'任务定义'}).json()
    project_id=original['project']['id']
    draft,_=create(client);draft=brief(client,draft);draft,_=generate(client,draft,recipe='domain-draft')
    # Domain authoring proposal is experiment mode, use a matching project.
    async def mode():
        async with async_session() as db:
            project=await db.get(Project,project_id);project.project_mode='experiment';await db.commit()
    asyncio.run(mode())
    first,request=handoff(client,draft,'discuss',project_id=project_id)
    assert first['project_id']==project_id
    response=client.post(f"/api/work-task-conversions/{draft['id']}/handoff",json={**request,'client_action_id':key()})
    assert response.status_code==200,response.text
    assert response.json()['project_id']==project_id and response.json()['session_id']==first['session_id']
    assert client.post(f"/api/work-task-conversions/{draft['id']}/handoff",json={**request,'client_action_id':key(),'project_id':None}).status_code==409


def test_concurrent_ticket_consumption_creates_one_project(client,monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    monkeypatch.setattr(settings,'role_package_launch_secret','test-handoff-secret-'*3)
    draft,_=create(client);draft=brief(client,draft);draft,_=generate(client,draft)
    handoff_data,_=handoff(client,draft);token=handoff_data['desktop_url'].split('ticket=')[1]
    def consume(_):
        response=client.post('/api/work-task-conversions/handoff/'+token,json={
            'client_action_id':key(),'expected_root_hash':draft['root_hash'],'confirmed':True})
        assert response.status_code==200,response.text
        return response.json()['project_id']
    with ThreadPoolExecutor(max_workers=2) as pool:
        ids=list(pool.map(consume,range(2)))
    assert ids[0]==ids[1]
    async def count():
        async with async_session() as db:
            return await db.scalar(select(func.count(Project.id)).where(Project.id==ids[0]))
    assert asyncio.run(count())==1


def test_selected_learning_steps_survive_tutor_context_and_resume(client, monkeypatch):
    from copy import deepcopy
    from app.services import xingchen_learning_task_candidates as x
    class Client:
        async def run(self, request, uid):
            bundle = _bundle("selected-test")
            work = bundle["task"]["work_task"]
            extra = deepcopy(work["task_steps"][-1])
            extra.update(step_id="step_4", name="额外归档", action="保存审计副本", deliverable="审计副本", check="副本完整")
            work["task_steps"].append(extra)
            return {"content": json.dumps(bundle), "runId": "selected-run"}
    monkeypatch.setattr(x, "XingchenWorkflowClient", Client)
    draft, _ = create(client)
    draft = brief(client, draft)
    draft, _ = generate(client, draft, mode="learning")
    assert draft["state"] == "generated", draft
    original_steps = draft["candidate"]["learning_candidate"]["task"]["steps"]
    assert len(original_steps) == 4
    ids = [step["id"] for step in original_steps[:3]]
    result, _ = handoff(client, draft, "discuss", selected_step_ids=ids)
    resumed = client.get(f"/api/work-task-conversions/{draft['id']}").json()
    assert resumed["selection"]["selected_step_ids"] == ids
    async def check():
        async with async_session() as db:
            session = await db.get(AgentSession, result["session_id"])
            context = session.context_summary["work_task_conversion"]
            assert context["selected_step_ids"] == ids
            assert len(context["candidate"]["learning_candidate"]["task"]["steps"]) == 4
            assert [step["id"] for step in context["selected_learning_candidate"]["task"]["steps"]] == ids
    asyncio.run(check())
