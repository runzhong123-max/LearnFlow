'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const entries = new Map();
let drawings=[];
function finite(value, at='value') {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `${at}: ${value}`);
  else if (Array.isArray(value)) value.forEach((x,i)=>finite(x,`${at}[${i}]`));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k,x])=>finite(x,`${at}.${k}`));
}
const Viz={colors:['#087f8c','#d57a19','#7250a3','#2d8a61','#bf5364'],escape:s=>String(s).replace(/[&<>"']/g,'')};
for (const name of ['plot','bars','matrix','graph','cells','flow','svg','text','line','rect']) Viz[name]=(...args)=>{finite(args,`Viz.${name}`);drawings.push({name,args});return ['text','line','rect'].includes(name)?`<g data-kind="${name}"/>`:`<svg data-kind="${name}"><g/></svg>`};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'engineering.js'),'utf8'),{Viz,register:e=>{assert.ok(!entries.has(e.session),e.session);entries.set(e.session,e)}},{filename:'engineering.js',timeout:10000});
const defaults=e=>Object.fromEntries(e.controls.map(c=>[c.id,c.value]));
function run(session, overrides={}) {drawings=[];const e=entries.get(session);assert.ok(e,session);const result=e.compute({...defaults(e),...overrides});return JSON.parse(JSON.stringify(result));}
const last=(session,p)=>run(session,p).frames.at(-1).values;
const near=(actual,expected,tol=1e-7)=>assert.ok(Math.abs(actual-expected)<tol,`${actual} ≠ ${expected}`);

test('all 81 curriculum entries register unique substantive controls and bounded finite snapshots at every boundary',t=>{
  assert.equal(entries.size,81);
  const expected={theory:6,compilers:6,'software-engineering':6,security:6,'ai-foundations':5,'machine-learning':6,'deep-learning':5,graphics:6,hci:6,'web-engineering':6,mobile:6,cloud:6,'data-engineering':6,'ai-engineering':5};
  for(const [prefix,count] of Object.entries(expected)) assert.equal([...entries.keys()].filter(s=>s.startsWith(prefix+'.')).length,count,prefix);
  let cases=0, snapshots=0, maxFrames=0;
  for(const e of entries.values()) {
    assert.ok(e.controls.length>=2,e.session);
    assert.ok(e.title && e.question && e.scope && e.takeaway,e.session);
    const params=[defaults(e)];
    let boundaries=[defaults(e)];
    for(const c of e.controls) {
      const values=c.type==='range'?[c.min,c.max]:c.options.map(o=>o.value);
      boundaries=boundaries.flatMap(p=>values.map(v=>({...p,[c.id]:v})));
      for(const v of values) params.push({...defaults(e),[c.id]:v});
    }
    params.push(...boundaries);
    for(const p of params) {
      drawings=[];
      const {frames}=e.compute(p);cases++;snapshots+=frames.length;maxFrames=Math.max(maxFrames,frames.length);
      assert.ok(frames.length>0 && frames.length<200,`${e.session} frames ${frames.length}`);
      assert.ok(drawings.length>0,e.session);
      for(const f of frames) {
        assert.match(f.svg,/<svg/);assert.ok(f.note && f.values,`${e.session} snapshot`);finite(f.values,e.session);
      }
    }
  }
  assert.ok(cases>=400);
  t.diagnostic(`${cases} parameter scenarios, ${snapshots} snapshots, largest trace ${maxFrames} frames`);
});

test('automata and certificates follow the concrete input, including rejection and empty input',()=>{
  assert.equal(last('theory.c1.s1',{word:'0101',rule:'even'}).accepted,true);
  assert.equal(last('theory.c1.s1',{word:'空串',rule:'end'}).accepted,false);
  assert.equal(last('theory.c1.s2',{word:'())(()',limit:6}).rejected,true);
  assert.equal(last('theory.c1.s2',{word:'((()))',limit:2}).rejected,true);
});

test('ASTs have no orphan operands and parentheses change the result',()=>{
  assert.equal(last('compilers.c1.s2',{a:2,group:'normal'}).result,14);
  assert.equal(last('compilers.c1.s2',{a:2,group:'paren'}).result,20);
  const g=drawings.find(d=>d.name==='graph').args[0];
  assert.equal(g.nodes.length,5);assert.equal(g.edges.length,4);
  run('theory.c3.s2');assert.equal(drawings.find(d=>d.name==='graph').args[0].directed,false);
});

test('PCA variance and scalar logistic probabilities have independently computed values',()=>{
  const pca=last('machine-learning.c3.s2',{angle:45,stretch:1});
  near(pca.retainedVariance,3.6);near(pca.totalVariance,4);near(pca.ratio,.9);
  assert.equal(drawings.find(d=>d.name==='plot').args[0].equalAspect,true);
  const logistic=last('machine-learning.c1.s2',{w:0,threshold:.5});
  assert.deepEqual(logistic.probabilities,[.5,.5,.5,.5,.5]);assert.deepEqual(logistic.classes,[1,1,1,1,1]);assert.equal(logistic.boundary,null);
});

test('ray-sphere intersections and keyframe derivatives are exact',()=>{
  const ray=last('graphics.c2.s2',{offset:0,radius:1});assert.equal(ray.near,2);assert.equal(ray.far,4);
  const miss=last('graphics.c2.s2',{offset:2,radius:1});assert.equal(miss.hit,false);assert.equal(miss.near,null);
  const smooth=last('graphics.c3.s1',{t:.5,curve:'smooth'});near(smooth.position,.5);near(smooth.velocity,1.5);
});

test('microtasks delay timers and cursor pagination avoids offset duplicates',()=>{
  assert.equal(last('web-engineering.c1.s2',{sync:4,micro:3}).timerStarted,7);
  assert.deepEqual(last('web-engineering.c2.s2',{mode:'offset',insert:1}).second,[20,30]);
  assert.deepEqual(last('web-engineering.c2.s2',{mode:'offset',insert:1}).duplicates,[20]);
  assert.deepEqual(last('web-engineering.c2.s2',{mode:'cursor',insert:1}).second,[30,40]);
  assert.deepEqual(last('web-engineering.c2.s2',{mode:'cursor',insert:1}).duplicates,[]);
});

test('node fragmentation leaves a pending pod despite enough total CPU',()=>{
  const p=last('cloud.c1.s2',{request:3,pods:3});assert.equal(p.pending,1);assert.deepEqual(p.remaining,[1,1,2]);assert.equal(p.serviceEndpoints,2);
});

test('ETL lineage and column pruning preserve results while changing work',()=>{
  const e=last('data-engineering.c1.s1',{rate:7,minimum:30});assert.deepEqual(e.totals,[105,40]);assert.deepEqual(e.lineage,{甲:['r1','r3'],乙:['r2']});
  const fast=last('data-engineering.c2.s1',{cut:9,columns:2,mode:'optimized'}),slow=last('data-engineering.c2.s1',{cut:9,columns:2,mode:'full'});
  assert.deepEqual(fast.matches,[9,10,11,12]);assert.deepEqual(fast.matches,slow.matches);assert.equal(fast.readCells,8);assert.equal(slow.readCells,36);
});

test('watermarks reject genuinely late events and preserve accepted window counts',()=>{
  const w=last('data-engineering.c1.s2',{window:5,lateness:4});assert.equal(w.watermark,13);assert.equal(w.late,2);assert.deepEqual(w.counts,{'0':2,'5':1,'10':1,'15':1});
  const wide=last('data-engineering.c1.s2',{window:5,lateness:8});assert.equal(wide.late,0);assert.deepEqual(wide.counts,{'0':2,'5':3,'10':1,'15':1});
});

test('schema migration does not silently bypass type, key, and amount validation',()=>{
  const good=last('data-engineering.c3.s1',{schema:'rename',reader:'migrate'});assert.equal(good.total,30);assert.equal(good.valid.length,2);assert.equal(good.errors.length,3);
  const broken=last('data-engineering.c3.s1',{schema:'rename',reader:'tolerant'});assert.equal(broken.valid.length,0);assert.equal(broken.errors.length,5);
  const cn=last('data-engineering.c3.s2',{metric:'net',scope:'cn'});assert.equal(cn.revenue,130);assert.equal(cn.buyers,1);assert.equal(cn.revenuePerBuyer,130);
});

test('chunking, checkpoint recovery, and idempotent retry have distinguishable causal outcomes',()=>{
  assert.equal(last('ai-engineering.c1.s1',{size:3,topk:4,query:'cache'}).fullEvidence,false);
  assert.equal(last('ai-engineering.c1.s1',{size:6,topk:4,query:'cache'}).fullEvidence,true);
  assert.deepEqual(last('ai-engineering.c2.s1',{checkpoint:'on',failure:'render'}).calls,[1,1,1,1]);
  assert.deepEqual(last('ai-engineering.c2.s1',{checkpoint:'off',failure:'render'}).calls,[2,2,2,1]);
  assert.equal(last('ai-engineering.c2.s2',{failure:'after',retries:1,idempotency:'on'}).balance,90);
  assert.equal(last('ai-engineering.c2.s2',{failure:'after',retries:1,idempotency:'off'}).balance,80);
  assert.equal(last('ai-engineering.c2.s2',{failure:'before',retries:1,idempotency:'off'}).balance,90);
});

test('evaluation ablations and versioned caches preserve the stated experimental conditions',()=>{
  const mixed=last('ai-engineering.c3.s1',{intervention:'context',set:'mixed'});assert.equal(mixed.baseline,2);assert.equal(mixed.passed,3);
  const stable=last('ai-engineering.c3.s2',{budget:10,policy:'route',version:'stable'});assert.equal(stable.cost,6);assert.equal(stable.hits,3);assert.equal(stable.answered,6);
  const changed=last('ai-engineering.c3.s2',{budget:10,policy:'route',version:'change'});assert.equal(changed.cost,10);assert.equal(changed.hits,1);assert.equal(changed.answered,5);
});

test('real renderer produces finite nonempty markup and respects graph direction for all 907 scenarios',t=>{
  const runtimePath=process.env.LEARNFLOW_VISUAL_RUNTIME || path.join(__dirname,'..','completion-runtime.js');
  const runtime=fs.readFileSync(runtimePath,'utf8');
  const actualEntries=new Map();
  let undirected=0,directed=0;
  const context=vm.createContext({register:e=>actualEntries.set(e.session,e),inspectDrawing:(name,args,markup)=>{
    finite(args,`actual Viz.${name}`);
    assert.doesNotMatch(markup,/\b(?:NaN|Infinity|undefined)\b/,`actual Viz.${name}`);
    if(name==='graph') {
      const g=args[0];
      if(g.directed===false){assert.doesNotMatch(markup,/marker-end=/);undirected++;}
      else if(g.edges.length){assert.match(markup,/marker-end=/);directed++;}
    }
  }});
  vm.runInContext(runtime,context,{filename:'completion-runtime.js',timeout:10000});
  vm.runInContext(`for(const name of ['plot','bars','matrix','graph','cells','flow','svg','text','line','rect']) {const fn=Viz[name];Viz[name]=(...args)=>{const markup=fn(...args);inspectDrawing(name,args,markup);return markup;};}`,context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'engineering.js'),'utf8'),context,{filename:'engineering.js',timeout:10000});
  let scenarios=0,snapshots=0;
  for(const e of actualEntries.values()) {
    const params=[defaults(e)];let boundaries=[defaults(e)];
    for(const c of e.controls){const values=c.type==='range'?[c.min,c.max]:c.options.map(o=>o.value);boundaries=boundaries.flatMap(p=>values.map(v=>({...p,[c.id]:v})));for(const v of values)params.push({...defaults(e),[c.id]:v});}
    params.push(...boundaries);
    for(const p of params){const {frames}=e.compute(p);scenarios++;snapshots+=frames.length;assert.ok(frames.length>0&&frames.length<200,e.session);for(const frame of frames){finite(frame.values,e.session);assert.match(frame.svg,/<(?:svg|div)\b/);assert.match(frame.svg,/<(?:path|rect|circle|line|text|span|strong)\b/,`${e.session} empty scene`);assert.doesNotMatch(frame.svg,/\b(?:NaN|Infinity|undefined)\b/,e.session);}}
  }
  assert.equal(scenarios,907);assert.equal(snapshots,2685);assert.ok(undirected>0);assert.ok(directed>0);
  t.diagnostic(`actual SVG/HTML renderer: ${scenarios} scenarios, ${snapshots} snapshots; ${undirected} undirected and ${directed} directed graph renders`);
});
