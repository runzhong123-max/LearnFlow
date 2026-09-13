import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { RolePackageRuntime } from '../plugins/role_capability_graph/runtime.ts'

const bundledRoot = resolve('plugins/role_capability_graph/data/packages')

function runtime() {
  return new RolePackageRuntime(bundledRoot)
}

/**
 * A pinned reference that cannot resolve must fail *terminally*. The message is
 * the only thing the caller sees, so it has to say what is installed and which
 * operator action fixes it — otherwise the failure looks transient and the
 * caller retries other body-dependent tools in a loop.
 */
test('不可解析的引用给出终止性说明：已装清单与安装命令', () => {
  const installed = runtime().packages[0].manifest
  let failure: Error | undefined
  try {
    runtime().resolve({ packageId: 'role-package:not-installed', packageVersion: '9.9.9', snapshotId: 'snapshot:none' })
  } catch (error) {
    failure = error as Error
  }
  assert.ok(failure, '未安装的引用必须失败')
  assert.match(failure.message, /^role_package_not_found:/u)
  // 明确指出重试不会成功，并给出唯一的运维动作。
  assert.match(failure.message, /重试读取不会成功/u)
  assert.match(failure.message, /npm run role:import-release/u)
  // 请求的身份与已安装清单都必须在消息里，便于直接判断改选哪一个。
  assert.match(failure.message, /role-package:not-installed \/ 9\.9\.9 \/ snapshot:none/u)
  assert.match(failure.message, new RegExp(installed.packageId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  assert.match(failure.message, new RegExp(installed.snapshotId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
})

test('内容哈希不符与“未安装”区分开，并说明不能沿用旧引用', () => {
  const target = runtime().packages[0].manifest
  let failure: Error | undefined
  try {
    runtime().resolve({ packageId: target.packageId, packageVersion: target.packageVersion, snapshotId: target.snapshotId, rootHash: '0'.repeat(64) })
  } catch (error) {
    failure = error as Error
  }
  assert.ok(failure, '内容哈希不符必须失败')
  assert.match(failure.message, /^role_package_root_hash_mismatch:/u)
  assert.match(failure.message, /内容哈希不同/u)
  assert.doesNotMatch(failure.message, /未安装/u)
})

test('解析成功的引用不受影响，且省略 rootHash 仍保持既有行为', () => {
  const target = runtime().packages[0].manifest
  const selector = { packageId: target.packageId, packageVersion: target.packageVersion, snapshotId: target.snapshotId }
  assert.equal(runtime().resolve(selector).manifest.rootHash, target.rootHash)
  assert.equal(runtime().resolve({ ...selector, rootHash: target.rootHash }).manifest.rootHash, target.rootHash)
})
