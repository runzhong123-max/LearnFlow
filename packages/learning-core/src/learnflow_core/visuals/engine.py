"""Production host validation adapted from the supplied reference (see SOURCE.md)."""
import copy
import json
import math
import re
import sys
from pathlib import Path
from jsonschema import Draft202012Validator
from .operations import PATTERNS, active_defaults, operation_manifest, pipeline, sequence

SCHEMA = json.loads(Path(__file__).with_name('schema.json').read_text())
SCHEMA_V2 = json.loads(Path(__file__).with_name('schema-0.2.0.json').read_text())
RUNTIME_VERSION = 'learnflow.visualize.2.0.0'
KINDS = {
 'axis': ({'axes'}, set()), 'curve': ({'points'}, set()),
 'point': ({'point'}, set()), 'region': ({'polygon'}, set()),
 'array': ({'items'}, set()), 'matrix': ({'values'}, set()),
 'graph': ({'graph'}, {'active'}), 'code': ({'source'}, {'active_line'}),
 'text': ({'value'}, set()), 'metric': ({'value'}, set()),
}
KINDS_V1 = copy.deepcopy(KINDS)
KINDS.update({
 'matrix': ({'values'}, {'active_cells', 'computed_cells'}),
 'array': ({'items'}, {'active_indices'}),
 'table': ({'columns', 'rows'}, {'active_row'}),
 'timeline': ({'lanes', 'events'}, {'active'}),
})
KINDS = {kind: (required, optional | {'visible'}) for kind, (required, optional) in KINDS.items()}
MODELS = {
 'optimization.quadratic_gd': {'alpha','x0','center'},
 'algorithms.bfs': {'graph','start'},
 'probability.uniform_interval': {'width','a','b'},
 'structure.snapshot': {'content'},
 'structure.sequence': {'stages'},
 'computation.pipeline': {'program'},
}
CHECKS = {
 'optimization.quadratic_gd': 'optimization.quadratic_recurrence',
 'algorithms.bfs': 'algorithms.bfs_invariants',
 'probability.uniform_interval': 'probability.uniform_mass',
 'structure.snapshot': 'structure.bindings',
 'structure.sequence': 'structure.sequence_bindings',
 'computation.pipeline': 'computation.operation_contracts',
}
def ensure(condition, message):
    if not condition: raise ValueError(message)
def numeric(x): return type(x) in (int, float) and abs(x) <= sys.float_info.max and math.isfinite(x)
def point(x): return isinstance(x,list) and len(x)==2 and all(numeric(v) for v in x)
def unique(values,label): ensure(len(set(values))==len(values),f'duplicate {label}')
def aligned(value, minimum, step):
    if not all(numeric(x) for x in (value, minimum, step)) or step <= 0:
        return False
    index = (value-minimum)/step
    return numeric(index) and abs(index-round(index)) < 1e-8
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

def validate_schema(spec, schema):
    """Return bounded repair diagnostics from installed schema, never input values."""
    diagnostics, seen = [], set()
    # The installed model's exact argument names are a registry contract, not
    # unrestricted JSON object properties. Report this alongside schema issues
    # so a repair removes an unexpected input instead of merely renaming it.
    model = spec.get('model') if isinstance(spec, dict) else None
    if isinstance(model, dict) and isinstance(model.get('id'), str) and model['id'] in MODELS and isinstance(model.get('inputs'), dict):
        expected_inputs = MODELS[model['id']]
        if set(model['inputs']) != expected_inputs:
            item = '/model/inputs [model_input_keys] expected=' + ','.join(sorted(expected_inputs))
            diagnostics.append(item)
            seen.add(item)
    for error in Draft202012Validator(schema).iter_errors(spec):
        path = '/' + '/'.join(str(token).replace('~', '~0').replace('/', '~1') for token in error.absolute_path)
        rule = str(error.validator)
        expected = error.validator_value
        if rule == 'required':
            expected = 'missing=' + ','.join(key for key in expected if key not in error.instance)
        elif rule == 'additionalProperties':
            expected = 'allowed=' + ','.join(error.schema.get('properties', {}))
        elif rule in {'oneOf', 'anyOf'}:
            # Branch descriptions come from the installed schema, not errors'
            # messages (which may embed an entire user-supplied object).
            alternatives = []
            for branch in expected:
                kind = branch.get('properties', {}).get('kind', {})
                option = kind.get('enum', branch.get('type', 'registered schema branch'))
                alternatives.append(option)
            expected = alternatives
        if not isinstance(expected, str):
            expected = json.dumps(expected, ensure_ascii=False, separators=(',', ':'))
        item = f'{path[:110]} [{rule}] {expected[:130]}'[:190]
        if item in seen:
            continue
        if len(diagnostics) == 8:
            diagnostics.append('additional errors omitted')
            break
        seen.add(item)
        diagnostics.append(item)
    if diagnostics:
        raise ValueError(('visual_schema_invalid: ' + '; '.join(diagnostics))[:1600])


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
    ensure(isinstance(spec, dict), '/: expected object')
    version = spec.get('spec_version')
    ensure(version in {'0.1.0', '0.2.0'}, '/spec_version: unsupported schema version')
    validate_schema(spec, SCHEMA if version == '0.1.0' else SCHEMA_V2)
    for field in ['parameters','views','interactions','annotations']:
        unique([x['id'] for x in spec[field]],field)
    elements=[e for v in spec['views'] for e in v['elements']]
    ensure(len(elements)<=200,'element budget')
    unique([e['id'] for e in elements],'elements')
    views={v['id'] for v in spec['views']}
    ensure(len(spec['layout']['view_order'])==len(views) and set(spec['layout']['view_order'])==views,'layout order')
    params={p['id']:p for p in spec['parameters']}
    for p in params.values():
        ensure(all(numeric(p[k]) for k in ('min', 'max', 'default', 'step')), '/parameters: expected finite numeric bounds')
        ensure(p['min']<p['max'] and p['min']<=p['default']<=p['max'],'parameter range')
        ensure(aligned(p['default'],p['min'],p['step']),'step alignment')
        if p['type']=='integer': ensure(all(float(p[k]).is_integer() for k in ['min','max','step','default']),'integer parameter')
    cps=spec['teaching']['checkpoints']; unique([c['id'] for c in cps],'checkpoints')
    for i in spec['interactions']:
        if i['kind']=='slider': ensure(i['parameter_id'] in params,'unknown parameter')
        if i['kind']=='prediction': ensure(i['checkpoint_id'] in {c['id'] for c in cps},'unknown checkpoint')
    for a in spec['annotations']:ensure(a['target_id'] in {e['id'] for e in elements},'annotation target')
    model=spec['model']; ensure(model['id'] in MODELS and model['version']=='1.0.0','/model: unsupported model or version')
    ensure(version == '0.2.0' or model['id'] not in {'computation.pipeline', 'structure.sequence'}, '/model: composable models require VisualSpec 0.2.0')
    ensure(set(model['inputs'])==MODELS[model['id']],'model input keys')
    for b in model['inputs'].values():ensure(b['source'].startswith(('/params/','/data/')),'model dependency root')
    for c in spec['validation']['requested_checks']:
        ensure(c['id']==CHECKS[model['id']] and c['version']=='1.0.0','unsupported check')
    for e in elements:
        required,optional=(KINDS_V1 if version == '0.1.0' else KINDS)[e['kind']]
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
    ensure(overrides is None or isinstance(overrides, dict), '/params: expected object')
    params={i:p['default'] for i,p in defs.items()}
    for k,v in (overrides or {}).items():
        ensure(k in defs and numeric(v),'invalid override')
        p=defs[k]
        ensure(p['min']<=v<=p['max'],'override range')
        ensure(aligned(v,p['min'],p['step']),'override step')
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
    elif model=='computation.pipeline':
        states=pipeline(config['program'],env,pointer,cap); derived=[{} for _ in states]
    elif model=='structure.sequence':
        states=sequence(config['stages'],cap); derived=[{} for _ in states]
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
                try:
                    values=bind_element(e, current, spec['model']['id'])['values']
                    check_primitive(e['kind'],values,spec['spec_version'])
                except (ValueError, KeyError, TypeError) as error:
                    raise ValueError(f'/views/{view["id"]}/elements/{e["id"]} at step {s.get("step", 0)}: {error}') from error
    ensure(len(json.dumps([states,derived],allow_nan=False).encode()) <= 2_000_000, 'trace budget')
    return params, states, derived

def axes(x0,x1,y0,y1,ylabel):
    return {'x':{'domain':[x0,x1],'label':'x','unit':'dimensionless','scale':'linear'},'y':{'domain':[y0,y1],'label':ylabel,'unit':'dimensionless','scale':'linear'}}
def check_primitive(kind, v, version='0.1.0'):
    """Validate the bound data, including bindings on invisible elements."""
    if 'visible' in v:
        ensure(type(v['visible']) is bool, 'visible must be boolean')
    if kind == 'axis':
        ensure(isinstance(v['axes'], dict) and set(v['axes']) == {'x', 'y'}, 'axes shape')
        for axis in v['axes'].values():
            ensure(isinstance(axis, dict) and axis.get('scale') == 'linear' and isinstance(axis.get('label'), str), 'axis contract')
            ensure(point(axis.get('domain')) and axis['domain'][0] < axis['domain'][1], 'axis domain')
    elif kind in {'curve', 'region'}:
        points = v['points'] if kind == 'curve' else v['polygon']
        ensure(isinstance(points, list) and (0 if kind == 'curve' else 3) <= len(points) <= 4096 and all(point(p) for p in points), 'points shape')
    elif kind == 'point': ensure(point(v['point']), 'point shape')
    elif kind == 'metric': ensure(numeric(v['value']), 'metric value')
    elif kind == 'text': ensure(isinstance(v['value'], str), 'text value')
    elif kind == 'array':
        items = v['items']
        ensure(isinstance(items, list) and len(items) <= 128 and all(scalar(x) for x in items), 'array items')
        if 'active_indices' in v:
            ensure(isinstance(v['active_indices'], list) and all(type(i) is int and 0 <= i < len(items) for i in v['active_indices']), 'array active_indices')
    elif kind == 'matrix':
        m = v['values']
        ensure(isinstance(m, list) and 1 <= len(m) <= 16 and all(isinstance(r, list) for r in m), 'matrix budget')
        ensure(1 <= len(m[0]) <= 16 and all(len(r) == len(m[0]) and all(numeric(x) for x in r) for r in m), 'matrix')
        for key in ('active_cells', 'computed_cells'):
            if key in v:
                ensure(isinstance(v[key], list) and len(v[key]) <= 256 and all(isinstance(cell, list) and len(cell) == 2 and all(type(x) is int for x in cell) and 0 <= cell[0] < len(m) and 0 <= cell[1] < len(m[0]) for cell in v[key]), 'matrix ' + key)
    elif kind == 'code':
        ensure(isinstance(v['source'], str), 'code text')
        if 'active_line' in v: ensure(type(v['active_line']) is int and 1 <= v['active_line'] <= len(v['source'].splitlines()), 'line')
    elif kind == 'graph':
        g = v['graph']; allowed = {'nodes', 'edges'} if version == '0.1.0' else {'nodes', 'edges', 'directed', 'labels'}
        ensure(isinstance(g, dict) and {'nodes', 'edges'} <= set(g) <= allowed, 'graph input')
        ensure(isinstance(g['nodes'], list) and 1 <= len(g['nodes']) <= 24 and all(isinstance(n, str) and 0 < len(n) <= 40 for n in g['nodes']), 'graph nodes')
        unique(g['nodes'], 'graph nodes')
        ensure(isinstance(g['edges'], list) and len(g['edges']) <= 64 and all(isinstance(e, list) and len(e) == 2 and all(n in g['nodes'] for n in e) for e in g['edges']), 'graph edges')
        if 'directed' in g: ensure(type(g['directed']) is bool, 'graph directed')
        if 'labels' in g: ensure(isinstance(g['labels'], dict) and set(g['labels']) <= set(g['nodes']) and all(isinstance(x, str) and len(x) <= 200 for x in g['labels'].values()), 'graph labels')
        if 'active' in v: ensure(v['active'] is None or v['active'] in g['nodes'], 'active node')
    elif kind == 'table':
        columns, rows = v['columns'], v['rows']
        ensure(isinstance(columns, list) and 1 <= len(columns) <= 12 and all(isinstance(c, str) and len(c) <= 100 for c in columns), 'table columns')
        ensure(isinstance(rows, list) and len(rows) <= 64 and all(isinstance(row, list) and len(row) == len(columns) and all(scalar(cell) for cell in row) for row in rows), 'table rows')
        if 'active_row' in v: ensure(v['active_row'] is None or type(v['active_row']) is int and 0 <= v['active_row'] < len(rows), 'table active_row')
    elif kind == 'timeline':
        lanes, events = v['lanes'], v['events']
        ensure(isinstance(lanes, list) and 1 <= len(lanes) <= 12 and all(isinstance(l, str) and 0 < len(l) <= 100 for l in lanes), 'timeline lanes')
        unique(lanes, 'timeline lanes')
        ensure(isinstance(events, list) and len(events) <= 128, 'timeline event budget')
        for event in events:
            ensure(isinstance(event, dict) and {'id', 'lane', 'label', 'at'} <= set(event) <= {'id', 'lane', 'label', 'at', 'until'}, 'timeline event shape')
            ensure(isinstance(event['id'], str) and 0 < len(event['id']) <= 80 and event['lane'] in lanes and isinstance(event['label'], str) and len(event['label']) <= 200 and numeric(event['at']), 'timeline event fields')
            if 'until' in event: ensure(numeric(event['until']) and event['until'] >= event['at'], 'timeline end precedes start')
        unique([e['id'] for e in events], 'timeline events')
        if 'active' in v: ensure(v['active'] is None or v['active'] in {e['id'] for e in events}, 'timeline active')


def scalar(value):
    return value is None or isinstance(value, (str, bool)) or numeric(value)


def digest(value):
    import hashlib
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()).hexdigest()


def bind_element(element, env, model_id):
    """Dynamic pipeline slots carry current roles, never stale authored names."""
    label = element['label']
    values = {key: pointer(env, binding['source']) for key, binding in element['inputs'].items()}
    if model_id == 'computation.pipeline':
        matrix_source = element['inputs'].get('values', {}).get('source') if element['kind'] == 'matrix' else None
        if matrix_source == '/state/active/input_matrix':
            label = '当前输入矩阵'
        elif matrix_source == '/state/active/output_matrix':
            label = '当前输出矩阵'
        elif matrix_source == '/state/active/kernel_matrix':
            label = {'matmul': '右侧矩阵', 'linear': '权重矩阵', 'conv2d': '卷积核'}.get(env['state']['operation'], '当前运算矩阵')
        if element['kind'] == 'array' and element['inputs'].get('items', {}).get('source') == '/state/active/values':
            label = '当前概率' if env['state']['operation'] == 'softmax' else '当前数组'
        # The same source-window mask cannot describe both left rows and right
        # columns. Active masks for registered dynamic roles come from the run.
        active = env['state']['active']
        if matrix_source == '/state/active/input_matrix' and 'active_cells' in values:
            values['active_cells'] = active['active_cells']
        elif matrix_source == '/state/active/output_matrix' and 'active_cells' in values:
            values['active_cells'] = active['output_cells']
        elif matrix_source == '/state/active/kernel_matrix' and 'active_cells' in values:
            kernel = active['kernel_matrix']
            if env['state']['operation'] in {'matmul', 'linear'}:
                columns = {cell[1] for cell in active['output_cells']}
                values['active_cells'] = [[r, c] for r in range(len(kernel)) for c in sorted(columns)]
            elif env['state']['operation'] == 'conv2d' and env['state']['phase'] == 'window':
                values['active_cells'] = [[r, c] for r, row in enumerate(kernel) for c in range(len(row))]
            else:
                values['active_cells'] = []
    return {**element, 'label': label, 'values': values, **({'binding_policy': 'registered_operation_roles'} if model_id == 'computation.pipeline' else {})}


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
                bind_element(e, env, spec['model']['id'])
                for e in view['elements']
            ]})
        frames.append({'step': index, 'state': state, 'views': views,
                       'snapshot_ref': digest({'run': run_id, 'step': index}),
                       **({'title': state['title'], 'narration': state['narration']} if 'title' in state and 'narration' in state else {})})
    ensure(len(json.dumps(frames, allow_nan=False).encode()) <= 4_000_000, 'compiled frame budget')
    model = spec['model']['id']
    scope = {'structure.snapshot': 'structure_only', 'structure.sequence': 'illustrative_authored_sequence', 'computation.pipeline': 'registered_operations_current_run'}.get(model, 'registered_model_current_run')
    return {
        'runtime_version': RUNTIME_VERSION, 'spec_revision': revision, 'run_id': run_id,
        'spec': spec, 'params': params, 'frames': frames,
        'verification': {
            'status': 'pass', 'checker': CHECKS[spec['model']['id']], 'version': '1.0.0',
            'scope': scope,
            'limitations': ['Authored labels and narratives are not algorithm proofs or learning evidence.'] + (['Sequence stages are authored illustrations; no simulated algorithm or numeric correctness is claimed.'] if model == 'structure.sequence' else []),
            'render_scope': 'typed_bindings_only; presentation geometry is checked by the renderer',
            **({'operations_checked': [{'id': step['id'], 'op': step['op'], 'version': '1.0.0'} for step in pointer({'params': params, 'data': spec['data']}, spec['model']['inputs']['program']['source'])['steps']]} if model == 'computation.pipeline' else {}),
            'assumptions': spec['teaching']['assumptions'], 'steps_checked': len(states),
            'input_digest': run_id, 'tolerance': {'atol': 1e-10, 'rtol': 1e-10},
        },
        'checkpoint_choices': {c['id']: gd_choices() for c in spec['teaching']['checkpoints'] if c['rubric_ref'] == 'gd.next_step.v1'},
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


def gd_choices():
    return [dict(id=ident, label=label) for ident, label in (
        ('same_closer', '仍在同一侧，更接近最低点'), ('cross_closer', '越过最低点，但更接近'),
        ('equal', '距离不变'), ('farther', '离最低点更远'), ('optimum', '恰好到达最低点'),
    )]


def capability_manifest():
    """Installed capabilities only; source design's planned domains are not executable."""
    return {
        'runtime_version': RUNTIME_VERSION, 'spec_versions': ['0.1.0', '0.2.0'],
        'models': [{'id': ident, 'version': '1.0.0', 'inputs': sorted(inputs),
                    'required_check': CHECKS[ident],
                    'verification_scope': {'structure.snapshot': 'structure_only', 'structure.sequence': 'illustrative_authored_sequence', 'computation.pipeline': 'registered_operations_current_run'}.get(ident, 'registered_model_current_run')}
                   for ident, inputs in MODELS.items()],
        'operations': operation_manifest(),
        'primitives': [{'id': kind, 'required_inputs': sorted(required), 'optional_inputs': sorted(optional)}
                       for kind, (required, optional) in KINDS.items()],
        'patterns': list(PATTERNS),
        'bindings': 'RFC6901 source pointers. Model inputs read data/params. Pipeline args recursively accept literals or {source}; state references read completed state/results only, never future operations.',
        'pipeline': {'binding_notes': {'values': 'One current array slot, not separate input/output vectors. Display it once with array_visible; its role follows the current operation (working array, queue, or probability).', 'result': 'The initial 0 is a placeholder, not a computed scalar. There is no result_visible field; omit this generic metric unless the display explicitly limits it to valid completed states.', 'matrices': 'Bind input_matrix/output_matrix/kernel_matrix to their own *_visible flags; output computed_cells distinguishes pending cells. Never rename the same active slot as different fixed results.'},
                     'program': {'steps': [{'id': 'unique identifier', 'op': 'registered operation id', 'args': 'typed literals or bindings', 'title': 'stage title', 'narration': 'explanation'}]},
                     'state': {'results': 'completed natural-type operation outputs by id', 'active': active_defaults(), 'title': 'current operation title', 'narration': 'current explanation', 'phase': 'start/window/complete/insert/visit'}},
        'sequence': {'stages': [{'id': 'unique identifier', 'title': 'stage title', 'narration': 'illustrative explanation', 'content': 'JSON object with same bound field types in every stage'}],
                     'state': 'content fields plus step,stage_id,title,narration; authored claims remain illustrative'},
        'primitive_types': {'matrix': 'values: numeric rectangular <=16x16, active_cells/computed_cells: [[row,column]]; absent computed_cells means every cell computed',
                            'array': 'items: scalar[], active_indices: integer[]',
                            'graph': 'graph:{nodes:string[],edges:[string,string][],directed?:boolean,labels?:record<node,string>}',
                            'table': 'columns:string[],rows:scalar[][],active_row?:integer|null',
                            'timeline': 'lanes:string[],events:[{id,lane,label,at:number,until?:number}],active?:eventId|null'},
        'limits': {'spec_bytes': 262144, 'trace_steps': 128, 'pipeline_operations': 24, 'matrix_rows': 16, 'matrix_columns': 16, 'operation_windows': 96, 'array_items': 128, 'graph_nodes': 24, 'graph_edges': 64, 'trace_bytes': 2000000, 'compiled_frame_bytes': 4000000},
        'transitions': ['cut'], 'arbitrary_code': False,
    }
