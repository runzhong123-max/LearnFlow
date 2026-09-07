"""Two product goldens: maintained CNN retrieval and a recipe absent from the library."""
import copy
import math
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.core.config import settings
from learnflow_core.visuals.catalog import read_template, search_catalog
from learnflow_core.visuals.engine import compile_visual, inspect_visual


def test_maintained_cnn_discovery_recompute_and_authenticated_provenance(monkeypatch):
    catalog = search_catalog('CNN 手写数字识别，给我一个动画演示一下', 'animation')
    assert catalog['templates'][0]['id'] == 'deep_learning.cnn.mechanism'
    reference = {'id': 'deep_learning.cnn.mechanism', 'version': '1.0.0'}
    recipe = read_template(**{'template_id': reference['id'], 'version': reference['version']})
    spec = recipe['spec']
    bundle = compile_visual(spec)
    final = bundle['frames'][-1]['state']['results']
    assert len(final['conv']) == 4 and len(final['conv'][0]) == 4
    assert len(final['pool']) == 2 and len(final['probabilities']) == 10
    assert math.isclose(sum(final['probabilities']), 1, abs_tol=1e-12)
    changed = compile_visual(spec, {'stride': 2, 'padding': 1})
    assert len(changed['frames'][-1]['state']['results']['conv']) == 3
    assert changed['run_id'] != bundle['run_id']
    with pytest.raises(ValueError, match='state conflict'):
        inspect_visual(spec, changed['params'], 0, bundle['frames'][0]['snapshot_ref'])
    assert not search_catalog('新问题 violet tensor projection', 'animation')['templates']
    with pytest.raises(ValueError):
        read_template('../../credentials', '1.0.0')
    monkeypatch.setattr(settings, 'desktop_mode', False)
    monkeypatch.setattr(settings, 'desktop_token', '')
    with TestClient(app) as client:
        assert client.post('/api/visuals/catalog', json={'query':'CNN','kind':'animation'}).status_code in (401,403)
        registration={'username':'visual_composition','password':'learnflow-pass-123','display_name':'Visual','education_stage':'undergraduate','background':'Python','focus_areas':['算法'],'weekly_hours':5,'preferred_modes':['explanation'],'career_goal':'','career_goal_status':'exploring'}
        assert client.post('/api/auth/register',json=registration).status_code == 200
        client.headers.update({'Origin':settings.cors_origins_list[0], 'X-CSRF-Token':client.get('/api/auth/csrf').json()['csrf_token']})
        response=client.post('/api/visuals/template',json=reference)
        assert response.status_code == 200, response.text
        response=client.post('/api/visuals/compile',json={'spec':spec,'template_ref':reference})
        assert response.status_code == 200, response.text
        assert response.json()['source_provenance']['source'] == 'maintained_library'
        adapted=copy.deepcopy(spec);adapted['title']='按当前问题调整的教学网络'
        response=client.post('/api/visuals/compile',json={'spec':adapted,'template_ref':reference})
        assert response.json()['source_provenance']['source'] == 'adapted_library'
        malformed=copy.deepcopy(spec);del malformed['model']['inputs']
        malformed['teaching']['misconceptions']=['误解描述并非ID']
        malformed['teaching']['checkpoints']=['checkpoint_is_not_an_object']
        response=client.post('/api/visuals/compile',json={'spec':malformed})
        assert response.status_code == 422
        assert 'missing=inputs' in response.json()['detail']
        assert '/teaching/misconceptions/0' in response.json()['detail']
        assert '/teaching/checkpoints/0' in response.json()['detail']


def test_from_scratch_pipeline_and_authored_timeline_are_distinct():
    spec=read_template('deep_learning.cnn.mechanism','1.0.0')['spec']
    spec['id']='novel_matrix_composition';spec['parameters']=[]
    spec['interactions']=[i for i in spec['interactions'] if i['kind']=='stepper']
    spec['data']={'a':[[1,2],[3,4]],'b':[[2,0],[0,2]],'program':{'steps':[
        {'id':'transpose','op':'transpose','args':{'input':{'source':'/data/a'}},'title':'转置','narration':'行列交换。'},
        {'id':'product','op':'matmul','args':{'left':{'source':'/state/results/transpose'},'right':{'source':'/data/b'}},'title':'矩阵乘法','narration':'与对角矩阵相乘。'},
        {'id':'flat','op':'flatten','args':{'input':{'source':'/state/results/product'}},'title':'展平','narration':'按行读取全部结果。'},
        {'id':'prob','op':'softmax','args':{'input':{'source':'/state/results/flat'}},'title':'归一化','narration':'由程序计算指数与总和。'},
    ]}}
    spec['views'][1]['elements'][0]['inputs']['active_cells']={'source':'/state/active/active_cells'}
    bundle=compile_visual(spec)
    results=bundle['frames'][-1]['state']['results']
    assert results['product'] == [[2,6],[4,8]]
    assert len(results['prob']) == 4 and math.isclose(sum(results['prob']),1,abs_tol=1e-12)
    assert bundle['verification']['scope'] == 'registered_operations_current_run'
    assert 'prob' not in bundle['frames'][0]['state']['results']
    assert '[i,j]' in bundle['frames'][0]['narration'] and '[j,i]' in bundle['frames'][0]['narration']
    assert bundle['frames'][0]['state']['authored_note'] == '行列交换。'
    product_frame=next(frame for frame in bundle['frames'] if frame['state']['operation']=='matmul')
    assert any(element['label']=='右侧矩阵' for view in product_frame['views'] for element in view['elements'])
    product_window=next(frame for frame in bundle['frames'] if frame['state']['operation']=='matmul' and frame['state']['phase']=='window')
    right=next(element for view in product_window['views'] for element in view['elements'] if element['label']=='右侧矩阵')
    assert right['values']['active_cells']==[[0,0],[1,0]]
    invalid=copy.deepcopy(spec);invalid['data']['program']['steps'][0]['op']='eval'
    with pytest.raises(ValueError): compile_visual(invalid)
    sequence=read_template('networking.tcp.handshake','1.0.0')['spec']
    trace=compile_visual(sequence)
    assert len(trace['frames'])==4
    assert trace['verification']['scope']=='illustrative_authored_sequence'
    assert trace['frames'][-1]['state']['rows']==[['客户端','ESTABLISHED'],['服务端','ESTABLISHED']]
