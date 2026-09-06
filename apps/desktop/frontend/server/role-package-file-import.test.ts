import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { installRolePackageFile, inspectRolePackageFile } from '../plugins/role_capability_graph/package-file.ts'
import { RolePackageRuntime } from '../plugins/role_capability_graph/runtime.ts'

const installedPackage = resolve('plugins/role_capability_graph/data/packages/llm-app-engineer/1.0.0')

async function transferFile(root: string) {
  const manifest = JSON.parse(await readFile(join(installedPackage, 'manifest.json'), 'utf8'))
  const components = Object.fromEntries(await Promise.all(Object.keys(manifest.hashes).map(async path => [
    path,
    await readFile(join(installedPackage, path), 'utf8'),
  ])))
  const file = join(root, 'llm-app-engineer.role-package.json')
  await writeFile(file, JSON.stringify({ manifest, components }), 'utf8')
  return file
}

test('role-agent 单文件 bundle 经独立校验后原子安装并可被岗位 runtime 发现', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learnflow-role-import-'))
  const packageRoot = join(root, 'packages')
  const file = await transferFile(root)
  const inspected = await inspectRolePackageFile(file)
  assert.equal(inspected.receipt.packageVersion, '1.0.0')

  const first = await installRolePackageFile({ packageFile: file, packageRoot })
  assert.equal(first.installed, true)
  const runtime = new RolePackageRuntime(packageRoot)
  assert.equal(runtime.packages.length, 1)
  assert.equal(runtime.packages[0].manifest.rootHash, first.rootHash)

  const repeated = await installRolePackageFile({ packageFile: file, packageRoot })
  assert.equal(repeated.installed, false)
  assert.equal(repeated.packagePath, first.packagePath)
})

test('dry-run 不写盘，组件篡改与路径穿越均在安装前失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'learnflow-role-import-invalid-'))
  const file = await transferFile(root)
  const dryRun = await installRolePackageFile({ packageFile: file, packageRoot: join(root, 'packages'), dryRun: true })
  assert.equal(dryRun.dryRun, true)

  const tampered = JSON.parse(await readFile(file, 'utf8'))
  tampered.components['semantic-graph.json'] = '{}'
  await writeFile(file, JSON.stringify(tampered), 'utf8')
  await assert.rejects(inspectRolePackageFile(file), /role_package_file_hash_mismatch/)

  const unsafe = await transferFile(root)
  const unsafeBundle = JSON.parse(await readFile(unsafe, 'utf8'))
  unsafeBundle.manifest.entrypoints.snapshot = '../snapshot.json'
  await writeFile(unsafe, JSON.stringify(unsafeBundle), 'utf8')
  await assert.rejects(inspectRolePackageFile(unsafe), /role_package_file_invalid:entrypoint:snapshot/)
})
