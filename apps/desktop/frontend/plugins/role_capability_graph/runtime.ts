import { checkedRolePackageBundle, type RolePackageBundle } from '../../../../../packages/learning-client/src/role-packages/bundle.ts'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LEARNFLOW_PLUGIN_OBJECT_VERSION,
  versionedPluginModuleUrl,
  type LearnFlowPluginObject,
  type PluginJson,
  type PluginToolResult,
} from '../../src/plugin-api.ts'
import { rolePackageInstallRoot } from './package-file.ts'
const {
  ROLE_CAPABILITY_PLUGIN,
  ROLE_OBJECT_SCHEMA_VERSION,
  ROLE_RENDERERS,
} = await import(versionedPluginModuleUrl('./shared.ts', import.meta.url)) as typeof import('./shared.ts')

type JsonObject = Record<string, PluginJson>

type StaticPackageManifest = {
  packageProtocol: string
  protocolVersion: string
  packageId: string
  packageVersion: string
  snapshotId: string
  snapshotAsOf: string
  roleTitle: string
  visibility: string
  evidencePolicy: string
  entrypoints: Record<string, string>
  hashes: Record<string, string>
  rootHash: string
}

type RoleNode = JsonObject & {
  id: string
  type: string
  label: string
  summary: string
  aliases?: string[]
  lifecycle?: string
  confidence?: number
  evidenceBindingIds?: string[]
  evidenceSegmentIds?: string[]
  ring?: number
}

type RoleRelation = JsonObject & {
  id: string
  type: string
  source?: string
  target?: string
  processNodeId?: string
  semanticNodeId?: string
  confidence?: number
  evidenceBindingIds?: string[]
  evidenceSegmentIds?: string[]
}

type ProcessScenario = JsonObject & {
  id: string
  label: string
  summary: string
  lifecycle?: string
  knowledgeState?: string
  taskRefs?: string[]
  evidenceBindingIds?: string[]
  evidenceSegmentIds?: string[]
}

type ProcessNode = RoleNode & {
  scenarioId: string
  kind: string
  knowledgeState?: string
  sequenceHint?: number
  taskRefs?: string[]
}

type SourceAsset = JsonObject & { id: string; title: string; publisher?: string; locator?: string }
type SourceSegment = JsonObject & { id: string; sourceId: string; text: string; locator?: string }
type EvidenceBinding = JsonObject & {
  id: string
  targetId: string
  sourceId: string
  segmentId: string
  confidence?: number
  strength?: string
  support?: string
  assertionType?: string
  limitations?: string[]
}

type RoleViewSection = JsonObject & {
  id: string
  title: string
  summary: string
  status?: string
  itemIds: string[]
  evidenceBindingIds?: string[]
}

type RetrievalEntry = JsonObject & {
  id: string
  snapshotId: string
  targetId: string
  text: string
}

type ObjectIndexEntry = JsonObject & {
  id: string
  kind: string
  label: string
  summary: string
  type: string
}

type LoadedRolePackage = {
  manifest: StaticPackageManifest
  semantic: { nodes: RoleNode[]; edges: RoleRelation[]; claims: JsonObject[] }
  process: { scenarios: ProcessScenario[]; nodes: ProcessNode[]; edges: RoleRelation[]; bridges: RoleRelation[] }
  sources: { assets: SourceAsset[]; segments: SourceSegment[]; evidenceBindings: EvidenceBinding[] }
  validation: JsonObject
  snapshot: JsonObject
  views: { sections: RoleViewSection[] }
  retrieval: RetrievalEntry[]
  objectIndex: ObjectIndexEntry[]
  referenceMigrations: JsonObject[]
  objects: Map<string, RoleNode | ProcessScenario | ProcessNode>
  relations: RoleRelation[]
  outgoing: Map<string, RoleRelation[]>
  incoming: Map<string, RoleRelation[]>
  assets: Map<string, SourceAsset>
  segments: Map<string, SourceSegment>
  bindingsByTarget: Map<string, EvidenceBinding[]>
  source: RolePackageSource
}

export type PackageSelector = {
  packageId?: string
  packageVersion?: string
  snapshotId?: string
  /**
   * Optional content pin. A reference fixes the full immutable identity
   * (packageId + packageVersion + snapshotId + rootHash); carrying the hash
   * through later reads keeps them from silently resolving to different bytes
   * that happen to share the same id, version and snapshot.
   */
  rootHash?: string
}

const PACKAGE_ROOT = fileURLToPath(new URL('./data/packages', import.meta.url))
const MAX_OBJECT_IDS = 25
const MAX_SEARCH_RESULTS = 12
const MAX_GRAPH_NODES = 28
const MAX_PROCESS_NODES = 36
const MAX_EVIDENCE_TARGETS = 8
const RADAR_RING_LIMITS = new Map([[0, 1], [1, 6], [2, 6], [3, 5], [4, 5], [5, 4]])
const DEFAULT_ROLE_AGENT_BASE_URL = 'http://localhost:3000'

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`role_package_invalid:${label}`)
  return value as JsonObject
}

function readJson(path: string) {
  const raw = readFileSync(path, 'utf8')
  return { raw, value: JSON.parse(raw) as unknown }
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

export type RolePackageSource = {
  root: string
  sourceKind: 'official_builtin' | 'reviewed_public' | 'owner_private' | 'role_agent_simulation' | 'installed'
  accessScope: 'official' | 'reviewed_public' | 'owner_private' | 'simulation_all' | 'installed'
}

export function defaultPackageSources(): RolePackageSource[] {
  const sources: RolePackageSource[] = [{ root: PACKAGE_ROOT, sourceKind: 'official_builtin', accessScope: 'official' }]
  const explicitRoots = (process.env.LEARNFLOW_ROLE_AGENT_PACKAGE_ROOTS || '').split(delimiter).filter(Boolean)
  const inferredRoots = process.env.NODE_ENV === 'production' ? [] : [
    fileURLToPath(new URL('../../../../role-atlas/packages', import.meta.url)),
  ]
  for (const root of [...explicitRoots, ...inferredRoots]) {
    const absolute = resolve(root)
    if (existsSync(absolute) && !sources.some(source => resolve(source.root) === absolute)) {
      sources.push({ root: absolute, sourceKind: 'role_agent_simulation', accessScope: 'simulation_all' })
    }
  }
  // Packages installed at runtime land outside the bundled root. Without this
  // source they would be on disk yet invisible to resolve(), which is exactly
  // how a pinned reference ends up failing with role_package_not_found.
  const installRoot = rolePackageInstallRoot()
  if (installRoot !== resolve(PACKAGE_ROOT) && existsSync(installRoot)
    && !sources.some(source => resolve(source.root) === installRoot)) {
    sources.push({ root: installRoot, sourceKind: 'installed', accessScope: 'installed' })
  }
  return sources
}

function discoverManifests(root: string) {
  const manifests: string[] = []
  if (!existsSync(root)) return manifests
  const visit = (directory: string, depth: number) => {
    if (depth > 4 || manifests.length >= 2_000) return
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const path = join(directory, entry.name)
      if (entry.isFile() && entry.name === 'manifest.json') manifests.push(path)
      else if (entry.isDirectory()) visit(path, depth + 1)
    }
  }
  visit(root, 0)
  return manifests.sort()
}

function loadPackage(manifestPath: string, source: RolePackageSource): LoadedRolePackage {
  const manifest = asObject(readJson(manifestPath).value, 'manifest') as unknown as StaticPackageManifest
  return loadPackageContent(manifest, path => readJson(join(dirname(manifestPath), path)), source)
}

function loadPackageContent(manifest: StaticPackageManifest, read: (path: string) => { raw: string; value: unknown }, source: RolePackageSource): LoadedRolePackage {
  if (manifest.packageProtocol !== 'static-role-package' || !manifest.packageId || !manifest.snapshotId || !manifest.rootHash) {
    throw new Error(`role_package_invalid:${manifest.packageId}`)
  }
  function componentValue(entrypoint: string, label: string) {
    const filename = manifest.entrypoints[entrypoint]
    if (!filename || filename.includes('..') || filename.startsWith('/')) throw new Error(`role_package_invalid:${label}_entrypoint`)
    const loaded = read(filename)
    if (manifest.hashes[filename] !== sha256(loaded.raw)) throw new Error(`role_package_hash_mismatch:${filename}`)
    return loaded.value as PluginJson
  }
  const component = (entrypoint: string, label: string) => asObject(componentValue(entrypoint, label), label)
  const semantic = component('semanticGraph', 'semantic') as unknown as LoadedRolePackage['semantic']
  const process = component('workProcessForest', 'process') as unknown as LoadedRolePackage['process']
  const sources = component('sources', 'sources') as unknown as LoadedRolePackage['sources']
  const validation = component('validation', 'validation')
  const snapshot = component('snapshot', 'snapshot')
  const views = component('views', 'views') as unknown as LoadedRolePackage['views']
  const retrieval = componentValue('retrieval', 'retrieval') as RetrievalEntry[]
  const objectIndex = componentValue('objectIndex', 'object_index') as ObjectIndexEntry[]
  const referenceMigrations = componentValue('referenceMigrations', 'reference_migrations') as JsonObject[]
  if (!Array.isArray(semantic.nodes) || !Array.isArray(semantic.edges)
    || !Array.isArray(process.scenarios) || !Array.isArray(process.nodes) || !Array.isArray(process.edges)
    || !Array.isArray(sources.assets) || !Array.isArray(sources.segments) || !Array.isArray(sources.evidenceBindings)
    || !Array.isArray(views.sections) || !Array.isArray(retrieval) || !Array.isArray(objectIndex)
    || !Array.isArray(referenceMigrations)) {
    throw new Error(`role_package_invalid:${manifest.packageId}`)
  }
  const objects = new Map<string, RoleNode | ProcessScenario | ProcessNode>()
  ;[...semantic.nodes, ...process.scenarios, ...process.nodes].forEach(object => {
    if (!object.id || objects.has(object.id)) throw new Error(`role_package_duplicate_object:${object.id}`)
    objects.set(object.id, object)
  })
  const relations = [...semantic.edges, ...process.edges, ...process.bridges]
  const outgoing = new Map<string, RoleRelation[]>()
  const incoming = new Map<string, RoleRelation[]>()
  relations.forEach(relation => {
    const source = relation.source || relation.processNodeId
    const target = relation.target || relation.semanticNodeId
    if (!source || !target || !objects.has(source) || !objects.has(target)) throw new Error(`role_package_relation_invalid:${relation.id}`)
    outgoing.set(source, [...(outgoing.get(source) || []), relation])
    incoming.set(target, [...(incoming.get(target) || []), relation])
  })
  const assets = new Map(sources.assets.map(asset => [asset.id, asset]))
  const segments = new Map(sources.segments.map(segment => [segment.id, segment]))
  const bindingsByTarget = new Map<string, EvidenceBinding[]>()
  sources.evidenceBindings.forEach(binding => bindingsByTarget.set(binding.targetId, [
    ...(bindingsByTarget.get(binding.targetId) || []), binding,
  ]))
  return {
    manifest, semantic, process, sources, validation, snapshot, views, retrieval, objectIndex, referenceMigrations,
    objects, relations, outgoing, incoming, assets, segments, bindingsByTarget, source,
  }
}

function normalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function tokens(value: string) {
  const text = normalize(value)
  const result = new Set<string>()
  for (const word of value.toLocaleLowerCase().match(/[a-z0-9][a-z0-9._:+-]*/g) || []) result.add(word)
  for (const character of text) result.add(character)
  for (let index = 0; index < text.length - 1; index += 1) result.add(text.slice(index, index + 2))
  return [...result]
}

function roleAgentResearchUrl(query: string) {
  const configured = process.env.LEARNFLOW_ROLE_AGENT_BASE_URL || DEFAULT_ROLE_AGENT_BASE_URL
  let base: URL
  try {
    base = new URL(configured)
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error('unsupported protocol')
  } catch {
    base = new URL(DEFAULT_ROLE_AGENT_BASE_URL)
  }
  const target = new URL('/projects/new', base)
  target.searchParams.set('role', query.trim())
  return target.toString()
}

function graphHubBrowseUrl(query: string) {
  const configured = process.env.LEARNFLOW_GRAPH_HUB_BASE_URL || process.env.LEARNFLOW_ROLE_AGENT_BASE_URL || DEFAULT_ROLE_AGENT_BASE_URL
  let base: URL
  try {
    base = new URL(configured)
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error('unsupported protocol')
  } catch {
    base = new URL(DEFAULT_ROLE_AGENT_BASE_URL)
  }
  const target = new URL('/hub', base)
  if (query.trim()) target.searchParams.set('q', query.trim())
  return target.toString()
}

function packageMatchesQuery(pkg: LoadedRolePackage, query: string) {
  const needle = normalize(query)
  if (!needle) return true
  const root = pkg.semantic.nodes.find(item => item.type === 'market_role')
  const names = [pkg.manifest.roleTitle, pkg.manifest.packageId, root?.label, ...(root?.aliases || [])]
    .filter((value): value is string => Boolean(value))
    .map(normalize)
    .filter(Boolean)
  return names.some(name => needle === name || needle.includes(name) || name.includes(needle))
}

function relationEndpoints(relation: RoleRelation) {
  return {
    source: relation.source || relation.processNodeId || '',
    target: relation.target || relation.semanticNodeId || '',
  }
}

function objectKind(object: RoleNode | ProcessScenario | ProcessNode) {
  if ('kind' in object && typeof object.kind === 'string') return object.kind
  if ('taskRefs' in object && !('scenarioId' in object) && Array.isArray(object.taskRefs)) return 'scenario'
  return typeof object.type === 'string' ? object.type : 'object'
}

function jsonRecord(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

export class RolePackageRuntime {
  readonly packages: readonly LoadedRolePackage[]
  readonly discoveryIssues: readonly string[]

  constructor(root: string | RolePackageSource[] | { bundles: RolePackageBundle[] } = defaultPackageSources()) {
    if (typeof root === 'object' && !Array.isArray(root)) {
      this.packages = root.bundles.map(value => {
        const bundle = checkedRolePackageBundle(value)
        return loadPackageContent(bundle.manifest as unknown as StaticPackageManifest,
          path => ({ raw: bundle.components[path], value: JSON.parse(bundle.components[path]) }),
          { root: 'authenticated-gateway', sourceKind: bundle.manifest.visibility === 'private' ? 'owner_private' : 'installed',
            accessScope: bundle.manifest.visibility === 'private' ? 'owner_private' : 'installed' })
      })
      this.discoveryIssues = []
      return
    }
    const sources: RolePackageSource[] = typeof root === 'string'
      ? [{ root: resolve(root), sourceKind: 'installed', accessScope: 'installed' }]
      : root.map(source => ({ ...source, root: resolve(source.root) }))
    const releases = new Map<string, LoadedRolePackage>()
    const discoveryIssues: string[] = []
    for (const source of sources) {
      for (const manifestPath of discoverManifests(source.root)) {
        let pkg: LoadedRolePackage
        try { pkg = loadPackage(manifestPath, source) }
        catch (error) {
          if (source.sourceKind !== 'role_agent_simulation') throw error
          discoveryIssues.push(`${manifestPath}: ${error instanceof Error ? error.message : 'invalid package'}`)
          continue
        }
        const key = `${pkg.manifest.packageId}@${pkg.manifest.packageVersion}`
        const existing = releases.get(key)
        if (existing && existing.manifest.rootHash !== pkg.manifest.rootHash) {
          if (source.sourceKind !== 'role_agent_simulation') throw new Error(`role_package_version_conflict:${key}`)
          discoveryIssues.push(`${manifestPath}: role_package_version_conflict:${key}`)
          continue
        }
        if (!existing) releases.set(key, pkg)
      }
    }
    this.packages = [...releases.values()].sort((left, right) => left.manifest.roleTitle.localeCompare(right.manifest.roleTitle)
      || left.manifest.packageVersion.localeCompare(right.manifest.packageVersion))
    this.discoveryIssues = discoveryIssues.slice(0, 20)
    if (!this.packages.length) throw new Error('role_package_unavailable:no static packages were found')
  }

  resolve(selector: PackageSelector) {
    const matches = this.packages.filter(item => (
      (!selector.packageId || item.manifest.packageId === selector.packageId)
      && (!selector.packageVersion || item.manifest.packageVersion === selector.packageVersion)
      && (!selector.snapshotId || item.manifest.snapshotId === selector.snapshotId)
    ))
    if (matches.length !== 1) {
      throw this.resolutionFailure(selector, matches.length ? 'ambiguous' : 'missing')
    }
    const match = matches[0]
    // Matching id + version + snapshot is not enough to claim the pinned
    // content: those three fields describe a release slot, not its bytes. When
    // the caller carries a rootHash, an installed package with different
    // content must fail loudly instead of quietly answering from other bytes.
    if (selector.rootHash && match.manifest.rootHash !== selector.rootHash) {
      throw this.resolutionFailure(selector, 'content')
    }
    return match
  }

  /**
   * A pinned reference can only resolve against packages this runtime can see.
   * A bare "not installed" reads like a transient fault, so the caller retries
   * other body-dependent tools and loops; the model cannot tell a missing本体
   * from a hiccup. Naming what IS installed and how to install the rest makes
   * the failure terminal: the next useful action is an operator command or a
   * different choice, never another read.
   *
   * Only identities the runtime already exposes through list_role_packages are
   * repeated here, so this adds no disclosure.
   */
  private resolutionFailure(selector: PackageSelector, reason: 'missing' | 'content' | 'ambiguous') {
    const code = reason === 'content' ? 'role_package_root_hash_mismatch'
      : reason === 'ambiguous' ? 'role_package_ambiguous' : 'role_package_not_found'
    const requested = [selector.packageId, selector.packageVersion, selector.snapshotId].filter(Boolean).join(' / ') || '(未指定)'
    const installed = this.packages.length
      ? this.packages.map(item => `${item.manifest.packageId}@${item.manifest.packageVersion} (${item.manifest.snapshotId})`).join('、')
      : '无'
    const guidance = reason === 'content'
      ? '本机存在同 id/版本/快照的岗位包，但内容哈希不同，不能沿用旧引用继续读取。'
      : reason === 'ambiguous'
        ? '选择器同时匹配多个已安装版本，请补充 packageId、packageVersion 或 snapshotId 后重试。'
        : '该不可变版本在本机不可用，重试读取不会成功。请让运维执行 npm run role:import-release 安装该版本，或改选下方已安装版本。'
    return new Error(`${code}:${guidance} 请求=${requested}；本机已安装=${installed}；安装完成后需重启 LearnFlow 前端以重建岗位包索引。`)
  }

  private hasSelector(selector: PackageSelector) {
    return Boolean(selector.packageId || selector.packageVersion || selector.snapshotId || selector.rootHash)
  }

  private resolveForQuery(selector: PackageSelector, query: string) {
    if (this.hasSelector(selector)) return this.resolve(selector)
    const matches = this.packages.filter(pkg => packageMatchesQuery(pkg, query))
    if (matches.length === 1) return matches[0]
    if (!matches.length) throw new Error('role_package_not_matched:list role packages with the requested role and use the Role Atlas handoff when none match')
    throw new Error('role_package_ambiguous:list role packages with the requested role and provide an exact package or snapshot selector')
  }

  private resolveForObjects(selector: PackageSelector, objectIds: string[]) {
    if (this.hasSelector(selector) || this.packages.length === 1) return this.resolve(selector)
    const ids = new Set(objectIds)
    const matches = this.packages.filter(pkg => [...ids].every(id => pkg.objects.has(id)))
    if (matches.length === 1) return matches[0]
    throw new Error(matches.length
      ? 'role_package_ambiguous:the object ids exist in multiple packages; pin a snapshot'
      : 'role_object_not_found:no installed package contains all requested object ids')
  }

  descriptor(pkg: LoadedRolePackage) {
    return {
      packageId: pkg.manifest.packageId,
      packageVersion: pkg.manifest.packageVersion,
      snapshotId: pkg.manifest.snapshotId,
      snapshotAsOf: pkg.manifest.snapshotAsOf,
      rootHash: pkg.manifest.rootHash,
      roleTitle: pkg.manifest.roleTitle,
      evidencePolicy: pkg.manifest.evidencePolicy,
      sourceKind: pkg.source.sourceKind,
      accessScope: pkg.source.accessScope,
    }
  }

  private pluginObject(pkg: LoadedRolePackage, objectType: string, objectId: string, label: string, category: string, data: unknown): LearnFlowPluginObject {
    return {
      protocol: LEARNFLOW_PLUGIN_OBJECT_VERSION,
      pluginId: ROLE_CAPABILITY_PLUGIN.id,
      objectType,
      objectId,
      schemaVersion: ROLE_OBJECT_SCHEMA_VERSION,
      label,
      value: {
        ...this.descriptor(pkg),
        category,
        data: jsonRecord(data),
      },
    }
  }

  private nodeObject(pkg: LoadedRolePackage, object: RoleNode | ProcessScenario | ProcessNode) {
    return this.pluginObject(pkg, 'role_object', object.id, object.label, objectKind(object), object)
  }

  private radarNodeObject(pkg: LoadedRolePackage, object: RoleNode) {
    return this.pluginObject(pkg, 'role_object', object.id, object.label, objectKind(object), {
      id: object.id,
      type: object.type,
      label: object.label,
      summary: object.summary,
      ring: object.ring || 0,
      lifecycle: object.lifecycle || 'snapshot',
      confidence: object.confidence,
    })
  }

  private relationObject(pkg: LoadedRolePackage, relation: RoleRelation) {
    return this.pluginObject(pkg, 'role_relation', relation.id, relation.type, relation.type, {
      ...relation,
      ...relationEndpoints(relation),
    })
  }


  private radarRelationObject(pkg: LoadedRolePackage, relation: RoleRelation) {
    const endpoints = relationEndpoints(relation)
    return this.pluginObject(pkg, 'role_relation', relation.id, relation.type, relation.type, {
      id: relation.id,
      type: relation.type,
      source: endpoints.source,
      target: endpoints.target,
      confidence: relation.confidence,
    })
  }

  private result(pkg: LoadedRolePackage, summary: string, renderer: string, objects: LearnFlowPluginObject[], payload: JsonObject): PluginToolResult {
    const focusObjectIds = objects.filter(object => object.objectType === 'role_object').map(object => object.objectId).slice(0, 24)
    return {
      summary,
      objects,
      payload: { snapshot: this.descriptor(pkg), ...payload },
      presentation: {
        renderer,
        state: {
          packageId: pkg.manifest.packageId,
          packageVersion: pkg.manifest.packageVersion,
          snapshotId: pkg.manifest.snapshotId,
          rootHash: pkg.manifest.rootHash,
          focusObjectIds,
        },
      },
    }
  }

  researchNodeRisks(selector: PackageSelector, objectId: string, question: string, maxNodes = 16): PluginToolResult {
    const pkg = this.resolveForObjects(selector, [objectId])
    const focus = pkg.objects.get(objectId)!
    const limit = Math.max(4, Math.min(24, maxNodes))
    const neighborhood = new Set<string>([objectId])
    let frontier = [objectId]
    for (let depth = 0; depth < 2 && frontier.length && neighborhood.size < limit; depth += 1) {
      const next: string[] = []
      for (const current of frontier) {
        for (const relation of [...(pkg.outgoing.get(current) || []), ...(pkg.incoming.get(current) || [])]) {
          const endpoints = relationEndpoints(relation)
          const adjacent = endpoints.source === current ? endpoints.target : endpoints.source
          if (pkg.objects.has(adjacent) && !neighborhood.has(adjacent) && neighborhood.size < limit) {
            neighborhood.add(adjacent); next.push(adjacent)
          }
        }
      }
      frontier = next
    }
    const relations = pkg.relations.filter(relation => {
      const endpoints = relationEndpoints(relation)
      return neighborhood.has(endpoints.source) && neighborhood.has(endpoints.target)
    })
    const bindings = [...neighborhood].flatMap(id => pkg.bindingsByTarget.get(id) || [])
    const directBindings = pkg.bindingsByTarget.get(objectId) || []
    const focusLifecycle = String(('lifecycle' in focus && focus.lifecycle) || ('knowledgeState' in focus && focus.knowledgeState) || 'snapshot')
    const riskNodes = [...neighborhood].map(id => pkg.objects.get(id)!).filter(item => ['risk', 'exception_risk'].includes(objectKind(item)))
    const risks: JsonObject[] = []
    if (!directBindings.length) risks.push(jsonRecord({ id: 'evidence_gap', severity: 'high', title: '焦点节点缺少直接证据绑定', detail: '当前快照只能从邻域关系解释该节点，不能把邻接节点证据当作直接支持。' }))
    if (focusLifecycle === 'candidate') risks.push(jsonRecord({ id: 'candidate_status', severity: 'medium', title: '节点仍是 candidate', detail: '解释时必须保留候选措辞，不能表述为稳定岗位事实。' }))
    const lowConfidence = typeof focus.confidence === 'number' && focus.confidence < 65
    if (lowConfidence) risks.push(jsonRecord({ id: 'low_confidence', severity: 'medium', title: '节点置信度较低', detail: `快照记录的置信度为 ${focus.confidence}，需要谨慎解释。` }))
    const limitations = [...new Set(bindings.flatMap(binding => binding.limitations || []).filter(Boolean))]
    limitations.slice(0, 6).forEach((detail, index) => risks.push(jsonRecord({ id: `evidence_limitation:${index + 1}`, severity: 'medium', title: '证据适用限制', detail })))
    riskNodes.slice(0, 8).forEach((node, index) => risks.push(jsonRecord({ id: `process_risk:${index + 1}`, severity: 'contextual', title: node.label, detail: node.summary, objectId: node.id })))
    if (neighborhood.size >= limit) risks.push(jsonRecord({ id: 'bounded_projection', severity: 'disclosure', title: '研究邻域达到上限', detail: `本次只读取 ${limit} 个节点；没有展示的关系不能据此判断为不存在。` }))
    if (!risks.length) risks.push(jsonRecord({ id: 'no_explicit_risk', severity: 'disclosure', title: '快照内未发现显式风险', detail: '这只表示当前有界快照未记录风险，不表示真实岗位不存在风险。' }))
    const relationFacts = relations.map(relation => {
      const endpoints = relationEndpoints(relation)
      return jsonRecord({ relationId: relation.id, type: relation.type, sourceId: endpoints.source, targetId: endpoints.target })
    })
    const riskId = `node-risk:${sha256(`${pkg.manifest.rootHash}\0${objectId}\0${question.trim()}\0${limit}`).slice(0, 20)}`
    const riskObject = this.pluginObject(pkg, 'role_node_risk', riskId, `${focus.label} · 风险研究`, 'role_node_risk', {
      id: riskId,
      focusObjectId: objectId,
      focusLabel: focus.label,
      question: question.trim(),
      lifecycle: focusLifecycle,
      neighborhoodIds: [...neighborhood],
      evidence: { directBindings: directBindings.length, neighborhoodBindings: bindings.length, limitations },
      risks,
      relationFacts,
      boundary: '仅解释固定岗位快照中的证据、关系、状态与事理风险；未联网补证据，不生成修改建议、patch 或后继版本。',
    })
    const nodeObjects = [...neighborhood].map(id => this.nodeObject(pkg, pkg.objects.get(id)!))
    return this.result(pkg, `围绕“${focus.label}”读取 ${neighborhood.size} 个节点、${relations.length} 条关系和 ${bindings.length} 条证据绑定，识别 ${risks.length} 项解释风险。`, ROLE_RENDERERS.nodeRisk,
      [riskObject, ...nodeObjects, ...relations.map(item => this.radarRelationObject(pkg, item))], {
        kind: 'role_node_risk_research', focusObjectId: objectId, question: question.trim(), risks, relationFacts,
        coverage: { nodes: neighborhood.size, relations: relations.length, evidenceBindings: bindings.length, bounded: neighborhood.size >= limit },
        boundary: '结果只用于解释当前不可变快照；冷启动、迭代、补证据和发布只在 role-agent/Hub 进行。',
      })
  }

  private roleRadarProjection(pkg: LoadedRolePackage, query: string) {
    const root = pkg.semantic.nodes.find(item => item.type === 'market_role')
    if (!root) throw new Error('role_package_invalid:missing role root')
    const selected = new Map<string, RoleNode>([[root.id, root]])
    const semanticRelations = pkg.semantic.edges
    for (const ring of [...RADAR_RING_LIMITS.keys()].filter(value => value > 0)) {
      const candidates = pkg.semantic.nodes.filter(item => item.ring === ring)
      const ranked = candidates.map(item => {
        const connected = semanticRelations.filter(relation => {
          const endpoints = relationEndpoints(relation)
          return (endpoints.source === item.id && selected.has(endpoints.target))
            || (endpoints.target === item.id && selected.has(endpoints.source))
        }).length
        return { item, score: connected * 100 + this.score(item, query || pkg.manifest.roleTitle) + (item.confidence || 0) }
      }).sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id))
      ranked.slice(0, RADAR_RING_LIMITS.get(ring) || 0).forEach(({ item }) => selected.set(item.id, item))
    }
    const ids = new Set(selected.keys())
    const relations = semanticRelations.filter(relation => {
      const endpoints = relationEndpoints(relation)
      return ids.has(endpoints.source) && ids.has(endpoints.target)
    }).slice(0, 56)
    const rings = [...new Set([...selected.values()].map(item => item.ring || 0))].sort((left, right) => left - right).map(ring => ({
      ring,
      label: ({ 0: '岗位中心', 1: '岗位身份与边界', 2: '典型任务', 3: '抽象能力', 4: '能力单元', 5: '知识技能' } as Record<number, string>)[ring] || `第 ${ring} 层`,
      objectIds: [...selected.values()].filter(item => (item.ring || 0) === ring).map(item => item.id),
      total: pkg.semantic.nodes.filter(item => (item.ring || 0) === ring).length,
    }))
    return { root, nodes: [...selected.values()], relations, rings }
  }

  listPackages(query = '') {
    const requestedRole = query.trim()
    const matched = requestedRole ? this.packages.filter(pkg => packageMatchesQuery(pkg, requestedRole)) : this.packages
    const packages = matched.map(pkg => this.descriptor(pkg))
    const matchStatus = requestedRole ? (packages.length ? 'matched' : 'not_found') : 'all'
    const researchUrl = matchStatus === 'not_found' ? roleAgentResearchUrl(requestedRole) : ''
    const hubUrl = graphHubBrowseUrl(requestedRole)
    return {
      summary: matchStatus === 'not_found'
        ? `没有发现与“${requestedRole}”匹配的可引用岗位包；可以前往 Role Atlas 自主研究该岗位。`
        : `${requestedRole ? `为“${requestedRole}”` : ''}发现 ${packages.length} 个当前可引用的不可变岗位包版本。`,
      objects: matched.map(pkg => this.pluginObject(
        pkg, 'role_snapshot', pkg.manifest.snapshotId, pkg.manifest.roleTitle, 'snapshot', this.descriptor(pkg),
      )),
      payload: {
        kind: 'role_package_catalog', packages, count: packages.length, totalAvailable: this.packages.length,
        requestedRole, matchStatus, roleAgentResearchUrl: researchUrl, graphHubBrowseUrl: hubUrl,
        selectionContract: '用户选择后必须用 packageId、packageVersion、snapshotId 与 rootHash 调用 reference_role_package；不得只凭标题猜测。',
        simulation: packages.some(item => item.sourceKind === 'role_agent_simulation')
          ? '开发模拟会把本机 role-agent packages 目录中的有效静态岗位包视为可用；这不代表已经通过正式 Hub 审核。'
          : '',
        warnings: [...this.discoveryIssues],
      },
      presentation: { renderer: ROLE_RENDERERS.catalog, state: { requestedRole, matchStatus, snapshotIds: packages.map(item => item.snapshotId) } },
    } satisfies PluginToolResult
  }

  referencePackage(input: Required<PackageSelector> & { rootHash: string }) {
    const pkg = this.resolve({
      packageId: input.packageId,
      packageVersion: input.packageVersion,
      snapshotId: input.snapshotId,
    })
    if (pkg.manifest.rootHash !== input.rootHash) throw new Error('role_package_reference_mismatch:rootHash does not match the selected immutable package')
    const descriptor = this.descriptor(pkg)
    const referenceId = `package-reference:${pkg.manifest.rootHash}`
    const reference = this.pluginObject(pkg, 'role_package_reference', referenceId, `${pkg.manifest.roleTitle} · 已引用`, 'package_reference', {
      ...descriptor,
      referenceId,
      pinnedBy: 'explicit_tool_selection',
      boundary: '该引用只固定当前对话中的岗位事实版本，不安装、修改或发布岗位包，也不形成学习者掌握证据。',
    })
    return {
      summary: `已引用“${pkg.manifest.roleTitle}”岗位包 ${pkg.manifest.packageVersion}，后续岗位读取必须固定 ${pkg.manifest.snapshotId}。`,
      objects: [reference],
      payload: {
        kind: 'role_package_reference', reference: descriptor,
        requiredSelector: {
          packageId: pkg.manifest.packageId,
          packageVersion: pkg.manifest.packageVersion,
          snapshotId: pkg.manifest.snapshotId,
          // The reference verified this hash against the selected immutable
          // package. Reusing it downstream keeps every later read pinned to the
          // exact bytes the learner chose, not merely the same release slot.
          rootHash: pkg.manifest.rootHash,
        },
        boundary: '引用固定到本次 ToolRun；后续工具必须复用精确 selector，不得按标题静默切换版本。',
      },
      presentation: {
        renderer: ROLE_RENDERERS.packageReference,
        state: {
          packageId: pkg.manifest.packageId,
          packageVersion: pkg.manifest.packageVersion,
          snapshotId: pkg.manifest.snapshotId,
          rootHash: pkg.manifest.rootHash,
          focusObjectIds: [],
        },
      },
    } satisfies PluginToolResult
  }

  explore(selector: PackageSelector, query: string) {
    const pkg = this.resolveForQuery(selector, query)
    const root = this.rank(pkg, query, true).find(item => item.object.type === 'market_role')?.object
      || this.rank(pkg, query, true)[0]?.object
      || pkg.semantic.nodes.find(item => item.type === 'market_role')
    if (!root) throw new Error('role_package_invalid:missing role root')
    const take = (kind: string, count: number) => pkg.views.sections.flatMap(section => section.itemIds)
      .map(objectId => pkg.objects.get(objectId))
      .filter((item): item is RoleNode | ProcessScenario | ProcessNode => Boolean(item) && objectKind(item!) === kind)
      .filter((item, index, values) => values.findIndex(candidate => candidate.id === item.id) === index)
      .slice(0, count)
    const tasks = take('task', 6)
    const capabilities = take('capability', 6)
    const scenarios = take('scenario', 4)
    const related = take('related_role', 4)
    const overviewNodes = [...new Map([root, ...tasks, ...capabilities, ...scenarios, ...related].map(item => [item.id, item])).values()]
    const radar = this.roleRadarProjection(pkg, query)
    const facts = overviewNodes.map(item => ({
      objectId: item.id,
      statement: `${item.label}：${item.summary}`,
      lifecycle: item.lifecycle || ('knowledgeState' in item ? item.knowledgeState : undefined) || 'snapshot',
      evidenceBindingIds: (pkg.bindingsByTarget.get(item.id) || []).map(binding => binding.id).slice(0, 4),
    }))
    return this.result(pkg, `一次读取“${root.label}”的岗位定位、${tasks.length} 项任务、${capabilities.length} 项核心能力和 ${scenarios.length} 个工作场景。`, ROLE_RENDERERS.overview,
      [
        ...overviewNodes.map(item => this.nodeObject(pkg, item)),
        ...radar.nodes.filter(item => !overviewNodes.some(node => node.id === item.id)).map(item => this.radarNodeObject(pkg, item)),
        ...radar.relations.map(item => this.radarRelationObject(pkg, item)),
      ], {
        kind: 'role_overview', rootId: root.id,
        sections: {
          tasks: tasks.map(item => item.id), capabilities: capabilities.map(item => item.id),
          scenarios: scenarios.map(item => item.id), relatedRoles: related.map(item => item.id),
        },
        radar: { rootId: radar.root.id, rings: radar.rings, relationIds: radar.relations.map(item => item.id) },
        grounding: {
          policy: 'snapshot_facts_only', facts,
          requiredDisclosure: `岗位事实固定于 ${pkg.manifest.snapshotAsOf} 的 ${pkg.manifest.snapshotId}；未出现在 facts 中的内容必须明确标为“通用补充（非岗位快照）”。`,
          boundary: '岗位对象不是学习者掌握证据；本工具只读，不创建或迭代岗位包。',
        },
      })
  }

  capabilityRadar(selector: PackageSelector, query: string) {
    const pkg = this.resolveForQuery(selector, query)
    const radar = this.roleRadarProjection(pkg, query)
    return this.result(pkg, `以“${radar.root.label}”为中心展开 ${radar.rings.length - 1} 个语义维度、${radar.nodes.length - 1} 个外围节点和 ${radar.relations.length} 条关系。`, ROLE_RENDERERS.radar,
      [...radar.nodes.map(item => this.radarNodeObject(pkg, item)), ...radar.relations.map(item => this.radarRelationObject(pkg, item))], {
        kind: 'role_dimension_radar', rootId: radar.root.id, rings: radar.rings,
        relationIds: radar.relations.map(item => item.id),
        boundary: '这是岗位包语义图的有界环形投影，不是学习者能力评分，也不以证据强度绘制面积。',
      })
  }

  compare(baseSelector: PackageSelector, targetSelector: PackageSelector) {
    const base = this.resolve(baseSelector)
    const target = this.resolve(targetSelector)
    const baseIds = new Set(base.objects.keys())
    const targetIds = new Set(target.objects.keys())
    const added = [...targetIds].filter(id => !baseIds.has(id))
    const removed = [...baseIds].filter(id => !targetIds.has(id))
    const changed = [...targetIds].filter(id => {
      const before = base.objects.get(id)
      const after = target.objects.get(id)
      return before && after && JSON.stringify(before) !== JSON.stringify(after)
    })
    const migrationIds = new Set(target.referenceMigrations.flatMap(item => Array.isArray(item.newIds) ? item.newIds as string[] : []))
    return {
      summary: `比较 ${base.manifest.packageVersion} → ${target.manifest.packageVersion}：新增 ${added.length}、移除 ${removed.length}、变更 ${changed.length}。`,
      objects: [
        this.pluginObject(base, 'role_snapshot', base.manifest.snapshotId, base.manifest.roleTitle, 'comparison_base', this.descriptor(base)),
        this.pluginObject(target, 'role_snapshot', target.manifest.snapshotId, target.manifest.roleTitle, 'comparison_target', this.descriptor(target)),
      ],
      payload: {
        kind: 'role_package_comparison', base: this.descriptor(base), target: this.descriptor(target),
        added: added.slice(0, 40), removed: removed.slice(0, 40), changed: changed.slice(0, 40),
        referenceMigrationHits: [...migrationIds].filter(id => added.includes(id) || changed.includes(id)).slice(0, 40),
        truncated: added.length > 40 || removed.length > 40 || changed.length > 40,
      },
      presentation: {
        renderer: ROLE_RENDERERS.comparison,
        state: { snapshotIds: [base.manifest.snapshotId, target.manifest.snapshotId] },
      },
    } satisfies PluginToolResult
  }

  private score(object: RoleNode | ProcessScenario | ProcessNode, query: string) {
    const queryTokens = tokens(query)
    const text = [object.id, object.label, object.summary, objectKind(object), ...(('aliases' in object && Array.isArray(object.aliases)) ? object.aliases : [])].join(' ')
    const targetTokens = new Set(tokens(text))
    const overlap = queryTokens.filter(token => targetTokens.has(token)).length
    return overlap + (normalize(text).includes(normalize(query)) ? Math.max(3, queryTokens.length) : 0)
  }

  private rank(pkg: LoadedRolePackage, query: string, includeCandidate: boolean) {
    const retrievalText = new Map(pkg.retrieval.map(item => [item.targetId, item.text]))
    return [...pkg.objects.values()].filter(object => includeCandidate || object.lifecycle !== 'candidate').map(object => ({
      object,
      score: this.score({ ...object, summary: `${object.summary} ${retrievalText.get(object.id) || ''}` }, query),
    })).filter(item => item.score > 0).sort((left, right) => right.score - left.score || left.object.id.localeCompare(right.object.id))
  }

  readObjects(selector: PackageSelector, objectIds: string[], includeRelations: boolean) {
    const pkg = this.resolveForObjects(selector, objectIds)
    const ids = [...new Set(objectIds)].slice(0, MAX_OBJECT_IDS)
    const objects = ids.map(id => pkg.objects.get(id)).filter((item): item is RoleNode | ProcessScenario | ProcessNode => Boolean(item))
    const relations = includeRelations
      ? [...new Map(objects.flatMap(object => [...(pkg.outgoing.get(object.id) || []), ...(pkg.incoming.get(object.id) || [])]).map(item => [item.id, item])).values()].slice(0, 36)
      : []
    return this.result(pkg, `读取 ${objects.length}/${ids.length} 个岗位对象${relations.length ? `及 ${relations.length} 条一跳关系` : ''}。`, ROLE_RENDERERS.cards, [
      ...objects.map(object => this.nodeObject(pkg, object)),
      ...relations.map(relation => this.relationObject(pkg, relation)),
    ], {
      kind: 'role_objects', requested: ids.length, returned: objects.length,
      omittedIds: ids.filter(id => !pkg.objects.has(id)), truncated: objectIds.length > MAX_OBJECT_IDS,
    })
  }

  search(selector: PackageSelector, query: string, topK: number, includeCandidate: boolean) {
    const pkg = this.resolveForQuery(selector, query)
    const scored = this.rank(pkg, query, includeCandidate)
    const selected = scored.slice(0, Math.min(Math.max(1, topK), MAX_SEARCH_RESULTS))
    return this.result(pkg, `在固定快照中找到 ${selected.length} 个与“${query.slice(0, 80)}”相关的对象。`, ROLE_RENDERERS.cards,
      selected.map(item => this.nodeObject(pkg, item.object)), {
        kind: 'search_results', query, coverage: {
          complete: scored.length <= selected.length,
          returned: selected.length,
          omitted: Math.max(0, scored.length - selected.length),
        },
        scores: selected.map(item => ({ objectId: item.object.id, score: item.score })),
      })
  }

  queryGraph(selector: PackageSelector, objectId: string, depth: number, direction: 'outgoing' | 'incoming' | 'both', maxNodes: number) {
    const pkg = this.resolveForObjects(selector, [objectId])
    if (!pkg.objects.has(objectId)) throw new Error(`role_object_not_found:${objectId}`)
    const limit = Math.min(Math.max(2, maxNodes), MAX_GRAPH_NODES)
    const nodeIds = new Set([objectId])
    const relations = new Map<string, RoleRelation>()
    let frontier = [objectId]
    for (let level = 0; level < Math.min(Math.max(1, depth), 2) && frontier.length && nodeIds.size < limit; level += 1) {
      const next: string[] = []
      for (const current of frontier) {
        const candidates = [
          ...(direction !== 'incoming' ? pkg.outgoing.get(current) || [] : []),
          ...(direction !== 'outgoing' ? pkg.incoming.get(current) || [] : []),
        ]
        for (const relation of candidates) {
          const endpoints = relationEndpoints(relation)
          const adjacent = endpoints.source === current ? endpoints.target : endpoints.source
          if (!pkg.objects.has(adjacent)) continue
          relations.set(relation.id, relation)
          if (!nodeIds.has(adjacent) && nodeIds.size < limit) {
            nodeIds.add(adjacent)
            next.push(adjacent)
          }
        }
      }
      frontier = next
    }
    const nodes = [...nodeIds].map(id => pkg.objects.get(id)!)
    const boundedRelations = [...relations.values()].filter(relation => {
      const endpoints = relationEndpoints(relation)
      return nodeIds.has(endpoints.source) && nodeIds.has(endpoints.target)
    }).slice(0, 48)
    const relationFacts = boundedRelations.map(relation => {
      const endpoints = relationEndpoints(relation)
      return {
        relationId: relation.id,
        type: relation.type,
        sourceId: endpoints.source,
        sourceLabel: pkg.objects.get(endpoints.source)?.label || endpoints.source,
        targetId: endpoints.target,
        targetLabel: pkg.objects.get(endpoints.target)?.label || endpoints.target,
      }
    })
    return this.result(pkg, `从“${pkg.objects.get(objectId)!.label}”读取 ${nodes.length} 个节点和 ${boundedRelations.length} 条关系。`, ROLE_RENDERERS.graph, [
      ...nodes.map(object => this.nodeObject(pkg, object)),
      ...boundedRelations.map(relation => this.relationObject(pkg, relation)),
    ], {
      kind: 'role_graph', rootId: objectId, depth: Math.min(Math.max(1, depth), 2), direction, truncated: nodeIds.size >= limit,
      grounding: {
        policy: 'returned_relations_only', relationFacts,
        requiredDisclosure: `只能解释 relationFacts 中逐条列出的方向和关系类型；不得改名、反向或补造未返回的关系。子图固定于 ${pkg.manifest.snapshotId}。`,
      },
    })
  }

  traceProcess(selector: PackageSelector, objectId: string, maxNodes: number) {
    const pkg = this.resolveForObjects(selector, [objectId])
    const scenarioIds = new Set<string>()
    if (pkg.process.scenarios.some(item => item.id === objectId)) scenarioIds.add(objectId)
    pkg.process.scenarios.filter(item => item.taskRefs?.includes(objectId)).forEach(item => scenarioIds.add(item.id))
    const processObject = pkg.process.nodes.find(item => item.id === objectId)
    if (processObject) scenarioIds.add(processObject.scenarioId)
    pkg.process.bridges.filter(item => item.semanticNodeId === objectId).forEach(bridge => {
      const node = pkg.process.nodes.find(item => item.id === bridge.processNodeId)
      if (node) scenarioIds.add(node.scenarioId)
    })
    if (!scenarioIds.size) throw new Error(`role_process_not_found:${objectId}`)
    const limit = Math.min(Math.max(4, maxNodes), MAX_PROCESS_NODES)
    const scenarios = pkg.process.scenarios.filter(item => scenarioIds.has(item.id)).slice(0, 4)
    const nodes = pkg.process.nodes.filter(item => scenarioIds.has(item.scenarioId)).sort((left, right) => (left.sequenceHint || 999) - (right.sequenceHint || 999) || left.id.localeCompare(right.id)).slice(0, limit)
    const nodeIds = new Set([...scenarios.map(item => item.id), ...nodes.map(item => item.id)])
    const relations = [...pkg.process.edges, ...pkg.process.bridges].filter(relation => {
      const endpoints = relationEndpoints(relation)
      return nodeIds.has(endpoints.source) && (nodeIds.has(endpoints.target) || pkg.objects.has(endpoints.target))
    }).slice(0, 64)
    return this.result(pkg, `读取 ${scenarios.length} 个工作场景、${nodes.length} 个事理对象和 ${relations.length} 条关系。`, ROLE_RENDERERS.process, [
      ...scenarios.map(object => this.nodeObject(pkg, object)),
      ...nodes.map(object => this.nodeObject(pkg, object)),
      ...relations.map(relation => this.relationObject(pkg, relation)),
    ], {
      kind: 'process_forest', anchorId: objectId, scenarioIds: scenarios.map(item => item.id),
      boundary: '事理森林表示有证据边界的工作模式；除 observed_pattern 外，不是企业真实事件日志。',
      truncated: pkg.process.nodes.filter(item => scenarioIds.has(item.scenarioId)).length > nodes.length,
    })
  }

  inspectEvidence(selector: PackageSelector, objectIds: string[]) {
    const pkg = this.resolveForObjects(selector, objectIds)
    const ids = [...new Set(objectIds)].slice(0, MAX_EVIDENCE_TARGETS)
    const evidence = ids.flatMap(targetId => (pkg.bindingsByTarget.get(targetId) || []).slice(0, 6).map(binding => {
      const segment = pkg.segments.get(binding.segmentId)
      const source = pkg.assets.get(binding.sourceId)
      return { targetId, binding, segment: segment ? { ...segment, text: segment.text.slice(0, 900) } : undefined, source }
    }))
    const objects = evidence.map(item => this.pluginObject(pkg, 'role_evidence', item.binding.id,
      item.source?.title || item.binding.id, item.binding.assertionType || 'evidence_binding', item))
    return this.result(pkg, `为 ${ids.length} 个对象解析 ${evidence.length} 条证据绑定。`, ROLE_RENDERERS.evidence, objects, {
      kind: 'role_evidence', targetIds: ids,
      coverage: ids.map(targetId => ({ targetId, bindingCount: (pkg.bindingsByTarget.get(targetId) || []).length })),
      truncated: objectIds.length > MAX_EVIDENCE_TARGETS,
    })
  }

  audit(selector: PackageSelector) {
    const pkg = this.resolve(selector)
    const validation = pkg.validation
    const descriptor = this.descriptor(pkg)
    return this.result(pkg, `岗位包“${descriptor.roleTitle}”协议${validation.valid === true ? '有效' : '无效'}；读取结构统计、警告和研究缺口。`, ROLE_RENDERERS.audit, [
      this.pluginObject(pkg, 'role_snapshot', pkg.manifest.snapshotId, descriptor.roleTitle, 'snapshot', descriptor),
      this.pluginObject(pkg, 'role_audit', `${pkg.manifest.snapshotId}:validation`, '岗位包结构审计', 'validation', validation),
    ], { kind: 'role_audit', validation })
  }
}

export function packageSelector(input: Record<string, PluginJson>): PackageSelector {
  return {
    packageId: typeof input.packageId === 'string' && input.packageId ? input.packageId : undefined,
    packageVersion: typeof input.packageVersion === 'string' && input.packageVersion ? input.packageVersion : undefined,
    snapshotId: typeof input.snapshotId === 'string' && input.snapshotId ? input.snapshotId : undefined,
    rootHash: typeof input.rootHash === 'string' && input.rootHash ? input.rootHash : undefined,
  }
}

export const rolePackageRuntime = new RolePackageRuntime()
