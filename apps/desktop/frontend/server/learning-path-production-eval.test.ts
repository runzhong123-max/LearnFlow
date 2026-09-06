import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OFFICIAL_PATH_EDGES,
  OFFICIAL_PATH_NODES,
  buildLearningPathPlanProposal,
  createInitialLearnerPathState,
  learningPathAudienceNodeIds,
  lookupLearningPathGraph,
  searchLearningPathGraph,
} from '../src/learning-path-graph.ts'

const state = createInitialLearnerPathState()

test('production eval: every official title is an exact stable lookup', () => {
  for (const node of OFFICIAL_PATH_NODES) {
    const packet = lookupLearningPathGraph(node.title, state)
    assert.equal(packet.retrievalMode, 'exact', node.title)
    assert.equal(packet.resolution, 'resolved', node.title)
    assert.deepEqual(packet.matchedNodeIds, [node.id], node.title)
  }
})

test('production eval: representative learner language resolves at the intended layer', () => {
  const cases = [
    { query: '我想系统学习机器学习，该学什么', resolution: 'resolved', nodeId: 'machine-learning', mode: 'exact' },
    { query: '研究生想做AI系统评测研究，该怎么规划', resolution: 'resolved', nodeId: 'ai-system-evaluation', mode: 'exact' },
    { query: '軟體工程', resolution: 'resolved', nodeId: 'software-engineering', mode: 'exact' },
    { query: '數據庫原里', resolution: 'resolved', nodeId: 'database-systems', mode: 'exact' },
    { query: '操作系統原里', resolution: 'resolved', nodeId: 'operating-systems', mode: 'exact' },
    { query: 'API设计', resolution: 'resolved', nodeId: 'api-design-evolution', mode: 'fuzzy' },
    { query: '安全', resolution: 'ambiguous', mode: 'fuzzy' },
    { query: '量子机器学习', resolution: 'not_found', mode: 'fuzzy' },
  ] as const

  for (const expected of cases) {
    const exact = lookupLearningPathGraph(expected.query, state)
    const result = exact.resolution === 'resolved' ? exact : searchLearningPathGraph(expected.query, state)
    assert.equal(result.retrievalMode, expected.mode, expected.query)
    assert.equal(result.resolution, expected.resolution, expected.query)
    if ('nodeId' in expected) assert.equal(result.candidates[0]?.nodeId, expected.nodeId, expected.query)
  }
})

test('production eval: every generated route is topological and retains direct hard prerequisites', () => {
  for (const target of OFFICIAL_PATH_NODES) {
    const packet = lookupLearningPathGraph(target.title, state, 14)
    const proposal = buildLearningPathPlanProposal(`我想学习${target.title}`, state, packet)
    assert.ok(proposal, target.title)
    assert.ok(proposal.routeNodeIds.includes(target.id), target.title)
    const positions = new Map(proposal.routeNodeIds.map((nodeId, index) => [nodeId, index]))
    for (const edge of OFFICIAL_PATH_EDGES) {
      const from = positions.get(edge.from), to = positions.get(edge.to)
      if (from !== undefined && to !== undefined && edge.kind !== 'co_learning') {
        assert.ok(from < to, `${target.title}: ${edge.from} must precede ${edge.to}`)
      }
      if (edge.to === target.id && edge.kind === 'hard_prerequisite') {
        assert.ok(positions.has(edge.from), `${target.title}: missing direct prerequisite ${edge.from}`)
      }
    }
  }
})

test('production eval: audience views never strand a visible course behind a hidden hard prerequisite', () => {
  for (const audience of ['vocational', 'undergraduate', 'graduate'] as const) {
    const visible = learningPathAudienceNodeIds(OFFICIAL_PATH_NODES, OFFICIAL_PATH_EDGES, audience)
    for (const edge of OFFICIAL_PATH_EDGES.filter(item => item.kind === 'hard_prerequisite')) {
      if (visible.has(edge.to)) assert.ok(visible.has(edge.from), `${audience}: ${edge.from} -> ${edge.to}`)
    }
  }
})
