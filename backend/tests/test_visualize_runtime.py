import asyncio, copy, json
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, func
from app.main import app
from app.core.config import settings
from app.db.database import async_session
from app.models.learning import EvidenceEvent, KernelMutation
from learnflow_core.visuals.engine import compile_visual, inspect_visual, predict_visual
ROOT = next(p for p in Path(__file__).resolve().parents if (p/'packages/learning-core').exists())
def example(name): return json.loads((ROOT/f'docs/design/visualize/source/examples/{name}.visualspec.json').read_text())
@pytest.mark.parametrize('name',['bfs','gradient-descent','density-area'])
def test_examples_replay_all_bindings(name):
    spec=example(name);a=compile_visual(spec);assert a==compile_visual(copy.deepcopy(spec))
    for f in a['frames']:assert inspect_visual(spec,a['params'],f['step'],f['snapshot_ref'])['semantic_state']==f['state']
def test_golden_reset_snapshot_and_prediction():
    spec=example('gradient-descent');a=compile_visual(spec)
    assert [(f['state']['x'],f['state']['loss']) for f in a['frames'][:3]]==[(-4,36),(5,9),(.5,2.25)]
    b=compile_visual(spec,{'alpha':.5});assert a['run_id']!=b['run_id']
    with pytest.raises(ValueError,match='state conflict'):inspect_visual(spec,b['params'],0,a['frames'][0]['snapshot_ref'])
    for alpha in [.05,.25,.5,.75,1,1.1]:assert compile_visual(spec,{'alpha':alpha})
    assert predict_visual(spec,a['params'],0,a['frames'][0]['snapshot_ref'],'cross_closer')['correct']
    assert predict_visual(spec,b['params'],0,b['frames'][0]['snapshot_ref'],'optimum')['correct']
def test_bfs_and_pdf():
    assert [f['state']['queue'] for f in compile_visual(example('bfs'))['frames']]==[['a'],['b','c'],['c','d'],['d'],[]]
    s=example('bfs');s['data']['graph']['nodes'].append('z');assert 'z' not in compile_visual(s)['frames'][-1]['state']['distance']
    s['model']['max_steps']=1
    with pytest.raises(ValueError,match='truncated'):compile_visual(s)
    s=example('density-area');assert compile_visual(s)['frames'][0]['state']['probability']==.2
    assert compile_visual(s,{'width':2})['frames'][0]['state']['probability']==.05
@pytest.mark.parametrize('mutate',[
 lambda s:s.update(script='alert(1)'),lambda s:s['model'].update(id='unknown'),lambda s:s['model'].update(max_steps=1000),lambda s:s['model'].update(version='2.0.0'),lambda s:s['data'].update(x0=float('nan')),lambda s:s['views'][0]['elements'][0]['inputs']['axes'].update(source='/state/missing'),lambda s:s['views'][0].update(renderer='canvas'),lambda s:s['parameters'][0].update(default=.76),lambda s:s['data'].update(__proto__={}),lambda s:s['playback']['transition'].update(kind='interpolate')])
def test_reject_invalid(mutate):
 s=example('gradient-descent');mutate(s)
 with pytest.raises(Exception):compile_visual(s)
async def counts():
 async with async_session() as db:
  return (int((await db.execute(select(func.count(EvidenceEvent.id)).where(EvidenceEvent.event_type=='visual_exploration_recorded'))).scalar_one()),int((await db.execute(select(func.count(KernelMutation.id)))).scalar_one()))
def test_authenticated_idempotent_zero_kernel(monkeypatch):
 monkeypatch.setattr(settings,'desktop_mode',False);monkeypatch.setattr(settings,'desktop_token','')
 with TestClient(app) as c:
  s=example('gradient-descent');assert c.post('/api/visuals/compile',json={'spec':s}).status_code in (401,403)
  registration={'username':'visualize_owner','password':'learnflow-pass-123','display_name':'visualize_owner','education_stage':'undergraduate','background':'Python','focus_areas':['算法'],'weekly_hours':5,'preferred_modes':['explanation'],'career_goal':'','career_goal_status':'exploring'}
  assert c.post('/api/auth/register',json=registration).status_code==200
  csrf=c.get('/api/auth/csrf').json()['csrf_token']
  c.headers.update({'Origin':settings.cors_origins_list[0],'X-CSRF-Token':csrf})
  r=c.post('/api/visuals/compile',json={'spec':s});assert r.status_code==200,r.text
  b=r.json();before=asyncio.run(counts());p={'spec':s,'params':b['params'],'step':0,'snapshot_ref':b['frames'][0]['snapshot_ref'],'answer':'cross_closer'}
  for _ in range(2):
   r=c.post('/api/visuals/predict',json=p);assert r.status_code==200,r.text;assert r.json()['correct']
  assert asyncio.run(counts())==(before[0]+1,before[1])
  p.pop('answer');p['params']={'alpha':.5};assert c.post('/api/visuals/inspect',json=p).status_code==409
