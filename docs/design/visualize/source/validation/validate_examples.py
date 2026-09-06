"""Reference checks for the design bundle, not a production gate.
Run: python validate_examples.py [--report]
Dependency: jsonschema==4.26.0. Only --report writes validation-report.md.
"""
import copy
import json
import math
import re
import sys
from pathlib import Path
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / 'schemas/visualspec-0.1.schema.json').read_text())
RESULTS = []
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
}
CHECKS = {
 'optimization.quadratic_gd': 'optimization.quadratic_recurrence',
 'algorithms.bfs': 'algorithms.bfs_invariants',
 'probability.uniform_interval': 'probability.uniform_mass',
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
    if model=='optimization.quadratic_gd':
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
    return states

def axes(x0,x1,y0,y1,ylabel):
    return {'x':{'domain':[x0,x1],'label':'x','unit':'dimensionless','scale':'linear'},'y':{'domain':[y0,y1],'label':ylabel,'unit':'dimensionless','scale':'linear'}}
def check_primitive(kind,v):
    if kind=='axis':
        ensure(set(v['axes'])=={'x','y'},'axes shape')
        for a in v['axes'].values():ensure(point(a['domain']) and a['domain'][0]<a['domain'][1],'axis domain')
    elif kind in {'curve','region'}:
        points=v['points'] if kind=='curve' else v['polygon']
        ensure(isinstance(points,list) and len(points)>=(0 if kind=='curve' else 3) and all(point(p) for p in points),'points shape')
    elif kind=='point':ensure(point(v['point']),'point shape')
    elif kind=='metric':ensure(numeric(v['value']),'metric value')
    elif kind=='text':ensure(isinstance(v['value'],str),'text value')
    elif kind=='array':ensure(isinstance(v['items'],list),'array items')
    elif kind=='matrix':
        m=v['values'];ensure(isinstance(m,list) and bool(m) and all(isinstance(r,list) and len(r)==len(m[0]) and all(numeric(x) for x in r) for r in m),'matrix')
    elif kind=='code':
        ensure(isinstance(v['source'],str),'code text')
        if 'active_line' in v:ensure(isinstance(v['active_line'],int) and 1<=v['active_line']<=len(v['source'].splitlines()),'line')
    elif kind=='graph':
        ensure(isinstance(v['graph'],dict),'graph input')
        if 'active' in v:ensure(v['active'] is None or v['active'] in v['graph']['nodes'],'active node')

def test(name,fn):
    fn();RESULTS.append(name)
def rejected(spec):
    try:simulate(spec)
    except Exception:return
    raise AssertionError('invalid specimen accepted')
def mutation(spec,fn):
    s=copy.deepcopy(spec);fn(s);rejected(s)

def main():
    test('Draft 2020-12 metaschema',lambda:Draft202012Validator.check_schema(SCHEMA))
    examples={p.stem:json.loads(p.read_text()) for p in sorted((ROOT/'examples').glob('*.json'))}
    for name,spec in examples.items():test('schema + registry + all-step bindings: '+name,lambda s=spec:simulate(s))
    gd=examples['gradient-descent.visualspec'];bfs=examples['bfs.visualspec'];pdf=examples['density-area.visualspec']
    test('GD default golden x/loss',lambda:ensure([(s['x'],s['loss']) for s in simulate(gd)[:3]]==[(-4,36),(5,9),(.5,2.25)],'GD golden'))
    for alpha in [.05,.25,.5,.75,1,1.1]:test('GD recurrence alpha='+str(alpha),lambda a=alpha:simulate(gd,{'alpha':a}))
    test('BFS diamond golden queue',lambda:ensure([s['queue'] for s in simulate(bfs)]==[['a'],['b','c'],['c','d'],['d'],[]],'queue golden'))
    test('PDF golden density/mass',lambda:ensure(simulate(pdf)[0]=={'step':0,'density':2,'probability':.2},'PDF golden'))
    for width in [.2,.5,2]:test('PDF boundary width='+str(width),lambda w=width:simulate(pdf,{'width':w}))
    for label,change in [
      ('unknown model',lambda s:s['model'].update(id='unknown.model')),
      ('unknown version',lambda s:s.update(spec_version='0.2.0')),
      ('extra script field',lambda s:s.update(script='alert(1)')),
      ('unknown primitive',lambda s:s['views'][0]['elements'][0].update(kind='run_js')),
      ('dangling binding',lambda s:s['views'][0]['elements'][0]['inputs']['axes'].update(source='/derived/missing')),
      ('invalid default',lambda s:s['parameters'][0].update(default=2)),
      ('off-step default',lambda s:s['parameters'][0].update(default=.76)),
      ('duplicate parameter',lambda s:s['parameters'].append(copy.deepcopy(s['parameters'][0]))),
      ('duplicate element',lambda s:s['views'][0]['elements'].append(copy.deepcopy(s['views'][0]['elements'][0]))),
      ('missing view order',lambda s:s['layout'].update(view_order=['missing'])),
      ('unknown slider target',lambda s:s['interactions'][0].update(parameter_id='missing')),
      ('future initial step',lambda s:s['playback'].update(initial_step=99)),
      ('future checkpoint',lambda s:s['teaching']['checkpoints'][0].update(at_step=99)),
      ('unknown check',lambda s:s['validation']['requested_checks'][0].update(id='fake.pass')),
      ('invalid model dependency',lambda s:s['model']['inputs']['alpha'].update(source='/state/x')),
      ('unsafe property',lambda s:s['data'].update(__proto__={})),
      ('NaN',lambda s:s['data'].update(x0=float('nan'))),
      ('invalid primitive key',lambda s:s['views'][0]['elements'][0]['inputs'].update(script={'source':'/data/x0'})),
    ]:test('reject '+label,lambda c=change:mutation(gd,c))
    test('reject BFS unknown start',lambda:mutation(bfs,lambda s:s['data'].update(start='z')))
    test('reject BFS truncated trace',lambda:mutation(bfs,lambda s:s['model'].update(max_steps=1)))
    test('reject PDF invalid interval',lambda:mutation(pdf,lambda s:s['data'].update(a=.3,b=.1)))
    outside=copy.deepcopy(pdf);outside['data'].update(a=3,b=4)
    test('PDF outside support has zero mass',lambda:ensure(simulate(outside)[0]['probability']==0,'support'))
    disconnected=copy.deepcopy(bfs);disconnected['data']['graph']['nodes'].append('z')
    test('BFS unreachable node omitted from distances',lambda:ensure('z' not in simulate(disconnected)[-1]['distance'],'unreachable'))
    singleton=copy.deepcopy(bfs);singleton['data']['graph']={'nodes':['a'],'edges':[]}
    test('BFS singleton terminates',lambda:ensure(len(simulate(singleton))==2,'singleton'))
    main_doc=(ROOT/'计算机专业群教育智能体-Visualize系统技术设计.md').read_text()
    domain_sections=re.findall(r'^### 8\.(\d+) [^\n`]+`([a-z_]+)`',main_doc,re.M)
    test('32 domain sections',lambda:ensure(len(domain_sections)==32,'domain count'))
    catalog=json.loads((ROOT/'context/domain-routing-catalog.json').read_text())
    test('routing catalog matches 32 domain IDs',lambda:ensure({d['id'] for d in catalog['domains']}=={d[1] for d in domain_sections} and len(catalog['domains'])==32,'catalog mismatch'))
    test('routing catalog does not claim production capability',lambda:ensure(all(d['maturity']=='planned' for d in catalog['domains']),'maturity'))
    test('64 representative domain cases',lambda:ensure(len(re.findall(r'^- \*\*案例 [AB]\*\*',main_doc,re.M))==64,'case count'))
    for path in ROOT.rglob('*.md'):
        text=path.read_text()
        ensure(text.count('```')%2==0,'unclosed fence '+str(path))
        for target in re.findall(r'\]\(([^)]+)\)',text):
            if '://' in target or target.startswith('#'):continue
            target=target.split('#')[0]
            # Report is generated after these checks.
            if target.endswith('validation-report.md'):continue
            ensure((path.parent/target).exists(),'broken local link '+target)
    RESULTS.append('Markdown fences and local links')
    report='# 设计包参考校验报告\n\n日期：2026-09-06。结果：**'+str(len(RESULTS))+' 项检查通过**。\n\n'
    report+='环境：Python 3.12；jsonschema 4.26.0；Draft 2020-12。检查不调用 DeepSeek，不运行浏览器，不连接真实系统。\n\n'
    report+='## 实际执行\n\n'+''.join('- '+n+'\n' for n in RESULTS)
    report+='\n## 范围与限制\n\nSchema metaschema、三个示例、默认与选定边界的参考模拟、所有生成 step 的数据绑定、若干非法变异，以及文档结构/本地链接已检查。梯度下降用闭式解核对迭代，BFS 用独立距离松弛核对，均匀分布用 CDF 差核对区间概率。\n\n'
    report+='该脚本是三样例参考检查器，并非通用 DSL 编译器。它不完整验证所有学科数学、所有参数组合、图形拓扑、标签布局、视觉正确性、浏览器隔离、可访问性、供应商 schema 子集、事件协议、评分与真实学习效果。未执行生产 E2E；其余能力按主文档 Roadmap 实现。\n'
    if '--report' in sys.argv:(ROOT/'validation/validation-report.md').write_text(report)
    print(f'PASS: {len(RESULTS)} checks')
if __name__=='__main__':main()
