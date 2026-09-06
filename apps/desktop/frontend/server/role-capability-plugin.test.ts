import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { loadLearnFlowPluginRegistry } from './plugin-loader.ts'
import { RolePackageRuntime } from '../plugins/role_capability_graph/runtime.ts'

const activation = { mode: 'simple_explain' as const, activePluginIds: ['role_capability_graph'] }
const executionContext = {
  ...activation,
  scope: { mode: 'simple_explain' as const, conversationId: 'test-conversation' },
  signal: AbortSignal.timeout(5_000),
}

async function registry() {
  return loadLearnFlowPluginRegistry(resolve(process.cwd(), 'plugins'))
}

test('role capability plugin is discovered declaratively with explanation-only read tools', async () => {
  const loaded = await registry()
  const tools = loaded.toolDefinitions(activation)
  assert.deepEqual(tools.map(tool => tool.name), [
    'role_capability_graph__search_graph_hub',
    'role_capability_graph__explore_role',
    'role_capability_graph__read_capability_radar',
    'role_capability_graph__read_role_objects',
    'role_capability_graph__search_role_knowledge',
    'role_capability_graph__query_role_graph',
    'role_capability_graph__trace_work_process',
    'role_capability_graph__inspect_role_evidence',
    'role_capability_graph__audit_role_package',
    'role_capability_graph__research_role_node_risks',
    'role_capability_graph__list_role_packages',
    'role_capability_graph__reference_role_package',
    'role_capability_graph__compare_role_packages',
  ])
  assert.equal(tools.filter(tool => tool.risk === 'read_only').length, 13)
  assert.equal(tools.filter(tool => tool.risk === 'artifact').length, 0)
  assert.match(loaded.skillInstructions(activation), /唯一岗位事实版本/)
  assert.match(loaded.skillInstructions(activation), /作为 query 调用 list_role_packages/)
  assert.match(loaded.skillInstructions(activation), /reference_role_package/)
  assert.match(loaded.skillInstructions(activation), /通用补充（非岗位快照）/)
  assert.match(loaded.skillInstructions(activation), /不能覆盖 LearnFlow 的教学状态/)
  assert.match(loaded.skillInstructions(activation), /节点.*风险/u)
  assert.match(loaded.skillInstructions(activation), /只在 role-agent\/Hub 进行/)
  assert.match(loaded.skillInstructions(activation), /matchStatus=not_found/)
  assert.match(loaded.skillInstructions(activation), /不得调用 explore_role/)
  assert.match(loaded.skillInstructions(activation), /先调用 search_graph_hub/)
})

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalValue(item)]))
  return typeof value === 'string' ? value.normalize('NFC') : value
}

function canonicalStringify(value: unknown) {
  return JSON.stringify(canonicalValue(value))
}

test('graph hub recommendation exposes an unreviewed personal graph only to its LearnFlow learner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learnflow-graph-hub-'))
  const core = {
    protocol: 'graph-hub-catalog.v1',
    generatedAt: new Date().toISOString(),
    audienceSubjectId: 'learnflow:learner:7',
    entries: [{
      graphId: 'personal-agent-map', graphVersion: '1.0.0', graphType: 'knowledge',
      title: '我的 Agent 学习图', summary: 'Agent 评测与工具设计', keywords: ['Agent', '评测'],
      ownerSubjectId: 'learnflow:learner:7', maintainerName: 'Learner 7', kind: 'personal',
      review: 'pending_owner', access: 'owner', objectHash: 'a'.repeat(64), objectPath: `objects/sha256/${'a'.repeat(64)}.graph.json`,
      submittedAt: new Date().toISOString(),
      nodeIndex: [{ id: 'agent-eval', label: 'Agent 评测', type: 'knowledge_skill', summary: '可靠性评测' }],
    }],
  }
  const rootHash = createHash('sha256').update(canonicalStringify({ ...core, generatedAt: '', rootHash: '' })).digest('hex')
  const catalogFile = join(root, 'catalog.json')
  await writeFile(catalogFile, canonicalStringify({ ...core, rootHash }), 'utf8')
  const previous = process.env.LEARNFLOW_GRAPH_HUB_CATALOG
  process.env.LEARNFLOW_GRAPH_HUB_CATALOG = catalogFile
  try {
    const loaded = await registry()
    const owner = await loaded.execute('role_capability_graph__search_graph_hub', {
      query: 'Agent 评测', topK: 3,
    }, { ...executionContext, scope: { ...executionContext.scope, learnerId: 7 } })
    assert.equal((owner.result.payload as any).recommendations.length, 1)
    assert.equal((owner.result.payload as any).recommendations[0].review, 'pending_owner')
    assert.equal(owner.result.objects?.[0].objectType, 'graph_recommendation')
    assert.equal(owner.result.presentation?.renderer, 'role_capability_graph:graph_hub_recommendation')
    assert.match(String((owner.result.payload as any).boundary), /不写学习路径、EvidenceEvent 或五核/)

    await assert.rejects(loaded.execute('role_capability_graph__search_graph_hub', {
      query: 'Agent 评测', topK: 3,
    }, { ...executionContext, scope: { ...executionContext.scope, learnerId: 8 } }), /graph_hub_catalog_not_visible:audience/)
  } finally {
    if (previous === undefined) delete process.env.LEARNFLOW_GRAPH_HUB_CATALOG
    else process.env.LEARNFLOW_GRAPH_HUB_CATALOG = previous
  }
})

test('graph hub recommendation uses the checked-in development catalog when no catalog is configured', async () => {
  const previousCatalog = process.env.LEARNFLOW_GRAPH_HUB_CATALOG
  const previousRoot = process.env.LEARNFLOW_GRAPH_HUB_CATALOG_ROOT
  const previousNodeEnv = process.env.NODE_ENV
  delete process.env.LEARNFLOW_GRAPH_HUB_CATALOG
  delete process.env.LEARNFLOW_GRAPH_HUB_CATALOG_ROOT
  process.env.NODE_ENV = 'test'
  try {
    const loaded = await registry()
    const result = await loaded.execute('role_capability_graph__search_graph_hub', {
      query: '大模型应用工程师', topK: 3,
    }, executionContext)
    assert.equal((result.result.payload as any).recommendations.length, 1)
    assert.equal((result.result.payload as any).recommendations[0].graphId, 'learnflow:built-in-llm-app-engineer')
  } finally {
    if (previousCatalog === undefined) delete process.env.LEARNFLOW_GRAPH_HUB_CATALOG
    else process.env.LEARNFLOW_GRAPH_HUB_CATALOG = previousCatalog
    if (previousRoot === undefined) delete process.env.LEARNFLOW_GRAPH_HUB_CATALOG_ROOT
    else process.env.LEARNFLOW_GRAPH_HUB_CATALOG_ROOT = previousRoot
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
  }
})

test('package catalog filters by requested role and hands unmatched roles to Role Atlas', async () => {
  const loaded = await registry()
  const matched = await loaded.execute('role_capability_graph__list_role_packages', {
    query: '我想了解大模型应用工程师',
  }, executionContext)
  const matchedPayload = matched.result.payload as any
  assert.equal(matchedPayload.matchStatus, 'matched')
  assert.ok(matchedPayload.packages.length >= 1)
  assert.ok(matchedPayload.packages.every((item: any) => item.roleTitle === '大模型应用工程师'))

  const missing = await loaded.execute('role_capability_graph__list_role_packages', {
    query: '软件测试工程师',
  }, executionContext)
  const missingPayload = missing.result.payload as any
  assert.equal(missingPayload.matchStatus, 'not_found')
  assert.equal(missingPayload.requestedRole, '软件测试工程师')
  assert.deepEqual(missingPayload.packages, [])
  assert.deepEqual(missing.result.objects, [])
  assert.equal(missing.result.presentation?.renderer, 'role_capability_graph:role_package_catalog')
  const target = new URL(missingPayload.roleAgentResearchUrl)
  assert.equal(target.pathname, '/projects/new')
  assert.equal(target.searchParams.get('role'), '软件测试工程师')
  await assert.rejects(() => loaded.execute('role_capability_graph__explore_role', {
    query: '软件测试工程师',
  }, executionContext), /role_package_not_matched/)
})

test('package catalog requires an exact user selection before producing a pinned reference', async () => {
  const loaded = await registry()
  const catalog = await loaded.execute('role_capability_graph__list_role_packages', {}, executionContext)
  const candidate = (catalog.result.payload as any).packages[0]
  assert.ok(candidate.packageId && candidate.packageVersion && candidate.snapshotId && candidate.rootHash)
  const selected = await loaded.execute('role_capability_graph__reference_role_package', {
    packageId: candidate.packageId,
    packageVersion: candidate.packageVersion,
    snapshotId: candidate.snapshotId,
    rootHash: candidate.rootHash,
  }, executionContext)
  assert.equal(selected.result.presentation?.renderer, 'role_capability_graph:role_package_reference')
  assert.equal(selected.result.objects?.[0].objectType, 'role_package_reference')
  assert.deepEqual((selected.result.payload as any).requiredSelector, {
    packageId: candidate.packageId,
    packageVersion: candidate.packageVersion,
    snapshotId: candidate.snapshotId,
  })
  assert.equal((selected.result.presentation?.state as any).rootHash, candidate.rootHash)
  await assert.rejects(() => loaded.execute('role_capability_graph__reference_role_package', {
    packageId: candidate.packageId,
    packageVersion: candidate.packageVersion,
    snapshotId: candidate.snapshotId,
    rootHash: '0'.repeat(64),
  }, executionContext), /role_package_reference_mismatch/)
})

test('role-agent simulation source exposes every valid static package as referenceable', () => {
  const runtime = new RolePackageRuntime([{
    root: resolve(process.cwd(), 'plugins/role_capability_graph/data/packages'),
    sourceKind: 'role_agent_simulation',
    accessScope: 'simulation_all',
  }])
  const payload = runtime.listPackages().payload as any
  assert.ok(payload.packages.length >= 1)
  assert.ok(payload.packages.every((item: any) => item.sourceKind === 'role_agent_simulation' && item.accessScope === 'simulation_all'))
  assert.match(payload.simulation, /不代表已经通过正式 Hub 审核/)
})

test('node deep research finds bounded snapshot risks for explanation without producing a patch', async () => {
  const loaded = await registry()
  const overview = await loaded.execute('role_capability_graph__explore_role', { query: '大模型应用工程师' }, executionContext)
  const payload = overview.result.payload as any
  const targetId = payload.sections.tasks[0]
  const research = await loaded.execute('role_capability_graph__research_role_node_risks', {
    snapshotId: payload.snapshot.snapshotId,
    objectId: targetId,
    question: '解释这个节点的证据边界和过程风险',
    maxNodes: 12,
  }, executionContext)
  assert.equal(research.result.presentation?.renderer, 'role_capability_graph:role_node_risk_research')
  const risk = research.result.objects?.find(item => item.objectType === 'role_node_risk')
  assert.ok(risk)
  assert.equal((risk!.value as any).snapshotId, payload.snapshot.snapshotId)
  assert.equal((risk!.value as any).rootHash, payload.snapshot.rootHash)
  assert.ok((risk!.value as any).data.risks.length >= 1)
  assert.match((risk!.value as any).data.boundary, /不生成修改建议、patch 或后继版本/)
})

test('one overview call returns grounded role, task, capability and scenario sections', async () => {
  const loaded = await registry()
  const execution = await loaded.execute('role_capability_graph__explore_role', {
    query: '介绍一下大模型应用工程师',
  }, executionContext)
  assert.equal(execution.result.presentation?.renderer, 'role_capability_graph:role_overview')
  const payload = execution.result.payload as any
  assert.equal(payload.kind, 'role_overview')
  assert.ok(payload.sections.tasks.length >= 4)
  assert.ok(payload.sections.capabilities.length >= 4)
  assert.ok(payload.sections.scenarios.length >= 3)
  assert.equal(payload.grounding.policy, 'snapshot_facts_only')
  assert.ok(payload.grounding.facts.every((fact: any) => fact.objectId && fact.statement))
  assert.equal((execution.result.presentation?.state as any).snapshotId, payload.snapshot.snapshotId)
  assert.ok((execution.result.presentation?.state as any).focusObjectIds.includes(payload.rootId))
})

test('capability radar expands semantic rings around the role and package catalog is version-addressable', async () => {
  const loaded = await registry()
  const radar = await loaded.execute('role_capability_graph__read_capability_radar', { query: '' }, executionContext)
  assert.equal(radar.result.presentation?.renderer, 'role_capability_graph:capability_radar')
  const radarPayload = radar.result.payload as any
  assert.equal(radarPayload.kind, 'role_dimension_radar')
  assert.ok(radarPayload.rings.length >= 5)
  assert.equal(radarPayload.rings[0].ring, 0)
  assert.ok(radarPayload.rings.some((ring: any) => ring.label === '知识技能'))
  assert.ok(radar.result.objects?.some(object => object.objectType === 'role_relation'))
  assert.match(radarPayload.boundary, /不是学习者能力评分/)

  const catalog = await loaded.execute('role_capability_graph__list_role_packages', {}, executionContext)
  assert.equal(catalog.result.presentation?.renderer, 'role_capability_graph:role_package_catalog')
  const snapshots = (catalog.result.payload as any).packages
  assert.ok(snapshots.length >= 1)
  const comparison = await loaded.execute('role_capability_graph__compare_role_packages', {
    baseSnapshotId: snapshots[0].snapshotId,
    targetSnapshotId: snapshots[0].snapshotId,
  }, executionContext)
  assert.equal(comparison.result.presentation?.renderer, 'role_capability_graph:role_package_comparison')
  assert.deepEqual((comparison.result.payload as any).added, [])
  assert.deepEqual((comparison.result.payload as any).removed, [])
  assert.deepEqual((comparison.result.payload as any).changed, [])
})

test('search pins one immutable package and returns typed objects with explicit coverage', async () => {
  const loaded = await registry()
  const catalog = await loaded.execute('role_capability_graph__list_role_packages', { query: '大模型应用工程师' }, executionContext)
  const selector = (catalog.result.payload as any).packages[0]
  const execution = await loaded.execute('role_capability_graph__search_role_knowledge', {
    packageId: selector.packageId, packageVersion: selector.packageVersion, snapshotId: selector.snapshotId,
    query: 'RAG 评测与知识库', topK: 5, includeCandidate: true,
  }, executionContext)
  assert.equal(execution.result.presentation?.renderer, 'role_capability_graph:role_cards')
  assert.ok(execution.result.objects?.length)
  const snapshotIds = new Set(execution.result.objects?.map(object => (object.value as any).snapshotId))
  const rootHashes = new Set(execution.result.objects?.map(object => (object.value as any).rootHash))
  assert.equal(snapshotIds.size, 1)
  assert.equal(rootHashes.size, 1)
  assert.match([...rootHashes][0], /^[a-f0-9]{64}$/)
  assert.equal((execution.result.payload as any).kind, 'search_results')
  assert.equal(typeof (execution.result.payload as any).coverage.complete, 'boolean')
})

test('graph, process, evidence and audit tools preserve package identity and renderer contracts', async () => {
  const loaded = await registry()
  const catalog = await loaded.execute('role_capability_graph__list_role_packages', { query: '大模型应用工程师' }, executionContext)
  const selector = (catalog.result.payload as any).packages[0]
  const exactSelector = { packageId: selector.packageId, packageVersion: selector.packageVersion, snapshotId: selector.snapshotId }
  const search = await loaded.execute('role_capability_graph__search_role_knowledge', { ...exactSelector, query: '构建 RAG', topK: 1 }, executionContext)
  const objectId = search.result.objects![0].objectId
  const graph = await loaded.execute('role_capability_graph__query_role_graph', { objectId, depth: 1, direction: 'both', maxNodes: 12 }, executionContext)
  assert.equal(graph.result.presentation?.renderer, 'role_capability_graph:role_graph')
  assert.ok(graph.result.objects?.some(object => object.objectType === 'role_relation'))
  assert.equal(graph.result.objects?.filter(object => object.objectType === 'role_object').length, (graph.result.payload as any).truncated ? 12 : graph.result.objects?.filter(object => object.objectType === 'role_object').length)
  const graphPayload = graph.result.payload as any
  assert.equal(graphPayload.grounding.relationFacts.length, graph.result.objects?.filter(object => object.objectType === 'role_relation').length)
  assert.ok(graphPayload.grounding.relationFacts.every((fact: any) => fact.relationId && fact.sourceId && fact.targetId && fact.type))
  assert.match(graphPayload.grounding.requiredDisclosure, /不得改名、反向或补造/)

  const task = await loaded.execute('role_capability_graph__search_role_knowledge', { ...exactSelector, query: '发布应用', topK: 8 }, executionContext)
  const processAnchor = task.result.objects!.find(object => ['task', 'scenario', 'event'].includes(String((object.value as any).category)))
  assert.ok(processAnchor)
  const process = await loaded.execute('role_capability_graph__trace_work_process', { objectId: processAnchor!.objectId, maxNodes: 20 }, executionContext)
  assert.equal(process.result.presentation?.renderer, 'role_capability_graph:process_forest')
  assert.match(String((process.result.payload as any).boundary), /不是企业真实事件日志/)

  const evidence = await loaded.execute('role_capability_graph__inspect_role_evidence', { objectIds: [objectId] }, executionContext)
  assert.equal(evidence.result.presentation?.renderer, 'role_capability_graph:evidence_panel')
  assert.ok(evidence.result.objects?.every(object => object.objectType === 'role_evidence'))

  const audit = await loaded.execute('role_capability_graph__audit_role_package', {}, executionContext)
  assert.equal(audit.result.presentation?.renderer, 'role_capability_graph:audit_panel')
  assert.equal((audit.result.payload as any).validation.valid, true)
})

test('package selectors fail closed instead of silently switching snapshots', async () => {
  const loaded = await registry()
  await assert.rejects(() => loaded.execute('role_capability_graph__audit_role_package', {
    snapshotId: 'snapshot:not-installed',
  }, executionContext), /role_package_not_found/)
})

test('role plugin implementation stays inside its package and host files contain no role-specific branches', () => {
  const hostSource = [
    resolve(process.cwd(), 'src/plugin-api.ts'),
    resolve(process.cwd(), 'src/PluginToolResultView.tsx'),
    resolve(process.cwd(), 'server/agent-runtime.ts'),
  ].map(path => readFileSync(path, 'utf8')).join('\n')
  assert.doesNotMatch(hostSource, /role_capability_graph|llm-app-engineer|process_forest/)
})

test('role object cards keep the source workspace lane interaction inside the plugin renderer', () => {
  const clientSource = readFileSync(resolve(process.cwd(), 'plugins/role_capability_graph/client.tsx'), 'utf8')
  const cssSource = readFileSync(resolve(process.cwd(), 'plugins/role_capability_graph/plugin.css'), 'utf8')

  assert.match(clientSource, /上下浏览语义维度，左右浏览同维度节点/)
  assert.match(clientSource, /clientWidth \* \.72/)
  assert.match(clientSource, /behavior: 'smooth'/)
  assert.match(clientSource, /向左浏览\$\{dimension\.label\}/)
  assert.match(clientSource, /向右浏览\$\{dimension\.label\}/)
  assert.match(cssSource, /scroll-snap-type:x proximity/)
  assert.match(cssSource, /flex:0 0 218px/)
  assert.match(cssSource, /flex-basis:292px/)
  assert.match(cssSource, /max-height:min\(68vh,720px\)/)
})

test('role product links use the desktop external URL bridge', () => {
  const clientSource = readFileSync(resolve(process.cwd(), 'plugins/role_capability_graph/client.tsx'), 'utf8')
  const desktopSource = readFileSync(resolve(process.cwd(), '../desktop/src-tauri/src/lib.rs'), 'utf8')
  assert.match(clientSource, /openExternalProductLink/)
  assert.match(clientSource, /invoke\('open_external_url'/)
  assert.match(desktopSource, /fn open_external_url/)
  assert.match(desktopSource, /starts_with\("http:\/\/"\) \|\| value\.starts_with\("https:\/\/"\)/)
})
