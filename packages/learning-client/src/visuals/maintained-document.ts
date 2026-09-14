/** A fixed public library route, never a credential-bearing cloud proxy URL. */
export function maintainedDocumentUrl(path: unknown, localApiBase?: string): string | undefined {
  if (typeof path !== 'string' || !/^\/api\/visuals\/document\/[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*\?digest=[a-f0-9]{64}$/.test(path)) return undefined
  if (!localApiBase) return path
  try {
    const base = new URL(localApiBase)
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.username || base.password || !/^\/api\/?$/.test(base.pathname) || base.search || base.hash) return undefined
    return base.origin + path
  } catch { return undefined }
}
