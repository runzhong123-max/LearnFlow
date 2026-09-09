/** Host-only credentials. Never copy this object into model context or tool arguments. */
export type BackendIdentity = {
  requestCookie?: string
  requestAuthorization?: string
  requestDesktopToken?: string
}

export function backendIdentityFromHeaders(headers: Record<string, string | string[] | undefined>): BackendIdentity {
  const authorization = headers.authorization
  if (authorization !== undefined) {
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]+$/i.test(authorization)) {
      throw new Error('API key 无效')
    }
    return { requestAuthorization: authorization,
      ...(typeof headers['x-learnflow-desktop-token'] === 'string' ? { requestDesktopToken: headers['x-learnflow-desktop-token'] } : {}) }
  }
  return typeof headers.cookie === 'string' && headers.cookie ? { requestCookie: headers.cookie } : {}
}

export function backendIdentityHeaders(identity: BackendIdentity): Record<string, string> {
  if (identity.requestAuthorization !== undefined) {
    // Authorization is authoritative; a stale browser cookie must never select another account.
    return { Authorization: identity.requestAuthorization,
      ...(identity.requestDesktopToken ? { 'X-LearnFlow-Desktop-Token': identity.requestDesktopToken } : {}) }
  }
  return identity.requestCookie ? { Cookie: identity.requestCookie } : {}
}

export async function backendWriteHeaders(identity: BackendIdentity & { backendBase?: string }, signal?: AbortSignal): Promise<Record<string, string>> {
  const headers = { 'Content-Type': 'application/json', ...backendIdentityHeaders(identity) }
  if (identity.requestAuthorization !== undefined) return headers
  if (!identity.requestCookie) throw new Error('无法验证当前登录，请重新登录后重试')
  if (!identity.backendBase) throw new Error('正式学习后端未连接')
  const response = await fetch(`${identity.backendBase}/api/auth/csrf`, { headers: backendIdentityHeaders(identity), signal, redirect: 'error' })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok || typeof payload.csrf_token !== 'string' || !payload.csrf_token) throw new Error('无法验证当前登录，请重新登录后重试')
  return { ...headers, 'X-CSRF-Token': payload.csrf_token }
}

export async function verifyBackendApiIdentity(backendBase: string, identity: BackendIdentity, signal?: AbortSignal) {
  if (identity.requestAuthorization === undefined) return
  const response = await fetch(`${backendBase}/api/auth/api-key/verify`, { headers: backendIdentityHeaders(identity), signal, redirect: 'error' })
  if (response.status !== 204) throw new Error('API key 无效或已失效')
}
