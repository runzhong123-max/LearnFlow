import { resolve } from 'node:path'
import { installRolePackageFromRelease } from '../plugins/role_capability_graph/release-install.ts'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const releaseId = argument('--release')
const baseUrl = argument('--base') || process.env.ROLE_ATLAS_PUBLIC_URL
const packageRoot = argument('--root')
const dryRun = process.argv.includes('--dry-run')

if (!releaseId || !baseUrl) {
  console.error('用法：npm run role:import-release -- --release <releaseId> [--base <Role Atlas 地址>] [--root <岗位包目录>] [--dry-run]')
  console.error('base 默认取 ROLE_ATLAS_PUBLIC_URL。只接受 HTTPS，localhost/127.0.0.1 可用 HTTP。')
  process.exitCode = 2
} else {
  try {
    const receipt = await installRolePackageFromRelease({
      baseUrl,
      releaseId,
      packageRoot: packageRoot ? resolve(packageRoot) : undefined,
      dryRun,
    })
    console.log(JSON.stringify(receipt, null, 2))
  } catch (error) {
    // Operator-facing CLI: report the reason, not a stack trace.
    console.error(`安装未完成：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
