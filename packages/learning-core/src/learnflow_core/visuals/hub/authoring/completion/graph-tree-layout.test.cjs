const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../completion-runtime.js'), 'utf8'), context);
const layout = context.layoutTeachingTree;

test('Huffman golden: ordered subtrees, centered parents, finite bounds and no edge crossings', () => {
  // Independent fixture: [5,9,12,13,16,20] yields internal weights 14,25,30,45,75.
  const nodes = ['A','B','C','D','E','F','14','25','30','45','75'].map(id => ({ id, w: 64, h: 38 }));
  const children = { 14: ['A','B'], 25: ['C','D'], 30: ['14','E'], 45: ['F','25'], 75: ['30','45'] };
  // Deliberately reversed registration: semantic labels, not input order, decide left/right.
  const edges = Object.entries(children).flatMap(([from, [zero, one]]) => [
    { from, to: one, label: '1' }, { from, to: zero, label: '0' },
  ]);
  const { positions, width, height } = layout(nodes, edges);
  const leafOrder = [...positions].filter(([id]) => /^[A-F]$/.test(id)).sort((a,b) => a[1].x-b[1].x).map(([id]) => id);
  assert.deepEqual(leafOrder, ['A','B','E','F','C','D']);
  assert.equal(positions.get('75').x, width / 2);
  const descendants = id => children[id] ? children[id].flatMap(descendants) : [id];
  for (const [parent, [zero, one]] of Object.entries(children)) {
    assert.ok(positions.get(zero).x < positions.get(one).x, `${parent}: 0 stays left of 1`);
    const xs = descendants(parent).map(id => positions.get(id).x);
    assert.equal(positions.get(parent).x, (Math.min(...xs) + Math.max(...xs)) / 2);
  }
  const cross = (a,b,c) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  for (let i=0; i<edges.length; i++) for (let j=i+1; j<edges.length; j++) {
    const e=edges[i], f=edges[j];
    if ([e.from,e.to].some(id => id===f.from||id===f.to)) continue;
    const [a,b,c,d]=[e.from,e.to,f.from,f.to].map(id=>positions.get(id));
    assert.ok(!(cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0), `${e.from}→${e.to} crosses ${f.from}→${f.to}`);
  }
  for (const node of nodes) {
    const p=positions.get(node.id);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    assert.ok(p.x-node.w/2>=0 && p.x+node.w/2<=width && p.y-node.h/2>=0 && p.y+node.h/2<=height);
  }
});

test('B+ leaf successors stay on one level; forests and pointer self-loops terminate', () => {
  const nodes = ['root','L','M','R'].map(id=>({id,w:80,h:38}));
  const edges = ['L','M','R'].map(to=>({from:'root',to})).concat([
    {from:'L',to:'M',label:'后继叶'}, {from:'M',to:'R',label:'后继叶'},
  ]);
  const plain=layout(nodes,edges.slice(0,3)), linked=layout(nodes,edges);
  assert.deepEqual([...linked.positions], [...plain.positions]);
  assert.equal(linked.positions.get('L').y, linked.positions.get('R').y);
  const forest=layout(['A','N','B'].map(id=>({id,w:64,h:38})), [{from:'A',to:'N'},{from:'N',to:'N'}]);
  assert.equal(forest.positions.size, 3);
  assert.ok(forest.positions.get('A').y < forest.positions.get('N').y);
  assert.notEqual(forest.positions.get('B').x, forest.positions.get('A').x);
});
