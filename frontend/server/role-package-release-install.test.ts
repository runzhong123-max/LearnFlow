import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { installRolePackageFromRelease } from '../plugins/role_capability_graph/release-install.ts'
import { RolePackageRuntime } from '../plugins/role_capability_graph/runtime.ts'

const installedPackage = resolve('plugins/role_capability_graph/data/packages/llm-app-engineer/1.0.0')

/** An empty root makes the runtime constructor throw, so absence is checked on disk. */
async function installedPackageCount(root: string) {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).length
  } catch {
    return 0
  }
}

/** The same canonical bundle shape the Role Atlas export route returns. */
async function releaseBundle() {
  const manifest = JSON.parse(await readFile(join(installedPackage, 'manifest.json'), 'utf8'))
  const components = Object.fromEntries(await Promise.all(Object.keys(manifest.hashes).map(async path => [
    path,
    await readFile(join(installedPackage, path), 'utf8'),
  ])))
  return JSON.stringify({ manifest, components })
}

function exportStub(body: string, init: { status?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit || {} })
    if (init.status && init.status >= 400) return new Response('denied', { status: init.status })
    return new Response(body, { status: 200, headers: { 'content-type': 'application/vnd.role-atlas.package+json' } })
  }) as typeof fetch
  return { calls, fetchImpl }
}

async function packageRoot() {
  return join(await mkdtemp(join(tmpdir(), 'learnflow-release-install-')), 'packages')
}

test('release 导出可被下载、独立校验并原子安装到本地包根', async () => {
  const root = await packageRoot()
  const { calls, fetchImpl } = exportStub(await releaseBundle())
  const receipt = await installRolePackageFromRelease({
    baseUrl: 'https://roles.example',
    releaseId: 'release:00000000-1111-2222-3333-444444444444',
    packageRoot: root,
    fetchImpl,
  })
  assert.equal(receipt.installed, true)
  assert.equal(receipt.source, 'role_atlas_release_export')
  assert.equal(receipt.releaseId, 'release:00000000-1111-2222-3333-444444444444')
  assert.equal(receipt.packageVersion, '1.0.0')

  // 读取端点必须带 format=json，且不得携带学习者凭据或跟随重定向。
  assert.equal(calls.length, 1)
  const requested = new URL(calls[0].url)
  assert.equal(requested.pathname, '/api/releases/release%3A00000000-1111-2222-3333-444444444444/export')
  assert.equal(requested.searchParams.get('format'), 'json')
  assert.equal(calls[0].init.credentials, 'omit')
  assert.equal(calls[0].init.redirect, 'error')

  // 装完之后普通岗位 runtime 必须能按根哈希发现它。
  const runtime = new RolePackageRuntime(root)
  assert.equal(runtime.packages.length, 1)
  assert.equal(runtime.packages[0].manifest.rootHash, receipt.rootHash)

  // 同一份内容重复安装保持幂等，不会产生第二个副本。
  const repeated = await installRolePackageFromRelease({
    baseUrl: 'https://roles.example',
    releaseId: 'release:00000000-1111-2222-3333-444444444444',
    packageRoot: root,
    fetchImpl,
  })
  assert.equal(repeated.installed, false)
  assert.equal(repeated.packagePath, receipt.packagePath)
  assert.equal(new RolePackageRuntime(root).packages.length, 1)
})

test('同版本不同内容在安装前被拒绝，不会覆盖已装岗位包', async () => {
  const root = await packageRoot()
  const good = await releaseBundle()
  await installRolePackageFromRelease({
    baseUrl: 'https://roles.example', releaseId: 'release:same', packageRoot: root,
    fetchImpl: exportStub(good).fetchImpl,
  })
  const tampered = JSON.parse(good)
  // 改内容但保留版本号：内容寻址身份必须拒绝这种“换字节不换版本”的替换。
  tampered.components['semantic-graph.json'] = '{"nodes":[],"edges":[]}'
  delete tampered.manifest.hashes['semantic-graph.json']
  tampered.manifest.hashes['semantic-graph.json'] = '0'.repeat(64)
  tampered.manifest.rootHash = '1'.repeat(64)
  const { fetchImpl } = exportStub(JSON.stringify(tampered))
  await assert.rejects(
    installRolePackageFromRelease({ baseUrl: 'https://roles.example', releaseId: 'release:same', packageRoot: root, fetchImpl }),
    /role_package_file_hash_mismatch|role_package_version_conflict/u,
  )
})

test('传输中篡改的组件在安装前失败，不留下任何岗位包', async () => {
  const root = await packageRoot()
  const bundle = JSON.parse(await releaseBundle())
  bundle.components['sources.json'] = '{"assets":[],"segments":[],"evidenceBindings":[]}'
  await assert.rejects(
    installRolePackageFromRelease({
      baseUrl: 'https://roles.example', releaseId: 'release:tampered', packageRoot: root,
      fetchImpl: exportStub(JSON.stringify(bundle)).fetchImpl,
    }),
    /role_package_file_hash_mismatch/u,
  )
  assert.equal(await installedPackageCount(root), 0)
})

test('不可信来源、非法 release id、拒绝访问与超大响应全部失败关闭', async () => {
  const root = await packageRoot()
  const bundle = await releaseBundle()
  const base = { baseUrl: 'https://roles.example', packageRoot: root, fetchImpl: exportStub(bundle).fetchImpl }

  // 明文 HTTP 只允许 loopback；其它主机一律拒绝，避免岗位包在链路上被替换。
  await assert.rejects(
    installRolePackageFromRelease({ ...base, baseUrl: 'http://roles.example', releaseId: 'release:one' }),
    /role_package_release_url_invalid/u,
  )
  await assert.rejects(
    installRolePackageFromRelease({ ...base, baseUrl: 'https://user:secret@roles.example', releaseId: 'release:one' }),
    /role_package_release_url_invalid/u,
  )
  // release id 直接进入 URL 路径，必须拒绝穿越与注入字符。
  for (const releaseId of ['../projects', 'release/../../etc', 'release one', '']) {
    await assert.rejects(
      installRolePackageFromRelease({ ...base, releaseId }),
      /role_package_release_id_invalid/u,
    )
  }
  // 端点已按 visible 强制授权：私包匿名返回 401，这里必须原样失败而不是静默降级。
  await assert.rejects(
    installRolePackageFromRelease({ ...base, releaseId: 'release:private', fetchImpl: exportStub('', { status: 401 }).fetchImpl }),
    /role_package_release_http_401/u,
  )
  const oversize = new ReadableStream({
    start(controller) {
      for (let index = 0; index < 21; index += 1) controller.enqueue(new Uint8Array(1024 * 1024))
      controller.close()
    },
  })
  await assert.rejects(
    installRolePackageFromRelease({
      ...base, releaseId: 'release:huge',
      fetchImpl: (async () => new Response(oversize, { status: 200 })) as typeof fetch,
    }),
    /role_package_release_too_large/u,
  )
  assert.equal(await installedPackageCount(root), 0)
})
