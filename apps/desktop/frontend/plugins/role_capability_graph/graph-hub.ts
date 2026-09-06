import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  LEARNFLOW_PLUGIN_OBJECT_VERSION,
  versionedPluginModuleUrl,
  type LearnFlowPluginObject,
  type PluginJson,
  type PluginToolResult,
} from '../../src/plugin-api.ts'
const { ROLE_CAPABILITY_PLUGIN, ROLE_OBJECT_SCHEMA_VERSION, ROLE_RENDERERS } = await import(
  versionedPluginModuleUrl('./shared.ts', import.meta.url)
) as typeof import('./shared.ts')

type GraphNode = {
  id: string
  label: string
  type: string
  summary?: string
  aliases?: string[]
  tags?: string[]
}

type GraphCatalogEntry = {
  graphId: string
  graphVersion: string
  graphType: 'learning_path' | 'role_semantic' | 'role_process' | 'knowledge' | 'custom'
  title: string
  summary: string
  keywords: string[]
  ownerSubjectId: string
  maintainerName: string
  kind: 'official' | 'personal'
  review: 'official' | 'approved' | 'pending_owner' | 'rejected_owner'
  access: 'public' | 'owner'
  objectHash: string
  objectPath: string
  submittedAt: string
  reviewedAt?: string
  nodeIndex: GraphNode[]
}

type GraphCatalog = {
  protocol: 'graph-hub-catalog.v1'
  generatedAt: string
  audienceSubjectId?: string
  entries: GraphCatalogEntry[]
  rootHash: string
}

const MAX_CATALOG_BYTES = 8 * 1024 * 1024

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalValue(item)]))
  if (typeof value === 'string') return value.normalize('NFC')
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('graph_hub_catalog_invalid:non_finite_number')
  return value
}

function canonicalStringify(value: unknown) {
  return JSON.stringify(canonicalValue(value))
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function normalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^a-z0-9+#\u3400-\u9fff]+/gu, '')
}

function queryTerms(value: string) {
  const normalized = normalize(value)
  const result = new Set((value.toLocaleLowerCase().match(/[a-z0-9][a-z0-9+#._-]*/gu) || []).map(normalize))
  for (const run of normalized.match(/[\u3400-\u9fff]+/gu) || []) {
    result.add(run)
    for (const char of run) result.add(char)
    for (let index = 0; index < run.length - 1; index += 1) result.add(run.slice(index, index + 2))
  }
  return [...result].filter(Boolean).slice(0, 40)
}

function scoreText(terms: string[], value: string) {
  const target = normalize(value)
  return terms.reduce((score, term) => score + (target === term ? 12 : target.includes(term) ? Math.min(8, 2 + term.length) : 0), 0)
}

function validateCatalog(value: unknown, actorSubjectId?: string): GraphCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('graph_hub_catalog_invalid:envelope')
  const catalog = value as GraphCatalog
  if (catalog.protocol !== 'graph-hub-catalog.v1' || !Array.isArray(catalog.entries) || !/^[0-9a-f]{64}$/u.test(catalog.rootHash || '')) {
    throw new Error('graph_hub_catalog_invalid:protocol')
  }
  const actual = sha256(canonicalStringify({ ...catalog, generatedAt: '', rootHash: '' }))
  if (actual !== catalog.rootHash) throw new Error('graph_hub_catalog_invalid:root_hash')
  if (catalog.audienceSubjectId && catalog.audienceSubjectId !== actorSubjectId) throw new Error('graph_hub_catalog_not_visible:audience')
  for (const entry of catalog.entries) {
    if (!entry.graphId || !entry.graphVersion || !entry.title || !/^[0-9a-f]{64}$/u.test(entry.objectHash || '') || !Array.isArray(entry.nodeIndex)) {
      throw new Error('graph_hub_catalog_invalid:entry')
    }
    if (entry.kind === 'personal' && entry.review !== 'approved' && entry.ownerSubjectId !== actorSubjectId) {
      throw new Error('graph_hub_catalog_not_visible:personal_review')
    }
    if (entry.access === 'owner' && entry.ownerSubjectId !== actorSubjectId) throw new Error('graph_hub_catalog_not_visible:owner')
  }
  return catalog
}

export function graphHubSubject(learnerId?: number) {
  return Number.isInteger(learnerId) && Number(learnerId) > 0 ? `learnflow:learner:${learnerId}` : undefined
}

export async function recommendGraphHubEntries(input: {
  catalogFile: string
  actorSubjectId?: string
  query: string
  graphTypes?: string[]
  topK?: number
}): Promise<PluginToolResult> {
  const file = resolve(input.catalogFile)
  const metadata = await stat(file)
  if (!metadata.isFile() || metadata.size > MAX_CATALOG_BYTES) throw new Error('graph_hub_catalog_invalid:file')
  const catalog = validateCatalog(JSON.parse(await readFile(file, 'utf8')), input.actorSubjectId)
  const terms = queryTerms(input.query)
  if (!terms.length) throw new Error('graph_hub_query_required')
  const allowedTypes = new Set((input.graphTypes || []).filter(Boolean))
  const ranked = catalog.entries.flatMap(entry => {
    if (allowedTypes.size && !allowedTypes.has(entry.graphType)) return []
    const metadataScore = scoreText(terms, [entry.title, entry.summary, ...entry.keywords].join(' '))
    const matchedNodes = entry.nodeIndex.map(node => ({
      id: node.id,
      label: node.label,
      type: node.type,
      summary: node.summary || '',
      score: scoreText(terms, [node.label, node.summary || '', ...(node.aliases || []), ...(node.tags || [])].join(' ')),
    })).filter(node => node.score > 0).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, 6)
    const score = metadataScore * 2 + matchedNodes.reduce((sum, node) => sum + node.score, 0)
    return score > 0 ? [{ entry, matchedNodes, score }] : []
  }).sort((left, right) => right.score - left.score || left.entry.graphId.localeCompare(right.entry.graphId))
  const limit = Math.min(10, Math.max(1, Number(input.topK) || 5))
  const selected = ranked.slice(0, limit)
  const objects: LearnFlowPluginObject[] = selected.map(({ entry, matchedNodes, score }) => ({
    protocol: LEARNFLOW_PLUGIN_OBJECT_VERSION,
    pluginId: ROLE_CAPABILITY_PLUGIN.id,
    objectType: 'graph_recommendation',
    objectId: `${entry.graphId}@${entry.graphVersion}`,
    schemaVersion: ROLE_OBJECT_SCHEMA_VERSION,
    label: entry.title,
    value: {
      graphId: entry.graphId,
      graphVersion: entry.graphVersion,
      graphType: entry.graphType,
      title: entry.title,
      summary: entry.summary,
      kind: entry.kind,
      review: entry.review,
      access: entry.access,
      objectHash: entry.objectHash,
      ownerSubjectId: entry.ownerSubjectId,
      maintainerName: entry.maintainerName,
      score,
      matchedNodes,
    } as PluginJson,
  }))
  return {
    summary: selected.length
      ? `图谱 Hub 找到 ${selected.length} 个与“${input.query}”相关且当前主体可见的图谱。`
      : `图谱 Hub 没有找到与“${input.query}”相关且当前主体可见的图谱。`,
    objects,
    presentation: { renderer: ROLE_RENDERERS.graphHub, state: { query: input.query, graphTypes: input.graphTypes || [] } },
    payload: {
      protocol: 'learnflow.graph-hub-recommendation.v1',
      query: input.query,
      recommendations: selected.map(({ entry, matchedNodes, score }) => ({
        graphId: entry.graphId,
        graphVersion: entry.graphVersion,
        graphType: entry.graphType,
        title: entry.title,
        summary: entry.summary,
        kind: entry.kind,
        review: entry.review,
        access: entry.access,
        objectHash: entry.objectHash,
        score,
        matchedNodes,
      })),
      coverage: {
        visibleGraphs: catalog.entries.length,
        matchedGraphs: ranked.length,
        returned: selected.length,
        omitted: Math.max(0, ranked.length - selected.length),
        truncated: ranked.length > selected.length,
      },
      boundary: '只推荐当前主体可见的图谱；个人未审核图只可能出现在所有者作用域目录中。结果不写学习路径、EvidenceEvent 或五核。',
    },
  }
}
