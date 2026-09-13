import assert from 'node:assert/strict'
import test from 'node:test'
import { teachingAffordances, remarkTeachingHighlights, existingQuoteSheet, TEACHING_AFFORDANCES_VERSION } from './affordances.ts'
const content = '闭包保留对外层变量的引用，因此函数返回后仍能访问变量。'
const raw = { version: TEACHING_AFFORDANCES_VERSION, sourceText: content, followUps: ['变量为什么还在？', '两个闭包会共享变量吗？', '能举一个计数器的例子吗？'], highlights: [{ quote: '闭包' }, { quote: '函数返回后仍能访问变量' }] }

test('metadata is exact-version bound and rejects stale, repeated or invented candidates', () => {
  assert.equal(teachingAffordances(raw, content)?.followUps.length, 3)
  assert.equal(teachingAffordances(raw, content + '改变'), undefined)
  assert.equal(teachingAffordances({ ...raw, version: 'future' }, content), undefined)
  assert.deepEqual(teachingAffordances({ ...raw, followUps: ['为何这样？', '为何这样?', '其他问题？'] }, content)?.followUps, [])
  assert.deepEqual(teachingAffordances({ ...raw, highlights: [{ quote: '变量' }, { quote: '不存在的概念' }, ...raw.highlights, { quote: '闭包保留对外层变量的引用' }] }, content)?.highlights, raw.highlights)
})

test('Markdown tree annotation protects code, math, HTML and links, annotates once', () => {
  const tree: any = { type: 'root', children: [
    ...['code', 'inlineCode', 'math', 'inlineMath', 'html', 'link', 'linkReference'].map(type => ({ type, value: '闭包', children: [{ type: 'text', value: '闭包' }] })),
    { type: 'paragraph', children: [{ type: 'text', value: '一个闭包示例' }] },
    { type: 'paragraph', children: [{ type: 'text', value: '另一个闭包' }] },
  ] }
  remarkTeachingHighlights({ quotes: ['闭包'] })(tree)
  assert.equal(tree.children[7].children[1].type, 'teachingHighlight')
  assert.equal(tree.children[7].children[1].data.hProperties['data-teaching-quote'], '闭包')
  assert.equal(tree.children[8].children[0].value, '另一个闭包')
  for (const child of tree.children.slice(0, 7)) assert.equal(child.children[0].type, 'text')
})

test('quote paper reuse is scoped to the parent paper and original message', () => {
  const sheet = { id: 'child', parentSheetId: 'main', sourceMessageId: 'message-1', quote: '闭包' }
  assert.equal(existingQuoteSheet([sheet], 'message-1', 'main', '闭包'), sheet)
  assert.equal(existingQuoteSheet([sheet], 'message-2', 'main', '闭包'), undefined)
  assert.equal(existingQuoteSheet([sheet], 'message-1', 'another', '闭包'), undefined)
})
