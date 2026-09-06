import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { exportOfficialLearningPathContract, exportOfficialLearningPathContractV2 } from '../src/learning-path-graph.ts'
import { OFFICIAL_PATH_CONTENT } from '../src/official-learning-path-content.ts'
import {
  GRAPH_EXTENSION_PROPOSAL_V2, ROLE_LEARNING_ALIGNMENT_V2, OFFICIAL_PATH_NAMESPACE,
  pathNodeKey, upgradeOfficialPathGraph, validateLearningPathGraphV2,
  validateGraphExtensionProposalV2, validateRoleLearningAlignmentV2,
  type GraphExtensionProposalV2, type LearningPathGraphV2, type PathEdgeV2,
  type RoleLearningAlignmentV2, type RoleAlignmentSource, type ContractValidation,
} from '../src/learning-path-contract-v2.ts'

const official = () => exportOfficialLearningPathContractV2()
const packageRef = { packageId: 'role:software-tester', packageVersion: '1.0.0', snapshotId: 'snapshot:1', rootHash: 'a'.repeat(64) }
const namespace = 'learnflow:extension:software-testing'
const source: RoleAlignmentSource = { packageRef, nodes: [{ id: 'role-point:boundary', kind: 'skill' }], evidenceIds: ['evidence:1'] }
const anchor = { namespace: OFFICIAL_PATH_NAMESPACE, id: 'software-testing' }

function proposal(): GraphExtensionProposalV2 {
  const graph = official()
  const provenance = { method: 'role_package_proposal' as const, packageRef, sourceRefs: ['moe-software-510203'], evidenceRefs: ['evidence:1'] }
  return {
    protocolVersion: GRAPH_EXTENSION_PROPOSAL_V2, idempotencyKey: 'extension:boundary:1',
    baseGraphRef: { graphId: graph.graphId, revision: graph.revision }, packageRef, namespace, sources: [],
    nodes: [{
      id: 'boundary-value-case-design', namespace, revision: 1, kind: 'skill', title: '使用边界值分析设计测试用例',
      summary: '根据输入范围识别边界，选择边界附近的数据并写出预期结果。', aliases: ['边界值用例设计'],
      domains: ['软件测试'], audiences: ['vocational'], stage: 'domain', order: 4,
      ownership: { system: 'learnflow', catalog: 'graph_extension' }, provenance,
      atomic: { scopeNote: '面向具有明确取值范围的输入，不包含性能压测。', assessmentCriteria: ['覆盖有效和无效边界并说明预期结果'] },
    }],
    edges: [{ id: 'extension:testing-contains-boundary', from: anchor, to: { namespace, id: 'boundary-value-case-design' }, kind: 'contains', rationale: '边界值用例设计是软件测试中的具体技能。', provenance }],
  }
}
function withExtension(): LearningPathGraphV2 {
  const graph = official(), p = proposal()
  return { ...graph, revision: 'test:extension:1', nodes: [...graph.nodes, ...p.nodes], edges: [...graph.edges, ...p.edges] }
}
function alignment(graph = withExtension()): RoleLearningAlignmentV2 {
  return {
    protocolVersion: ROLE_LEARNING_ALIGNMENT_V2, packageRef,
    graphRef: { graphId: graph.graphId, revision: graph.revision },
    bindings: [{ id: 'binding:boundary', roleNodeId: 'role-point:boundary', roleNodeKind: 'skill',
      target: { namespace, id: 'boundary-value-case-design', revision: 1 }, relation: 'equivalent',
      requiredLevel: 'apply', context: '根据电商优惠券输入规则独立设计用例。', rationale: '工作要求与节点定义及考核边界一致。', evidenceRefs: ['evidence:1'] }],
  }
}
function rejects(result: ContractValidation<unknown>, code: string) {
  assert.equal(result.valid, false)
  assert.ok(result.issues.some(i => i.code === code), JSON.stringify(result.issues))
}

test('official v2 retains every v1 identity, relationship and curated summary without inventing atomic semantics', () => {
  const v1 = exportOfficialLearningPathContract(), v2 = official()
  assert.equal(v2.nodes.length, 108); assert.equal(v2.edges.length, 187)
  assert.deepEqual(v2.nodes.map(n => n.id), v1.nodes.map(n => n.id))
  assert.deepEqual(v2.edges.map(e => [e.id, e.from.id, e.to.id, e.kind]), v1.edges.map(e => [e.id, e.from, e.to, e.kind]))
  assert.deepEqual(Object.keys(OFFICIAL_PATH_CONTENT).sort(), v1.nodes.map(n => n.id).sort())
  assert.equal(validateLearningPathGraphV2(v2).valid, true)
  assert.ok(v2.nodes.every(n => n.kind === 'course' || n.kind === 'skill_domain'))
  for (const node of v2.nodes) {
    assert.ok(node.summary.length >= 20, node.id)
    assert.ok(!node.summary.includes('的核心概念、方法与基本实践'), node.id)
    assert.equal(node.summary, v1.nodes.find(n => n.id === node.id)!.summary)
    assert.equal(node.provenance.method, 'editorial_synthesis')
  }
  const result = validateLearningPathGraphV2(v2)
  assert.ok(result.valid)
  result.value.nodes[0].summary = 'changed'
  assert.notEqual(v2.nodes[0].summary, 'changed')
  assert.notEqual(official().nodes[0].summary, 'changed')
})

test('Role Atlas artifacts are byte-stable exports of the same canonical v1/v2 graph', () => {
  for (const [filename, graph] of [['learnflow-learning-path.json', exportOfficialLearningPathContract()], ['learnflow-learning-path.v2.json', official()]] as const) {
    const text = readFileSync(new URL(`../../apps/role-atlas/public/data/${filename}`, import.meta.url), 'utf8')
    assert.equal(text, `${JSON.stringify(graph, null, 2)}\n`, 'Run npm run learning-path:sync in apps/role-atlas')
  }
})

test('strict source contracts reject malformed input, learner fields, missing sources and duplicate identities', () => {
  rejects(validateLearningPathGraphV2(null), 'type')
  rejects(validateLearningPathGraphV2({ ...official(), learnerId: 'learner:1' }), 'unknown_field')
  const nested = official(); (nested.nodes[0] as unknown as Record<string, unknown>).mastery = true
  rejects(validateLearningPathGraphV2(nested), 'unknown_field')
  const missing = official(); missing.nodes[0].provenance.sourceRefs = ['missing']
  rejects(validateLearningPathGraphV2(missing), 'source_missing')
  const duplicate = official(); duplicate.nodes.push(duplicate.nodes[0])
  rejects(validateLearningPathGraphV2(duplicate), 'duplicate')
  const dangling = official(); dangling.edges[0].to.id = 'missing'
  rejects(validateLearningPathGraphV2(dangling), 'endpoint_missing')
  const badUrl = official(); assert.ok(badUrl.sources[0].kind !== 'package_evidence'); badUrl.sources[0].url = 'javascript:alert(1)'
  rejects(validateLearningPathGraphV2(badUrl), 'url')
})

test('contains and prerequisites have separate cycle rules; co_learning never imposes sequence', () => {
  const g = withExtension(), contains = g.edges.at(-1)!
  const back: PathEdgeV2 = { ...contains, id: 'back', from: contains.to, to: contains.from, kind: 'soft_prerequisite' }
  g.edges.push(back)
  assert.equal(validateLearningPathGraphV2(g).valid, true, 'Containment is not a prerequisite')
  g.edges.push({ ...contains, id: 'order', kind: 'hard_prerequisite' })
  rejects(validateLearningPathGraphV2(g), 'prerequisite_cycle')
  g.edges[g.edges.length - 1].kind = 'co_learning'
  assert.equal(validateLearningPathGraphV2(g).valid, true)
  const cycle = official(), a = cycle.nodes.find(n => n.kind === 'skill_domain')!, b = cycle.nodes.find(n => n.kind === 'skill_domain' && n.id !== a.id)!
  const key = (n: typeof a) => ({ id: n.id, namespace: n.namespace })
  cycle.edges.push({ ...contains, id: 'contains-a', from: key(a), to: key(b) }, { ...contains, id: 'contains-b', from: key(b), to: key(a) })
  rejects(validateLearningPathGraphV2(cycle), 'containment_cycle')
})

test('course name matching cannot become equivalent knowledge/skill semantics', () => {
  const graph = official(), a = alignment(graph)
  a.bindings[0].target = { ...anchor, revision: 1 }
  rejects(validateRoleLearningAlignmentV2(a, graph, source), 'granularity')
  a.bindings[0].relation = 'narrower_than'
  assert.equal(validateRoleLearningAlignmentV2(a, graph, source).valid, true)
  assert.equal(validateRoleLearningAlignmentV2(alignment(), withExtension(), source).valid, true)
})

test('bindings require exact graph, node, package and evidence identities', () => {
  const graph = withExtension()
  for (const [change, code] of [
    [(a: RoleLearningAlignmentV2) => { a.graphRef.revision = 'old' }, 'stale_graph'],
    [(a: RoleLearningAlignmentV2) => { a.packageRef = { ...packageRef, snapshotId: 'other' } }, 'package_mismatch'],
    [(a: RoleLearningAlignmentV2) => { a.bindings[0].target.revision = 2 }, 'target_revision'],
    [(a: RoleLearningAlignmentV2) => { a.bindings[0].target.namespace = 'learnflow:extension:other' }, 'target_revision'],
    [(a: RoleLearningAlignmentV2) => { a.bindings[0].evidenceRefs = ['invented'] }, 'evidence_missing'],
    [(a: RoleLearningAlignmentV2) => { a.bindings[0].roleNodeKind = 'knowledge' }, 'role_node'],
  ] as const) {
    const a = alignment(graph); change(a)
    rejects(validateRoleLearningAlignmentV2(a, graph, source), code)
  }
})

test('extension batch validates additions and keeps base graph unchanged', () => {
  const graph = official(), before = JSON.stringify(graph), p = proposal()
  assert.equal(validateGraphExtensionProposalV2(p, graph, source).valid, true)
  assert.equal(JSON.stringify(graph), before)
  assert.equal(graph.nodes.some(n => pathNodeKey(n) === pathNodeKey(p.nodes[0])), false)
  const noBoundary = structuredClone(p) as unknown as { nodes: Array<Record<string, unknown>> }
  delete noBoundary.nodes[0].atomic
  rejects(validateGraphExtensionProposalV2(noBoundary, graph, source), 'type')
})

test('enterprise evidence can ground extensions without inventing a public URL or copying private text', () => {
  const p = proposal()
  p.sources = [{ id: 'source:enterprise', title: '脱敏测试用例规范', kind: 'package_evidence', packageRef, evidenceRefs: ['evidence:1'] }]
  for (const item of [...p.nodes, ...p.edges]) item.provenance.sourceRefs = ['source:enterprise']
  assert.equal(validateGraphExtensionProposalV2(p, official(), source).valid, true)
  assert.ok(p.sources[0].kind === 'package_evidence')
  p.sources[0].evidenceRefs = ['invented']
  rejects(validateGraphExtensionProposalV2(p, official(), source), 'evidence_missing')
})

test('extensions reject stale bases, ownership spoofing, disconnected nodes and conflicting source identities', () => {
  for (const [change, code] of [
    [(p: GraphExtensionProposalV2) => { p.baseGraphRef.revision = 'old' }, 'stale_graph'],
    [(p: GraphExtensionProposalV2) => { p.nodes[0].provenance = { ...p.nodes[0].provenance, evidenceRefs: ['invented'] } }, 'evidence_missing'],
    [(p: GraphExtensionProposalV2) => { p.packageRef = { ...packageRef, snapshotId: 'other' } }, 'package_mismatch'],
    [(p: GraphExtensionProposalV2) => { p.nodes[0].namespace = OFFICIAL_PATH_NAMESPACE }, 'namespace'],
    [(p: GraphExtensionProposalV2) => { p.nodes[0].revision = 2 }, 'extension_scope'],
    [(p: GraphExtensionProposalV2) => { p.nodes[0].provenance = { ...p.nodes[0].provenance, packageRef: { ...packageRef, rootHash: 'b'.repeat(64) } } }, 'provenance'],
    [(p: GraphExtensionProposalV2) => { p.sources.push(official().sources[0]) }, 'duplicate'],
    [(p: GraphExtensionProposalV2) => { p.edges[0].from = { namespace, id: 'missing' } }, 'unanchored'],
    [(p: GraphExtensionProposalV2) => { p.edges[0].to = { namespace: OFFICIAL_PATH_NAMESPACE, id: 'software-engineering' } }, 'existing_edge_edit'],
  ] as const) {
    const p = proposal(); change(p)
    rejects(validateGraphExtensionProposalV2(p, official(), source), code)
  }
})

test('v1 upgrade refuses personal overlays or undeclared granularity', () => {
  const graph = exportOfficialLearningPathContract(), v2 = official()
  assert.throws(() => upgradeOfficialPathGraph(graph, v2.sources, v2, {}), /explicit/)
  graph.nodes[0].origin = 'personal'
  assert.throws(() => upgradeOfficialPathGraph(graph, v2.sources, v2, {}), /official/)
})

test('official node revisions evolve independently from graph release and keep stable IDs', () => {
  const graph = exportOfficialLearningPathContract(), original = official(), content = structuredClone(OFFICIAL_PATH_CONTENT)
  content[graph.nodes[0].id].revision = 2
  graph.nodes[0].summary = '更新后的数字素养课程定义与实践目标。'
  const next = upgradeOfficialPathGraph(graph, original.sources, { graphId: original.graphId, revision: 'test:next' }, content)
  assert.equal(next.nodes[0].id, original.nodes[0].id)
  assert.equal(next.nodes[0].revision, 2)
  assert.equal(next.nodes[1].revision, 1)
  assert.equal(next.revision, 'test:next')
})
