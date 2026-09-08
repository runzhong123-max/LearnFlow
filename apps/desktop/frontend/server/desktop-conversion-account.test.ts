import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { initializeRuntimeClient, runtimeFetch } from '../src/runtime-client.ts'
import { getFormalAuthStatus, loginFormalAccount, logoutFormalAccount } from '../src/formal-runtime.ts'
import { validateConversionPreview } from '../src/desktop-conversion.ts'

// Exercise AuthGate's real logout/login functions through native runtime HTTP,
// with native IPC represented by an in-memory queue. No ticket storage fallback.
test('wrong-account recovery logs out, requires explicit login, and retains only native pending ticket', async () => {
  const original = { window: globalThis.window, document: globalThis.document, sessionStorage: globalThis.sessionStorage, localStorage: globalThis.localStorage, fetch: globalThis.fetch }
  const ticket = 'wt_' + 'a'.repeat(43)
  const nativeQueue = [ticket]
  const ipc: string[] = [], requests: string[] = []
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }
  let loggedIn = 0
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const file = { path: 'README.md', content: '初始材料', sha256: hash('初始材料') }
  const proposal = { schema_version: 'learnflow.work-task-conversion.v1', learner_id: 7, id: 'wc-1', root_hash: 'b'.repeat(64), candidate: { project_mode: 'experiment', title: '实验', summary: '比较输入' }, starter_files: [file], starter_manifest_hash: hash(JSON.stringify([{ path: file.path, sha256: file.sha256, size: Buffer.byteLength(file.content) }])), expires_at: new Date(Date.now() + 900_000).toISOString(), consumed: false }
  Object.assign(globalThis, {
    sessionStorage: storage, localStorage: storage,
    document: { documentElement: { dataset: {} } },
    window: Object.assign(new EventTarget(), {
      location: { protocol: 'tauri:', hostname: 'localhost' },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        invoke: async (command: string) => {
          ipc.push(command)
          if (command === 'desktop_runtime_config') return { apiBaseUrl: 'http://127.0.0.1:8011/api', desktopToken: 'native-session', cloudOrigin: 'https://learn.example' }
          if (command === 'desktop_pending_conversion') return nativeQueue[0] ?? null
          if (command === 'clear_desktop_pending_conversion') { nativeQueue.shift(); return }
          if (command === 'clear_desktop_auth_token') return
          throw new Error('Unexpected IPC: ' + command)
        },
      },
    }),
  })
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    requests.push(path)
    if (path === '/health') return new Response('{}')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('X-LearnFlow-Desktop-Token'), 'native-session')
    if (path === '/cloud/api/auth/login') {
      loggedIn = JSON.parse(String(init?.body)).username === 'owner' ? 7 : 8
      return Response.json({ id: loggedIn, learner_id: loggedIn, username: loggedIn === 7 ? 'owner' : 'other', desktop_auth_token: 'handle-' + loggedIn })
    }
    if (path === '/cloud/api/auth/logout') { assert.equal(headers.get('Authorization'), 'Bearer handle-8'); loggedIn = 0; return Response.json({ status: 'ok' }) }
    if (path === '/cloud/api/auth/status') return Response.json({ authenticated: loggedIn > 0 })
    if (path.startsWith('/cloud/api/work-task-conversions/handoff/')) {
      if (loggedIn !== 7) return Response.json({ detail: 'Wrong account' }, { status: 404 })
      assert.equal(headers.get('Authorization'), 'Bearer handle-7')
      return Response.json(proposal)
    }
    throw new Error('Unexpected HTTP request: ' + path)
  }
  try {
    await initializeRuntimeClient()
    const { invoke } = await import('@tauri-apps/api/core')
    await loginFormalAccount('other', 'user-entered-password')
    assert.equal((await runtimeFetch('/api/work-task-conversions/handoff/' + ticket)).status, 404)
    // The modal's new recovery action calls auth.signOut, which invokes this.
    await logoutFormalAccount()
    assert.equal((await getFormalAuthStatus()).authenticated, false)
    assert.equal(loggedIn, 0)
    assert.equal(values.has('learnflow.desktop.auth-token'), false)
    assert.equal(await invoke('desktop_pending_conversion'), ticket)
    assert.equal(requests.filter(path => path.endsWith('/auth/login')).length, 1)
    // Only an explicit new login can proceed; the original ticket was never consumed/cleared.
    const owner = await loginFormalAccount('owner', 'another-user-entered-password')
    const resumed = await runtimeFetch('/api/work-task-conversions/handoff/' + await invoke('desktop_pending_conversion'))
    assert.equal((await validateConversionPreview(await resumed.json(), owner.learner_id)).root_hash, proposal.root_hash)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.ok(ipc.includes('clear_desktop_auth_token'))
    assert.ok(!ipc.includes('clear_desktop_pending_conversion'))
    assert.ok([...values.values()].every(value => !value.includes(ticket)))
    assert.equal(nativeQueue[0], ticket)
  } finally { Object.assign(globalThis, original) }
})
