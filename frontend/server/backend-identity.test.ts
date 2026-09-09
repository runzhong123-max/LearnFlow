import assert from 'node:assert/strict'
import test from 'node:test'
import { backendIdentityFromHeaders, backendIdentityHeaders, backendWriteHeaders, verifyBackendApiIdentity } from './backend-identity.ts'
import { createVisualHostTransport } from './tool-runtime.ts'
import { requestProjectPluginIntegration, runTutorAgentTurn } from './agent-runtime.ts'
import { serverArtifactHost } from './plugin-artifact-host.ts'
import { resolveLearnFlowIdentity } from '../../apps/role-atlas/lib/integrations/learnflow/auth.ts'

const authorization = `Bearer lfak_${'a'.repeat(43)}`

test('explicit authorization discards cookie identity and rejects ambiguous header values', () => {
  assert.deepEqual(backendIdentityHeaders(backendIdentityFromHeaders({authorization, cookie:'other-account'})), {Authorization:authorization})
  assert.deepEqual(backendIdentityHeaders(backendIdentityFromHeaders({cookie:'browser-session'})), {Cookie:'browser-session'})
  for (const invalid of ['', 'Basic secret', `${authorization},${authorization}`, [authorization, authorization]]) {
    assert.throws(() => backendIdentityFromHeaders({authorization:invalid}), /API key 无效/)
  }
})

test('key writes never request cookie CSRF and browser writes retain session CSRF', async () => {
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (url, init) => {
    requests.push(String(url))
    assert.equal(new Headers(init?.headers).get('Cookie'), 'browser-session')
    return new Response(JSON.stringify({csrf_token:'bound-csrf'}))
  }
  try {
    const headers = await backendWriteHeaders({requestAuthorization:authorization,requestCookie:'other-account'})
    assert.deepEqual(headers, {'Content-Type':'application/json',Authorization:authorization})
    assert.equal(requests.length, 0)
    const browser = await backendWriteHeaders({backendBase:'https://backend.test',requestCookie:'browser-session'})
    assert.equal(browser['X-CSRF-Token'],'bound-csrf')
    assert.deepEqual(requests, ['https://backend.test/api/auth/csrf'])
    await assert.rejects(backendWriteHeaders({backendBase:'https://backend.test'}), /无法验证/)
  } finally { globalThis.fetch = original }
})

test('key verification fails before a caller can start streaming on an invalid credential', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url),'https://backend.test/api/auth/api-key/verify')
    assert.equal(new Headers(init?.headers).get('Authorization'),authorization)
    assert.equal(new Headers(init?.headers).get('Cookie'),null)
    return new Response('', {status:401})
  }
  try { await assert.rejects(verifyBackendApiIdentity('https://backend.test',{requestAuthorization:authorization}), /API key 无效/) }
  finally { globalThis.fetch = original }
})

test('project integration and visual hosts carry key auth without cookie or csrf requests', async () => {
  const original = globalThis.fetch
  const paths: string[] = []
  globalThis.fetch = async (url, init) => {
    paths.push(String(url))
    assert.equal(new Headers(init?.headers).get('Authorization'), authorization)
    assert.equal(new Headers(init?.headers).get('Cookie'),null)
    assert.equal(new Headers(init?.headers).get('X-CSRF-Token'),null)
    assert.ok(!String(url).endsWith('/api/auth/csrf'))
    assert.ok(!String(init?.body).includes(authorization))
    return new Response(JSON.stringify({ok:true}))
  }
  try {
    await createVisualHostTransport({backendBase:'https://backend.test',requestAuthorization:authorization})('catalog', {})
    const host = serverArtifactHost({pluginId:'educational_visuals',backendBase:'https://backend.test',authorization,
      signal:new AbortController().signal,generate:async()=>'',context:'visible-only',projectId:3,sessionId:4})
    await host.request('catalog', {})
    await requestProjectPluginIntegration({input:{backendBase:'https://backend.test',requestAuthorization:authorization,messages:[]} as any,
      pluginId:'learning_task_conversion',operation:'prepare_project_guidance',payload:{name:'Experiment',objective:'Learn',project_mode:'experiment'},signal:new AbortController().signal})
    assert.equal(paths.length,3)
  } finally { globalThis.fetch = original }
})

test('Tutor provider inputs do not contain transport authorization', async () => {
  const result = await runTutorAgentTurn({
    baseUrl:'https://provider.test/v1',model:'test',mode:'free_conversation',toolChoice:'none',
    messages:[{role:'user',content:'你好'}],requestAuthorization:authorization,
    generate:async()=>'',invokeProvider:async request => {
      assert.ok(!JSON.stringify(request).includes(authorization))
      return {choices:[{message:{content:'你好。'},finish_reason:'stop'}]}
    },
  } as any)
  assert.ok(!JSON.stringify(result).includes(authorization))
})

test('Role Atlas forwards the key and consumes the backend effective user role without promoting it', async () => {
  const identity = await resolveLearnFlowIdentity({
    request:new Request('https://roles.test/api/admin/research?view=access',{headers:{Authorization:authorization}}),
    baseUrl:'https://backend.test',
    fetchImpl:async (url,init)=>{
      assert.equal(String(url),'https://backend.test/api/auth/me')
      assert.equal(new Headers(init?.headers).get('Authorization'),authorization)
      return Response.json({id:11,learner_id:23,username:'owner',display_name:'Owner',role:'user'})
    },
  })
  assert.equal(identity?.subjectId,'learnflow:learner:23')
  assert.equal(identity?.role,'user')
})
