import assert from 'node:assert/strict'
import test from 'node:test'
import { isIpAccountConsole, ipAccountApiUrl } from '../src/ip-account-console.ts'

test('account desk uses only trusted HTTPS IP and a separate auth prefix', () => {
  const location = {protocol:'https:', hostname:'8.148.28.98', pathname:'/account'}
  assert.equal(isIpAccountConsole(location), true)
  assert.equal(ipAccountApiUrl('/api/auth/api-keys/1/reveal', location), '/account-api/auth/api-keys/1/reveal')
  assert.equal(ipAccountApiUrl('/api/projects', location), '/api/projects')
  assert.equal(ipAccountApiUrl('/api/authentic', location), '/api/authentic')
  for (const other of [{...location,protocol:'http:'},{...location,hostname:'learn.learnflow.club'},{...location,pathname:'/settings'},{...location,pathname:'/account-evil'}]) {
    assert.equal(isIpAccountConsole(other), false)
    assert.equal(ipAccountApiUrl('/api/auth/me', other), '/api/auth/me')
  }
})

test('account desk sends Cookie and CSRF via its bounded browser prefix', async () => {
  const { activateRuntimeAuth, clearRuntimeAuth, runtimeFetch } = await import('../src/runtime-client.ts')
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousFetch = globalThis.fetch
  const calls: Array<{url: string; init?: RequestInit}> = []
  Object.defineProperty(globalThis, 'window', {configurable:true,value:{location:{protocol:'https:',hostname:'8.148.28.98',pathname:'/account'}}})
  globalThis.fetch = async (url, init) => {
    calls.push({url:String(url),init})
    return Response.json(String(url).endsWith('/csrf') ? {csrf_token:'test-csrf'} : {ok:true})
  }
  try {
    activateRuntimeAuth({})
    await runtimeFetch('/api/auth/api-keys', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
    assert.deepEqual(calls.map(call=>call.url), ['/account-api/auth/csrf','/account-api/auth/api-keys'])
    assert.equal(new Headers(calls[1].init?.headers).get('X-CSRF-Token'), 'test-csrf')
    assert.equal(new Headers(calls[1].init?.headers).has('Authorization'), false)
    assert.equal(calls[1].init?.credentials, 'include')
  } finally {
    clearRuntimeAuth(); globalThis.fetch=previousFetch
    if (previousWindow) Object.defineProperty(globalThis,'window',previousWindow)
    else Reflect.deleteProperty(globalThis,'window')
  }
})
