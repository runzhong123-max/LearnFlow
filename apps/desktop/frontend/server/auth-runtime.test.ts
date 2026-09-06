import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bootstrapFormalRuntime,
  deleteFormalModelCredential,
  getFormalDemoStatus,
  invalidateFormalIdentity,
  listFormalAdminAccounts,
  loginFormalAccount,
  loginFormalDemoAccount,
  registerFormalAccount,
  saveFormalModelCredential,
} from '../src/formal-runtime.ts'
import {
  isolateLegacyWorkspaceCache,
  learnerWorkspaceStorageKey,
  LEGACY_WORKSPACE_STORAGE_KEY,
  runtimeFetch,
} from '../src/runtime-client.ts'

const ACCOUNT = {
  id: 7,
  account_number: 12,
  username: 'learner-a',
  display_name: '学习者 A',
  learner_id: 101,
  role: 'user' as const,
  status: 'active',
  must_change_password: false,
  is_legacy_demo: false,
  profile: {
    education_stage: 'working',
    background: '工程背景',
    focus_areas: ['Agent'],
    weekly_hours: 5,
    preferred_modes: ['练习'],
    career_goal: '',
    career_goal_status: 'exploring',
  },
  dev_test_login_enabled: false,
  is_dev_login: false,
}

test('web login is explicit and does not probe or silently select development accounts', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; method: string; body: unknown; headers: Headers }> = []
  invalidateFormalIdentity()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: String(init?.method || 'GET'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    })
    return new Response(JSON.stringify(ACCOUNT), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const account = await loginFormalAccount('learner-a', 'a password with spaces')
    assert.equal(account.learner_id, 101)
    assert.deepEqual(calls.map(call => call.url), ['/api/auth/login'])
    assert.equal(calls[0].method, 'POST')
    assert.deepEqual(calls[0].body, {
      username: 'learner-a',
      password: 'a password with spaces',
    })
    assert.equal(calls[0].headers.has('X-CSRF-Token'), false)
  } finally {
    globalThis.fetch = originalFetch
    invalidateFormalIdentity()
  }
})

test('registration validation errors are presented without framework prefixes', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    detail: [{ msg: 'Value error, 密码至少 8 位，并包含至少两类字符' }],
  }), {
    status: 422,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch
  try {
    await assert.rejects(
      registerFormalAccount({
        username: 'learner-b',
        password: 'abcdefgh',
        display_name: '学习者 B',
        education_stage: 'working',
        background: '工程背景',
        focus_areas: ['Agent'],
        weekly_hours: 5,
        preferred_modes: ['练习'],
        career_goal: '',
        career_goal_status: 'exploring',
      }),
      error => error instanceof Error
        && error.message === '密码至少 8 位，并包含至少两类字符',
    )
  } finally {
    globalThis.fetch = originalFetch
    invalidateFormalIdentity()
  }
})

test('signed-out formal bootstrap never falls through to demo or dev login', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  invalidateFormalIdentity()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return new Response(JSON.stringify({
      authenticated: false,
      dev_test_login_enabled: true,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const result = await bootstrapFormalRuntime()
    assert.equal(result.connection.status, 'auth_required')
    assert.deepEqual(calls, ['/api/auth/status'])
  } finally {
    globalThis.fetch = originalFetch
    invalidateFormalIdentity()
  }
})

test('seeded demo login is an explicit two-step capability and activates only that account', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  invalidateFormalIdentity()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${String(init?.method || 'GET')} ${String(input)}`)
    if (String(input) === '/api/demo/status') {
      return new Response(JSON.stringify({ enabled: true, offline: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({
      ...ACCOUNT,
      username: 'learnflow-demo',
      is_legacy_demo: true,
      is_dev_login: true,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const status = await getFormalDemoStatus()
    assert.deepEqual(status, { enabled: true, offline: true })
    const account = await loginFormalDemoAccount()
    assert.equal(account.username, 'learnflow-demo')
    assert.equal(account.is_legacy_demo, true)
    assert.deepEqual(calls, ['GET /api/demo/status', 'POST /api/demo/login'])
  } finally {
    globalThis.fetch = originalFetch
    invalidateFormalIdentity()
  }
})

test('concurrent seeded demo mounts share one login request', async () => {
  const originalFetch = globalThis.fetch
  let loginCalls = 0
  invalidateFormalIdentity()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), '/api/demo/login')
    loginCalls += 1
    await new Promise(resolve => setTimeout(resolve, 5))
    return new Response(JSON.stringify({
      ...ACCOUNT,
      username: 'learnflow-demo',
      is_legacy_demo: true,
      is_dev_login: true,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const [first, second] = await Promise.all([
      loginFormalDemoAccount(),
      loginFormalDemoAccount(),
    ])
    assert.equal(first.learner_id, second.learner_id)
    assert.equal(loginCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
    invalidateFormalIdentity()
  }
})

test('web unsafe requests fetch and reuse the session CSRF token', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; method: string; headers: Headers; body?: unknown }> = []
  invalidateFormalIdentity()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = String(init?.method || 'GET')
    calls.push({
      url,
      method,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    if (url === '/api/auth/login') {
      return new Response(JSON.stringify(ACCOUNT), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url === '/api/auth/csrf') {
      return new Response(JSON.stringify({ csrf_token: 'csrf-session-101' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (method === 'PUT') {
      return new Response(JSON.stringify({ configured: true, key_hint: 'sk-…7890', updated_at: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ configured: false, key_hint: '', updated_at: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  try {
    await loginFormalAccount('learner-a', '123456789012345')
    await saveFormalModelCredential('sk-account-secret')
    await deleteFormalModelCredential()

    assert.deepEqual(calls.map(call => `${call.method} ${call.url}`), [
      'POST /api/auth/login',
      'GET /api/auth/csrf',
      'PUT /api/auth/model-credential',
      'DELETE /api/auth/model-credential',
    ])
    assert.equal(calls[0].headers.has('X-CSRF-Token'), false)
    assert.equal(calls[2].headers.get('X-CSRF-Token'), 'csrf-session-101')
    assert.equal(calls[3].headers.get('X-CSRF-Token'), 'csrf-session-101')
    assert.deepEqual(calls[2].body, { api_key: 'sk-account-secret' })
  } finally {
    globalThis.fetch = originalFetch
    invalidateFormalIdentity()
  }
})

test('a 401 response publishes the auth-expired signal used by AuthGate', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window
  const windowTarget = new EventTarget()
  let unauthorized = 0
  windowTarget.addEventListener('learnflow:unauthorized', () => { unauthorized += 1 })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowTarget })
  globalThis.fetch = (async () => new Response(JSON.stringify({ detail: '登录已失效' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch
  try {
    const response = await runtimeFetch('/api/protected')
    assert.equal(response.status, 401)
    assert.equal(unauthorized, 1)
  } finally {
    globalThis.fetch = originalFetch
    if (originalWindow === undefined) delete (globalThis as typeof globalThis & { window?: unknown }).window
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  }
})

test('admin account projection keeps configured status and drops any key hint', async () => {
  const originalFetch = globalThis.fetch
  invalidateFormalIdentity()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === '/api/auth/login') {
      return new Response(JSON.stringify({ ...ACCOUNT, role: 'admin' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify([{
      account_number: 21,
      username: 'learner-b',
      display_name: '学习者 B',
      role: 'user',
      status: 'active',
      created_at: null,
      updated_at: null,
      last_login_at: null,
      project_count: 2,
      api_key_configured: true,
      api_key_hint: 'must-not-reach-admin-ui',
    }]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  try {
    await loginFormalAccount('admin-a', '123456789012345')
    const accounts = await listFormalAdminAccounts()
    assert.deepEqual(accounts, [{
      account_number: 21,
      username: 'learner-b',
      display_name: '学习者 B',
      role: 'user',
      status: 'active',
      created_at: null,
      updated_at: null,
      last_login_at: null,
      project_count: 2,
      api_key_configured: true,
    }])
    assert.equal('api_key_hint' in accounts[0], false)
  } finally {
    globalThis.fetch = originalFetch
    invalidateFormalIdentity()
  }
})

test('legacy workspace cache is quarantined and two learners use disjoint keys', () => {
  const values = new Map<string, string>([
    ['learnflow.vnext.workspace.v1', JSON.stringify({ conversations: ['unowned legacy'] })],
  ])
  const storage = {
    getItem(key: string) { return values.get(key) ?? null },
    setItem(key: string, value: string) { values.set(key, value) },
    removeItem(key: string) { values.delete(key) },
  }

  const learnerAKey = learnerWorkspaceStorageKey(101)
  const learnerBKey = learnerWorkspaceStorageKey(202)
  assert.notEqual(learnerAKey, learnerBKey)
  assert.equal(values.get(learnerAKey), undefined)
  assert.equal(values.get(learnerBKey), undefined)

  assert.equal(isolateLegacyWorkspaceCache(storage), LEGACY_WORKSPACE_STORAGE_KEY)
  assert.equal(values.has('learnflow.vnext.workspace.v1'), false)
  assert.match(values.get(LEGACY_WORKSPACE_STORAGE_KEY) || '', /unowned legacy/)
  assert.equal(values.get(learnerAKey), undefined, 'legacy data must not be imported into learner A')

  values.set(learnerAKey, JSON.stringify({ owner: 101, draft: 'A only' }))
  values.set(learnerBKey, JSON.stringify({ owner: 202, draft: 'B only' }))
  assert.deepEqual(JSON.parse(values.get(learnerAKey) || '{}'), { owner: 101, draft: 'A only' })
  assert.deepEqual(JSON.parse(values.get(learnerBKey) || '{}'), { owner: 202, draft: 'B only' })
})
