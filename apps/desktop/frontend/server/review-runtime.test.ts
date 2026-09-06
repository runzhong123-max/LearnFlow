import assert from 'node:assert/strict'
import test from 'node:test'

import { submitReviewItem, type ReviewItem } from '../src/review-runtime.ts'
import { activateRuntimeAuth, clearRuntimeAuth } from '../src/runtime-client.ts'

test('review submission uses the authenticated runtime and sends CSRF protection', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; method: string; csrf: string | null }> = []
  clearRuntimeAuth()
  activateRuntimeAuth({ learner_id: 7 })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: String(init?.method || 'GET'),
      csrf: new Headers(init?.headers).get('X-CSRF-Token'),
    })
    if (url === '/api/auth/csrf') {
      return new Response(JSON.stringify({ csrf_token: 'csrf-review-7' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ outcome: 'incorrect', item: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  try {
    await submitReviewItem({
      id: 42,
      version: 3,
      presentation: { version: 'question-v2' },
    } as ReviewItem, {
      responseStatus: 'answered',
      code: 'print(1)',
    })
    assert.deepEqual(calls, [
      { url: '/api/auth/csrf', method: 'GET', csrf: null },
      { url: '/api/review/items/42/submit', method: 'POST', csrf: 'csrf-review-7' },
    ])
  } finally {
    globalThis.fetch = originalFetch
    clearRuntimeAuth()
  }
})
