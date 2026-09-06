import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_PACKAGE_BYTES = 20 * 1024 * 1024
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const REQUIRED_ENTRYPOINTS = [
  'snapshot',
  'sources',
  'semanticGraph',
  'workProcessForest',
  'views',
  'objectIndex',
  'retrieval',
  'validation',
  'referenceMigrations',
] as const

type RolePackageManifest = {
  packageProtocol: 'static-role-package'
  protocolVersion: '3.0.0'
  packageId: string
  packageVersion: string
  snapshotId: string
  snapshotAsOf: string
  roleTitle: string
  entrypoints: Record<string, string>
  hashes: Record<string, string>
  rootHash: string
  [key: string]: unknown
}

type RolePackageFileBundle = {
  manifest: RolePackageManifest
  components: Record<string, string>
}

export const BUILTIN_ROLE_PACKAGE_ROOT = fileURLToPath(new URL('./data/packages', import.meta.url))

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]))
  }
  if (typeof value === 'string') return value.normalize('NFC')
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('role_package_file_invalid:non_finite_number')
  return value
}

function canonicalStringify(value: unknown) {
  return JSON.stringify(canonicalValue(value))
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function safeComponentPath(path: string) {
  return Boolean(path && !isAbsolute(path) && !path.includes('..') && !path.includes('\\'))
}

function asRecord(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`role_package_file_invalid:${label}`)
  return value as Record<string, unknown>
}

function validateBundle(value: unknown): RolePackageFileBundle {
  const envelope = asRecord(value, 'envelope')
  const manifest = asRecord(envelope.manifest, 'manifest') as RolePackageManifest
  const components = asRecord(envelope.components, 'components') as Record<string, string>
  if (manifest.packageProtocol !== 'static-role-package' || manifest.protocolVersion !== '3.0.0') {
    throw new Error('role_package_file_invalid:unsupported_protocol')
  }
  if (!manifest.packageId || !manifest.snapshotId || !manifest.rootHash || !SEMVER.test(manifest.packageVersion || '')) {
    throw new Error('role_package_file_invalid:identity')
  }
  const componentPaths = Object.keys(components).sort()
  const hashPaths = Object.keys(manifest.hashes || {}).sort()
  if (componentPaths.length !== hashPaths.length || componentPaths.some((path, index) => path !== hashPaths[index])) {
    throw new Error('role_package_file_invalid:component_set')
  }
  for (const key of REQUIRED_ENTRYPOINTS) {
    const path = manifest.entrypoints?.[key]
    if (!safeComponentPath(path) || !manifest.hashes[path]) throw new Error(`role_package_file_invalid:entrypoint:${key}`)
  }
  for (const path of componentPaths) {
    if (!safeComponentPath(path) || typeof components[path] !== 'string') throw new Error(`role_package_file_invalid:component:${path}`)
    if (sha256(components[path]) !== manifest.hashes[path]) throw new Error(`role_package_file_hash_mismatch:${path}`)
  }
  const actualRootHash = sha256(canonicalStringify({ ...manifest, rootHash: '' }))
  if (actualRootHash !== manifest.rootHash) throw new Error('role_package_file_root_hash_mismatch')
  try {
    const snapshot = asRecord(JSON.parse(components[manifest.entrypoints.snapshot]), 'snapshot_component')
    const snapshotIdentity = asRecord(snapshot.snapshot, 'snapshot_identity')
    if (snapshotIdentity.id !== manifest.snapshotId) throw new Error('role_package_file_invalid:snapshot_identity')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('role_package_file_invalid:')) throw error
    throw new Error('role_package_file_invalid:snapshot_component')
  }
  return { manifest, components }
}

export async function inspectRolePackageFile(packageFile: string) {
  const file = resolve(packageFile)
  const metadata = await stat(file)
  if (!metadata.isFile()) throw new Error('role_package_file_invalid:not_a_file')
  if (metadata.size > MAX_PACKAGE_BYTES) throw new Error('role_package_file_invalid:too_large')
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    throw new Error('role_package_file_invalid:json')
  }
  const bundle = validateBundle(parsed)
  return {
    bundle,
    receipt: {
      protocol: 'learnflow.role-package-file-import.v1',
      packageId: bundle.manifest.packageId,
      packageVersion: bundle.manifest.packageVersion,
      snapshotId: bundle.manifest.snapshotId,
      rootHash: bundle.manifest.rootHash,
      roleTitle: bundle.manifest.roleTitle,
      components: Object.keys(bundle.components).length,
      bytes: metadata.size,
    },
  }
}

async function installedVersion(root: string, manifest: RolePackageManifest) {
  let packageDirectories
  try {
    packageDirectories = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
    throw error
  }
  for (const packageDirectory of packageDirectories.filter(item => item.isDirectory() && !item.name.startsWith('.'))) {
    const packagePath = join(root, packageDirectory.name)
    for (const versionDirectory of (await readdir(packagePath, { withFileTypes: true })).filter(item => item.isDirectory() && !item.name.startsWith('.'))) {
      const path = join(packagePath, versionDirectory.name)
      try {
        const installed = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')) as RolePackageManifest
        if (installed.packageId === manifest.packageId && installed.packageVersion === manifest.packageVersion) return { path, manifest: installed }
      } catch {
        // Unrelated invalid installed directories remain the package runtime's responsibility.
      }
    }
  }
  return undefined
}

function packageDirectoryName(packageId: string) {
  const slug = packageId.normalize('NFKC').replace(/[^0-9A-Za-z._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'role-package'
  return `${slug}--${sha256(packageId).slice(0, 12)}`
}

export async function installRolePackageFile(input: { packageFile: string; packageRoot?: string; dryRun?: boolean }) {
  const inspected = await inspectRolePackageFile(input.packageFile)
  const root = resolve(input.packageRoot || BUILTIN_ROLE_PACKAGE_ROOT)
  const existing = await installedVersion(root, inspected.bundle.manifest)
  if (existing) {
    if (existing.manifest.rootHash !== inspected.bundle.manifest.rootHash) throw new Error('role_package_version_conflict')
    return { ...inspected.receipt, installed: false, dryRun: Boolean(input.dryRun), packagePath: existing.path, packageRoot: root }
  }
  const packagePath = join(root, packageDirectoryName(inspected.bundle.manifest.packageId))
  const target = join(packagePath, inspected.bundle.manifest.packageVersion)
  if (input.dryRun) return { ...inspected.receipt, installed: false, dryRun: true, packagePath: target, packageRoot: root }

  await mkdir(packagePath, { recursive: true })
  await mkdir(dirname(root), { recursive: true })
  const stage = await mkdtemp(join(dirname(root), '.role-package-import-'))
  try {
    for (const [path, content] of Object.entries(inspected.bundle.components)) {
      const destination = join(stage, path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, content, { encoding: 'utf8', flag: 'wx' })
    }
    await writeFile(join(stage, 'manifest.json'), canonicalStringify(inspected.bundle.manifest), { encoding: 'utf8', flag: 'wx' })
    try {
      await access(target, constants.F_OK)
      throw new Error('role_package_version_conflict')
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
    await rename(stage, target)
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
  return { ...inspected.receipt, installed: true, packagePath: target, packageRoot: root }
}
