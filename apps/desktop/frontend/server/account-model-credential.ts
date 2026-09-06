export type ModelCredential = {
  apiKey: string
  source: string
}

export type AccountCredentialRequest = {
  headers?: Record<string, string | string[] | undefined>
}

type CredentialResolverOptions = {
  mode: string
  backendBase: string
  runtimeBridgeToken: string
  legacyDevelopmentCredential?: ModelCredential
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? String(value[0] || '') : String(value || '')
}

function forwardedIdentityHeaders(request: AccountCredentialRequest): Record<string, string> {
  const headers = request.headers || {}
  const cookie = firstHeader(headers.cookie)
  const authorization = firstHeader(headers.authorization)
  const desktopToken = firstHeader(headers['x-learnflow-desktop-token'])
  return {
    ...(cookie ? { Cookie: cookie } : {}),
    ...(authorization ? { Authorization: authorization } : {}),
    ...(desktopToken ? { 'X-LearnFlow-Desktop-Token': desktopToken } : {}),
  }
}

async function responseDetail(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { detail?: unknown }
    return typeof payload.detail === 'string' ? payload.detail.trim() : ''
  } catch {
    return ''
  }
}

/**
 * Resolve the signed-in learner's model credential without exposing the
 * server-only bridge token or decrypted API key to browser JavaScript.
 *
 * The process-global key is retained only as a local-development migration
 * fallback. Production fails closed when the bridge is absent or invalid.
 */
export function createAccountCredentialResolver(options: CredentialResolverOptions) {
  const bridgeToken = options.runtimeBridgeToken.trim()
  const backendBase = options.backendBase.replace(/\/$/, '')
  const requestFetch = options.fetchImpl || fetch
  const timeoutMs = options.timeoutMs || 4_000

  return async (request: AccountCredentialRequest): Promise<ModelCredential> => {
    if (bridgeToken.length >= 32) {
      const upstream = await requestFetch(`${backendBase}/api/auth/model-credential/internal/resolve`, {
        method: 'POST',
        headers: {
          'X-LearnFlow-Runtime-Bridge-Token': bridgeToken,
          ...forwardedIdentityHeaders(request),
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (upstream.ok) {
        const payload = await upstream.json() as { api_key?: unknown }
        const apiKey = typeof payload.api_key === 'string' ? payload.api_key.trim() : ''
        if (!apiKey) throw new Error('账户模型凭据解析结果为空')
        return { apiKey, source: '当前账户的加密凭据' }
      }
      if (upstream.status === 401) return { apiKey: '', source: '尚未登录' }
      if (upstream.status === 409) return { apiKey: '', source: '当前账户尚未配置' }
      const detail = await responseDetail(upstream)
      throw new Error(detail || `账户模型凭据解析失败（${upstream.status}）`)
    }

    const fallback = options.legacyDevelopmentCredential
    if (options.mode !== 'production' && fallback?.apiKey) return fallback
    return {
      apiKey: '',
      source: bridgeToken ? '运行时凭据桥配置无效' : '运行时凭据桥未配置',
    }
  }
}
