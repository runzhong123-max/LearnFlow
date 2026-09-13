import { createHash } from 'node:crypto'
import { checkedRolePackageRef, sameRolePackageRef, type RolePackageRef } from './reference.ts'
export type RolePackageBundle = {
  manifest: RolePackageRef & { packageProtocol: string; protocolVersion: string; entrypoints: Record<string, string>; hashes: Record<string, string>; [key: string]: unknown }
  components: Record<string, string>
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  return typeof value === 'string' ? value.normalize('NFC') : value
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
/** Validate the exact published bytes before constructing a request-local reading runtime. */
export function checkedRolePackageBundle(value: unknown, expected?: RolePackageRef): RolePackageBundle {
  const bundle = value as RolePackageBundle
  const manifest = bundle?.manifest
  const actual = checkedRolePackageRef(manifest)
  if (expected && !sameRolePackageRef(actual, expected)) throw new Error('role_package_root_hash_mismatch')
  if (manifest.packageProtocol !== 'static-role-package' || !['2.0.0', '3.0.0', '3.1.0'].includes(manifest.protocolVersion)
    || !manifest.entrypoints || !manifest.hashes || !bundle.components
    || hash(JSON.stringify(canonical({ ...manifest, rootHash: '' }))) !== manifest.rootHash) throw new Error('role_package_integrity_failed:manifest')
  const paths = Object.keys(manifest.hashes)
  if (!paths.length || paths.length > 100 || paths.length !== Object.keys(bundle.components).length
    || Object.values(manifest.entrypoints).some(path => !Object.hasOwn(manifest.hashes, path))) throw new Error('role_package_integrity_failed:components')
  for (const path of paths) {
    if (!path || path.includes('..') || path.startsWith('/') || typeof bundle.components[path] !== 'string'
      || hash(bundle.components[path]) !== manifest.hashes[path]) throw new Error('role_package_integrity_failed:component_hash')
  }
  const snapshot = JSON.parse(bundle.components[manifest.entrypoints.snapshot])
  if (snapshot?.snapshot?.id !== manifest.snapshotId) throw new Error('role_package_integrity_failed:snapshot')
  return bundle
}
