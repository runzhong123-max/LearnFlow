import { resolve } from 'node:path'
import { installRolePackageFile } from '../plugins/role_capability_graph/package-file.ts'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const packageFile = argument('--file')
const packageRoot = argument('--root')
const dryRun = process.argv.includes('--dry-run')

if (!packageFile) {
  console.error('用法：npm run role:import-file -- --file <*.role-package.json> [--root <岗位包目录>] [--dry-run]')
  process.exitCode = 2
} else {
  const receipt = await installRolePackageFile({
    packageFile: resolve(packageFile),
    packageRoot: packageRoot ? resolve(packageRoot) : undefined,
    dryRun,
  })
  console.log(JSON.stringify(receipt, null, 2))
}
