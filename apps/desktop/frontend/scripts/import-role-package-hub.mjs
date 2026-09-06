import { resolve } from 'node:path'
import { installRolePackageFromHub } from '../plugins/role_capability_graph/hub-catalog.ts'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const catalogFile = argument('--catalog')
const packageId = argument('--package')
if (!catalogFile || !packageId) {
  console.error('用法：npm run role:import-hub -- --catalog <hub/catalog.json> --package <packageId> [--version <SemVer>] [--actor-subject <subject>] [--root <目录>] [--dry-run]')
  process.exitCode = 2
} else {
  const receipt = await installRolePackageFromHub({
    catalogFile: resolve(catalogFile),
    packageId,
    packageVersion: argument('--version'),
    actorSubjectId: argument('--actor-subject'),
    packageRoot: argument('--root') ? resolve(argument('--root')) : undefined,
    dryRun: process.argv.includes('--dry-run'),
  })
  console.log(JSON.stringify(receipt, null, 2))
}
