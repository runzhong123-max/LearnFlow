import assert from 'node:assert/strict'
import test from 'node:test'
import { rolePackageToolContext, serverRolePackageHost } from './role-package-host.ts'
import { latestRolePackageReference, rolePackageToolArguments } from '../../packages/learning-client/src/role-packages/reference.ts'
const ref = { packageId: 'role:hub', packageVersion: '1.2.0', snapshotId: 'snapshot:hub', rootHash: 'a'.repeat(64) }

test('a consumed legacy launch pins subsequent tools including the omitted hash; explicit switch changes the pin', () => {
  const { rootHash, ...oldSelector } = ref
  const message = { toolRuns: [{ status: 'completed', plugin: { pluginId: 'role_capability_graph', toolId: 'reference_role_package', result: { payload: { requiredSelector: oldSelector, reference: ref } } } }] }
  const pin = latestRolePackageReference([message])
  assert.deepEqual(pin, ref)
  assert.deepEqual(rolePackageToolArguments('role_capability_graph', 'read_role_objects', { objectIds: ['task:1'] }, pin), { ...ref, objectIds: ['task:1'] })
  assert.throws(() => rolePackageToolArguments('role_capability_graph', 'audit_role_package', { rootHash: 'b'.repeat(64) }, pin), /reference_conflict/)
  assert.deepEqual(rolePackageToolArguments('another_plugin', 'audit_role_package', {}, pin), {})
  const next = { ...ref, rootHash: 'b'.repeat(64) }
  assert.deepEqual(rolePackageToolArguments('role_capability_graph', 'reference_role_package', next, pin), next)
  assert.deepEqual(latestRolePackageReference([message, { toolRuns: [{ plugin: { ...message.toolRuns[0].plugin, result: { payload: { requiredSelector: next } } } }] }]), next)
  assert.deepEqual(rolePackageToolContext('another_plugin', {}, new AbortController().signal), {})
  const invalid = latestRolePackageReference([message, { toolRuns: [{ plugin: { ...message.toolRuns[0].plugin, result: { payload: { requiredSelector: oldSelector } } } }] }])
  assert.throws(() => rolePackageToolArguments('role_capability_graph', 'audit_role_package', {}, invalid), /reference_incomplete/)
  assert.deepEqual(rolePackageToolArguments('role_capability_graph', 'reference_role_package', next, invalid), next)
})

test('host reads through a fixed authenticated gateway, validates identity and never reuses private bytes', async () => {
  const original = globalThis.fetch
  const calls: Array<{ url: string; body: any; headers: Headers }> = []
  let denied = false, mismatched = false
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)), headers = new Headers(init?.headers)
    calls.push({ url: String(url), body, headers })
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.cache, 'no-store')
    assert.equal(headers.get('Authorization'), 'Bearer fixture')
    assert.equal(headers.get('Cookie'), null)
    return new Response(JSON.stringify({ protocol: 'learnflow-ecosystem/v1', requestId: body.requestId, ok: !denied,
      ...(denied ? { error: { code: 'PACKAGE_NOT_FOUND' } } : { data: { packageRef: mismatched ? { ...ref, snapshotId: 'other' } : ref, bundle: { fixture: true } } }),
    }), { status: denied ? 404 : 200 })
  }
  try {
    const host = serverRolePackageHost({ backendBase: 'https://backend.test', requestAuthorization: 'Bearer fixture', requestCookie: 'stale=other-account' }, new AbortController().signal)
    assert.deepEqual(await host.resolve(ref), { fixture: true })
    denied = true; await assert.rejects(host.resolve(ref), /PACKAGE_NOT_FOUND/)
    denied = false; mismatched = true; await assert.rejects(host.resolve(ref), /identity_mismatch/)
    assert.equal(calls.length, 3)
    assert.ok(calls.every(call => call.url === 'https://backend.test/api/ecosystem/dispatch'
      && call.body.operation === 'package.resolve' && call.body.payload.format === 'bundle'))
    assert.deepEqual(calls[0].body.payload.packageRef, ref)
    assert.notEqual(calls[0].body.requestId, calls[1].body.requestId)
  } finally { globalThis.fetch = original }
})
