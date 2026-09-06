import { usesLocalDesktopRuntime } from './runtime-surface.ts'
import { AI_LATENCY_BUDGETS } from './latency-budgets.ts'

const DESKTOP_AUTH_STORAGE_KEY = 'learnflow.desktop.auth-token'
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const UNSCOPED_WORKSPACE_STORAGE_KEY = 'learnflow.vnext.workspace.v1'

export const LEGACY_WORKSPACE_STORAGE_KEY = `${UNSCOPED_WORKSPACE_STORAGE_KEY}.legacy-unscoped`

export type RuntimeClientState = {
  kind: 'web' | 'desktop'
  ready: boolean
  apiBaseUrl?: string
  desktopToken?: string
  startupError?: string
}

let runtime: RuntimeClientState = { kind: 'web', ready: true }
let initialization: Promise<RuntimeClientState> | undefined
let csrfToken = ''
let csrfInitialization: Promise<CsrfBootstrapResult> | undefined
let runtimeAuthGeneration = 0
let runtimeAuthActive = false

type CsrfBootstrapResult = {
  token?: string
  failure?: {
    status: number
    statusText: string
    body: string
    contentType: string
  }
}

type WorkspaceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function isTauriWindow() {
  return typeof window !== 'undefined' && usesLocalDesktopRuntime(
    '__TAURI_INTERNALS__' in window, window.location.protocol, window.location.hostname,
  )
}

export function getRuntimeClientState() {
  return runtime
}

export function isDesktopRuntime() {
  return runtime.kind === 'desktop'
}

export function learnerWorkspaceStorageKey(learnerId: number) {
  if (!Number.isInteger(learnerId) || learnerId <= 0) throw new Error('learner_id 必须是正整数')
  return `${UNSCOPED_WORKSPACE_STORAGE_KEY}.learner.${learnerId}`
}

export function isolateLegacyWorkspaceCache(storage: WorkspaceStorage) {
  try {
    const unscoped = storage.getItem(UNSCOPED_WORKSPACE_STORAGE_KEY)
    if (unscoped === null) return undefined
    let target = LEGACY_WORKSPACE_STORAGE_KEY
    const existingLegacy = storage.getItem(target)
    if (existingLegacy !== null && existingLegacy !== unscoped) {
      target = `${LEGACY_WORKSPACE_STORAGE_KEY}.${Date.now()}`
    }
    storage.setItem(target, unscoped)
    storage.removeItem(UNSCOPED_WORKSPACE_STORAGE_KEY)
    return target
  } catch {
    // Storage can be unavailable or quota-limited. The unscoped key is never
    // read by the application even when the recoverable rename cannot run.
    return undefined
  }
}

export function resolveRuntimeUrl(input: RequestInfo | URL) {
  if (runtime.kind !== 'desktop' || !runtime.apiBaseUrl || typeof input !== 'string' || !input.startsWith('/api')) {
    return input
  }
  return `${runtime.apiBaseUrl.replace(/\/$/, '')}${input.slice('/api'.length)}`
}

export function captureRuntimeAuth(payload: unknown) {
  if (runtime.kind !== 'desktop' || !payload || typeof payload !== 'object') return
  const token = (payload as Record<string, unknown>).desktop_auth_token
  if (typeof token !== 'string' || !token) return
  try { sessionStorage.setItem(DESKTOP_AUTH_STORAGE_KEY, token) } catch { /* no persistent fallback */ }
}

export function resetRuntimeCsrfToken() {
  runtimeAuthGeneration += 1
  csrfToken = ''
  csrfInitialization = undefined
}

export function activateRuntimeAuth(payload: unknown) {
  resetRuntimeCsrfToken()
  runtimeAuthActive = true
  captureRuntimeAuth(payload)
}

export function clearRuntimeAuth() {
  resetRuntimeCsrfToken()
  runtimeAuthActive = false
  try { sessionStorage.removeItem(DESKTOP_AUTH_STORAGE_KEY) } catch { /* sessionStorage may be unavailable */ }
}

function notifyUnauthorized() {
  clearRuntimeAuth()
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('learnflow:unauthorized'))
  }
}

function requestPath(input: RequestInfo | URL) {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL ? input.toString() : input.url
  try {
    return new URL(raw, 'http://learnflow.local').pathname
  } catch {
    return ''
  }
}

function csrfBootstrapExempt(path: string) {
  return path === '/api/auth/login'
    || path === '/api/auth/register'
    || path === '/api/demo/login'
    || path.startsWith('/api/dev/accounts/') && path.endsWith('/login')
}

async function fetchBrowserCsrfToken(generation: number): Promise<CsrfBootstrapResult> {
  const response = await fetch(resolveRuntimeUrl('/api/auth/csrf'), {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
  })
  const body = await response.text()
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized()
    return {
      failure: {
        status: response.status,
        statusText: response.statusText,
        body,
        contentType: response.headers.get('Content-Type') || 'application/json',
      },
    }
  }
  let payload: unknown
  try { payload = body ? JSON.parse(body) : null } catch { payload = null }
  const token = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>).csrf_token
    : undefined
  if (typeof token !== 'string' || !token) {
    return {
      failure: {
        status: 502,
        statusText: 'Bad Gateway',
        body: JSON.stringify({ detail: '认证服务没有返回 CSRF token' }),
        contentType: 'application/json',
      },
    }
  }
  if (generation !== runtimeAuthGeneration) {
    return {
      failure: {
        status: 409,
        statusText: 'Conflict',
        body: JSON.stringify({ detail: '身份已切换，请重新发起请求' }),
        contentType: 'application/json',
      },
    }
  }
  csrfToken = token
  return { token }
}

async function browserCsrfToken() {
  if (csrfToken) return { token: csrfToken } satisfies CsrfBootstrapResult
  if (!csrfInitialization) {
    const generation = runtimeAuthGeneration
    const pending = fetchBrowserCsrfToken(generation)
    csrfInitialization = pending
    const clearPending = () => {
      if (csrfInitialization === pending) csrfInitialization = undefined
    }
    pending.then(clearPending, clearPending)
  }
  return csrfInitialization
}

export async function runtimeFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const method = String(init.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase()
  const headers = new Headers(init.headers)
  if (runtime.kind === 'desktop' && runtime.desktopToken) {
    headers.set('X-LearnFlow-Desktop-Token', runtime.desktopToken)
    let authToken: string | null = null
    try { authToken = sessionStorage.getItem(DESKTOP_AUTH_STORAGE_KEY) } catch { /* no bearer available */ }
    if (authToken) headers.set('Authorization', `Bearer ${authToken}`)
  } else if (runtimeAuthActive && UNSAFE_METHODS.has(method) && !csrfBootstrapExempt(requestPath(input))) {
    const csrf = await browserCsrfToken()
    if (csrf.failure) {
      return new Response(csrf.failure.body, {
        status: csrf.failure.status,
        statusText: csrf.failure.statusText,
        headers: { 'Content-Type': csrf.failure.contentType },
      })
    }
    headers.set('X-CSRF-Token', csrf.token || '')
  }
  const response = await fetch(resolveRuntimeUrl(input), {
    ...init,
    method,
    headers,
    credentials: init.credentials || 'include',
  })
  if (response.status === 401) notifyUnauthorized()
  return response
}

async function waitForSidecar(apiBaseUrl: string) {
  const healthUrl = `${apiBaseUrl.replace(/\/api\/?$/, '')}/health`
  let lastError: unknown
  const deadline = Date.now() + AI_LATENCY_BUDGETS.desktopStartup
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl)
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => window.setTimeout(resolve, 500))
  }
  const detail = lastError instanceof Error ? `：${lastError.message}` : ''
  throw new Error(`本地服务启动超时（${Math.round(AI_LATENCY_BUDGETS.desktopStartup / 1000)} 秒）${detail}`)
}

export function initializeRuntimeClient(): Promise<RuntimeClientState> {
  if (initialization) return initialization
  initialization = (async () => {
    if (!isTauriWindow()) return runtime
    runtime = { kind: 'desktop', ready: false }
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const config = await invoke<{ apiBaseUrl: string; desktopToken: string }>('desktop_runtime_config')
      await waitForSidecar(config.apiBaseUrl)
      runtime = {
        kind: 'desktop', ready: true,
        apiBaseUrl: config.apiBaseUrl, desktopToken: config.desktopToken,
      }
      document.documentElement.dataset.learnflowDesktop = 'true'
    } catch (error) {
      runtime = {
        kind: 'desktop', ready: false,
        startupError: error instanceof Error ? error.message : '桌面本地服务启动失败',
      }
    }
    window.dispatchEvent(new CustomEvent('learnflow:runtime-changed'))
    return runtime
  })()
  return initialization
}
