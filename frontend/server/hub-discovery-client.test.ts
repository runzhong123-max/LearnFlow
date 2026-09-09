import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverPublicRolePackages, withHubDiscovery } from '../plugins/role_capability_graph/hub-discovery-client.ts'
import { loadLearnFlowPluginRegistry } from './plugin-loader.ts'
import { resolve } from 'node:path'

const item = { id: 'line:test', packageId: 'pkg:test', title: '软件测试工程师', summary: '开展软件质量保障', reasons: ['匹配岗位名称或包 ID'],
  release: { packageVersion: '1.0.0', snapshotId: 'snap:test', rootHash: 'a'.repeat(64) } }
const installed = { summary: '当前目录无匹配', objects: [], payload: { packages: [], matchStatus: 'not_found', kind: 'role_package_catalog' } }

test('public discovery queries the configured Hub API without cookies and preserves pinned identity', async () => {
  let requestUrl = ''
  const result = await discoverPublicRolePackages({ baseUrl: 'https://graphs.example.test', query: '软件测试工程师', fetchImpl: async (url, options) => {
    requestUrl = String(url)
    assert.equal(options?.credentials, 'omit')
    assert.equal(new Headers(options?.headers).has('cookie'), false)
    assert.equal(options?.redirect, 'error')
    return Response.json({ protocol: 'graph-hub.discovery.v1', status: 'available', items: [item], total: 1 })
  } })
  assert.equal(new URL(requestUrl).pathname, '/api/hub/search')
  assert.equal(new URL(requestUrl).searchParams.get('q'), '软件测试工程师')
  assert.equal(result.candidates[0].rootHash, item.release.rootHash)
  assert.equal(result.candidates[0].repositoryUrl, 'https://graphs.example.test/hub/line%3Atest')
  const merged = withHubDiscovery(installed, result, '软件测试工程师')
  assert.equal((merged.payload as any).matchStatus, 'available_not_installed')
  assert.equal(merged.objects?.length, 0)
  assert.match(merged.summary, /尚未加载/)
})

test('upstream failure, malformed identity and missing configuration must not become a not-found answer', async () => {
  for (const fetchImpl of [async () => new Response('bad gateway', { status: 502 }), async () => Response.json({ protocol: 'graph-hub.discovery.v1', status: 'available', items: [{ ...item, release: { ...item.release, rootHash: 'invalid' } }], total: 1 })]) {
    const result = await discoverPublicRolePackages({ baseUrl: 'https://graphs.example.test', query: '测试', fetchImpl })
    assert.equal(result.status, 'unavailable')
    assert.equal((withHubDiscovery(installed, result, '测试').payload as any).matchStatus, 'discovery_unavailable')
  }
  const missing = await discoverPublicRolePackages({ query: '测试' })
  assert.equal(missing.status, 'not_configured')
  assert.equal((withHubDiscovery(installed, missing, '测试').payload as any).matchStatus, 'discovery_unavailable')
})

test('same package and version but a different snapshot is not collapsed, and discovery never fabricates an installed object', () => {
  const candidate = { packageId: item.packageId, packageVersion: item.release.packageVersion, snapshotId: item.release.snapshotId, rootHash: item.release.rootHash,
    roleTitle: item.title, summary: '', repositoryUrl: 'https://graphs.example.test/hub/line', reasons: [], availability: 'available_not_installed' as const }
  const existing = { ...installed, payload: { packages: [{ ...candidate, snapshotId: 'snap:other' }], matchStatus: 'matched' } }
  const result = withHubDiscovery(existing, { status: 'available', candidates: [candidate], total: 1, truncated: false }, '测试')
  assert.equal((result.payload as any).availablePackages.length, 1)
})

test('inconsistent counts and availability are rejected rather than reported as missing repositories', async () => {
  for (const response of [
    { status: 'not_found', items: [item], total: 0 },
    { status: 'available', items: [], total: 0 },
    { status: 'available', items: [item, item], total: 1 },
    { status: 'not_found', items: [], total: 3 },
  ]) {
    const result = await discoverPublicRolePackages({ baseUrl: 'https://graphs.example.test', query: '测试',
      fetchImpl: async () => Response.json({ protocol: 'graph-hub.discovery.v1', ...response }) })
    assert.equal(result.status, 'unavailable')
    assert.equal(result.error, 'hub_response_inconsistent')
  }
})

test('plugin tool integrates public discovery even when no matching local package exists', async context => {
  const previous = process.env.LEARNFLOW_GRAPH_HUB_BASE_URL
  process.env.LEARNFLOW_GRAPH_HUB_BASE_URL = 'https://graphs.example.test'
  context.mock.method(globalThis, 'fetch', async () => Response.json({ protocol: 'graph-hub.discovery.v1', status: 'available', items: [item], total: 1 }))
  try {
    const registry = await loadLearnFlowPluginRegistry(resolve(process.cwd(), 'plugins'))
    const result = await registry.execute('role_capability_graph__list_role_packages', { query: '软件测试工程师' }, {
      mode: 'simple_explain', activePluginIds: ['role_capability_graph'], scope: { mode: 'simple_explain', learnerId: 7, conversationId: 'test-discovery' }, signal: AbortSignal.timeout(5_000),
    })
    const payload = result.result.payload as any
    assert.equal(payload.matchStatus, 'available_not_installed')
    assert.equal(payload.packages.length, 0)
    assert.equal(payload.availablePackages[0].snapshotId, 'snap:test')
    assert.equal(result.result.presentation?.renderer, 'role_capability_graph:role_package_catalog')
  } finally {
    if (previous === undefined) delete process.env.LEARNFLOW_GRAPH_HUB_BASE_URL
    else process.env.LEARNFLOW_GRAPH_HUB_BASE_URL = previous
  }
})

test('task queries use the shared endpoint and preserve task identity together with its release', async () => {
  const matchedTasks = [{ id: 'task:backup', label: '数据库备份恢复', type: 'task', summary: '校验恢复结果' }]
  const result = await discoverPublicRolePackages({ baseUrl: 'https://graphs.example.test', query: '数据库备份恢复', target: 'task', roleQuery: '云运维工程师', fetchImpl: async url => {
    assert.equal(new URL(String(url)).searchParams.get('target'), 'task')
    assert.equal(new URL(String(url)).searchParams.get('role'), '云运维工程师')
    return Response.json({ protocol: 'graph-hub.discovery.v1', status: 'available', total: 1, items: [{ ...item, matchedTasks, matchedTaskCount: 8 }] })
  } })
  assert.deepEqual(result.candidates[0].matchedTasks, matchedTasks)
  assert.equal(result.candidates[0].matchedTaskCount, 8)
  assert.equal(result.candidates[0].snapshotId, item.release.snapshotId)
  const oldServer = await discoverPublicRolePackages({ baseUrl: 'https://graphs.example.test', query: '数据库备份恢复', target: 'task', fetchImpl: async () => Response.json({ protocol: 'graph-hub.discovery.v1', status: 'available', total: 1, items: [item] }) })
  assert.equal(oldServer.status, 'unavailable')
})
