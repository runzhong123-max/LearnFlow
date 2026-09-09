import type { PluginJson, PluginToolResult } from '../../src/plugin-api.ts'

export type PublicRoleCandidate = {
  packageId: string; packageVersion: string; snapshotId: string; rootHash: string
  roleTitle: string; summary: string; repositoryUrl: string; reasons: string[]
  matchedTasks?: Array<{ id: string; label: string; type: string; summary: string }>; matchedTaskCount?: number
  availability: 'available_not_installed'
}
export type HubDiscovery = {
  status: 'available' | 'not_found' | 'unavailable' | 'not_configured'
  candidates: PublicRoleCandidate[]; total: number; truncated: boolean; error?: string
}

/** Deployment-owned destination. Public discovery never forwards learner credentials or installs packages. */
export async function discoverPublicRolePackages(input: {
  baseUrl?: string; query: string; target?: 'role' | 'task' | 'all'; roleQuery?: string; signal?: AbortSignal; limit?: number; fetchImpl?: typeof fetch
}): Promise<HubDiscovery> {
  if (!input.baseUrl?.trim()) return { status: 'not_configured', candidates: [], total: 0, truncated: false }
  try {
    const base = new URL(input.baseUrl)
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('hub_url_invalid')
    const endpoint = new URL('/api/hub/search', base)
    endpoint.searchParams.set('q', input.query.slice(0, 500))
    endpoint.searchParams.set('target', input.target || 'all')
    if (input.roleQuery) endpoint.searchParams.set('role', input.roleQuery.slice(0, 500))
    endpoint.searchParams.set('limit', String(Math.min(10, Math.max(1, input.limit || 5))))
    const timeout = AbortSignal.timeout(8_000)
    const response = await (input.fetchImpl || fetch)(endpoint, { redirect: 'error', credentials: 'omit',
      headers: { accept: 'application/json' }, signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout })
    if (!response.ok || !response.body) throw new Error(`hub_http_${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > 1_048_576) { await reader.cancel(); throw new Error('hub_response_too_large') }
        text += decoder.decode(chunk.value, { stream: true })
      }
      text += decoder.decode()
    } finally { reader.releaseLock() }
    const payload = JSON.parse(text) as { protocol?: unknown; status?: unknown; total?: unknown; items?: unknown }
    if (payload.protocol !== 'graph-hub.discovery.v1' || !['available', 'not_found'].includes(String(payload.status))
      || !Array.isArray(payload.items) || payload.items.length > 100 || !Number.isInteger(payload.total) || Number(payload.total) < 0) throw new Error('hub_response_invalid')
    const candidates = payload.items.slice(0, 10).map(value => {
      const item = value as Record<string, unknown>
      const release = item.release as Record<string, unknown> | undefined
      const required = [item.id, item.packageId, item.title, release?.packageVersion, release?.snapshotId, release?.rootHash]
      if (!required.every(value => typeof value === 'string' && value.length > 0 && value.length <= 500)
        || !/^[a-f0-9]{64}$/u.test(String(release?.rootHash))) throw new Error('hub_identity_invalid')
      const matchedTasks = (Array.isArray(item.matchedTasks) ? item.matchedTasks : []).slice(0, 6).map(raw => {
        const task = raw as Record<string, unknown>
        if (!task || typeof task.id !== 'string' || !task.id || task.id.length > 500 || typeof task.label !== 'string'
          || !['task', 'typical_task'].includes(String(task.type))) throw new Error('hub_task_invalid')
        return { id: task.id, label: task.label.slice(0, 500), type: String(task.type), summary: String(task.summary || '').slice(0, 2000) }
      })
      if (input.target === 'task' && !matchedTasks.length) throw new Error('hub_task_matches_missing')
      return { matchedTasks, matchedTaskCount: Number.isInteger(item.matchedTaskCount) && Number(item.matchedTaskCount) >= matchedTasks.length ? Number(item.matchedTaskCount) : matchedTasks.length, packageId: String(item.packageId), roleTitle: String(item.title), packageVersion: String(release!.packageVersion),
        snapshotId: String(release!.snapshotId), rootHash: String(release!.rootHash), summary: String(item.summary || '').slice(0, 2000),
        repositoryUrl: new URL(`/hub/${encodeURIComponent(String(item.id))}`, base).toString(),
        reasons: Array.isArray(item.reasons) ? item.reasons.filter((reason): reason is string => typeof reason === 'string').slice(0, 6).map(reason => reason.slice(0, 500)) : [],
        availability: 'available_not_installed' as const }
    })
    const total = Number(payload.total)
    if (total < payload.items.length
      || (payload.status === 'not_found' && (total !== 0 || candidates.length !== 0))
      || (payload.status === 'available' && (total === 0 || candidates.length === 0))) throw new Error('hub_response_inconsistent')
    return { status: candidates.length ? 'available' : 'not_found', candidates, total: Number(payload.total), truncated: Number(payload.total) > candidates.length }
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason
    return { status: 'unavailable', candidates: [], total: 0, truncated: false, error: error instanceof Error ? error.message : 'hub_discovery_failed' }
  }
}

export function withHubDiscovery(installed: PluginToolResult, hub: HubDiscovery, query: string): PluginToolResult {
  const payload = (installed.payload || {}) as Record<string, PluginJson>
  const packages = Array.isArray(payload.packages) ? payload.packages as Array<Record<string, PluginJson>> : []
  const available = hub.candidates.filter(candidate => !packages.some(item => item.packageId === candidate.packageId
    && item.packageVersion === candidate.packageVersion && item.snapshotId === candidate.snapshotId && item.rootHash === candidate.rootHash))
  const matchStatus = packages.length ? payload.matchStatus : available.length ? 'available_not_installed'
    : hub.status === 'unavailable' || hub.status === 'not_configured' ? 'discovery_unavailable' : 'not_found'
  const summary = packages.length ? `${installed.summary}${available.length ? ` Hub 另有 ${available.length} 个可用发布版本。` : ''}`
    : available.length ? `Graph Hub 找到 ${available.length} 个与“${query}”相关的已发布岗位包，当前运行环境尚未加载。请打开仓库选择“在 LearnFlow 中使用”；不得把这些包说成不存在。`
      : matchStatus === 'discovery_unavailable' ? `当前运行环境未找到匹配岗位包，且 Graph Hub 检索${hub.status === 'not_configured' ? '尚未配置' : '暂时不可用'}，因此不能判断仓库是否存在该岗位包。`
        : `当前已加载岗位包和 Graph Hub 公开仓库均未找到与“${query}”匹配的岗位包。`
  return { ...installed, summary, payload: { ...payload, matchStatus, hubStatus: hub.status,
    availablePackages: available as unknown as PluginJson, hubTotal: hub.total, hubTruncated: hub.truncated,
    discoveryBoundary: '已加载与可发现分开；远程发现不安装、不替用户确认、不写学习状态。未加载版本必须先通过仓库进入 LearnFlow。',
  } }
}
