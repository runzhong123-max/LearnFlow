import assert from 'node:assert/strict'
import test from 'node:test'
import { projectPathSourceExtensions } from '../src/path-source-extensions.ts'
import { exportOfficialLearningPathContractV2 } from '../src/learning-path-graph.ts'
import { OFFICIAL_PATH_NAMESPACE, type PathNodeV2 } from '../src/learning-path-contract-v2.ts'

function fixture() {
  const graph = exportOfficialLearningPathContractV2()
  const course = graph.nodes[0]
  const node: PathNodeV2 = {
    ...course, namespace: 'learnflow:extension:example', id: 'skill:one', revision: 1,
    kind: 'skill', title: '检查测试结果', summary: '依据预期输出判断测试执行结果。',
    ownership: { system: 'learnflow', catalog: 'graph_extension' },
    atomic: { scopeNote: '测试执行结果判断', assessmentCriteria: ['能区分通过、失败与未执行'] },
  }
  graph.nodes.push(node)
  graph.edges.push({ id: 'contains:one', from: { namespace: course.namespace, id: course.id }, to: { namespace: node.namespace, id: node.id }, kind: 'contains', rationale: '学习内容归属', provenance: course.provenance })
  return { graph, course, node }
}

test('persisted atomic extension appears below its official course with scope and criteria, without learner projection', () => {
  const { graph, course, node } = fixture()
  const original = JSON.stringify(graph)
  const view = projectPathSourceExtensions(graph, course.id)
  assert.equal(view.attached.length, 1)
  assert.equal(view.attached[0].id, node.id)
  assert.deepEqual(view.attached[0].atomic?.assessmentCriteria, ['能区分通过、失败与未执行'])
  assert.equal(view.parents(node)[0].title, course.title)
  assert.equal('statuses' in view, false)
  assert.equal('prerequisites' in view, false)
  assert.equal(JSON.stringify(graph), original)
})

test('co-learning and prerequisite edges do not become containment; equal local IDs in different namespaces stay distinct', () => {
  const { graph, course, node } = fixture()
  const other = { ...node, namespace: 'learnflow:extension:other', title: '另一企业的技能' }
  graph.nodes.push(other)
  graph.edges.push({ id: 'related:other', from: { namespace: OFFICIAL_PATH_NAMESPACE, id: course.id }, to: { namespace: other.namespace, id: other.id }, kind: 'co_learning', rationale: '相关', provenance: course.provenance })
  const view = projectPathSourceExtensions(graph, course.id)
  assert.equal(view.extensions.length, 2)
  assert.equal(view.attached.length, 1)
  assert.equal(view.attached[0].namespace, node.namespace)
  assert.deepEqual(view.parents(other), [])
})

test('containment descendants remain reachable while an unselected course does not claim attachment', () => {
  const { graph, course, node } = fixture()
  const nested = { ...node, id: 'skill:nested' }
  graph.nodes.push(nested)
  graph.edges.push({ id: 'contains:nested', from: node, to: nested, kind: 'contains', rationale: '细分内容', provenance: course.provenance })
  assert.equal(projectPathSourceExtensions(graph, course.id).attached.length, 2)
  assert.equal(projectPathSourceExtensions(graph).attached.length, 0)
})
