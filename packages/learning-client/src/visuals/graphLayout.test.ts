import {test} from 'node:test'
import assert from 'node:assert/strict'
import {graphLayout} from './graphLayout.ts'
test('B+ root is above children, leaf links do not flatten hierarchy',()=>{
 for(const w of [280,720]){const l=graphLayout(['r','a','b','c'],[['r','a'],['r','b'],['r','c'],['a','b'],['b','c']],{r:'根 [20,40]',a:'叶 [5,12]',b:'叶 [20,27,35]',c:'叶 [40,48]'},w,true);
 assert(l.positions.r[1]<l.positions.a[1]);assert.equal(l.positions.a[1],l.positions.c[1]);
 for(const [a,b] of [['a','b'],['b','c']])assert(l.positions[b][0]-l.positions[a][0]>(l.widths[a]+l.widths[b])/2+19);
 }
});
test('cycles have distinct spatial positions and bounds',()=>{const l=graphLayout(['a','b','c','d'],[['a','b'],['b','c'],['c','d'],['d','a']],{},320,true);assert.equal(new Set(Object.values(l.positions).map(p=>p.join(','))).size,4);for(const [id,[x,y]]of Object.entries(l.positions)){assert(x-l.widths[id]/2>=0);assert(y>=20)}});
