"""Two goldens: curriculum discovery and immutable interactive work ownership."""
import copy
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.core.config import settings
from learnflow_core.visuals.hub import curriculum, works, compile_work, reference, query_hub
from learnflow_core.visuals.catalog import search_catalog, read_template
from test_visual_workspace import register, call


def test_curriculum_ready_references_and_dependency_graph():
    data = curriculum(); modules = {m['id']:m for m in data['modules']}; seen=set(); active=set()
    def visit(mid):
        assert mid in modules
        if mid in seen:return
        assert mid not in active, 'cyclic prerequisites'
        active.add(mid)
        for parent in modules[mid]['prerequisite_module_ids']:visit(parent)
        active.remove(mid);seen.add(mid)
    for mid in modules:visit(mid)
    for track in data['tracks']:
        assert all(mid in modules for mid in track['module_ids'])
    ids=[]; ready=set()
    for m in modules.values():
        for chapter in m['chapters']:
            for s in chapter['sessions']:
                ids.append(s['id']);assert s['duration_minutes']==[20,40]
                for candidate in s['visual_candidates']:
                    if candidate['status']=='ready':
                        assert candidate['work_refs']
                        for ref in candidate['work_refs']:
                            entry=read_template(ref['id'],ref['version']);assert entry['builder'] in ('interactive_html','visual_spec');ready.add(ref['id'])
                    else:assert candidate['status']=='planned' and not candidate['work_refs']
    assert len(ids)==len(set(ids)) and len(modules)>=40
    assert {w['id'] for w in works()} <= ready
    result=query_hub(module_id='math-calculus',limit=2)
    assert result['total']==6 and result['next_offset']==2
    assert query_hub(module_id='math-calculus',offset=2,limit=2)['sessions'][0]['id']!=result['sessions'][0]['id']
    assert any(t['id']=='hub-derivative' for t in search_catalog('割线 导数','animation')['templates'])
    assert not search_catalog('割线 导数','animation',False)['templates']
    for w in works():
        bundle=compile_work(reference(w));assert "connect-src 'none'" in bundle['html']
        bad={**reference(w),'sha256':'0'*64}
        with pytest.raises(ValueError):compile_work(bad)
    with pytest.raises(ValueError):query_hub(limit=10000)


def test_hub_publish_read_and_isolation(monkeypatch):
    monkeypatch.setattr(settings,'desktop_mode',False);monkeypatch.setattr(settings,'desktop_token','')
    with TestClient(app) as client:
        assert client.post('/api/visuals/hub',json={}).status_code in (401,403)
        register(client,'hub_owner')
        assert client.post('/api/visuals/hub',json={'module_id':'math-linear'}).json()['total']==6
        entry=read_template('hub-linear','1.0.0')
        job=call(client,'start_job',{'request_id':'hub-golden','request':'观察二维线性变换','kind':'animation','source_mode':'reuse'})
        p={'job_id':job['job_id'],'expected_version':1,'builder':'interactive_html','source':entry['spec'],'template_ref':{'id':entry['id'],'version':entry['version']}}
        bad=copy.deepcopy(p);bad['source']['html']='<script>evil()</script>';call(client,'publish',bad,422)
        artifact=call(client,'publish',p);assert call(client,'publish',p)==artifact
        result=call(client,'read',{'revision_id':artifact['revision_id']});assert result['builder']=='interactive_html' and 'data-lab="linear"' in result['html']
        call(client,'rerun',{'revision_id':artifact['revision_id'],'params':{'k':2}},422)
        fresh=call(client,'start_job',{'request_id':'hub-fresh','request':'新的动画','kind':'animation','source_mode':'fresh'})
        call(client,'publish',{'job_id':fresh['job_id'],'expected_version':1,'builder':'interactive_html','source':entry['spec']},422)
        register(client,'hub_other')
        call(client,'read',{'revision_id':artifact['revision_id']},404)
