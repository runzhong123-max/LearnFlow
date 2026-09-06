import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { createAccountCredentialResolver } from './account-model-credential.ts'

const BRIDGE = 'bridge-token-that-is-definitely-32-characters-long'

test('account credential resolver forwards only identity material and keeps bridge server-side', async () => {
  let observed: RequestInit | undefined
  const resolveCredential = createAccountCredentialResolver({
    mode: 'production',
    backendBase: 'http://127.0.0.1:8010/',
    runtimeBridgeToken: BRIDGE,
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observed = init
      return new Response(JSON.stringify({ api_key: 'sk-account-only' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch,
  })

  const result = await resolveCredential({
    headers: {
      cookie: 'learnflow_session=opaque',
      authorization: 'Bearer desktop-session',
      origin: 'https://attacker.example',
      'x-learnflow-desktop-token': 'desktop-token',
    },
  })

  assert.deepEqual(result, { apiKey: 'sk-account-only', source: '当前账户的加密凭据' })
  const headers = new Headers(observed?.headers)
  assert.equal(headers.get('X-LearnFlow-Runtime-Bridge-Token'), BRIDGE)
  assert.equal(headers.get('Cookie'), 'learnflow_session=opaque')
  assert.equal(headers.get('Authorization'), 'Bearer desktop-session')
  assert.equal(headers.get('Origin'), null)
})

test('production fails closed without a valid bridge and never inherits a global key', async () => {
  const resolveCredential = createAccountCredentialResolver({
    mode: 'production',
    backendBase: 'http://127.0.0.1:8010',
    runtimeBridgeToken: 'short',
    legacyDevelopmentCredential: { apiKey: 'sk-global-must-not-leak', source: 'legacy' },
  })
  assert.deepEqual(await resolveCredential({}), {
    apiKey: '',
    source: '运行时凭据桥配置无效',
  })
})

test('development migration fallback remains explicit and account errors are stable', async () => {
  const developmentResolver = createAccountCredentialResolver({
    mode: 'development',
    backendBase: 'http://127.0.0.1:8010',
    runtimeBridgeToken: '',
    legacyDevelopmentCredential: { apiKey: 'sk-local-development', source: 'frontend/.env.local' },
  })
  assert.equal((await developmentResolver({})).apiKey, 'sk-local-development')

  const signedOutResolver = createAccountCredentialResolver({
    mode: 'production',
    backendBase: 'http://127.0.0.1:8010',
    runtimeBridgeToken: BRIDGE,
    fetchImpl: (async () => new Response('{}', { status: 401 })) as typeof fetch,
  })
  assert.deepEqual(await signedOutResolver({}), { apiKey: '', source: '尚未登录' })

  const unconfiguredResolver = createAccountCredentialResolver({
    mode: 'production',
    backendBase: 'http://127.0.0.1:8010',
    runtimeBridgeToken: BRIDGE,
    fetchImpl: (async () => new Response('{}', { status: 409 })) as typeof fetch,
  })
  assert.deepEqual(await unconfiguredResolver({}), { apiKey: '', source: '当前账户尚未配置' })
})

test('Tutor legacy credential selection never falls back to the task preflight key', () => {
  const viteConfig = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8')
  const loadTutorKeyBody = viteConfig.match(/function loadTutorKey[\s\S]*?\r?\n}\r?\n\r?\nfunction loadLearningTaskPreflightConfiguration/)?.[0] || ''

  assert.match(loadTutorKeyBody, /LEARNFLOW_API_KEY/)
  assert.doesNotMatch(loadTutorKeyBody, /LEARNING_TASK_PREFLIGHT_API_KEY/)
})
