import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { installRolePackageFile, inspectRolePackageFile } from './package-file.ts'

const MAX_CATALOG_BYTES = 2 * 1024 * 1024
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/u
const SUBJECT = /^[0-9A-Za-z][0-9A-Za-z._:@/-]{2,159}$/u

type HubCatalogEntry = {
  packageId: string
  packageVersion: string
  snapshotId: string
  rootHash: string
  roleTitle: string
  ownerSubjectId: string
  maintainerName: string
  channel: 'official' | 'community'
  visibility: 'private' | 'public'
  review: 'not_required_private' | 'approved'
  objectPath: string
  publishedAt: string
}

type HubCatalog = {
  protocol: 'role-package-hub-catalog.v1'
  generatedAt: string
  entries: HubCatalogEntry[]
  rootHash: string
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalValue(item)]))
  if (typeof value === 'string') return value.normalize('NFC')
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('role_package_hub_catalog_invalid:non_finite_number')
  return value
}

function canonicalStringify(value: unknown) {
  return JSON.stringify(canonicalValue(value))
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function parseSemver(value: string) {
  const match = SEMVER.exec(value)
  if (!match) return null
  const prerelease = match[4]?.split('.') || []
  const build = match[5]?.split('.') || []
  if ([...prerelease, ...build].some(identifier => !identifier)) return null
  if (prerelease.some(identifier => /^\d+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) return null
  return { core: match.slice(1, 4).map(Number), prerelease }
}

function safeObjectPath(path: string) {
  return Boolean(path && !isAbsolute(path) && !path.includes('..') && !path.includes('\\') && path.startsWith('objects/sha256/'))
}

function validateCatalog(value: unknown): HubCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('role_package_hub_catalog_invalid:envelope')
  const catalog = value as HubCatalog
  if (catalog.protocol !== 'role-package-hub-catalog.v1' || !Array.isArray(catalog.entries) || !/^[0-9a-f]{64}$/u.test(catalog.rootHash || '')) {
    throw new Error('role_package_hub_catalog_invalid:protocol')
  }
  const releaseKeys = new Set<string>()
  for (const entry of catalog.entries) {
    if (!entry.packageId || !parseSemver(entry.packageVersion || '') || !entry.snapshotId || !/^[0-9a-f]{64}$/u.test(entry.rootHash || '')) {
      throw new Error('role_package_hub_catalog_invalid:entry_identity')
    }
    if (!['official', 'community'].includes(entry.channel) || !['public', 'private'].includes(entry.visibility)) {
      throw new Error('role_package_hub_catalog_invalid:entry_channel_visibility')
    }
    if (!SUBJECT.test(entry.ownerSubjectId || '') || !entry.maintainerName || !entry.publishedAt) {
      throw new Error('role_package_hub_catalog_invalid:entry_provenance')
    }
    if (!safeObjectPath(entry.objectPath)) throw new Error('role_package_hub_catalog_invalid:object_path')
    if (entry.objectPath !== `objects/sha256/${entry.rootHash}.role-package.json`) throw new Error('role_package_hub_catalog_invalid:content_address')
    if (entry.visibility === 'public' && entry.review !== 'approved') throw new Error('role_package_hub_catalog_invalid:public_review')
    if (entry.visibility === 'private' && entry.review !== 'not_required_private') throw new Error('role_package_hub_catalog_invalid:private_review')
    const key = `${entry.packageId}@${entry.packageVersion}`
    if (releaseKeys.has(key)) throw new Error(`role_package_hub_catalog_invalid:duplicate_release:${key}`)
    releaseKeys.add(key)
  }
  const actual = sha256(canonicalStringify({ ...catalog, generatedAt: '', rootHash: '' }))
  if (actual !== catalog.rootHash) throw new Error('role_package_hub_catalog_root_hash_mismatch')
  return catalog
}

export async function inspectRolePackageHubCatalog(catalogFile: string, actorSubjectId?: string) {
  const file = resolve(catalogFile)
  const metadata = await stat(file)
  if (!metadata.isFile() || metadata.size > MAX_CATALOG_BYTES) throw new Error('role_package_hub_catalog_invalid:file')
  let parsed: unknown
  try { parsed = JSON.parse(await readFile(file, 'utf8')) }
  catch { throw new Error('role_package_hub_catalog_invalid:json') }
  const catalog = validateCatalog(parsed)
  const visibleEntries = catalog.entries.filter(entry =>
    entry.visibility === 'public' || Boolean(actorSubjectId && entry.ownerSubjectId === actorSubjectId),
  )
  return {
    catalog,
    visibleEntries,
    receipt: {
      protocol: 'learnflow.role-package-hub-catalog.v1',
      rootHash: catalog.rootHash,
      totalEntries: catalog.entries.length,
      visibleEntries: visibleEntries.length,
      generatedAt: catalog.generatedAt,
    },
  }
}

function compareSemver(left: string, right: string) {
  const a = parseSemver(left)!
  const b = parseSemver(right)!
  for (let index = 0; index < 3; index += 1) if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index]
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index]
    const rightIdentifier = b.prerelease[index]
    if (leftIdentifier === undefined || rightIdentifier === undefined) return leftIdentifier === undefined ? -1 : 1
    if (leftIdentifier === rightIdentifier) continue
    const leftNumeric = /^\d+$/u.test(leftIdentifier)
    const rightNumeric = /^\d+$/u.test(rightIdentifier)
    if (leftNumeric && rightNumeric) return Number(leftIdentifier) - Number(rightIdentifier)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftIdentifier.localeCompare(rightIdentifier)
  }
  return 0
}

export async function installRolePackageFromHub(input: {
  catalogFile: string
  packageId: string
  packageVersion?: string
  actorSubjectId?: string
  packageRoot?: string
  dryRun?: boolean
}) {
  const inspectedCatalog = await inspectRolePackageHubCatalog(input.catalogFile, input.actorSubjectId)
  const candidates = inspectedCatalog.visibleEntries.filter(entry =>
    entry.packageId === input.packageId && (!input.packageVersion || entry.packageVersion === input.packageVersion),
  )
  const entry = candidates.sort((left, right) => compareSemver(right.packageVersion, left.packageVersion))[0]
  if (!entry) throw new Error('role_package_hub_release_not_visible')
  const catalogRoot = dirname(resolve(input.catalogFile))
  const packageFile = resolve(catalogRoot, entry.objectPath)
  if (!packageFile.startsWith(`${catalogRoot}${sep}`)) throw new Error('role_package_hub_catalog_invalid:object_path')
  const packageInspection = await inspectRolePackageFile(packageFile)
  if (
    packageInspection.receipt.packageId !== entry.packageId
    || packageInspection.receipt.packageVersion !== entry.packageVersion
    || packageInspection.receipt.snapshotId !== entry.snapshotId
    || packageInspection.receipt.rootHash !== entry.rootHash
  ) throw new Error('role_package_hub_release_identity_mismatch')
  const installation = await installRolePackageFile({
    packageFile,
    packageRoot: input.packageRoot,
    dryRun: input.dryRun,
  })
  return {
    ...installation,
    hubCatalogRootHash: inspectedCatalog.catalog.rootHash,
    channel: entry.channel,
    visibility: entry.visibility,
    maintainerName: entry.maintainerName,
    review: entry.review,
  }
}
