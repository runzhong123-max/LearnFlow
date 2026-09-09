const {readFileSync}=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const test=require('node:test');
const entries=[];
function finite(value,label='value'){
  if(typeof value==='number')assert.ok(Number.isFinite(value),label+' must be finite');
  else if(Array.isArray(value))value.forEach((v,i)=>finite(v,label+'['+i+']'));
  else if(value&&typeof value==='object')Object.entries(value).forEach(([k,v])=>finite(v,label+'.'+k));
}
const render=(...args)=>{finite(args,'Viz input');return '<svg>'+JSON.stringify(args)+'</svg>';};
const Viz={plot:render,bars:render,matrix:render,graph:render,cells:render,flow:render,svg:render,text:render,line:render,rect:render,escape:String,colors:['#087f8c','#d57a19','#7250a3','#2d8a61','#bf5364']};
const sandbox={register:x=>entries.push(x),Math,Set,Map,Number,Array,String,Boolean};
if(process.env.FOUNDATIONS_VIZ_RUNTIME)vm.runInNewContext(readFileSync(process.env.FOUNDATIONS_VIZ_RUNTIME,'utf8'),sandbox);else sandbox.Viz=Viz;
vm.runInNewContext(readFileSync(path.join(__dirname,'foundations.js'),'utf8'),sandbox,{timeout:5000});
const get=id=>{const item=entries.find(x=>x.session===id);assert.ok(item,id);return item;};
const defaults=entry=>Object.fromEntries(entry.controls.map(c=>[c.id,c.value]));
const run=(id,overrides={})=>{const item=get(id);return item.compute({...defaults(item),...overrides});};
const last=(id,p={})=>{const frames=run(id,p).frames;return JSON.parse(JSON.stringify(frames[frames.length-1].values));};
const near=(a,b,tol=1e-9)=>assert.ok(Math.abs(a-b)<=tol,`${a} != ${b}`);

test('67 specific candidates execute default and every declared control boundary without nonfinite data',()=>{
  assert.equal(entries.length,67);assert.equal(new Set(entries.map(x=>x.session)).size,67);
  let runs=0;
  for(const entry of entries){
    assert.ok(entry.controls.length>=2,entry.session);assert.ok(entry.question&&entry.scope&&entry.takeaway,entry.session);
    const base=defaults(entry),variants=[base];
    for(const c of entry.controls)for(const value of c.type==='range'?[c.min,c.max]:c.options.map(o=>o.value))variants.push({...base,[c.id]:value});
    for(const params of variants){const output=entry.compute(params);assert.ok(output.frames.length>=1&&output.frames.length<=200,entry.session);for(const f of output.frames){assert.equal(typeof f.svg,'string');assert.ok(f.svg.length>20,entry.session);assert.ok(!/\b(?:NaN|Infinity)\b/.test(f.svg),entry.session+' nonfinite markup');assert.ok(f.note.trim().length>0,entry.session);finite(f.values,entry.session);}runs++;}
  }
  console.log(`Validated ${runs} bounded candidate computations (${process.env.FOUNDATIONS_VIZ_RUNTIME?'real shared renderer':'rendering stub'}).`);
});

test('mathematical goldens independently check counting, limits, integration, rank and optimization',()=>{
  assert.equal(last('math-functions.c1.s2',{x:3,scale:1}).euclidean,5);
  const conditional=last('math-probability.c1.s1',{threshold:8,face:6});assert.equal(conditional.denominator,15);assert.equal(conditional.numerator,5);near(conditional.conditional,1/3);
  assert.equal(last('math-calculus.c1.s1',{case:'hole'}).continuous,false);assert.equal(last('math-calculus.c1.s1',{case:'jump'}).limit,null);
  near(last('math-calculus.c2.s1',{n:2,side:'left'}).area,.125);near(last('math-calculus.c2.s1',{n:2,side:'right'}).area,.625);
  const chain=last('math-calculus.c3.s2',{t:1,path:'curve'});near(chain.derivative,6);near(chain.numerical,6,1e-6);
  assert.equal(last('math-linear.c2.s2',{a:1,b:2}).solutionCount,'infinite');assert.equal(last('math-linear.c2.s2',{a:1,b:3}).solutionCount,'none');
  near(last('math-linear.c3.s2',{small:1,rank:'one'}).error,1);
  const lp=last('math-optimization.c2.s2',{budget:5,price:3});near(lp.objective,13);near(lp.dualValue,13);
  const lag=last('math-optimization.c2.s1',{c:3,weight:2});near(lag.x,2);near(lag.y,1);near(lag.minimum,6);
  const cancellation=last('math-optimization.c3.s1',{x:100,digits:4});assert.equal(cancellation.naive,0);assert.ok(Math.abs(cancellation.stable-cancellation.reference)<1e-6);
  near(last('math-probability.c3.s1',{cutoff:1.96,effect:0}).alpha,.05,.00001);
});

test('algorithm goldens catch greedy and ordering mistakes with exact expected outputs',()=>{
  assert.equal(last('math-discrete.c3.s2',{shape:'cycle',n:5}).tree,false);
  assert.deepEqual(last('programming.c3.s2',{cap:5,version:'bug'}).failures,[5]);
  assert.deepEqual(last('algorithms.c2.s2',{algorithm:'merge',input:'duplicates'}).array,[1,1,2,3,3]);
  assert.deepEqual(last('algorithms.c2.s2',{algorithm:'heap',input:'mixed'}).array,[1,2,3,4,5]);
  const dp=last('algorithms.c3.s2',{coins:'trap',target:6});assert.equal(dp.minimum,2);assert.equal(dp.greedy,3);
  const h=last('data-structures.c3.s2',{freq:4,other:'balanced'});assert.equal(h.cost,32);assert.deepEqual(Object.values(h.codes).map(s=>s.length),[2,2,2,2]);
  const codes=Object.values(last('data-structures.c3.s2',{freq:20,other:'skew'}).codes);for(let i=0;i<codes.length;i++)for(let j=0;j<codes.length;j++)if(i!==j)assert.ok(!codes[j].startsWith(codes[i]));
  assert.equal(last('digital-logic.c1.s2',{a:7,mode:'add'}).full,12);assert.equal(last('digital-logic.c1.s2',{a:7,mode:'add'}).output,4);
});

test('system goldens check hazard stalls, cache conflicts, scheduling, delivery and recovery',()=>{
  assert.equal(last('architecture.c1.s2',{producer:'load',forward:'yes'}).stalls,1);assert.equal(last('architecture.c1.s2',{producer:'alu',forward:'yes'}).stalls,0);
  assert.equal(last('architecture.c2.s1',{lines:4,access:'conflict'}).hits,0);assert.equal(last('architecture.c2.s1',{lines:4,access:'local'}).hits,4);
  assert.equal(last('architecture.c3.s2',{stride:1,offset:0}).transactions,1);assert.equal(last('architecture.c3.s2',{stride:1,offset:1}).transactions,2);
  near(last('operating-systems.c1.s2',{policy:'fcfs',b:3}).averageWaiting,5);near(last('operating-systems.c1.s2',{policy:'sjf',b:3}).averageWaiting,7/3);
  assert.equal(last('networks.c1.s2',{host:127,specific:'on'}).prefix,24);assert.equal(last('networks.c1.s2',{host:128,specific:'on'}).prefix,25);
  assert.equal(last('networks.c2.s2',{window:3,lost:2}).ack,6);
  assert.equal(last('networks.c3.s2',{certificate:'name',tamper:'no'}).accepted,false);
  assert.equal(last('databases.c1.s1',{join:'left',orders:2}).count,4);
  assert.equal(last('databases.c3.s1',{value:9,crash:'before'}).recovered,0);assert.equal(last('databases.c3.s1',{value:9,crash:'after'}).recovered,9);
  assert.equal(last('databases.c3.s2',{read:'one'}).observed,0);assert.equal(last('databases.c3.s2',{read:'quorum'}).observed,1);
});
