import assert from 'node:assert/strict'
import test from 'node:test'
import { readTabLayout, saveTabLayout, clearTabLayout, consumeLayoutReset, withoutTabLayout } from '../src/workspace-layout.ts'
function store() { const data = new Map<string,string>(); return { getItem: (k:string) => data.get(k) ?? null, setItem: (k:string,v:string) => { data.set(k,v) }, removeItem: (k:string) => { data.delete(k) } } }
const layout = { tabs: [{ id: 'one' }, { id: 'two' }], activeTabId: 'one', splitTabId: 'two', drafts: { one: '未发送' } }
test('refresh restores closed layout, active tab, split and draft', () => {
  const s = store(); saveTabLayout(s, 1, layout)
  assert.deepEqual(readTabLayout(s,1), layout)
  saveTabLayout(s,1,{ ...layout, tabs: [{id:'one'}], splitTabId: '' })
  assert.deepEqual(readTabLayout(s,1)?.tabs, [{id:'one'}])
})
test('browser sessions and learners do not share layouts', () => {
  const a=store(), b=store(); saveTabLayout(a,1,layout)
  assert.equal(readTabLayout(b,1),undefined)
  assert.equal(readTabLayout(a,2),undefined)
})
test('explicit logout clears drafts and marks one clean start; auth expiry retains layout', () => {
  const s=store(); saveTabLayout(s,1,layout)
  assert.equal(consumeLayoutReset(s,1),false)
  assert.deepEqual(readTabLayout(s,1),layout)
  clearTabLayout(s,1)
  assert.equal(readTabLayout(s,1),undefined)
  assert.equal(consumeLayoutReset(s,1),true)
  assert.equal(consumeLayoutReset(s,1),false)
})
test('shared content cache contains no layout and preserves conversations', () => {
  assert.deepEqual(withoutTabLayout({ tabs: layout.tabs, activeTabId:'one', splitTabId:'two', conversations:[{id:'one'}] }),{conversations:[{id:'one'}]})
})
