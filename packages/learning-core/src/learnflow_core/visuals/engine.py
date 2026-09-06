"""Production host validation adapted from the supplied reference (see SOURCE.md)."""
import copy
import json
import math
import re
import sys
from pathlib import Path
from jsonschema import Draft202012Validator

SCHEMA = json.loads(Path(__file__).with_name('schema.json').read_text())
RUNTIME_VERSION = 'learnflow.visualize.1.0.0'
KINDS = {
 'axis': ({'axes'}, set()), 'curve': ({'points'}, set()),
 'point': ({'point'}, set()), 'region': ({'polygon'}, set()),
 'array': ({'items'}, set()), 'matrix': ({'values'}, set()),
 'graph': ({'graph'}, {'active'}), 'code': ({'source'}, {'active_line'}),
 'text': ({'value'}, set()), 'metric': ({'value'}, set()),
}
MODELS = {
 'optimization.quadratic_gd': {'alpha','x0','center'},
 'algorithms.bfs': {'graph','start'},
 'probability.uniform_interval': {'width','a','b'},
 'structure.snapshot': {'content'},
}
CHECKS = {
 'optimization.quadratic_gd': 'optimization.quadratic_recurrence',
 'algorithms.bfs': 'algorithms.bfs_invariants',
 'probability.uniform_interval': 'probability.uniform_mass',
 'structure.snapshot': 'structure.bindings',
}
def ensure(condition, message):
    if not condition: raise ValueError(message)
def numeric(x): return isinstance(x,(int,float)) and not isinstance(x,bool) and math.isfinite(x)
def point(x): return isinstance(x,list) and len(x)==2 and all(numeric(v) for v in x)
def unique(values,label): ensure(len(set(values))==len(values),f'duplicate {label}')
def pointer(root,path):
    tokens=path.split('/')[1:]
    ensure(tokens and tokens[0] in {'params','data','state','derived'},'bad root')
    value=root
    for t in tokens:
        t=t.replace('~1','/').replace('~0','~')
        ensure(t not in {'__proto__','constructor','prototype'},'forbidden token')
        if isinstance(value,list):
            ensure(t.isdigit() and int(t)<len(value),'invalid index')
            value=value[int(t)]
        else:
            ensure(isinstance(value,dict) and t in value,'unresolved binding '+path)
            value=value[t]
    return value

def structure(spec):
    ensure(len(json.dumps(spec,ensure_ascii=False).encode())<=262144,'payload limit')
    def walk(x,depth=0):
        ensure(depth<=32,'depth limit')
        if isinstance(x,float): ensure(math.isfinite(x),'nonfinite')
        if isinstance(x,dict):
            for k,v in x.items():
                ensure(k not in {'__proto__','constructor','prototype'},'unsafe property')
                walk(v,depth+1)
        if isinstance(x,list):
            for v in x:walk(v,depth+1)
    walk(spec)
    Draft202012Validator(SCHEMA).validate(spec)
    for field in ['parameters','views','interactions','annotations']:
        unique([x['id'] for x in spec[field]],field)
    elements=[e for v in spec['views'] for e in v['elements']]
    ensure(len(elements)<=200,'element budget')
    unique([e['id'] for e in elements],'elements')
    views={v['id'] for v in spec['views']}
    ensure(len(spec['layout']['view_order'])==len(views) and set(spec['layout']['view_order'])==views,'layout order')
    params={p['id']:p for p in spec['parameters']}
    for p in params.values():
        ensure(p['min']<p['max'] and p['min']<=p['default']<=p['max'],'parameter range')
        ensure(abs((p['default']-p['min'])/p['step']-round((p['default']-p['min'])/p['step']))<1e-8,'step alignment')
        if p['type']=='integer': ensure(all(float(p[k]).is_integer() for k in ['min','max','step','default']),'integer parameter')
    cps=spec['teaching']['checkpoints']; unique([c['id'] for c in cps],'checkpoints')
    for i in spec['interactions']:
        if i['kind']=='slider': ensure(i['parameter_id'] in params,'unknown parameter')
        if i['kind']=='prediction': ensure(i['checkpoint_id'] in {c['id'] for c in cps},'unknown checkpoint')
    for a in spec['annotations']:ensure(a['target_id'] in {e['id'] for e in elements},'annotation target')
    model=spec['model']; ensure(model['id'] in MODELS and model['version']=='1.0.0','unsupported model')
    ensure(set(model['inputs'])==MODELS[model['id']],'model input keys')
    for b in model['inputs'].values():ensure(b['source'].startswith(('/params/','/data/')),'model dependency root')
    for c in spec['validation']['requested_checks']:
        ensure(c['id']==CHECKS[model['id']] and c['version']=='1.0.0','unsupported check')
    for e in elements:
        required,optional=KINDS[e['kind']]
        ensure(required<=set(e['inputs'])<=required|optional,'primitive input keys')
    ensure(spec['playback']['transition']['kind']=='cut', 'unsupported transition: interpolate')
    for view in spec['views']:
        plot = [e for e in view['elements'] if e['kind'] in {'axis','curve','region','point'}]
        if plot:
            ensure(len(plot)==len(view['elements']) and sum(e['kind']=='axis' for e in plot)==1, 'plot requires exactly one axis and separate container views')
        ensure(view['renderer'] != 'canvas', 'unsupported renderer: canvas')
    for c in cps:
        ensure(model['id']=='optimization.quadratic_gd' and c['rubric_ref']=='gd.next_step.v1', 'unsupported rubric')
    return params

def simulate(spec,overrides=None):
    defs=structure(spec)
    params={i:p['default'] for i,p in defs.items()}
    for k,v in (overrides or {}).items():
        ensure(k in defs and numeric(v),'invalid override')
        p=defs[k]
        ensure(p['min']<=v<=p['max'],'override range')
        ensure(abs((v-p['min'])/p['step']-round((v-p['min'])/p['step']))<1e-8,'override step')
        params[k]=v
    env={'params':params,'data':spec['data']}
    config={k:pointer(env,b['source']) for k,b in spec['model']['inputs'].items()}
    model=spec['model']['id']; cap=spec['model']['max_steps']; states=[]
    ensure(cap <= 128, 'resource budget: max_steps exceeds 128')
    if model=='optimization.quadratic_gd':
        ensure(all(numeric(v) and abs(v) <= 1e6 for v in config.values()), 'numeric domain limit')
        ensure(all(numeric(v) for v in config.values()) and config['alpha']>0,'gd domain')
        x=config['x0']; center=config['center']; alpha=config['alpha']
        for t in range(cap+1):
            states.append({'step':t,'x':x,'loss':(x-center)**2,'error':x-center})
            x=x-alpha*2*(x-center)
        # Independent closed form checks the iterative computation.
        for s in states:
            expected=center+(config['x0']-center)*(1-2*alpha)**s['step']
            ensure(math.isclose(s['x'],expected,rel_tol=1e-10,abs_tol=1e-10),'recurrence mismatch')
            ensure(all(numeric(v) for v in s.values()),'nonfinite trace')
        lo=min([s['x'] for s in states]+[center])-1; hi=max([s['x'] for s in states]+[center])+1
        objective=[[lo+(hi-lo)*i/100,(lo+(hi-lo)*i/100-center)**2] for i in range(101)]
        ymax=max(p[1] for p in objective)+1
        derived=[{'axes':axes(lo,hi,0,ymax,'f(x)'), 'objective':objective,'path':[[q['x'],q['loss']] for q in states[:s['step']+1]],'current_point':[s['x'],s['loss']]} for s in states]
    elif model=='algorithms.bfs':
        g=config['graph']; ensure(isinstance(g,dict) and set(g)=={'nodes','edges'},'graph shape')
        ensure(len(g['nodes']) <= 24 and len(g['edges']) <= 64, 'graph budget')
        nodes=g['nodes']; ensure(isinstance(nodes,list) and all(isinstance(n,str) for n in nodes),'nodes')
        unique(nodes,'nodes'); ensure(config['start'] in nodes,'unknown start')
        adj={n:set() for n in nodes}
        for edge in g['edges']:
            ensure(isinstance(edge,list) and len(edge)==2 and all(v in adj for v in edge),'bad edge')
            a,b=edge; adj[a].add(b); adj[b].add(a)
        q=[config['start']]; discovered=q.copy(); distance={q[0]:0}; current=None
        states=[{'step':0,'current':None,'queue':q.copy(),'discovered':discovered.copy(),'distance':distance.copy()}]
        while q and len(states)<=cap:
            current=q.pop(0)
            for n in sorted(adj[current]):
                if n not in distance:
                    distance[n]=distance[current]+1; discovered.append(n); q.append(n)
            states.append({'step':len(states),'current':current,'queue':q.copy(),'discovered':discovered.copy(),'distance':distance.copy()})
        ensure(not q,'simulation truncated')
        # Independent relaxation oracle, rather than the same queue code.
        oracle={n:math.inf for n in nodes};oracle[config['start']]=0
        for _ in nodes:
            for a,b in g['edges']:
                oracle[a]=min(oracle[a],oracle[b]+1);oracle[b]=min(oracle[b],oracle[a]+1)
        ensure(distance=={n:d for n,d in oracle.items() if math.isfinite(d)},'distance oracle')
        for s in states:
            unique(s['queue'],'queue');unique(s['discovered'],'discovered')
            ensure(set(s['queue'])<=set(s['discovered']),'discovery invariant')
        derived=[{} for s in states]
    elif model=='structure.snapshot':
        ensure(isinstance(config['content'],dict),'content object required')
        states=[copy.deepcopy(config['content'])]; derived=[{}]
    else:
        w,a,b=config['width'],config['a'],config['b']
        ensure(all(numeric(v) for v in [w,a,b]) and w>0 and a<=b,'distribution domain')
        low=max(0,min(w,a));high=max(0,min(w,b)); density=1/w
        prob=max(0,high-low)/w
        cdf=lambda x: min(1,max(0,x/w))
        ensure(math.isclose(prob,cdf(b)-cdf(a),abs_tol=1e-12),'cdf oracle')
        ensure(math.isclose(density*w,1) and 0<=prob<=1,'mass invariant')
        states=[{'step':0,'density':density,'probability':prob}]
        derived=[{'axes':axes(-0.1,w+0.1,0,density*1.1,'density'),'pdf_points':[[-0.1,0],[0,0],[0,density],[w,density],[w,0],[w+0.1,0]],'interval_polygon':[[low,0],[low,density],[high,density],[high,0]]}]
    ensure(spec['playback']['initial_step']<len(states),'initial step')
    for c in spec['teaching']['checkpoints']: ensure(c['at_step']<len(states),'checkpoint step')
    for s,d in zip(states,derived):
        current={**env,'state':s,'derived':d}
        for view in spec['views']:
            for e in view['elements']:
                values={k:pointer(current,v['source']) for k,v in e['inputs'].items()}
                check_primitive(e['kind'],values)
    ensure(len(json.dumps([states,derived],allow_nan=False).encode()) <= 2_000_000, 'trace budget')
    return params, states, derived

def axes(x0,x1,y0,y1,ylabel):
    return {'x':{'domain':[x0,x1],'label':'x','unit':'dimensionless','scale':'linear'},'y':{'domain':[y0,y1],'label':ylabel,'unit':'dimensionless','scale':'linear'}}
def check_primitive(kind,v):
    if kind=='axis':
        ensure(set(v['axes'])=={'x','y'},'axes shape')
        for a in v['axes'].values():
            ensure(isinstance(a,dict) and a.get('scale')=='linear' and isinstance(a.get('label'),str), 'axis contract')
            ensure(point(a['domain']) and a['domain'][0]<a['domain'][1],'axis domain')
    elif kind in {'curve','region'}:
        points=v['points'] if kind=='curve' else v['polygon']
        ensure(isinstance(points,list) and len(points)>=(0 if kind=='curve' else 3) and all(point(p) for p in points),'points shape')
    elif kind=='point':ensure(point(v['point']),'point shape')
    elif kind=='metric':ensure(numeric(v['value']),'metric value')
    elif kind=='text':ensure(isinstance(v['value'],str),'text value')
    elif kind=='array':ensure(isinstance(v['items'],list) and len(v['items'])<=128 and all(x is None or isinstance(x,(str,bool)) or numeric(x) for x in v['items']),'array items')
    elif kind=='matrix':
        m=v['values'];ensure(len(m)<=16 and all(len(r)<=16 for r in m),'matrix budget');ensure(isinstance(m,list) and bool(m) and all(isinstance(r,list) and len(r)==len(m[0]) and all(numeric(x) for x in r) for r in m),'matrix')
    elif kind=='code':
        ensure(isinstance(v['source'],str),'code text')
        if 'active_line' in v:ensure(isinstance(v['active_line'],int) and 1<=v['active_line']<=len(v['source'].splitlines()),'line')
    elif kind=='graph':
        g=v['graph']; ensure(isinstance(g,dict) and set(g)=={'nodes','edges'},'graph input')
        ensure(isinstance(g['nodes'],list) and 1<=len(g['nodes'])<=24 and all(isinstance(n,str) and 0<len(n)<=40 for n in g['nodes']),'graph nodes')
        unique(g['nodes'],'graph nodes')
        ensure(isinstance(g['edges'],list) and len(g['edges'])<=64 and all(isinstance(e,list) and len(e)==2 and all(n in g['nodes'] for n in e) for e in g['edges']),'graph edges')
        if 'active' in v:ensure(v['active'] is None or v['active'] in v['graph']['nodes'],'active node')


def digest(value):
    import hashlib
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()).hexdigest()


def compile_visual(spec, overrides=None):
    """No model-supplied status/check list can bypass the installed validators."""
    params, states, derived = simulate(spec, overrides)
    revision = digest({'spec': spec, 'runtime': RUNTIME_VERSION})
    run_id = digest({'revision': revision, 'params': params})
    frames = []
    for index, (state, data) in enumerate(zip(states, derived)):
        env = {'params': params, 'data': spec['data'], 'state': state, 'derived': data}
        views = []
        for view_id in spec['layout']['view_order']:
            view = next(v for v in spec['views'] if v['id'] == view_id)
            views.append({**view, 'elements': [
                {**e, 'values': {k: pointer(env, b['source']) for k, b in e['inputs'].items()}}
                for e in view['elements']
            ]})
        frames.append({'step': index, 'state': state, 'views': views,
                       'snapshot_ref': digest({'run': run_id, 'step': index})})
    return {
        'runtime_version': RUNTIME_VERSION, 'spec_revision': revision, 'run_id': run_id,
        'spec': spec, 'params': params, 'frames': frames,
        'verification': {
            'status': 'pass', 'checker': CHECKS[spec['model']['id']], 'version': '1.0.0',
            'scope': 'structure_only' if spec['model']['id']=='structure.snapshot' else 'registered_model_current_run',
            'assumptions': spec['teaching']['assumptions'], 'steps_checked': len(states),
            'input_digest': run_id, 'tolerance': {'atol': 1e-10, 'rtol': 1e-10},
        },
        'termination': 'budget_exhausted' if spec['model']['id']=='optimization.quadratic_gd' else 'complete',
    }


def inspect_visual(spec, params, step, snapshot_ref):
    bundle = compile_visual(spec, params)
    ensure(type(step) is int and 0 <= step < len(bundle['frames']), 'invalid step')
    frame = bundle['frames'][step]
    ensure(frame['snapshot_ref'] == snapshot_ref, 'state conflict')
    return {
        'spec_revision': bundle['spec_revision'], 'run_id': bundle['run_id'],
        'snapshot_ref': snapshot_ref, 'step': step, 'params': bundle['params'],
        'semantic_state': frame['state'], 'assumptions': bundle['verification']['assumptions'],
        'validation_scope': bundle['verification']['scope'],
        'termination': bundle['termination'],
    }


def predict_visual(spec, params, step, snapshot_ref, answer):
    snapshot = inspect_visual(spec, params, step, snapshot_ref)
    ensure(spec['model']['id']=='optimization.quadratic_gd', 'unsupported rubric')
    ensure(any(c['at_step']==step and c['rubric_ref']=='gd.next_step.v1' for c in spec['teaching']['checkpoints']), 'checkpoint not active')
    choices = ('same_closer', 'cross_closer', 'equal', 'farther', 'optimum')
    ensure(answer in choices, 'invalid answer')
    bundle = compile_visual(spec, params)
    ensure(step+1 < len(bundle['frames']), 'no next step')
    current = snapshot['semantic_state']; nxt = bundle['frames'][step+1]['state']
    a, b = current['error'], nxt['error']
    expected = 'optimum' if abs(b)<1e-12 else 'equal' if math.isclose(abs(a),abs(b)) else 'farther' if abs(b)>abs(a) else 'cross_closer' if a*b<0 else 'same_closer'
    return {'correct': answer==expected, 'explanation': f"下一步 x={nxt['x']:g}，误差从 {a:g} 变为 {b:g}。", 'snapshot_ref': snapshot_ref, 'evidence_level': 'exploration_only'}
