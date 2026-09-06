import assert from 'node:assert/strict'
import test from 'node:test'
import { createEcosystemClient, EcosystemError, samePackageRef } from '../src/ecosystem-client.ts'
const packageRef = { packageId: 'role:test', packageVersion: '1.0.0', snapshotId: 'snapshot:one', rootHash: 'a'.repeat(64) }
const response = (requestId: string, data: unknown) => Response.json({ protocol: 'learnflow-ecosystem/v1', requestId, ok: true, data })
test('web and desktop clients call only runtime-relative gateway paths with all four pinned package fields', async () => {
  const calls: Array<{ path: string; body: any }> = []
  const client = createEcosystemClient(async (input, options) => {
    const body = JSON.parse(String(options?.body)); calls.push({ path: String(input), body })
    assert.equal(new Headers(options?.headers).has('Authorization'), false)
    assert.equal(new Headers(options?.headers).has('Cookie'), false)
    return response(body.requestId, { packageRef, title: '测试', result: { semantic: { nodes: [] } } })
  })
  await client.package(packageRef)
  assert.equal(calls[0].path, '/api/ecosystem/dispatch')
  assert.equal(calls[0].body.protocol, 'learnflow-ecosystem/v1')
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['operation', 'payload', 'protocol', 'requestId'])
  assert.equal(calls[0].body.operation, 'package.resolve')
  assert.deepEqual(calls[0].body.payload.packageRef, packageRef)
})
test('manual retry preserves operation identity and failures never auto retry an agent run', async () => {
  const bodies: any[] = []
  const client = createEcosystemClient(async (_input, options) => {
    bodies.push(JSON.parse(String(options?.body)))
    throw new Error('secret upstream url and token')
  })
  for (let i = 0; i < 2; i++) await assert.rejects(client.run(packageRef, '解释该技能', ['K-1'], 'same-request'), (e: any) => e instanceof EcosystemError && e.retryable && !e.message.includes('secret'))
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[0], bodies[1])
})
test('unauthorized and not configured never become a not-found catalog result or expose raw errors', async () => {
  for (const status of [401, 403, 503]) {
    const client = createEcosystemClient(async (_input, options) => Response.json({ protocol: 'learnflow-ecosystem/v1', requestId: JSON.parse(String(options?.body)).requestId, ok: false, error: { code: 'NOT_CONFIGURED', message: 'token=secret', retryable: false } }, { status }))
    await assert.rejects(client.search('测试'), (e: any) => e instanceof EcosystemError && !e.message.includes('secret') && (status !== 503 || e.code === 'NOT_CONFIGURED'))
  }
})
test('package identity rejects missing hash before transport and mismatched resolved snapshot', async () => {
  let count = 0
  const client = createEcosystemClient(async (_input, options) => {
    count++; return response(JSON.parse(String(options?.body)).requestId, { packageRef: { ...packageRef, snapshotId: 'different' }, result: { semantic: { nodes: [] } } })
  })
  await assert.rejects(client.package({ ...packageRef, rootHash: '' }), /标识不完整/)
  assert.equal(count, 0)
  await assert.rejects(client.package(packageRef), /不兼容/)
  assert.equal(samePackageRef(packageRef, { ...packageRef, rootHash: 'b'.repeat(64) }), false)
})
test('request correlation and protocol are checked before returning an operation result', async () => {
  const client = createEcosystemClient(async () => response('other-request', {}))
  await assert.rejects(client.commit('resolution:one', 'expected-request'), /不兼容/)
})
test('preview and explicit commit use separate endpoints and commit retries retain the same resolution', async () => {
  const calls: Array<{ url: string; body: any }> = []
  const client = createEcosystemClient(async (url, options) => {
    const body = JSON.parse(String(options?.body)); calls.push({ url: String(url), body }); return response(body.requestId, {})
  })
  await client.resolve(packageRef, ['K-1'], 'resolve-one')
  assert.equal(calls.length, 1)
  await client.commit('resolution:one', 'commit-one')
  await client.commit('resolution:one', 'commit-one')
  assert.equal(calls[0].url, '/api/ecosystem/learning-path/resolve')
  assert.deepEqual(calls[0].body.packageRef, packageRef)
  assert.equal(calls[1].url, '/api/ecosystem/learning-path/commit')
  assert.deepEqual(calls[1], calls[2])
})

test('agent completion and polling cannot silently switch the pinned package or run identity', async () => {
  for (const data of [
    { runId: 'run:one', status: 'completed', result: { answer: 'answer', citations: [], packageRef: { ...packageRef, rootHash: 'b'.repeat(64) } } },
    { runId: 'run:other', status: 'running' },
    { runId: 'run:one', status: 'completed' },
  ]) {
    const client = createEcosystemClient(async (_url, options) => response(JSON.parse(String(options?.body)).requestId, data))
    await assert.rejects(client.getRun('run:one', packageRef), /不兼容/)
  }
})
