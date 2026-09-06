import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { inspectRolePackageHubCatalog, installRolePackageFromHub } from '../plugins/role_capability_graph/hub-catalog.ts'
import { RolePackageRuntime } from '../plugins/role_capability_graph/runtime.ts'

const installedPackage = resolve('plugins/role_capability_graph/data/packages/llm-app-engineer/1.0.0')

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return typeof value === 'string' ? value.normalize('NFC') : value
}

async function hubFixture(visibility: 'private' | 'public', ownerSubjectId = 'user:alice') {
  const hub = await mkdtemp(join(tmpdir(), 'learnflow-role-hub-'))
  const manifest = JSON.parse(await readFile(join(installedPackage, 'manifest.json'), 'utf8'))
  const components = Object.fromEntries(await Promise.all(Object.keys(manifest.hashes).map(async path => [path, await readFile(join(installedPackage, path), 'utf8')])))
  const objectPath = `objects/sha256/${manifest.rootHash}.role-package.json`
  await mkdir(join(hub, 'objects', 'sha256'), { recursive: true })
  await writeFile(join(hub, objectPath), JSON.stringify({ manifest, components }), 'utf8')
  const core = {
    protocol: 'role-package-hub-catalog.v1',
    generatedAt: new Date().toISOString(),
    entries: [{
      packageId: manifest.packageId,
      packageVersion: manifest.packageVersion,
      snapshotId: manifest.snapshotId,
      rootHash: manifest.rootHash,
      roleTitle: manifest.roleTitle,
      ownerSubjectId,
      maintainerName: 'Alice',
      channel: 'community',
      visibility,
      review: visibility === 'public' ? 'approved' : 'not_required_private',
      objectPath,
      publishedAt: new Date().toISOString(),
    }],
  }
  const rootHash = createHash('sha256').update(JSON.stringify(canonical({ ...core, generatedAt: '', rootHash: '' }))).digest('hex')
  const catalog = join(hub, 'catalog.json')
  await writeFile(catalog, JSON.stringify({ ...core, rootHash }), 'utf8')
  return { catalog, manifest }
}

test('公共审核包可从 Hub 目录安装并被岗位插件发现', async () => {
  const { catalog, manifest } = await hubFixture('public')
  const packageRoot = await mkdtemp(join(tmpdir(), 'learnflow-role-hub-install-'))
  const receipt = await installRolePackageFromHub({ catalogFile: catalog, packageId: manifest.packageId, packageRoot })
  assert.equal(receipt.installed, true)
  assert.equal(receipt.review, 'approved')
  assert.equal(new RolePackageRuntime(packageRoot).packages[0].manifest.rootHash, manifest.rootHash)
})

test('私有包仅所有者可见，目录篡改在安装前失败', async () => {
  const { catalog, manifest } = await hubFixture('private')
  assert.equal((await inspectRolePackageHubCatalog(catalog)).visibleEntries.length, 0)
  assert.equal((await inspectRolePackageHubCatalog(catalog, 'user:alice')).visibleEntries.length, 1)
  await assert.rejects(installRolePackageFromHub({ catalogFile: catalog, packageId: manifest.packageId }), /release_not_visible/u)
  const tampered = JSON.parse(await readFile(catalog, 'utf8'))
  tampered.entries[0].review = 'approved'
  await writeFile(catalog, JSON.stringify(tampered), 'utf8')
  await assert.rejects(inspectRolePackageHubCatalog(catalog, 'user:alice'), /private_review|root_hash_mismatch/u)

  tampered.entries[0].review = 'not_required_private'
  tampered.entries[0].visibility = 'owner_only'
  tampered.rootHash = createHash('sha256').update(JSON.stringify(canonical({ ...tampered, generatedAt: '', rootHash: '' }))).digest('hex')
  await writeFile(catalog, JSON.stringify(tampered), 'utf8')
  await assert.rejects(inspectRolePackageHubCatalog(catalog, 'user:alice'), /entry_channel_visibility/u)
})
