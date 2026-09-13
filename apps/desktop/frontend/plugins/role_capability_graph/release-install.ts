import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installRolePackageFile } from './package-file.ts'

/** Same ceiling as the local file importer; a release export cannot exceed it. */
const MAX_RELEASE_BYTES = 20 * 1024 * 1024
const RELEASE_ID = /^[A-Za-z0-9._:-]{1,220}$/u
const RELEASE_EXPORT_MEDIA_TYPE = 'application/vnd.role-atlas.package+json'

export type ReleaseInstallReceipt = Awaited<ReturnType<typeof installRolePackageFile>> & {
  releaseId: string
  source: 'role_atlas_release_export'
}

function trustedBaseUrl(value: string) {
  let base: URL
  try {
    base = new URL(value)
  } catch {
    throw new Error('role_package_release_url_invalid')
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
  if (base.username || base.password) throw new Error('role_package_release_url_invalid')
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) {
    throw new Error('role_package_release_url_invalid')
  }
  return base
}

async function readBounded(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('role_package_release_empty')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RELEASE_BYTES) {
        await reader.cancel()
        throw new Error('role_package_release_too_large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (!size) throw new Error('role_package_release_empty')
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * Download one immutable release from a Role Atlas export endpoint and install
 * it into the local package root.
 *
 * The export route already enforces release visibility — public lines are world
 * readable and everything else requires the owning learner — so this function
 * never forwards learner credentials and simply fails closed on 401/403.
 *
 * The downloaded bundle is validated by `installRolePackageFile`, which
 * re-checks protocol version, component hashes and rootHash. A tampered or
 * truncated response therefore cannot be installed under another identity, and
 * reinstalling the same content stays idempotent.
 */
export async function installRolePackageFromRelease(input: {
  baseUrl: string
  releaseId: string
  packageRoot?: string
  dryRun?: boolean
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}): Promise<ReleaseInstallReceipt> {
  const base = trustedBaseUrl(input.baseUrl)
  const releaseId = String(input.releaseId || '').trim()
  if (!RELEASE_ID.test(releaseId)) throw new Error('role_package_release_id_invalid')

  const endpoint = new URL(`/api/releases/${encodeURIComponent(releaseId)}/export`, base)
  endpoint.searchParams.set('format', 'json')
  const timeout = AbortSignal.timeout(20_000)
  const response = await (input.fetchImpl || fetch)(endpoint, {
    redirect: 'error',
    credentials: 'omit',
    headers: { accept: RELEASE_EXPORT_MEDIA_TYPE },
    signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  })
  if (!response.ok) throw new Error(`role_package_release_http_${response.status}`)

  const bytes = await readBounded(response)
  const staging = await mkdtemp(join(tmpdir(), 'role-package-release-'))
  try {
    const packageFile = join(staging, `${releaseId.replace(/[^A-Za-z0-9._-]+/gu, '-')}.role-package.json`)
    await writeFile(packageFile, bytes)
    const installation = await installRolePackageFile({
      packageFile,
      packageRoot: input.packageRoot,
      dryRun: input.dryRun,
    })
    return { ...installation, releaseId, source: 'role_atlas_release_export' }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
