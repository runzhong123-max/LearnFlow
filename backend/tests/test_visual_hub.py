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
    assert len(ids)==len(set(ids)) == 246 and len(modules)==41
    assert all(v['status']=='ready' and v['work_refs'] for m in modules.values() for c in m['chapters'] for s in c['sessions'] for v in s['visual_candidates'])
    latest = search_catalog('哈夫曼 编码', 'animation')['templates']
    assert len({r['id'] for r in latest}) == len(latest)
    assert not any(r['id']=='lab2-huffman' and r['version']!='2.0.0' for r in latest)
    assert {w['id'] for w in works()} <= ready
    result=query_hub(module_id='math-calculus',limit=2)
    assert result['total']==6 and result['next_offset']==2
    assert query_hub(module_id='math-calculus',offset=2,limit=2)['sessions'][0]['id']!=result['sessions'][0]['id']
    assert any(t['id']=='hub-derivative' for t in search_catalog('割线 导数','diagram')['templates'])
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


def test_gallery_paging_filter_and_authenticated_preview(monkeypatch):
    from learnflow_core.visuals.hub import browse_works
    all_rows=browse_works(limit=50)
    assert all_rows['total']==296 and all_rows['next_offset']==50
    assert len(browse_works(offset=250,limit=50)['items'])==46
    huffman=browse_works(query='哈夫曼')['items']
    assert huffman and huffman[0]['id']=='lab2-huffman'
    assert all('animation' in row['kind'] for row in browse_works(kind='animation',limit=50)['items'])
    assert not browse_works(query='not-present-xqz')['items']
    with pytest.raises(ValueError):browse_works(limit=0)
    with pytest.raises(ValueError):browse_works(module_id={})
    monkeypatch.setattr(settings,'desktop_mode',False);monkeypatch.setattr(settings,'desktop_token','')
    with TestClient(app) as client:
        assert client.post('/api/visuals/preview',json={'id':'lab2-huffman','version':'1.0.0'}).status_code==200
        assert client.post('/api/visuals/gallery',json={}).json()['total']==296
        assert client.post('/api/visuals/compile',json={}).status_code in (401,403)
        assert client.post('/api/visuals/workspace',json={}).status_code in (401,403)
        for row in [r for offset in range(0,296,50) for r in browse_works(offset=offset,limit=50)['items']]:
            response=client.post('/api/visuals/preview',json={'id':row['id'],'version':row['version']})
            assert response.status_code==200
            if response.json()['builder']=='visual_spec':
                bundle=response.json()['bundle'];assert bundle['owner_scope']=='public:maintained'
                response=client.post('/api/visuals/preview',json={'id':row['id'],'version':row['version'],'params':bundle['params']})
                assert response.status_code==200 and response.json()['bundle']['owner_scope']==bundle['owner_scope']
        assert client.post('/api/visuals/preview',json={'id':'deep_learning.cnn.mechanism','version':'1.0.0','spec':{}}).status_code==422
        register(client,'hub_gallery_owner')
        result=client.post('/api/visuals/gallery',json={'query':'哈夫曼'});assert result.status_code==200
        result=client.post('/api/visuals/preview',json={'id':'lab2-huffman','version':'1.0.0'});assert result.status_code==200 and result.json()['builder']=='interactive_html'
        assert client.post('/api/visuals/preview',json={'id':'../../secret','version':'1.0.0'}).status_code==422
        result=client.post('/api/visuals/preview',json={'id':'deep_learning.cnn.mechanism','version':'1.0.0'});assert result.status_code==200 and result.json()['bundle']['verification']['status']=='pass'
