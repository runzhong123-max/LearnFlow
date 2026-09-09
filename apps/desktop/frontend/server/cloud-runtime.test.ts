import assert from 'node:assert/strict'
import test from 'node:test'
import { activateRuntimeAuth, clearRuntimeAuth, getRuntimeClientState, isCloudDesktopRuntime, isLocalLearningRuntime, learnerWorkspaceStorageKey, resolveRuntimeUrl, runtimeFetch } from '../src/runtime-client.ts'
import { connectFormalApiKey, invalidateFormalIdentity, loadFormalTutorSession, logoutFormalAccount } from '../src/formal-runtime.ts'

test('cloud desktop selects the relay and namespaces cloud learner caches', async () => {
  const state = getRuntimeClientState()
  const previous = { ...state }
  try {
    Object.assign(state, { kind: 'desktop', cloud: true, cloudOrigin: 'https://learn.example', apiBaseUrl: 'http://127.0.0.1:8011/api' })
    assert.equal(isCloudDesktopRuntime(), true)
    assert.equal(isLocalLearningRuntime(), false)
    assert.equal(resolveRuntimeUrl('/api/auth/login'), 'http://127.0.0.1:8011/cloud/api/auth/login')
    const cloudKey = learnerWorkspaceStorageKey(7)
    state.cloud = false
    assert.notEqual(cloudKey, learnerWorkspaceStorageKey(7))
    assert.equal(resolveRuntimeUrl('/api/projects'), 'http://127.0.0.1:8011/api/projects')
    assert.equal((await runtimeFetch('https://untrusted.example/api')).status, 400)
    assert.equal((await runtimeFetch('/apiculture')).status, 400)
  } finally {
    for (const key of Object.keys(state)) delete (state as Record<string, unknown>)[key]
    Object.assign(state, previous)
  }
})

async function withCloudRuntime(run: (values: Map<string, string>, events: EventTarget) => Promise<void>) {
  const state = getRuntimeClientState()
  const previousState = { ...state }
  const previousFetch = globalThis.fetch
  const globals = ['sessionStorage', 'localStorage', 'window'] as const
  const descriptors = globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }
  const events = new EventTarget()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events })
  Object.assign(state, { kind: 'desktop', ready: true, cloud: true, cloudOrigin: 'https://8.148.28.98', apiBaseUrl: 'http://127.0.0.1:8011/api', desktopToken: 'native-fixture' })
  invalidateFormalIdentity()
  try { await run(values, events) }
  finally {
    invalidateFormalIdentity()
    globalThis.fetch = previousFetch
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    for (const key of Object.keys(state)) delete (state as Record<string, unknown>)[key]
    Object.assign(state, previousState)
  }
}

test('cloud API key reaches only the local connect endpoint and only the returned handle is stored', async () => {
  await withCloudRuntime(async values => {
    const apiKey = 'lfak_' + 'a'.repeat(43)
    const calls: string[] = []
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      calls.push(url)
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('X-LearnFlow-Desktop-Token'), 'native-fixture')
      if (url.endsWith('/auth/api-key/connect')) {
        assert.equal(url, 'http://127.0.0.1:8011/cloud/api/auth/api-key/connect')
        assert.equal(init?.method, 'POST')
        assert.deepEqual(JSON.parse(String(init?.body)), { api_key: apiKey })
        assert.equal(headers.has('Authorization'), false)
        return Response.json({ id: 7, learner_id: 101, username: 'owner', desktop_auth_token: 'opaque-local-handle' })
      }
      assert.equal(headers.get('Authorization'), 'Bearer opaque-local-handle')
      assert.equal(headers.has('X-API-Key'), false)
      return Response.json([])
    }
    const account = await connectFormalApiKey('  ' + apiKey + '  ')
    assert.equal(account.learner_id, 101)
    await runtimeFetch('/api/projects')
    assert.deepEqual(calls, ['http://127.0.0.1:8011/cloud/api/auth/api-key/connect', 'http://127.0.0.1:8011/cloud/api/projects'])
    assert.deepEqual([...values], [['learnflow.desktop.auth-token', 'opaque-local-handle']])
    assert.ok([...values.values()].every(value => !value.includes(apiKey)))
  })
})

test('cloud disconnect clears identity during a failed logout and a late connect cannot restore it', async () => {
  await withCloudRuntime(async values => {
    let connected!: (response: Response) => void
    let started!: () => void
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    globalThis.fetch = async input => {
      if (String(input).endsWith('/auth/logout')) throw new TypeError('local relay unavailable')
      assert.ok(String(input).endsWith('/auth/api-key/connect'))
      started()
      return new Promise<Response>(resolve => { connected = resolve })
    }
    const pending = connectFormalApiKey('lfak_' + 'b'.repeat(43))
    await startedPromise
    await logoutFormalAccount()
    assert.equal(values.has('learnflow.desktop.auth-token'), false)
    connected(Response.json({ id: 8, learner_id: 102, desktop_auth_token: 'late-handle' }))
    await assert.rejects(pending, /身份已切换|连接已取消/)
    assert.equal(values.has('learnflow.desktop.auth-token'), false)
  })
})

test('an old cloud request returning 401 cannot disconnect a newly connected account', async () => {
  await withCloudRuntime(async (values, events) => {
    let finish!: (response: Response) => void
    let started!: () => void
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    let unauthorized = 0
    events.addEventListener('learnflow:unauthorized', () => { unauthorized += 1 })
    globalThis.fetch = async () => {
      started()
      return new Promise<Response>(resolve => { finish = resolve })
    }
    activateRuntimeAuth({ desktop_auth_token: 'old-handle' })
    const pending = runtimeFetch('/api/projects')
    await startedPromise
    activateRuntimeAuth({ desktop_auth_token: 'new-handle' })
    finish(Response.json({ detail: 'expired' }, { status: 401 }))
    assert.equal((await pending).status, 409)
    assert.equal(values.get('learnflow.desktop.auth-token'), 'new-handle')
    assert.equal(unauthorized, 0)
  })
})

test('a Tutor session body arriving after identity clearing cannot expose the previous account messages', async () => {
  await withCloudRuntime(async values => {
    let body!: ReadableStreamDefaultController<Uint8Array>
    const encoder = new TextEncoder()
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { body = controller; controller.enqueue(encoder.encode('{"id":17,"messages":')) },
    }), { headers: { 'Content-Type': 'application/json' } })
    activateRuntimeAuth({ desktop_auth_token: 'old-pet-handle' })
    const pending = loadFormalTutorSession(17)
    await new Promise(resolve => setImmediate(resolve))
    clearRuntimeAuth()
    assert.equal(values.has('learnflow.desktop.auth-token'), false)
    activateRuntimeAuth({ desktop_auth_token: 'new-pet-handle' })
    body.enqueue(encoder.encode('[{"content":"previous account private message"}]}'))
    body.close()
    await assert.rejects(pending, /身份已切换/)
    assert.equal(values.get('learnflow.desktop.auth-token'), 'new-pet-handle')
  })
})

test('native pet capability replacement invalidates pending bodies and a late native token cannot undo clearing', async () => {
  await withCloudRuntime(async (values, events) => {
    const modulePath = '../src/runtime-client.ts?pet-identity-test'
    const petRuntime = await import(modulePath) as typeof import('../src/runtime-client.ts')
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
    let nativeToken = 'lfpet_cloud_account-a'
    let readNativeToken = async () => nativeToken
    Object.assign(events, {
      location: { protocol: 'tauri:', hostname: 'localhost' },
      __TAURI_INTERNALS__: {
        metadata: { currentWebview: { label: 'pet' }, currentWindow: { label: 'pet' } },
        invoke: async (command: string) => {
          if (command === 'desktop_runtime_config') return { apiBaseUrl: 'http://127.0.0.1:8011/api', desktopToken: 'native-fixture', cloudOrigin: 'https://8.148.28.98' }
          assert.equal(command, 'desktop_pet_auth_token')
          return readNativeToken()
        },
      },
    })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: {} } } })
    globalThis.fetch = async () => Response.json({ ok: true })
    try {
      const initialized = await petRuntime.initializeRuntimeClient()
      assert.equal(initialized.ready, true, initialized.startupError)
      let body!: ReadableStreamDefaultController<Uint8Array>
      globalThis.fetch = async (_input, init) => {
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer lfpet_cloud_account-a')
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller } }))
      }
      const response = await petRuntime.runtimeFetch('/api/agent/sessions/17')
      const pending = response.json()
      nativeToken = 'lfpet_cloud_account-b'
      await petRuntime.refreshDesktopPetAuthToken()
      body.enqueue(new TextEncoder().encode('{"messages":["old account"]}'))
      body.close()
      await assert.rejects(pending, /身份已切换/)
      globalThis.fetch = async (_input, init) => {
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer lfpet_cloud_account-b')
        return Response.json({ messages: ['current account'] })
      }
      assert.deepEqual(await (await petRuntime.runtimeFetch('/api/agent/sessions/18')).json(), { messages: ['current account'] })

      let finishNative!: (value: string) => void
      readNativeToken = () => new Promise<string>(resolve => { finishNative = resolve })
      const staleNativeRead = petRuntime.refreshDesktopPetAuthToken()
      await new Promise(resolve => setImmediate(resolve))
      petRuntime.clearRuntimeAuth()
      finishNative('lfpet_cloud_account-b')
      await staleNativeRead
      assert.equal(values.has('learnflow.desktop.auth-token'), false)
    } finally {
      petRuntime.clearRuntimeAuth()
      if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
      else delete (globalThis as Record<string, unknown>).document
    }
  })
})
