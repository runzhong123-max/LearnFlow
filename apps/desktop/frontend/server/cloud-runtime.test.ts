import assert from 'node:assert/strict'
import test from 'node:test'
import { getRuntimeClientState, isCloudDesktopRuntime, isLocalLearningRuntime, learnerWorkspaceStorageKey, resolveRuntimeUrl, runtimeFetch } from '../src/runtime-client.ts'

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
