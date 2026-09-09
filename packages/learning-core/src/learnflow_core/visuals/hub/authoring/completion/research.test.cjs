const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const works = new Map();
const renderCalls = [];
function finite(value) {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), 'non-finite value');
  else if (value && typeof value === 'object') for (const item of Object.values(value)) finite(item);
}
const render = name => (...args) => {finite(args);renderCalls.push([name,args]);return `<svg data-render="${name}">${JSON.stringify(args)}</svg>`};
const Viz=Object.fromEntries(['plot','bars','matrix','graph','cells','flow','svg','text','line','rect'].map(name=>[name,render(name)]));
Viz.escape=String;Viz.colors=['#087f8c','#d57a19','#7250a3','#2d8a61','#bf5364'];
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'research.js'),'utf8'),{register:work=>{assert.ok(!works.has(work.session),'duplicate '+work.session);works.set(work.session,work)},Viz},{filename:'research.js'});
const params = w => Object.fromEntries(w.controls.map(c=>[c.id,c.value]));
const run = (id,override={}) => {const w=works.get(id);assert.ok(w,id);return w.compute({...params(w),...override})};
const last = (id,override) => JSON.parse(JSON.stringify(run(id,override).frames.at(-1).values));
const near = (a,b,e=1e-10) => assert.ok(Math.abs(a-b)<e,`${a} != ${b}`);

test('all 78 research sessions are registered with scoped interactive finite results',()=>{
 assert.equal(works.size,78);
 const modules=['testing','embedded','computer-vision','nlp','reinforcement-learning','distributed-systems','formal-methods','advanced-algorithms','robotics','retrieval-mining','privacy-crypto','quantum','bioinformatics'];
 for(const mod of modules) for(let c=1;c<=3;c++) for(let s=1;s<=2;s++) assert.ok(works.has(`${mod}.c${c}.s${s}`));
 for(const [id,w] of works){
  assert.ok(w.scope.length>20&&w.takeaway.length>10,id);
  assert.equal(w.controls.length,2,id);
  const baseline=run(id);assert.ok(baseline.frames.length>0&&baseline.frames.length<200,id);
  for(const f of baseline.frames){assert.match(f.svg,/^<svg/);assert.ok(f.note&&f.values,id);finite(f.values)}
  for(const control of w.controls){
   const values=control.type==='range'?[control.min,control.max,control.min+control.step]:control.options.map(o=>o.value);
   let changes=false;
   for(const value of values){const output=run(id,{[control.id]:value});assert.ok(output.frames.length>0&&output.frames.length<200,id);for(const f of output.frames)finite(f.values);if(JSON.stringify(output)!==JSON.stringify(baseline))changes=true}
   assert.ok(changes,`${id}.${control.id} never changes the result`);
  }
 }
});

test('queue, serial bits, idempotent recovery and lost-update counterexample',()=>{
 const q=last('testing.c3.s1',{arrival:5,service:7});assert.equal(q.p95,43);assert.equal(q.mean,26);
 assert.deepEqual(last('embedded.c1.s2',{byte:65,baud:'9600'}).bits,[0,1,0,0,0,0,0,1,0,1]);
 assert.equal(last('testing.c3.s2',{retries:3,key:'yes'}).balance,90);
 assert.equal(last('testing.c3.s2',{retries:3,key:'no'}).balance,60);
 assert.deepEqual(last('formal-methods.c2.s2',{threads:2,atomic:'yes'}).terminalValues,[2]);
 assert.deepEqual(last('formal-methods.c2.s2',{threads:2,atomic:'no'}).terminalValues,[1,2]);
 assert.equal(last('embedded.c3.s2',{power:1,order:'unsafe'}).bootable,false);
 assert.equal(last('embedded.c3.s2',{power:2,order:'safe'}).bootable,true);
});

test('NMS, denoising inversion, Bellman and policy-gradient mean/variance',()=>{
 const n=last('computer-vision.c2.s1',{offset:0,threshold:.5});assert.deepEqual(n.kept,[0,2]);near(n.overlap,9/11);
 near(last('computer-vision.c2.s2',{alpha:.5,bias:0}).mse,0);
 near(last('computer-vision.c2.s2',{alpha:.5,bias:.25}).mse,.0625);
 near(last('reinforcement-learning.c1.s1',{gamma:.5,stay:.5}).exact,4/3);
 const g=last('reinforcement-learning.c2.s2',{logit:0,baseline:2});near(g.mean,.5);near(g.variance,0);
});

test('flow/cut equality, cover approximation, Kalman update and loop closure',()=>{
 for(const [a,b,expected] of [[2,3,5],[6,6,7],[1,1,2]]){const f=last('advanced-algorithms.c1.s1',{a,b});assert.equal(f.flow,expected);assert.equal(f.minCut,expected)}
 const v=last('advanced-algorithms.c2.s1',{shape:'star',order:'forward'});assert.equal(v.cover.length,2);assert.equal(v.optimum.length,1);
 const k=last('robotics.c1.s2',{measurement:2,noise:1});near(k.gain,.5);near(k.mean,1);near(k.variance,.5);
 const s=last('robotics.c3.s1',{drift:.2,weight:2});near(s.positions[2],2.08);near(s.positions[1],1.04);
 const arm=last('robotics.c1.s1',{x:1.5,y:.5});for(const endpoint of arm.endpoints){near(endpoint[0],1.5);near(endpoint[1],.5)}
});

test('ranking/cryptographic identities and quantum normalisation have independent numeric goldens',()=>{
 near(last('retrieval-mining.c2.s1',{swap:1,k:5}).ndcg,1);
 const dh=last('privacy-crypto.c1.s1',{a:6,b:7});assert.equal(dh.aliceKey,12);assert.equal(dh.bobKey,12);
 const zk=last('privacy-crypto.c1.s2',{secret:4,challenge:2});assert.equal(zk.z,0);assert.equal(zk.lhs,1);assert.equal(zk.rhs,1);
 const agg=last('privacy-crypto.c2.s2',{update:2,mask:8});assert.equal(agg.aggregate,4);
 const qft=last('quantum.c2.s1',{frequency:2,input:'phase'});near(qft.probabilities[2],1);near(qft.norm,1);
 const grover=last('quantum.c2.s2',{marked:3,iterations:2});near(grover.success,121/128);near(grover.norm,1);
 near(last('quantum.c3.s1',{p:.1,channel:'bit'}).logical,.028);
 near(last('quantum.c1.s2',{theta:90,gate:'cnot'}).concurrence,1);
});

test('alignment, multiple testing, PCA and numerical convergence',()=>{
 const a=last('bioinformatics.c1.s1',{pair:'ACG/AG',gap:1});assert.equal(a.score,3);assert.deepEqual(a.alignment,['ACG','A-G']);
 assert.equal(last('bioinformatics.c2.s1',{q:.05,method:'bh'}).rejected,3);
 assert.equal(last('bioinformatics.c2.s1',{q:.05,method:'bonf'}).rejected,1);
 const d=last('bioinformatics.c1.s2',{sequence:'ATGAT',k:3});assert.equal(d.assembly,'ATGAT');assert.equal(d.usedEdges.length,3);
 const e=last('bioinformatics.c3.s1',{step:.5,rate:2});assert.equal(e.value,0);assert.equal(e.multiplier,0);
 const c=last('bioinformatics.c3.s2',{level:4,x:.75});assert.ok(c.ratio>3.99&&c.ratio<4.01);
 const p=last('bioinformatics.c2.s2',{scale:1,standardize:'yes'});near(p.direction[0],Math.SQRT1_2);near(p.direction[1],Math.SQRT1_2);
});

test('current input, selected candidates and spatial relationships remain visible in the primary scene',()=>{
 const pictures=(id,p)=>JSON.stringify(run(id,p).frames.map(f=>f.svg));
 for(const [id,key,value] of [
  ['testing.c1.s1','age',15],['embedded.c1.s2','baud','115200'],
  ['computer-vision.c1.s1','depth',10],['computer-vision.c3.s2','threshold',0],
  ['reinforcement-learning.c3.s2','limit',0],['distributed-systems.c3.s2','fanout',1],
  ['advanced-algorithms.c3.s1','days',1],['retrieval-mining.c1.s1','tf',12],
  ['retrieval-mining.c1.s2','budget',8],['retrieval-mining.c2.s1','k',1],
  ['retrieval-mining.c3.s1','neighbors',1],['privacy-crypto.c3.s1','guess',0],
  ['quantum.c3.s1','p',.5],['bioinformatics.c3.s2','level',1]
 ])assert.notEqual(pictures(id,{}),pictures(id,{[key]:value}),`${id}.${key} must affect the primary scene`);
 assert.notEqual(pictures('quantum.c2.s1',{input:'basis',frequency:0}),pictures('quantum.c2.s1',{input:'basis',frequency:1}),'QFT must expose phase, even when probabilities are uniform');
 for(const id of ['robotics.c1.s1','retrieval-mining.c1.s2','bioinformatics.c2.s2']){
  renderCalls.length=0;run(id);const calls=renderCalls.filter(([name])=>name==='plot');
  assert.ok(calls.length>0&&calls.every(([,args])=>args[0].equalAspect===true),id+' must preserve geometric distances');
 }
 renderCalls.length=0;run('bioinformatics.c1.s2',{sequence:'ATATG',k:2});
 const edges=renderCalls.filter(([name])=>name==='graph')[0][1][0].edges;
 assert.equal(edges.length,3);assert.ok(edges.some(e=>e.label==='AT × 2，剩 1'),'repeated k-mer multiplicity must remain visible after consuming one copy');
});

test('real Viz renderer covers defaults and control-boundary combinations without invalid geometry strings',()=>{
 const runtime=process.env.VISUAL_COMPLETION_RUNTIME||path.resolve(__dirname,'../completion-runtime.js');
 assert.ok(fs.existsSync(runtime),'Set VISUAL_COMPLETION_RUNTIME to the shared renderer when testing an isolated authoring worktree');
 const actual=new Map(),context=vm.createContext({register:work=>actual.set(work.session,work)});
 vm.runInContext(fs.readFileSync(runtime,'utf8'),context,{filename:'completion-runtime.js'});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'research.js'),'utf8'),context,{filename:'research.js'});
 let configurations=0,frames=0;
 for(const [id,work] of actual){
  const defaults=params(work),bounds=work.controls.map(c=>c.type==='range'?[c.min,c.max]:c.options.map(o=>o.value));
  const variants=[defaults];
  for(let ci=0;ci<2;ci++)for(const v of bounds[ci])variants.push({...defaults,[work.controls[ci].id]:v});
  for(const a of bounds[0])for(const b of bounds[1])variants.push({...defaults,[work.controls[0].id]:a,[work.controls[1].id]:b});
  for(const parameters of variants){
   configurations++;const output=work.compute(parameters);assert.ok(output.frames.length>0&&output.frames.length<200,id);
   for(const item of output.frames){frames++;assert.ok(item.svg.length>20,id);assert.doesNotMatch(item.svg,/NaN|[+-]?Infinity/,id);finite(item.values);assert.doesNotMatch(item.svg,/<script\b|on(?:load|error)=/i,id)}
  }
 }
 for(const id of ['advanced-algorithms.c2.s1','advanced-algorithms.c3.s2']){
  const work=actual.get(id),output=work.compute(params(work));for(const item of output.frames)assert.doesNotMatch(item.svg,/marker-end=/,'undirected graph '+id);
 }
 console.log(`Real Viz: ${actual.size} works, ${configurations} configurations, ${frames} frames`);
});
