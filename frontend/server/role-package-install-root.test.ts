import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { installRolePackageFile } from '../plugins/role_capability_graph/package-file.ts'
import { defaultPackageSources, RolePackageRuntime } from '../plugins/role_capability_graph/runtime.ts'

const installedPackage = resolve('plugins/role_capability_graph/data/packages/llm-app-engineer/1.0.0')

async function bundleFile(root: string) {
  const manifest = JSON.parse(await readFile(join(installedPackage, 'manifest.json'), 'utf8'))
  const components = Object.fromEntries(await Promise.all(Object.keys(manifest.hashes).map(async path => [
    path,
    await readFile(join(installedPackage, path), 'utf8'),
  ])))
  const file = join(root, 'release.role-package.json')
  await writeFile(file, JSON.stringify({ manifest, components }), 'utf8')
  return file
}

/** Runs `body` with LEARNFLOW_ROLE_PACKAGE_HOME set to a fresh directory. */
async function withPackageHome<T>(body: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env.LEARNFLOW_ROLE_PACKAGE_HOME
  const home = join(await mkdtemp(join(tmpdir(), 'learnflow-role-home-')), 'packages')
  process.env.LEARNFLOW_ROLE_PACKAGE_HOME = home
  try {
    return await body(home)
  } finally {
    if (previous === undefined) delete process.env.LEARNFLOW_ROLE_PACKAGE_HOME
    else process.env.LEARNFLOW_ROLE_PACKAGE_HOME = previous
  }
}

test('未配置可写包根时不引入 installed 来源，保持既有解析行为', async () => {
  const previous = process.env.LEARNFLOW_ROLE_PACKAGE_HOME
  delete process.env.LEARNFLOW_ROLE_PACKAGE_HOME
  try {
    const sources = defaultPackageSources()
    assert.equal(sources.filter(source => source.sourceKind === 'installed').length, 0)
    assert.equal(sources[0].sourceKind, 'official_builtin')
  } finally {
    if (previous !== undefined) process.env.LEARNFLOW_ROLE_PACKAGE_HOME = previous
  }
})

test('安装到可写包根的岗位包会作为 installed 来源被发现，否则引用永远解析不到', async () => {
  const staging = await mkdtemp(join(tmpdir(), 'learnflow-role-staging-'))
  const file = await bundleFile(staging)
  await withPackageHome(async home => {
    // 不显式指定 root 时，安装必须落到可写包根，而不是只读的内置目录。
    const receipt = await installRolePackageFile({ packageFile: file })
    assert.equal(receipt.installed, true)
    assert.equal(resolve(receipt.packageRoot), resolve(home))
    assert.ok(resolve(receipt.packagePath).startsWith(`${resolve(home)}/`))

    const sources = defaultPackageSources()
    const installed = sources.filter(source => source.sourceKind === 'installed')
    assert.equal(installed.length, 1)
    assert.equal(resolve(installed[0].root), resolve(home))
    assert.equal(installed[0].accessScope, 'installed')

    // 默认来源构造出的运行时必须真的扫到这个目录。
    const runtime = new RolePackageRuntime()
    assert.ok(runtime.packages.length >= 1)
    assert.deepEqual(runtime.discoveryIssues, [])
  })
})

test('显式 packageRoot 仍然优先，不被可写包根覆盖', async () => {
  const staging = await mkdtemp(join(tmpdir(), 'learnflow-role-staging-'))
  const file = await bundleFile(staging)
  const explicit = join(await mkdtemp(join(tmpdir(), 'learnflow-role-explicit-')), 'packages')
  await withPackageHome(async home => {
    const receipt = await installRolePackageFile({ packageFile: file, packageRoot: explicit })
    assert.equal(resolve(receipt.packageRoot), resolve(explicit))
    assert.notEqual(resolve(receipt.packageRoot), resolve(home))
  })
})
