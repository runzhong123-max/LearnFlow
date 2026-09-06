import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OFFICIAL_PATH_EDGES,
  OFFICIAL_PATH_NODES,
  addPersonalPathNode,
  alignPersonalConceptsToLearningPath,
  archiveLearningPathPlan,
  buildLearningPathPlanProposal,
  buildLearningGraphAlignments,
  buildPersonalNodeProposal,
  assessPersonalPathNodeEvidence,
  commitLearningPathPlan,
  createInitialLearnerPathState,
  lookupLearningPathGraph,
  learningPathAudienceNodeIds,
  projectLearnerPath,
  readLearningPathGraph,
  removePersonalPathNode,
  setLearnerPathStatus,
  searchLearningPathGraph,
  topologicallyOrderLearningPathRoute,
  validateOfficialLearningPathGraph,
} from '../src/learning-path-graph.ts'
import { extractLearningPathTopic } from '../src/learning-path-retrieval.ts'
import { executeTutorAgentTool, TUTOR_AGENT_TOOL_DEFINITIONS } from './tool-runtime.ts'
import {
  KNOWLEDGE_CLUSTERS,
  NEBULA_WIDTH,
  clusterLearningPathNode,
  learningStageIndex,
  layoutLearningPathNebula,
  nebulaHeight,
  traceLearningPath,
} from '../src/learning-path-nebula.ts'

const qmlEvidence = [{
  title: 'Quantum Machine Learning',
  url: 'https://example.edu/quantum-machine-learning',
  snippet: 'Quantum machine learning combines quantum computing methods with machine learning models and algorithms.',
  source: 'Example University',
  quality: 'academic' as const,
  role: 'course' as const,
}]

test('official graph is sourced, broad, and acyclic', () => {
  const validation = validateOfficialLearningPathGraph()
  assert.equal(validation.valid, true, validation.errors.join('\n'))
  assert.ok(OFFICIAL_PATH_NODES.length >= 90)
  assert.ok(OFFICIAL_PATH_EDGES.length >= 140)
  assert.ok(OFFICIAL_PATH_NODES.some((node) => node.audiences.includes('vocational')))
  assert.ok(OFFICIAL_PATH_NODES.some((node) => node.audiences.includes('graduate')))
  assert.ok(OFFICIAL_PATH_NODES.some((node) => node.id === 'agent-engineering'))
  assert.ok(OFFICIAL_PATH_NODES.every((node) => node.sourceRefs.length > 0))
})

test('vocational computer and information technology pathways expose job-facing core courses', () => {
  const expectedVocationalNodes = [
    'computer-maintenance', 'windows-server-administration', 'network-cabling',
    'software-modeling-design', 'enterprise-application-development', 'software-testing',
    'wireless-networking', 'network-automation', 'network-systems-integration',
    'virtualization-technology', 'cloud-platform-operations', 'container-cloud-operations',
    'data-acquisition-technology', 'data-preprocessing-etl', 'data-analysis-applications',
    'data-visualization-applications', 'big-data-platform-operations',
    'operating-system-security', 'security-product-configuration', 'storage-disaster-recovery',
    'digital-forensics', 'security-risk-assessment', 'mobile-cross-platform', 'mini-program-development',
  ]
  expectedVocationalNodes.forEach(nodeId => {
    const node = OFFICIAL_PATH_NODES.find(item => item.id === nodeId)
    assert.ok(node, `missing vocational node: ${nodeId}`)
    assert.ok(node!.audiences.includes('vocational'), `${nodeId} must support vocational learners`)
    assert.ok(node!.sourceRefs.some(source => source.startsWith('moe-')), `${nodeId} must cite an MOE standard`)
  })
  assert.ok(OFFICIAL_PATH_EDGES.some(edge => edge.from === 'network-routing-switching' && edge.to === 'network-systems-integration'))
  assert.ok(OFFICIAL_PATH_EDGES.some(edge => edge.from === 'cloud-platform-operations' && edge.to === 'container-cloud-operations'))
  assert.ok(OFFICIAL_PATH_EDGES.some(edge => edge.from === 'data-preprocessing-etl' && edge.to === 'data-analysis-applications'))
})

test('reader returns a planning packet around a known course', () => {
  const packet = readLearningPathGraph('我想系统学习 Agent 开发', createInitialLearnerPathState())
  assert.equal(packet.matchKind, 'official_match')
  assert.ok(packet.matchedNodeIds.includes('agent-engineering'))
  assert.equal(packet.needsExternalResearch, false)
  assert.equal(packet.manifest.noKnowledgeMasteryInference, true)
})

test('exact reader resolves ids, names and aliases without fuzzy or external work', () => {
  const state = createInitialLearnerPathState()
  const byId = lookupLearningPathGraph('machine-learning', state)
  const byName = lookupLearningPathGraph('机器学习', state)
  const byAlias = lookupLearningPathGraph('我想系统学习 Agent 开发', state)
  assert.equal(byId.resolution, 'resolved')
  assert.equal(byName.candidates[0].reasons[0], 'exact_title')
  assert.equal(byAlias.candidates[0].nodeId, 'agent-engineering')
  assert.equal(byAlias.needsFuzzySearch, false)
  assert.equal(byAlias.needsExternalResearch, false)
})

test('fuzzy reader repairs spelling but exposes broad ambiguity instead of guessing', () => {
  const state = createInitialLearnerPathState()
  const typo = searchLearningPathGraph('操作系統源理', state)
  assert.equal(typo.resolution, 'resolved')
  assert.equal(typo.candidates[0].nodeId, 'operating-systems')
  assert.ok(typo.candidates[0].reasons.includes('alias_similarity'))
  assert.ok(typo.candidates[0].scoreBreakdown.spelling >= 0.8)

  const ambiguous = searchLearningPathGraph('安全', state)
  assert.equal(ambiguous.resolution, 'ambiguous')
  assert.equal(ambiguous.recommendedNextAction, 'ask_disambiguation')
  assert.equal(ambiguous.matchedNodeIds.length, 0)
  assert.equal(buildLearningPathPlanProposal('安全', state, ambiguous), undefined)
  assert.equal(buildPersonalNodeProposal(ambiguous, qmlEvidence, state), undefined)
})

test('compound graph gaps do not collapse into a shorter official course', () => {
  const state = createInitialLearnerPathState()
  const packet = searchLearningPathGraph('我想学习量子机器学习', state)
  assert.equal(packet.matchKind, 'graph_gap')
  assert.equal(packet.resolution, 'not_found')
  assert.equal(packet.needsExternalResearch, true)
  assert.equal(packet.candidates[0].nodeId, 'machine-learning')
  assert.equal(buildPersonalNodeProposal(packet, [], state), undefined)
  const proposal = buildPersonalNodeProposal(packet, qmlEvidence, state)
  assert.ok(proposal)
  assert.equal(proposal!.requiresLearnerConfirmation, true)
  assert.equal(proposal!.masteryUnchanged, true)
  assert.equal(proposal!.generatedFromSnapshotId, packet.snapshotId)
})

test('path ACI catalog separates exact, fuzzy and proposal responsibilities', () => {
  const tools = new Map(TUTOR_AGENT_TOOL_DEFINITIONS.map(tool => [tool.name, tool]))
  assert.ok(tools.has('lookup_learning_path_node'))
  assert.ok(tools.has('search_learning_path_graph'))
  assert.ok(tools.has('propose_personal_path_node'))
  assert.equal(tools.has('read_learning_path'), false)
  assert.equal(tools.get('lookup_learning_path_node')?.risk, 'read_only')
  assert.equal(tools.get('search_learning_path_graph')?.risk, 'read_only')
  assert.equal(tools.get('propose_personal_path_node')?.risk, 'proposal')
  assert.match(tools.get('propose_personal_path_node')?.description || '', /不得直接写图/)
})

test('a graph gap becomes a confirmable personal node and remains removable', () => {
  const initial = createInitialLearnerPathState()
  const packet = readLearningPathGraph('我想学习量子机器学习', initial)
  assert.equal(packet.matchKind, 'graph_gap')
  assert.equal(packet.needsExternalResearch, true)

  const proposal = buildPersonalNodeProposal(packet, qmlEvidence)
  assert.ok(proposal)
  const added = addPersonalPathNode(initial, proposal!)
  const projection = projectLearnerPath(added)
  const personal = projection.nodes.find((node) => node.sourceProposalId === proposal!.id)
  assert.ok(personal)
  assert.ok(projection.edges.some((edge) => edge.to === personal!.id))

  const removed = removePersonalPathNode(added, personal!.id)
  assert.equal(projectLearnerPath(removed).nodes.some((node) => node.id === personal!.id), false)
})

test('personal-node evidence rejects URL-only and off-topic search results', () => {
  const packet = searchLearningPathGraph('量子机器学习', createInitialLearnerPathState())
  assert.equal(buildPersonalNodeProposal(packet, [{ url: 'https://example.edu/qml' }]), undefined)
  const report = assessPersonalPathNodeEvidence('量子机器学习', [{
    title: 'Introduction to Databases', url: 'https://example.edu/database',
    snippet: 'A course about SQL, transactions, indexing and database design.',
    source: 'Example University', quality: 'academic', role: 'course',
  }])
  assert.equal(report.valid, false)
  assert.equal(report.accepted.length, 0)
  assert.equal(buildPersonalNodeProposal(packet, [{
    title: 'Introduction to Databases', url: 'https://example.edu/database',
    snippet: 'A course about SQL, transactions, indexing and database design.',
    source: 'Example University', quality: 'academic', role: 'course',
  }]), undefined)
})

test('topic extraction removes planning wrappers without swallowing the course name', () => {
  assert.equal(extractLearningPathTopic('我想学量子机器学习，需要哪些前置？'), '量子机器学习')
  assert.equal(extractLearningPathTopic('研究生想做具身智能研究，该怎么规划'), '具身智能')
  assert.equal(extractLearningPathTopic('我想从机器学习走向科研，该学什么'), '机器学习')
  assert.equal(extractLearningPathTopic('帮我看看网络安全和系统安全的区别'), '网络安全和系统安全')
})

test('industry practice domains are explicit course nodes with inspectable content', () => {
  const expected = [
    'engineering-debugging-observability', 'reliability-incident-response',
    'secure-software-supply-chain', 'information-retrieval', 'data-governance-privacy',
    'ai-system-evaluation', 'api-design-evolution', 'performance-engineering',
    'platform-engineering', 'software-maintenance-evolution', 'open-source-collaboration',
    'numerical-scientific-computing',
  ]
  expected.forEach(nodeId => {
    const node = OFFICIAL_PATH_NODES.find(item => item.id === nodeId)
    assert.ok(node, `missing industry domain: ${nodeId}`)
    assert.ok(node!.summary.length >= 45, `${nodeId} needs a concrete scope summary`)
    assert.ok(node!.sourceRefs.length > 0)
  })
})

test('audience views retain hidden hard prerequisites as bridge nodes', () => {
  const graduate = learningPathAudienceNodeIds(OFFICIAL_PATH_NODES, OFFICIAL_PATH_EDGES, 'graduate')
  const vocational = learningPathAudienceNodeIds(OFFICIAL_PATH_NODES, OFFICIAL_PATH_EDGES, 'vocational')
  for (const edge of OFFICIAL_PATH_EDGES.filter(item => item.kind === 'hard_prerequisite')) {
    if (graduate.has(edge.to)) assert.ok(graduate.has(edge.from), `graduate view hides ${edge.from} -> ${edge.to}`)
    if (vocational.has(edge.to)) assert.ok(vocational.has(edge.from), `vocational view hides ${edge.from} -> ${edge.to}`)
  }
})

test('route ordering honors hard and soft prerequisites while excluding co-learning as precedence', () => {
  const ordered = topologicallyOrderLearningPathRoute(
    ['deep-learning', 'optimization', 'machine-learning', 'computer-organization', 'digital-logic'],
    OFFICIAL_PATH_NODES,
    OFFICIAL_PATH_EDGES,
  )
  assert.ok(ordered.indexOf('optimization') < ordered.indexOf('deep-learning'))
  assert.ok(ordered.indexOf('digital-logic') < ordered.indexOf('computer-organization'))
  const plan = buildLearningPathPlanProposal('我想系统学习深度学习', createInitialLearnerPathState())
  assert.ok(plan)
  assert.ok(plan!.routeNodeIds.indexOf('optimization') < plan!.routeNodeIds.indexOf('deep-learning'))
  assert.equal(plan!.policyId, 'vnext-learning-path-planner-v2')
})

test('course status remains explicitly self reported', () => {
  const state = setLearnerPathStatus(
    createInitialLearnerPathState(),
    'machine-learning',
    'self_reported_mastered',
  )
  const packet = readLearningPathGraph('机器学习', state)
  assert.equal(packet.nodes.find((node) => node.id === 'machine-learning')?.status, 'self_reported_mastered')
  assert.equal(packet.manifest.noKnowledgeMasteryInference, true)
})

test('personal concept anchors align to course nodes without sharing mastery conclusions', () => {
  const alignments = alignPersonalConceptsToLearningPath([
    { concept_key: 'bayes-formula', name: '贝叶斯公式' },
    { concept_key: 'machine-learning', name: '机器学习' },
    { concept_key: 'my-python', name: 'Python', official_node_id: 'python-programming' },
  ])
  assert.deepEqual(alignments.map(item => item.pathNodeId), ['machine-learning', 'python-programming'])
  assert.ok(alignments.every(item => item.authority === 'deterministic_alignment_projection'))
  assert.ok(alignments.every(item => !('mastery' in item)))
})

test('four graph families use explicit alignment records and preserve unmatched gaps', () => {
  const initial = createInitialLearnerPathState()
  const proposal = buildLearningPathPlanProposal('我想用半年系统学习 Agent 开发', initial)!
  const state = commitLearningPathPlan(initial, proposal)
  const alignment = buildLearningGraphAlignments(
    state,
    [
      { concept_key: 'machine-learning', name: '机器学习' },
      { concept_key: 'private-intuition', name: '我自己的调试直觉' },
    ],
    [
      { id: 'repo-agent', title: 'Agent 工程', labels: ['智能体工程', '工具调用'], sourceIds: ['source-1'] },
      { id: 'repo-unknown', title: '团队内部专用协议', labels: ['私有协议'], sourceIds: ['source-2'] },
    ],
  )
  assert.equal(alignment.version, 'vnext-graph-alignment.v1')
  assert.ok(alignment.alignments.some(item => item.fromGraph === 'source_knowledge_domain' && item.toId === 'agent-engineering'))
  assert.ok(alignment.alignments.some(item => item.fromGraph === 'learning_path_plan' && item.relation === 'routes_through'))
  assert.ok(alignment.alignments.some(item => item.fromGraph === 'personal_concept_graph' && item.toId === 'machine-learning'))
  assert.ok(alignment.alignments.some(item => item.toGraph === 'personal_course_overlay'))
  assert.ok(alignment.alignments.every(item => item.carriesMastery === false))
  assert.ok(alignment.gaps.some(item => item.objectId === 'repo-unknown'))
  assert.ok(alignment.gaps.some(item => item.objectId === 'private-intuition'))
})

test('planning mode invokes the path reader without asking the model to decide structure', async () => {
  const result = await executeTutorAgentTool('lookup_learning_path_node', {
    query: '我想规划 Agent 开发的学习路线',
  }, {
    message: '我想规划 Agent 开发的学习路线',
    mode: 'learning_plan',
    learnerPathState: createInitialLearnerPathState(),
    generate: async () => { throw new Error('known-node path read should not need generation') },
  })
  const pathRun = result.run
  const observation = result.observation as { context: string; pathPlanProposal?: { targetNodeIds: string[] } }
  assert.equal(pathRun?.status, 'completed')
  assert.match(pathRun?.detail || '', /智能体工程/)
  assert.match(observation.context, /结构核参考投影/)
  assert.match(observation.context, /不能替代题目、项目或迁移证据/)
  assert.ok(pathRun?.pathPlanProposal)
  assert.ok(pathRun!.pathPlanProposal!.targetNodeIds.includes('agent-engineering'))
  assert.equal(observation.pathPlanProposal, pathRun.pathPlanProposal)
})

test('long-term route proposal becomes an inspectable learner-owned plan and remains archivable', () => {
  const initial = createInitialLearnerPathState()
  const proposal = buildLearningPathPlanProposal('我想用半年系统学习 Agent 开发并做一个项目', initial)
  assert.ok(proposal)
  assert.equal(proposal!.horizon, '6 个月')
  assert.ok(proposal!.targetNodeIds.includes('agent-engineering'))
  assert.ok(proposal!.routeNodeIds.includes('agent-engineering'))
  assert.ok(proposal!.routeNodeIds.some(nodeId => ['python-programming', 'machine-learning', 'deep-learning'].includes(nodeId)))
  assert.ok(proposal!.milestoneNodeIds.length >= 2)

  const committed = commitLearningPathPlan(initial, proposal!)
  const projection = projectLearnerPath(committed)
  assert.equal(projection.activePlan?.id, proposal!.id)
  assert.equal(projection.activePlan?.status, 'active')
  assert.equal(projection.activePlan?.revision, 1)

  const archived = archiveLearningPathPlan(committed, proposal!.id)
  const archivedProjection = projectLearnerPath(archived)
  assert.equal(archivedProjection.activePlan, undefined)
  assert.equal(archivedProjection.plans.find(plan => plan.id === proposal!.id)?.status, 'archived')
})

test('knowledge nebula gives every course one bounded thematic position', () => {
  const positions = layoutLearningPathNebula(OFFICIAL_PATH_NODES, OFFICIAL_PATH_EDGES)
  const canvasHeight = nebulaHeight(OFFICIAL_PATH_NODES)
  assert.equal(positions.size, OFFICIAL_PATH_NODES.length)
  assert.equal(new Set(OFFICIAL_PATH_NODES.map(clusterLearningPathNode)).size, KNOWLEDGE_CLUSTERS.length)
  positions.forEach(position => {
    assert.ok(position.x >= 0 && position.x + position.width <= NEBULA_WIDTH)
    assert.ok(position.y >= 0 && position.y + position.height <= canvasHeight)
  })
  assert.ok(learningStageIndex(OFFICIAL_PATH_NODES.find(node => node.id === 'python-programming')!.stage)
    < learningStageIndex(OFFICIAL_PATH_NODES.find(node => node.id === 'agent-engineering')!.stage))
  assert.equal(clusterLearningPathNode(OFFICIAL_PATH_NODES.find(node => node.id === 'linear-algebra')!), 'mathematics')
  assert.equal(clusterLearningPathNode(OFFICIAL_PATH_NODES.find(node => node.id === 'operating-systems')!), 'systems')
  assert.equal(clusterLearningPathNode(OFFICIAL_PATH_NODES.find(node => node.id === 'agent-engineering')!), 'ai')
  assert.equal(clusterLearningPathNode(OFFICIAL_PATH_NODES.find(node => node.id === 'computer-security')!), 'security')
})

test('knowledge nebula distinguishes one-hop hover from pinned prerequisite paths', () => {
  const oneHop = traceLearningPath(OFFICIAL_PATH_EDGES, 'machine-learning', false)
  const fullPath = traceLearningPath(OFFICIAL_PATH_EDGES, 'machine-learning', true)
  assert.ok(oneHop.nodes.has('machine-learning'))
  assert.ok(fullPath.nodes.size >= oneHop.nodes.size)
  assert.ok(fullPath.upstream.has('linear-algebra'))
  assert.ok(fullPath.edgeIds.size > 0)
})
