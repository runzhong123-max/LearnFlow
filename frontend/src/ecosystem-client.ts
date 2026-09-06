import { validateLearningPathGraphV2 } from './learning-path-contract-v2.ts'
import { runtimeFetch } from './runtime-client.ts'
import type { RolePackageRef, LearningPathGraphV2, RoleLearningAlignmentV2, GraphExtensionProposalV2, PathGraphRef } from './learning-path-contract-v2.ts'
export type { RolePackageRef }
export type CatalogItem = { packageRef: RolePackageRef; title: string; summary: string; visibility: string }
export type RoleNode = { id: string; type: string; label: string; summary: string; learningKind?: string; learningDefinition?: { scopeNote: string; assessmentCriteria: string[] } }
export type RolePackage = { packageRef: RolePackageRef; title: string; result: { semantic: { nodes: RoleNode[] } } }
export type AgentRun = { runId: string; status: 'completed' | 'running' | 'failed'; result?: { answer: string; citations: unknown[]; packageRef: RolePackageRef } }
export type ResolutionPreview = { resolutionId: string; resolution: { alignment: RoleLearningAlignmentV2; pendingBindings: RoleLearningAlignmentV2['bindings']; extensionProposal?: GraphExtensionProposalV2; unresolved: Array<{ roleNodeId: string; reason: string; candidates: Array<{ namespace: string; id: string; revision: number; title: string; kind: string }> }> } }
export type CommitReceipt = { receiptId: string; resolutionId: string; graphRef: PathGraphRef; alignment: RoleLearningAlignmentV2; addedNodeIds: string[]; masteryUnchanged: true }
export class EcosystemError extends Error {
  code: string
  retryable: boolean
  constructor(code: string, retryable = false) {
    super(code === 'UNAUTHORIZED' ? '登录已失效，请重新登录。' : code === 'NOT_CONFIGURED' ? '岗位服务尚未配置，请联系维护者连接 Graph Hub 与 Role Atlas。' : code === 'FORBIDDEN' ? '当前账号没有执行此操作的权限。' : code === 'INVALID_PACKAGE_REF' ? '岗位包版本标识不完整，请重新选择岗位包。' : code === 'INVALID_RESPONSE' ? '服务返回了不兼容的数据，请刷新后重试。' : '岗位服务暂不可用，请保留当前版本并稍后重试。')
    this.name = 'EcosystemError'; this.code = code; this.retryable = retryable
  }
}
export const newEcosystemRequestId = () => `eco-${globalThis.crypto.randomUUID()}`
export function checkedPackageRef(value: RolePackageRef): RolePackageRef {
  if (!value || !['packageId', 'packageVersion', 'snapshotId'].every(k => typeof value[k as keyof RolePackageRef] === 'string' && value[k as keyof RolePackageRef].trim()) || !/^[a-f0-9]{64}$/i.test(value.rootHash)) throw new EcosystemError('INVALID_PACKAGE_REF')
  return { packageId: value.packageId, packageVersion: value.packageVersion, snapshotId: value.snapshotId, rootHash: value.rootHash }
}
export function samePackageRef(a: RolePackageRef, b: RolePackageRef) { return JSON.stringify(checkedPackageRef(a)) === JSON.stringify(checkedPackageRef(b)) }
export function createEcosystemClient(fetchImpl: typeof runtimeFetch = runtimeFetch) {
  async function request<T>(path: string, body?: unknown, requestId?: string): Promise<T> {
    let response: Response
    try { response = await fetchImpl(`/api/ecosystem${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) } catch { throw new EcosystemError('UNAVAILABLE', true) }
    if (response.status === 401) throw new EcosystemError('UNAUTHORIZED')
    if (response.status === 403) throw new EcosystemError('FORBIDDEN')
    let envelope: any
    try { envelope = await response.json() } catch { throw new EcosystemError('INVALID_RESPONSE') }
    if (envelope?.protocol !== 'learnflow-ecosystem/v1' || requestId && envelope.requestId !== requestId) throw new EcosystemError('INVALID_RESPONSE')
    if (!response.ok || envelope.ok !== true) throw new EcosystemError(typeof envelope.error?.code === 'string' ? envelope.error.code.toUpperCase() : 'UNAVAILABLE', envelope.error?.retryable === true)
    return envelope.data as T
  }
  function dispatch<T>(operation: string, payload: unknown, requestId = newEcosystemRequestId()) { return request<T>('/dispatch', { protocol: 'learnflow-ecosystem/v1', operation, requestId, payload }, requestId) }
  return {
    capabilities: async () => {
      const data = await request<{ available: boolean; operations: string[]; sourceGraphAvailable: boolean }>('/capabilities')
      if (typeof data?.available !== 'boolean' || !Array.isArray(data.operations) || !data.operations.every(x => typeof x === 'string')) throw new EcosystemError('INVALID_RESPONSE')
      return data
    },
    graph: async () => {
      const data = await request<{ graph: LearningPathGraphV2; namespace: string }>('/learning-path')
      if (!data || typeof data.namespace !== 'string' || !validateLearningPathGraphV2(data.graph).valid) throw new EcosystemError('INVALID_RESPONSE')
      return data
    },
    search: async (query: string, offset = 0) => {
      const result = await dispatch<{ items: CatalogItem[]; total: number; offset: number; limit: number; truncated: boolean }>('catalog.search', { query, offset, limit: 20 })
      if (!Array.isArray(result?.items) || !Number.isInteger(result.total)) throw new EcosystemError('INVALID_RESPONSE')
      result.items.forEach(item => checkedPackageRef(item.packageRef)); return result
    },
    package: async (packageRef: RolePackageRef) => {
      const result = await dispatch<RolePackage>('package.resolve', { packageRef: checkedPackageRef(packageRef) })
      if (!samePackageRef(packageRef, result.packageRef) || !Array.isArray(result.result?.semantic?.nodes)) throw new EcosystemError('INVALID_RESPONSE')
      return result
    },
    evidence: (packageRef: RolePackageRef, target: string) => dispatch<any>('role.query', { packageRef: checkedPackageRef(packageRef), tool: 'inspect_role_evidence', args: { target, mode: 'trace' } }),
    run: async (packageRef: RolePackageRef, message: string, targetIds: string[], requestId: string) => {
      const run = await dispatch<AgentRun>('agent.run', { packageRef: checkedPackageRef(packageRef), message, targetIds }, requestId)
      return checkedAgentRun(run, packageRef)
    },
    getRun: async (runId: string, packageRef?: RolePackageRef) => {
      const run = checkedAgentRun(await dispatch<AgentRun>('agent.get_run', { runId }), packageRef)
      if (run.runId !== runId) throw new EcosystemError('INVALID_RESPONSE')
      return run
    },
    resolve: (packageRef: RolePackageRef, targetIds: string[], requestId: string) => request<ResolutionPreview>('/learning-path/resolve', { requestId, packageRef: checkedPackageRef(packageRef), targetIds }, requestId),
    commit: (resolutionId: string, requestId: string) => request<CommitReceipt>('/learning-path/commit', { resolutionId, requestId }, requestId),
  }
}

export function checkedAgentRun(run: AgentRun, packageRef?: RolePackageRef): AgentRun {
  if (!run || typeof run.runId !== 'string' || !run.runId || !['completed', 'running', 'failed'].includes(run.status)) throw new EcosystemError('INVALID_RESPONSE')
  if (run.status === 'completed' && (!run.result || typeof run.result.answer !== 'string' || !Array.isArray(run.result.citations))) throw new EcosystemError('INVALID_RESPONSE')
  if (run.result && packageRef && !samePackageRef(packageRef, run.result.packageRef)) throw new EcosystemError('INVALID_RESPONSE')
  return run
}
export function citationLabels(citations: unknown[]): string[] {
  return citations.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const c = value as Record<string, unknown>
    return [typeof c.label === 'string' ? c.label : typeof c.targetId === 'string' ? c.targetId : ''].filter(Boolean)
  })
}
