// A few family goldens, plus finite/bounded checks for all 50 maintained models.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'../packages/learning-core/src/learnflow_core/visuals/hub/authoring');
require(path.join(root,'batch2-models.js'));const build=globalThis.buildHubModel,defs=JSON.parse(fs.readFileSync(path.join(root,'batch2.json')));let cases=0;
for(const d of defs)for(const p of [d[4],d[7],d[5]]){const frames=build(d[0],p);assert(frames.length>0&&frames.length<150,d[0]);function finite(v){if(typeof v==='number')assert(Number.isFinite(v),d[0]);else if(Array.isArray(v))v.forEach(finite);else if(v&&typeof v==='object')Object.values(v).forEach(finite)}finite(frames);cases++}
const last=(id,p)=>build(id,p).at(-1);
for(const id of ['quicksort','merge','heap'])for(const p of [1,9,15])assert.deepEqual(last(id,p).bars,[p,3,12,5,8,1,10].sort((a,b)=>a-b));
assert.equal(last('fifo',3).metric,9);assert.equal(last('fifo',4).metric,10);
for(let p=1;p<=10;p++){let best=0;for(let m=0;m<16;m++){let w=0,v=0;[2,3,4,5].forEach((x,i)=>{if(m>>i&1){w+=x;v+=[3,4,5,8][i]}});if(w<=p)best=Math.max(best,v)}assert.equal(last('knapsack',p).metric,best)}
for(let p=1;p<=12;p++){assert.equal(last('prim',p).metric,last('kruskal',p).metric)}
assert.equal(last('huffman',5).metric,5*3+9*3+12*3+13*3+16*2+20*2); // Independent weighted leaf depths for frequencies 5,9,12,13,16,20.
for(const id of ['binomial','clt','softmax'])assert(Math.abs(last(id,id==='binomial'?50:id==='clt'?4:1).metric-1)<1e-10);
for(const p of [-1,0,2]){const eps=1e-5,L=w=>(2*w+1-5)**2/2;assert(Math.abs(last('backprop',p).metric-(L(p+eps)-L(p-eps))/(2*eps))<1e-8)}
assert.equal(last('stack',7).metric,5040);assert.equal(last('paging',42).metric,26);
console.log(JSON.stringify({models:defs.length,boundaryCases:cases,goldens:'sort, paging, replacement, knapsack, MST, Huffman, probability, derivative'}));
