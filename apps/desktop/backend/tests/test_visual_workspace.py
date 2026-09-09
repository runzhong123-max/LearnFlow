"""Two golden workflows: private computed revision and native authored SVG story."""
import asyncio
import copy
import json
from concurrent.futures import ThreadPoolExecutor
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, func
from app.main import app
from app.core.config import settings
from app.db.database import async_session
from app.models.learning import EvidenceEvent, KernelMutation
from learnflow_core.visuals.catalog import read_template
from learnflow_core.visuals.workspace import VisualJob, VisualRevision, VisualRun, workspace_operation


def register(client, username):
    p={'username':username,'password':'learnflow-pass-123','display_name':username,'education_stage':'undergraduate','background':'Python','focus_areas':['算法'],'weekly_hours':5,'preferred_modes':['explanation'],'career_goal':'','career_goal_status':'exploring'}
    r=client.post('/api/auth/register',json=p);assert r.status_code==200,r.text
    client.headers.update({'Origin':settings.cors_origins_list[0],'X-CSRF-Token':client.get('/api/auth/csrf').json()['csrf_token']})


def call(client, operation, payload, expected=200):
    response=client.post('/api/visuals/workspace',json={'operation':operation,'payload':payload})
    assert response.status_code==expected,response.text
    return response.json()


async def counts():
    async with async_session() as db:
        return tuple([int(await db.scalar(select(func.count(cls.id)))) for cls in (VisualJob,VisualRevision,VisualRun,KernelMutation)])


def test_computed_workspace_resume_revisions_ownership_and_idempotency(monkeypatch):
    monkeypatch.setattr(settings,'desktop_mode',False);monkeypatch.setattr(settings,'desktop_token','')
    with TestClient(app) as client:
        call(client,'search',{'query':''},401)
        register(client,'visual_store_owner')
        project=client.post('/api/projects',json={'name':'Synthetic visual project','user_level':'beginner'});assert project.status_code==200,project.text
        session=client.post('/api/agent/sessions',json={'session_type':'global'});assert session.status_code==200,session.text
        scope={'project_id':project.json()['id'],'session_id':session.json()['id']}
        initial=asyncio.run(counts())
        start={**scope,'request_id':'computed-golden','request':'演示梯度下降','kind':'animation','source_mode':'reuse'}
        # Concurrent logical duplicates share exactly one job, even across requests.
        with ThreadPoolExecutor(max_workers=2) as pool:
            jobs=list(pool.map(lambda _:call(client,'start_job',start),range(2)))
        job=jobs[0];assert jobs[1]['job_id']==job['job_id'] and job['version']==1
        call(client,'start_job',{**start,'request':'换一个请求'},409)
        recipe=read_template('optimization.gd.overshoot','1.0.0');spec=recipe['spec'];ref={'id':recipe['id'],'version':recipe['version']}
        candidate={'builder':'visual_spec','source':spec,'template_ref':ref}
        paused=call(client,'checkpoint',{'job_id':job['job_id'],'expected_version':1,'stage':'waiting_budget','status':'paused','candidate':candidate,'diagnostics':['预算暂停，可继续']})
        assert paused['version']==2 and paused['candidate']==candidate
        recovered=call(client,'search',{'query':'梯度下降','kind':'animation'})['jobs']
        assert recovered[0]['job_id']==job['job_id'] and recovered[0]['version']==2 and recovered[0]['status']=='paused'
        assert 'candidate' not in recovered[0] and 'route' not in recovered[0] and recovered[0]['updated_at']
        resumed=call(client,'get_job',{'job_id':recovered[0]['job_id']});assert resumed['candidate']==candidate
        assert not call(client,'search',{'query':'梯度下降','kind':'diagram'})['jobs']
        call(client,'checkpoint',{'job_id':job['job_id'],'expected_version':1,'stage':'wrong','status':'running'},409)
        publication={'job_id':job['job_id'],'expected_version':2,**candidate}
        with ThreadPoolExecutor(max_workers=2) as pool:
            references=list(pool.map(lambda _:call(client,'publish',publication),range(2)))
        artifact=references[0];assert references[1]==artifact
        assert not call(client,'search',{'query':'梯度下降'})['jobs']
        assert call(client,'publish',publication)==artifact
        call(client,'publish',{**publication,'source':{**spec,'title':'另一份'}},409)
        read=call(client,'read',{'revision_id':artifact['revision_id']})
        assert read['bundle']['source_provenance']['source']=='maintained_library'
        snap=read['bundle']['frames'][1]['snapshot_ref']
        view={'revision_id':artifact['revision_id'],'run_id':artifact['run_id'],'view_state':{'step':1,'speed':1,'focus':'current'}}
        call(client,'view',view)
        assert call(client,'read',{'revision_id':artifact['revision_id']})['view_state']==view['view_state']
        changed=call(client,'rerun',{'revision_id':artifact['revision_id'],'params':{'alpha':0.5}})
        assert changed['run_id']!=artifact['run_id'] and changed['bundle']['params']['alpha']==0.5
        assert call(client,'rerun',{'revision_id':artifact['revision_id'],'params':{'alpha':0.5}})['run_id']==changed['run_id']
        assert call(client,'read',{'revision_id':artifact['revision_id']})['run_id']==artifact['run_id']
        feedback={'revision_id':artifact['revision_id'],'run_id':artifact['run_id'],'snapshot_ref':snap,'comment':'这一步已经看清楚了'}
        assert call(client,'feedback',feedback)==call(client,'feedback',feedback)
        async def scoped_events():
            async with async_session() as db:
                rows=(await db.scalars(select(EvidenceEvent).where(EvidenceEvent.event_type=='visual_workspace_changed'))).all()
                return [(e.project_id,e.session_id,e.payload['operation']) for e in rows if e.payload.get('job_id')==job['job_id']]
        assert set(asyncio.run(scoped_events()))=={(scope['project_id'],scope['session_id'],op) for op in ('publish','rerun','feedback')}
        call(client,'feedback',{**feedback,'snapshot_ref':'foreign-snapshot'},409)
        adapt=call(client,'start_job',{'request_id':'adapt-golden','request':'调整标题','kind':'animation','source_mode':'adapt','base_revision_id':artifact['revision_id']})
        revised=copy.deepcopy(spec);revised['title']='新的教学视角'
        second=call(client,'publish',{'job_id':adapt['job_id'],'expected_version':1,'builder':'visual_spec','source':revised,'parent_revision_id':artifact['revision_id']})
        assert second['artifact_id']==artifact['artifact_id'] and second['revision_id']!=artifact['revision_id']
        assert call(client,'read',{'revision_id':artifact['revision_id']})['source']['title']==spec['title']
        assert call(client,'search',{'query':'新的教学视角'})['items'][0]['revision_id']==second['revision_id']
        body_query='交替收敛与等幅振荡是什么关系'
        body_match=call(client,'search',{'query':body_query})['items']
        assert body_query not in revised['title'] and body_match[0]['revision_id']==second['revision_id']
        assert '交替收敛' in body_match[0]['summary'] and '等幅振荡' in body_match[0]['retrieval_snippet']
        assert len({item['artifact_id'] for item in body_match})==len(body_match)
        after=asyncio.run(counts());assert after[1]-initial[1]==2 and after[2]-initial[2]==3 and after[3]==initial[3]
        other=TestClient(app)
        register(other,'visual_store_other')
        for op,p in [('get_job',{'job_id':job['job_id']}),('read',{'revision_id':artifact['revision_id']}),('rerun',{'revision_id':artifact['revision_id'],'params':{}}),('feedback',{'revision_id':artifact['revision_id'],'comment':'x'}),('start_job',{'request_id':'foreign','request':'copy','kind':'animation','source_mode':'adapt','base_revision_id':artifact['revision_id']})]:call(other,op,p,404)
        assert not call(other,'search',{'query':'新的教学视角'})['items']
        assert not call(other,'search',{'query':body_query})['items']
        call(other,'start_job',{'request_id':'foreign-project','request':'copy','kind':'animation','source_mode':'fresh','project_id':999999},404)


def test_native_svg_story_publish_cancel_and_explicit_fresh(monkeypatch):
    monkeypatch.setattr(settings,'desktop_mode',False);monkeypatch.setattr(settings,'desktop_token','')
    source={'story_version':'1','title':'独立消息过程','goal':'观察消息方向','nodes':[{'id':'client','label':'<script>alert(1)</script>'},{'id':'server','label':'接收方'}],
            'edges':[{'id':'message','from':'client','to':'server','label':'请求'}],
            'steps':[{'title':'开始','note':'发送前状态','active_nodes':['client'],'active_edges':[]},{'title':'传递','note':'沿消息关系传递','active_nodes':['server'],'active_edges':['message']}]}
    with TestClient(app) as client:
        register(client,'visual_store_story')
        job=call(client,'start_job',{'request_id':'svg-story','request':'从零构建消息动画','kind':'animation','source_mode':'fresh'})
        recipe=read_template('optimization.gd.overshoot','1.0.0')
        call(client,'publish',{'job_id':job['job_id'],'expected_version':1,'builder':'visual_spec','source':recipe['spec'],'template_ref':{'id':recipe['id'],'version':recipe['version']}},422)
        ref=call(client,'publish',{'job_id':job['job_id'],'expected_version':1,'builder':'svg_story','source':source})
        read=call(client,'read',{'revision_id':ref['revision_id']});assert len(read['scenes'])==2 and ref['verification']['scope']=='authored_structural_illustration'
        assert '&lt;script&gt;' in read['scenes'][0]['svg'] and '<script>' not in read['scenes'][0]['svg']
        assert read['scenes'][0]['snapshot_ref']!=read['scenes'][1]['snapshot_ref']
        assert call(client,'read',{'revision_id':ref['revision_id']})==read
        cancelled=call(client,'start_job',{'request_id':'cancel-story','request':'另一个动画','kind':'animation','source_mode':'auto'})
        call(client,'checkpoint',{'job_id':cancelled['job_id'],'expected_version':1,'stage':'budget_pause','status':'paused','candidate':{'builder':'svg_story','source':source}})
        stopped=call(client,'cancel_job',{'job_id':cancelled['job_id']});assert stopped['status']=='cancelled' and stopped['candidate']['source']==source
        assert call(client,'cancel_job',{'job_id':cancelled['job_id']})==stopped
        call(client,'publish',{'job_id':cancelled['job_id'],'expected_version':3,'builder':'svg_story','source':source},409)
        invalid=call(client,'start_job',{'request_id':'invalid-story','request':'重复状态','kind':'animation','source_mode':'fresh'})
        identical={**source,'steps':[source['steps'][0],source['steps'][0]]}
        call(client,'publish',{'job_id':invalid['job_id'],'expected_version':1,'builder':'svg_story','source':identical},422)
        assert call(client,'get_job',{'job_id':invalid['job_id']})['status']=='running'
        recoverable=call(client,'search',{'query':''})['jobs']
        assert [item['job_id'] for item in recoverable]==[invalid['job_id']]
        other=TestClient(app);register(other,'visual_store_story_other')
        assert not call(other,'search',{'query':'重复状态'})['jobs']


def test_svg_story_optional_step_identity_and_precise_diagnostics():
    import copy
    from learnflow_core.visuals.svg_story import compile_svg_story
    import pytest
    source = {'story_version': '1', 'title': '合并过程', 'goal': '追踪状态',
              'nodes': [{'id': 'a', 'label': 'A'}, {'id': 'b', 'label': 'B'}], 'edges': [],
              'steps': [{'id': 'start', 'title': '开始', 'note': '观察 A', 'active_nodes': ['a'], 'active_edges': []},
                        {'id': 'next', 'title': '下一步', 'note': '观察 B', 'active_nodes': ['b'], 'active_edges': []}]}
    # A persisted candidate with harmless step identifiers must compile unchanged.
    assert compile_svg_story(source, 'animation')['source'] == source
    invalid = copy.deepcopy(source)
    invalid['steps'][1]['unexpected'] = True
    del invalid['steps'][1]['note']
    with pytest.raises(ValueError, match=r"/steps/1: missing fields \['note'\]; unknown fields \['unexpected'\]"):
        compile_svg_story(invalid, 'animation')
    invalid = copy.deepcopy(source)
    invalid['steps'][1]['id'] = 'start'
    with pytest.raises(ValueError, match='/steps/1/id: invalid or duplicate'):
        compile_svg_story(invalid, 'animation')
    invalid = copy.deepcopy(source)
    invalid['steps'][1]['active_nodes'] = ['missing']
    with pytest.raises(ValueError, match='/steps/1/active_nodes: references invalid'):
        compile_svg_story(invalid, 'animation')
