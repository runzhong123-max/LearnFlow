import assert from 'node:assert/strict'
import test from 'node:test'
import {renderView, presentationContext} from '../../packages/learning-client/src/visuals/presentation.ts'
import type {VisualBundle, VisualView} from '../../packages/learning-client/src/visuals/types.ts'

const view = (elements: VisualView['elements']): VisualView => ({id: 'golden', title: '组合视图', renderer: 'svg', elements})

test('convolution window keeps matrix coordinates and masks only uncomputed outputs on a small screen', () => {
  const matrix = Array.from({length: 4}, (_, row) => Array.from({length: 6}, (_, col) => row * 6 + col))
  const result = renderView(view([{id: 'input', kind: 'matrix', label: '输入', inputs: {}, values: {values: matrix, active_cells: [[1, 2], [1, 3], [2, 2], [2, 3]]}}, {id: 'output', kind: 'matrix', label: '输出', inputs: {}, values: {values: [[0, 0], [0, 0]], computed_cells: [[0, 0]], active_cells: [[0, 0]]}}]), 300)
  assert.deepEqual(result.diagnostics, [])
  assert.ok(result.plan.repairs.some(repair => repair.code === 'HORIZONTAL_SCROLL'))
  const cell = (id: string) => result.plan.objects.find(object => object.id === id)!.bounds
  assert.equal(cell('input[1,0]')[1], cell('input[1,5]')[1], 'one matrix row must never wrap into another row')
  assert.ok(cell('input[2,0]')[1] > cell('input[1,0]')[1])
  assert.match(result.svg, /第 0 行第 0 列，0，当前窗口/)
  assert.match(result.svg, /第 0 行第 1 列，尚未计算/)
  assert.match(result.svg, /data-visual-id="input\[1,2\]"/)
})

test('directed graph and timeline retain stable semantic identities across stages', () => {
  const graph = (nodes: string[]) => view([{id: 'network', kind: 'graph', label: '连接状态', inputs: {}, values: {graph: {nodes, edges: nodes.includes('server') ? [['client', 'server']] : [], directed: true, labels: {client: '客户端', server: '服务端'}}, active: 'client'}}])
  const a = graph(['client']), b = graph(['client', 'server'])
  const context = presentationContext({frames: [{views: [a]}, {views: [b]}]} as VisualBundle)
  const before = renderView(a, 300, context), after = renderView(b, 300, context)
  assert.deepEqual(before.plan.objects.find(object => object.id === 'network.client')?.bounds, after.plan.objects.find(object => object.id === 'network.client')?.bounds)
  assert.match(after.svg, /marker-end="url\(#arrow-golden-network\)"/)
  const timeline = renderView(view([{id: 'messages', kind: 'timeline', label: '握手消息', inputs: {}, values: {lanes: ['客户端', '服务端'], events: [{id: 'syn', lane: '客户端', label: 'SYN：请求建立连接', at: 0}, {id: 'ack', lane: '服务端', label: 'SYN + ACK：确认并回应', at: 1}]}}]), 300)
  assert.deepEqual(timeline.diagnostics, [])
  assert.match(timeline.svg, /data-visual-id="messages.syn"/)
  assert.match(timeline.svg, /不据此证明/)
})

test('from-scratch table and code compose with wrapped labels, safe markup and explicit active lines', () => {
  const result = renderView(view([{id: 'code', kind: 'code', label: '代码', inputs: {}, values: {source: 'x = "<script>"\nreturn x', active_line: 2}}, {id: 'table', kind: 'table', label: '变量表', inputs: {}, values: {columns: ['对象', '值'], rows: [['x', '<script>'], ['说明', '较长的说明文字应该局部换行而不改变内容和表格关系']]}}]), 300)
  assert.deepEqual(result.diagnostics, [])
  assert.doesNotMatch(result.svg, /<script>/)
  assert.match(result.svg, /&lt;script&gt;/)
  assert.match(result.svg, /data-visual-id="code:2"[^]*?fill="#ffedd5"/)
  assert.equal(result.plan.transition, 'cut')
  assert.ok(result.plan.objects.some(object => object.id === 'table[1,1]'))
})
