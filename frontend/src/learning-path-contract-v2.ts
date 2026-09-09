import type { LearningPathGraphContract, LearningPathSource, PathAudience, PathStage } from './learning-path-protocol.ts'

/** Source-graph contracts only. These objects contain no learner state or write authority. */
export const LEARNING_PATH_V2 = 'learnflow-learning-path/v2' as const
export const ROLE_LEARNING_ALIGNMENT_V2 = 'learnflow-role-learning-alignment/v2' as const
export const GRAPH_EXTENSION_PROPOSAL_V2 = 'learnflow-graph-extension-proposal/v2' as const
export const OFFICIAL_PATH_NAMESPACE = 'learnflow:official' as const

export type RolePackageRef = { packageId: string; packageVersion: string; snapshotId: string; rootHash: string }
export type PathSourceV2 = LearningPathSource | {
  id: string
  title: string
  kind: 'package_evidence'
  packageRef: RolePackageRef
  evidenceRefs: string[]
}
export type PathGraphRef = { graphId: string; revision: string }
export type PathNodeKey = { namespace: string; id: string }
export type PathNodeRef = PathNodeKey & { revision: number }
export type PathNodeKind = 'course' | 'skill_domain' | 'knowledge' | 'skill'
export type PathRelationKind = 'contains' | 'hard_prerequisite' | 'soft_prerequisite' | 'co_learning'
export type PathProvenance = {
  method: 'editorial_synthesis' | 'role_package_proposal'
  sourceRefs: string[]
  packageRef?: RolePackageRef
  evidenceRefs?: string[]
}
export type PathNodeV2 = PathNodeRef & {
  title: string
  summary: string
  aliases: string[]
  domains: string[]
  audiences: PathAudience[]
  stage: PathStage
  order: number
  ownership: { system: 'learnflow'; catalog: 'official' | 'graph_extension' }
  provenance: PathProvenance
} & (
  | { kind: 'course' | 'skill_domain'; atomic?: never }
  | { kind: 'knowledge' | 'skill'; atomic: { scopeNote: string; assessmentCriteria: string[] } }
)
export type PathEdgeV2 = {
  id: string
  from: PathNodeKey
  to: PathNodeKey
  kind: PathRelationKind
  rationale: string
  provenance: PathProvenance
}
export type LearningPathGraphV2 = PathGraphRef & {
  protocolVersion: typeof LEARNING_PATH_V2
  sources: PathSourceV2[]
  nodes: PathNodeV2[]
  edges: PathEdgeV2[]
}
export type RoleLearningAlignmentV2 = {
  protocolVersion: typeof ROLE_LEARNING_ALIGNMENT_V2
  packageRef: RolePackageRef
  graphRef: PathGraphRef
  bindings: Array<{
    id: string
    roleNodeId: string
    roleNodeKind: 'knowledge' | 'skill'
    target: PathNodeRef
    /** Direction: role requirement -> canonical learning node. Similarity is not equivalence. */
    relation: 'equivalent' | 'narrower_than' | 'related'
    requiredLevel: 'understand' | 'apply' | 'analyze' | 'evaluate' | 'create'
    context: string
    rationale: string
    evidenceRefs: string[]
  }>
}
export type RolePackageEvidenceContext = {
  packageRef: RolePackageRef
  evidenceIds: string[]
}
export type RoleAlignmentSource = RolePackageEvidenceContext & {
  nodes: Array<{ id: string; kind: 'knowledge' | 'skill' }>
}
/** Additive candidate batch. A valid proposal is not a persisted catalog revision. */
export type GraphExtensionProposalV2 = {
  protocolVersion: typeof GRAPH_EXTENSION_PROPOSAL_V2
  idempotencyKey: string
  baseGraphRef: PathGraphRef
  packageRef: RolePackageRef
  namespace: string
  sources: PathSourceV2[]
  nodes: PathNodeV2[]
  edges: PathEdgeV2[]
  /** Explicit learner-owned curriculum roots; never an inferred connection to an official course. */
  standaloneRoots?: PathNodeKey[]
}
export type ContractIssue = { path: string; code: string; message: string }
export type ContractValidation<T> = { valid: true; value: T; issues: [] } | { valid: false; issues: ContractIssue[] }

const stages = ['foundation', 'core', 'domain', 'advanced', 'research']
const audiences = ['vocational', 'undergraduate', 'graduate', 'self_directed']
const nodeKinds = ['course', 'skill_domain', 'knowledge', 'skill']
const edgeKinds = ['contains', 'hard_prerequisite', 'soft_prerequisite', 'co_learning']
const extensionNamespace = /^learnflow:extension:[a-z0-9][a-z0-9._-]*$/
export const pathNodeKey = (ref: PathNodeKey): string => JSON.stringify([ref.namespace, ref.id])
const sameGraph = (a: PathGraphRef, b: PathGraphRef) => a.graphId === b.graphId && a.revision === b.revision
const samePackage = (a: RolePackageRef, b: RolePackageRef) =>
  a.packageId === b.packageId && a.packageVersion === b.packageVersion && a.snapshotId === b.snapshotId && a.rootHash === b.rootHash

// Small strict boundary checker; no dependency on a browser, model, store or schema coercion.
class Check {
  issues: ContractIssue[] = []
  issue(path: string, code: string, message: string) { this.issues.push({ path, code, message }) }
  object(value: unknown, path: string, keys: string[]): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      this.issue(path, 'type', 'Expected an object'); return false
    }
    for (const key of Object.keys(value)) if (!keys.includes(key)) this.issue(`${path}.${key}`, 'unknown_field', 'Unknown field')
    return true
  }
  text(value: unknown, path: string) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()) this.issue(path, 'text', 'Expected a nonempty trimmed string')
  }
  choice(value: unknown, path: string, choices: readonly string[]) {
    if (typeof value !== 'string' || !choices.includes(value)) this.issue(path, 'enum', `Expected ${choices.join(' | ')}`)
  }
  integer(value: unknown, path: string, min: number) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) this.issue(path, 'integer', `Expected a safe integer >= ${min}`)
  }
  array(value: unknown, path: string, visit: (item: unknown, path: string) => void, min = 0) {
    if (!Array.isArray(value)) { this.issue(path, 'type', 'Expected an array'); return }
    if (value.length < min) this.issue(path, 'empty', `Expected at least ${min} item(s)`)
    value.forEach((item, i) => visit(item, `${path}[${i}]`))
  }
  strings(value: unknown, path: string, min = 0) {
    this.array(value, path, (v, p) => this.text(v, p), min)
    if (Array.isArray(value) && new Set(value).size !== value.length) this.issue(path, 'duplicate', 'Duplicate values')
  }
  result<T>(value: unknown): ContractValidation<T> {
    return this.issues.length ? { valid: false, issues: this.issues } : { valid: true, value: structuredClone(value) as T, issues: [] }
  }
}
function checkGraphRef(c: Check, value: unknown, path: string) {
  if (!c.object(value, path, ['graphId', 'revision'])) return
  c.text(value.graphId, `${path}.graphId`); c.text(value.revision, `${path}.revision`)
}
function checkPackage(c: Check, value: unknown, path: string) {
  if (!c.object(value, path, ['packageId', 'packageVersion', 'snapshotId', 'rootHash'])) return
  for (const key of ['packageId', 'packageVersion', 'snapshotId', 'rootHash']) c.text(value[key], `${path}.${key}`)
  if (typeof value.rootHash === 'string' && !/^[a-f0-9]{64}$/.test(value.rootHash)) c.issue(`${path}.rootHash`, 'hash', 'Expected a lowercase SHA-256 digest')
}
function checkKey(c: Check, value: unknown, path: string, versioned = false) {
  if (!c.object(value, path, versioned ? ['namespace', 'id', 'revision'] : ['namespace', 'id'])) return
  c.text(value.namespace, `${path}.namespace`); c.text(value.id, `${path}.id`)
  if (versioned) c.integer(value.revision, `${path}.revision`, 1)
}
function checkProvenance(c: Check, value: unknown, path: string) {
  if (!c.object(value, path, ['method', 'sourceRefs', 'packageRef', 'evidenceRefs'])) return
  c.choice(value.method, `${path}.method`, ['editorial_synthesis', 'role_package_proposal'])
  c.strings(value.sourceRefs, `${path}.sourceRefs`, 1)
  if (value.method === 'role_package_proposal' || value.packageRef !== undefined) checkPackage(c, value.packageRef, `${path}.packageRef`)
  if (value.method === 'role_package_proposal' || value.evidenceRefs !== undefined) c.strings(value.evidenceRefs, `${path}.evidenceRefs`, 1)
  if (value.method === 'editorial_synthesis' && (value.packageRef !== undefined || value.evidenceRefs !== undefined)) c.issue(path, 'provenance', 'Editorial records do not claim package provenance')
}
function checkSource(c: Check, value: unknown, path: string) {
  const keys = value && typeof value === 'object' && 'kind' in value && value.kind === 'package_evidence'
    ? ['id', 'title', 'kind', 'packageRef', 'evidenceRefs'] : ['id', 'title', 'institution', 'url', 'kind']
  if (!c.object(value, path, keys)) return
  if (value.kind === 'package_evidence') {
    c.text(value.id, `${path}.id`); c.text(value.title, `${path}.title`)
    checkPackage(c, value.packageRef, `${path}.packageRef`)
    c.strings(value.evidenceRefs, `${path}.evidenceRefs`, 1)
    return
  }
  for (const key of ['id', 'title', 'institution', 'url']) c.text(value[key], `${path}.${key}`)
  c.choice(value.kind, `${path}.kind`, ['framework', 'university', 'vocational', 'emerging'])
  try {
    const url = new URL(String(value.url))
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('url')
  } catch { c.issue(`${path}.url`, 'url', 'Expected an HTTP(S) source URL without credentials') }
}
function checkNode(c: Check, value: unknown, path: string) {
  if (!c.object(value, path, ['namespace', 'id', 'revision', 'kind', 'title', 'summary', 'aliases', 'domains', 'audiences', 'stage', 'order', 'ownership', 'provenance', 'atomic'])) return
  for (const key of ['namespace', 'id', 'title', 'summary']) c.text(value[key], `${path}.${key}`)
  c.integer(value.revision, `${path}.revision`, 1); c.integer(value.order, `${path}.order`, 0)
  c.choice(value.kind, `${path}.kind`, nodeKinds); c.choice(value.stage, `${path}.stage`, stages)
  c.strings(value.aliases, `${path}.aliases`); c.strings(value.domains, `${path}.domains`, 1)
  c.strings(value.audiences, `${path}.audiences`, 1)
  c.array(value.audiences, `${path}.audiences`, (v, p) => c.choice(v, p, audiences), 1)
  if (c.object(value.ownership, `${path}.ownership`, ['system', 'catalog'])) {
    c.choice(value.ownership.system, `${path}.ownership.system`, ['learnflow'])
    c.choice(value.ownership.catalog, `${path}.ownership.catalog`, ['official', 'graph_extension'])
    if (value.ownership.catalog === 'official' && value.namespace !== OFFICIAL_PATH_NAMESPACE) c.issue(path, 'namespace', 'Official nodes use the official namespace')
    if (value.ownership.catalog === 'graph_extension' && !extensionNamespace.test(String(value.namespace))) c.issue(path, 'namespace', 'Extensions need a scoped LearnFlow extension namespace')
  }
  checkProvenance(c, value.provenance, `${path}.provenance`)
  if (value.kind === 'knowledge' || value.kind === 'skill') {
    if (c.object(value.atomic, `${path}.atomic`, ['scopeNote', 'assessmentCriteria'])) {
      c.text(value.atomic.scopeNote, `${path}.atomic.scopeNote`)
      c.strings(value.atomic.assessmentCriteria, `${path}.atomic.assessmentCriteria`, 1)
    }
  } else if (value.atomic !== undefined) c.issue(`${path}.atomic`, 'granularity', 'Only knowledge/skill points have atomic assessment definitions')
}
function checkEdge(c: Check, value: unknown, path: string) {
  if (!c.object(value, path, ['id', 'from', 'to', 'kind', 'rationale', 'provenance'])) return
  c.text(value.id, `${path}.id`); c.text(value.rationale, `${path}.rationale`)
  checkKey(c, value.from, `${path}.from`); checkKey(c, value.to, `${path}.to`)
  c.choice(value.kind, `${path}.kind`, edgeKinds); checkProvenance(c, value.provenance, `${path}.provenance`)
}
function unique(c: Check, ids: string[], path: string) {
  if (new Set(ids).size !== ids.length) c.issue(path, 'duplicate', 'Duplicate identities')
}
function hasCycle(edges: PathEdgeV2[]): boolean {
  const next = new Map<string, Set<string>>(), degree = new Map<string, number>()
  for (const edge of edges) {
    const a = pathNodeKey(edge.from), b = pathNodeKey(edge.to)
    if (!degree.has(a)) degree.set(a, 0)
    if (!next.has(a)) next.set(a, new Set())
    if (!next.get(a)!.has(b)) {
      next.get(a)!.add(b); degree.set(b, (degree.get(b) ?? 0) + 1)
    }
  }
  const ready = [...degree].filter(([, d]) => !d).map(([key]) => key)
  let visited = 0
  for (let i = 0; i < ready.length; i++) {
    const key = ready[i]; visited++
    for (const to of next.get(key) ?? []) {
      degree.set(to, degree.get(to)! - 1)
      if (!degree.get(to)) ready.push(to)
    }
  }
  return visited !== degree.size
}
function checkGraphRelations(c: Check, graph: LearningPathGraphV2) {
  unique(c, graph.sources.map(s => s.id), '$.sources')
  unique(c, graph.nodes.map(pathNodeKey), '$.nodes')
  unique(c, graph.edges.map(e => e.id), '$.edges')
  unique(c, graph.edges.map(e => JSON.stringify([e.kind, ...(e.kind === 'co_learning'
    ? [pathNodeKey(e.from), pathNodeKey(e.to)].sort() : [pathNodeKey(e.from), pathNodeKey(e.to)])])), '$.edges')
  const sources = new Set(graph.sources.map(s => s.id)), nodes = new Map(graph.nodes.map(n => [pathNodeKey(n), n]))
  for (const [kind, entries] of [['nodes', graph.nodes], ['edges', graph.edges]] as const) {
    entries.forEach((entry, i) => {
      for (const ref of entry.provenance.sourceRefs) if (!sources.has(ref)) c.issue(`$.${kind}[${i}].provenance`, 'source_missing', `Unknown source ${ref}`)
    })
  }
  graph.edges.forEach((edge, i) => {
    const from = nodes.get(pathNodeKey(edge.from)), to = nodes.get(pathNodeKey(edge.to)), path = `$.edges[${i}]`
    if (!from || !to) c.issue(path, 'endpoint_missing', 'Edge endpoint does not exist in this snapshot')
    if (pathNodeKey(edge.from) === pathNodeKey(edge.to)) c.issue(path, 'self_edge', 'Self edges are not allowed')
    if (edge.kind === 'contains' && from && to) {
      if (!['course', 'skill_domain'].includes(from.kind) || to.kind === 'course') c.issue(path, 'containment_kind', 'A course/skill domain may contain skill domains or knowledge/skill points')
    }
  })
  if (hasCycle(graph.edges.filter(e => e.kind === 'contains'))) c.issue('$.edges', 'containment_cycle', 'Containment must be acyclic')
  if (hasCycle(graph.edges.filter(e => e.kind === 'hard_prerequisite' || e.kind === 'soft_prerequisite'))) c.issue('$.edges', 'prerequisite_cycle', 'Prerequisites must be acyclic; contains and co_learning do not imply order')
}
export function validateLearningPathGraphV2(input: unknown): ContractValidation<LearningPathGraphV2> {
  const c = new Check()
  if (c.object(input, '$', ['protocolVersion', 'graphId', 'revision', 'sources', 'nodes', 'edges'])) {
    c.choice(input.protocolVersion, '$.protocolVersion', [LEARNING_PATH_V2])
    c.text(input.graphId, '$.graphId'); c.text(input.revision, '$.revision')
    c.array(input.sources, '$.sources', (v, p) => checkSource(c, v, p), 1)
    c.array(input.nodes, '$.nodes', (v, p) => checkNode(c, v, p), 1)
    c.array(input.edges, '$.edges', (v, p) => checkEdge(c, v, p))
  }
  if (!c.issues.length) checkGraphRelations(c, input as LearningPathGraphV2)
  return c.result(input)
}

/** Explicit v1 migration: course/domain granularity is supplied, never guessed from similarity. */
export function upgradeOfficialPathGraph(
  input: LearningPathGraphContract, sources: PathSourceV2[], graphRef: PathGraphRef,
  definitions: Record<string, { kind: 'course' | 'skill_domain'; revision: number }>,
): LearningPathGraphV2 {
  if (input.protocolVersion !== 'learnflow-learning-path/v1' || input.nodes.some(n => n.origin !== 'official') || input.edges.some(e => e.origin !== 'official')) throw new Error('Only the official v1 source graph can be migrated')
  if (Object.keys(definitions).length !== input.nodes.length || input.nodes.some(n => !definitions[n.id])) throw new Error('Every official node needs an explicit kind and revision')
  const graph: LearningPathGraphV2 = {
    protocolVersion: LEARNING_PATH_V2, graphId: graphRef.graphId, revision: graphRef.revision, sources,
    nodes: input.nodes.map(({ origin: _origin, sourceRefs, sourceProposalId: _proposal, ...node }) => ({
      ...node, namespace: OFFICIAL_PATH_NAMESPACE, revision: definitions[node.id].revision, kind: definitions[node.id].kind,
      ownership: { system: 'learnflow', catalog: 'official' },
      provenance: { method: 'editorial_synthesis', sourceRefs },
    })),
    edges: input.edges.map(({ origin: _origin, from, to, ...edge }) => ({
      ...edge, from: { namespace: OFFICIAL_PATH_NAMESPACE, id: from }, to: { namespace: OFFICIAL_PATH_NAMESPACE, id: to },
      provenance: { method: 'editorial_synthesis', sourceRefs: [...new Set([
        ...(input.nodes.find(n => n.id === from)?.sourceRefs ?? []), ...(input.nodes.find(n => n.id === to)?.sourceRefs ?? []),
      ])] },
    })),
  }
  const result = validateLearningPathGraphV2(graph)
  if (!result.valid) throw new Error(JSON.stringify(result.issues))
  return result.value
}

export function validateRoleLearningAlignmentV2(input: unknown, graph: LearningPathGraphV2, source: RoleAlignmentSource): ContractValidation<RoleLearningAlignmentV2> {
  const c = new Check()
  const checkedGraph = validateLearningPathGraphV2(graph)
  if (!checkedGraph.valid) return { valid: false, issues: checkedGraph.issues.map(i => ({ ...i, path: `graph${i.path}` })) }
  if (c.object(input, '$', ['protocolVersion', 'packageRef', 'graphRef', 'bindings'])) {
    c.choice(input.protocolVersion, '$.protocolVersion', [ROLE_LEARNING_ALIGNMENT_V2])
    checkPackage(c, input.packageRef, '$.packageRef'); checkGraphRef(c, input.graphRef, '$.graphRef')
    c.array(input.bindings, '$.bindings', (v, p) => {
      if (!c.object(v, p, ['id', 'roleNodeId', 'roleNodeKind', 'target', 'relation', 'requiredLevel', 'context', 'rationale', 'evidenceRefs'])) return
      for (const key of ['id', 'roleNodeId', 'context', 'rationale']) c.text(v[key], `${p}.${key}`)
      c.choice(v.roleNodeKind, `${p}.roleNodeKind`, ['knowledge', 'skill'])
      checkKey(c, v.target, `${p}.target`, true)
      c.choice(v.relation, `${p}.relation`, ['equivalent', 'narrower_than', 'related'])
      c.choice(v.requiredLevel, `${p}.requiredLevel`, ['understand', 'apply', 'analyze', 'evaluate', 'create'])
      c.strings(v.evidenceRefs, `${p}.evidenceRefs`, 1)
    })
  }
  if (!c.issues.length) {
    const alignment = input as RoleLearningAlignmentV2
    if (!sameGraph(alignment.graphRef, graph)) c.issue('$.graphRef', 'stale_graph', 'Graph identity/revision mismatch')
    if (!samePackage(alignment.packageRef, source.packageRef)) c.issue('$.packageRef', 'package_mismatch', 'Immutable package reference mismatch')
    unique(c, alignment.bindings.map(b => b.id), '$.bindings')
    unique(c, alignment.bindings.map(b => JSON.stringify([b.roleNodeId, pathNodeKey(b.target)])), '$.bindings')
    const nodes = new Map(graph.nodes.map(n => [pathNodeKey(n), n])), roles = new Map(source.nodes.map(n => [n.id, n.kind])), evidence = new Set(source.evidenceIds)
    alignment.bindings.forEach((binding, i) => {
      const p = `$.bindings[${i}]`, node = nodes.get(pathNodeKey(binding.target))
      if (roles.get(binding.roleNodeId) !== binding.roleNodeKind) c.issue(p, 'role_node', 'Role node must exist with the declared atomic kind')
      if (!node || node.revision !== binding.target.revision) c.issue(p, 'target_revision', 'Target node identity/revision mismatch')
      if (binding.relation === 'equivalent' && node?.kind !== binding.roleNodeKind) c.issue(p, 'granularity', 'Equivalence requires a matching knowledge/skill kind, not a course or domain')
      for (const id of binding.evidenceRefs) if (!evidence.has(id)) c.issue(p, 'evidence_missing', `Unknown package evidence ${id}`)
    })
  }
  return c.result(input)
}

export function validateGraphExtensionProposalV2(input: unknown, baseGraph: LearningPathGraphV2, source: RolePackageEvidenceContext): ContractValidation<GraphExtensionProposalV2> {
  const c = new Check(), base = validateLearningPathGraphV2(baseGraph)
  if (!base.valid) return { valid: false, issues: base.issues.map(i => ({ ...i, path: `base${i.path}` })) }
  if (c.object(input, '$', ['protocolVersion', 'idempotencyKey', 'baseGraphRef', 'packageRef', 'namespace', 'sources', 'nodes', 'edges', 'standaloneRoots'])) {
    c.choice(input.protocolVersion, '$.protocolVersion', [GRAPH_EXTENSION_PROPOSAL_V2])
    c.text(input.idempotencyKey, '$.idempotencyKey'); checkGraphRef(c, input.baseGraphRef, '$.baseGraphRef')
    checkPackage(c, input.packageRef, '$.packageRef')
    if (typeof input.namespace !== 'string' || !extensionNamespace.test(input.namespace)) c.issue('$.namespace', 'namespace', 'Expected a scoped LearnFlow extension namespace')
    c.array(input.sources, '$.sources', (v, p) => checkSource(c, v, p))
    c.array(input.nodes, '$.nodes', (v, p) => checkNode(c, v, p), 1)
    // A standalone course can be proposed without inventing prerequisite/containment edges.
    c.array(input.edges, '$.edges', (v, p) => checkEdge(c, v, p), Array.isArray(input.standaloneRoots) && input.standaloneRoots.length ? 0 : 1)
    if (input.standaloneRoots !== undefined) c.array(input.standaloneRoots, '$.standaloneRoots', (v, p) => checkKey(c, v, p), 1)
  }
  if (!c.issues.length) {
    const proposal = input as GraphExtensionProposalV2
    if (!sameGraph(proposal.baseGraphRef, baseGraph)) c.issue('$.baseGraphRef', 'stale_graph', 'Rebase the proposal against the current graph revision')
    if (!samePackage(proposal.packageRef, source.packageRef)) c.issue('$.packageRef', 'package_mismatch', 'Immutable package reference mismatch')
    const evidence = new Set(source.evidenceIds)
    proposal.sources.forEach((entry, i) => {
      if (entry.kind !== 'package_evidence') return
      if (!samePackage(entry.packageRef, proposal.packageRef)) c.issue(`$.sources[${i}]`, 'package_mismatch', 'Source package reference mismatch')
      for (const id of entry.evidenceRefs) if (!evidence.has(id)) c.issue(`$.sources[${i}]`, 'evidence_missing', `Unknown package evidence ${id}`)
    })
    const added = new Set(proposal.nodes.map(pathNodeKey))
    proposal.nodes.forEach((node, i) => {
      if (node.namespace !== proposal.namespace || node.ownership.catalog !== 'graph_extension' || node.revision !== 1) c.issue(`$.nodes[${i}]`, 'extension_scope', 'New nodes must use this extension namespace, catalog and initial revision')
    })
    for (const item of [...proposal.nodes, ...proposal.edges]) {
      if (item.provenance.method !== 'role_package_proposal' || !item.provenance.packageRef || !samePackage(item.provenance.packageRef, proposal.packageRef)) c.issue('$.packageRef', 'provenance', 'Every addition must carry the same immutable package provenance')
      for (const id of item.provenance.evidenceRefs ?? []) if (!evidence.has(id)) c.issue('$.nodes/edges', 'evidence_missing', `Unknown package evidence ${id}`)
    }
    proposal.edges.forEach((edge, i) => {
      if (!added.has(pathNodeKey(edge.from)) && !added.has(pathNodeKey(edge.to))) c.issue(`$.edges[${i}]`, 'existing_edge_edit', 'An extension edge must touch a new node')
    })
    // Standalone roots require an explicit proposal. Atomic points cannot become unanchored roots.
    const roots = proposal.standaloneRoots || []
    unique(c, roots.map(pathNodeKey), '$.standaloneRoots')
    for (const root of roots) {
      const node = proposal.nodes.find(n => pathNodeKey(n) === pathNodeKey(root))
      if (!node || node.namespace !== proposal.namespace || !['course', 'skill_domain'].includes(node.kind)
        || node.ownership.catalog !== 'graph_extension' || proposal.edges.some(e => e.kind === 'contains' && pathNodeKey(e.to) === pathNodeKey(root))) {
        c.issue('$.standaloneRoots', 'root_scope', 'Standalone roots must be new scoped curriculum containers without a parent')
      }
    }
    // Every addition reaches the existing catalog or an explicitly proposed learner-owned root.
    const reached = new Set(baseGraph.nodes.map(pathNodeKey)), neighbors = new Map<string, string[]>()
    for (const edge of proposal.edges) {
      const a = pathNodeKey(edge.from), b = pathNodeKey(edge.to)
      neighbors.set(a, [...(neighbors.get(a) ?? []), b]); neighbors.set(b, [...(neighbors.get(b) ?? []), a])
    }
    const queue = [...reached]
    for (let i = 0; i < queue.length; i++) for (const key of neighbors.get(queue[i]) ?? []) if (!reached.has(key)) { reached.add(key); queue.push(key) }
    const contained = new Set(roots.map(pathNodeKey)), children = new Map<string, string[]>()
    for (const edge of proposal.edges) if (edge.kind === 'contains') {
      const from = pathNodeKey(edge.from)
      children.set(from, [...(children.get(from) ?? []), pathNodeKey(edge.to)])
    }
    const rootQueue = [...contained]
    for (let i = 0; i < rootQueue.length; i++) for (const key of children.get(rootQueue[i]) ?? []) if (!contained.has(key)) { contained.add(key); rootQueue.push(key) }
    for (const key of contained) reached.add(key)
    for (const key of added) if (!reached.has(key)) c.issue('$.nodes', 'unanchored', `New node ${key} is disconnected from the catalog`)
    const combined = validateLearningPathGraphV2({ ...baseGraph, sources: [...baseGraph.sources, ...proposal.sources], nodes: [...baseGraph.nodes, ...proposal.nodes], edges: [...baseGraph.edges, ...proposal.edges] })
    if (!combined.valid) c.issues.push(...combined.issues)
  }
  return c.result(input)
}
