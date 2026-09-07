import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activateFormalIdentity, invalidateFormalIdentity, loadFormalRemediationCase,
  changeFormalRemediationExplanation, prepareFormalRemediationVariant, submitFormalRemediationVariant,
  submitFormalConceptAnswer, submitFormalExercise, remediationCaseId, remediationRetryContext,
  remediationViewState, type FormalRemediationCase,
} from '../src/formal-runtime.ts'
import { completePracticeSubmission, learningFileProgressKey, preparePracticeSubmission } from '../src/learning-file-progress.ts'
import { getRuntimeClientState } from '../src/runtime-client.ts'

const explaining: FormalRemediationCase = {
  id: 31, status: 'explaining', item_type: 'concept', item_id: 8, current_delivery_mode: 'step_by_step',
  available_actions: { switch: true, steps: true, example: true, retry: true, variant: false },
}

function memoryStorage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}

test('only a real case opens remediation and server actions govern retry, variant and completion', () => {
  assert.equal(remediationCaseId(undefined, { latest_passed: true, attempt_count: 2 }), undefined)
  assert.equal(remediationCaseId(undefined, { latest_passed: false, attempt_count: 2 }), undefined)
  assert.equal(remediationCaseId({ remediation: { id: 31 } }, { remediation_case_id: 29 }), 31)
  assert.equal(remediationCaseId(undefined, { remediation_case_id: 29 }), 29)
  assert.equal(remediationCaseId(undefined, { remediation_case_id: -1 }), undefined)
  assert.equal(remediationViewState().canRetry, false)
  assert.equal(remediationViewState({ ...explaining, available_actions: {} }).canRetry, false)
  const initial = remediationViewState(explaining)
  assert.equal(initial.canRetry, true)
  assert.equal(initial.canVariant, false)
  assert.equal(initial.completed, false)
  assert.deepEqual(initial.explanationActions, ['switch', 'steps', 'example'])
  const variant = remediationViewState({ ...explaining, status: 'variant_ready', retry_attempt_id: 99,
    available_actions: { retry: false, variant: true } })
  assert.equal(variant.canRetry, false)
  assert.equal(variant.canVariant, true)
  assert.equal(variant.completed, false, 'a passed retry alone cannot complete a case')
  const completed = remediationViewState({ ...explaining, status: 'completed', available_actions: { retry: true, variant: true, switch: true } })
  assert.equal(completed.completed, true)
  assert.equal(completed.canRetry, false)
  assert.equal(completed.canVariant, false)
  assert.deepEqual(completed.explanationActions, [])
})

test('reading help and refreshing a case cannot turn a retry into independent original evidence', () => {
  assert.deepEqual(remediationRetryContext(explaining, { assistance_level: 'none', attempt_role: 'original' }), {
    remediation_case_id: 31, assistance_level: 'guided', attempt_role: 'retry',
  })
  const changedMode = { ...explaining, current_delivery_mode: 'contrast' }
  assert.equal(remediationRetryContext(changedMode, {}, 'guided').assistance_level, 'guided')
  assert.equal(remediationRetryContext(changedMode, {}).assistance_level, 'hint')
})

test('formal remediation transport preserves item/case IDs, response status, and authenticated write headers', async () => {
  const originalFetch = globalThis.fetch
  const runtime = getRuntimeClientState()
  const previousRuntime = { ...runtime }
  Object.assign(runtime, { kind: 'web', ready: true })
  const calls: Array<{ url: string; method: string; body: any; headers: Headers; credentials?: RequestCredentials }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, method: init?.method || 'GET', body: JSON.parse(String(init?.body || '{}')), headers: new Headers(init?.headers), credentials: init?.credentials })
    return new Response(JSON.stringify(url === '/api/auth/csrf' ? { csrf_token: 'remediation-fixture' }
      : url.endsWith('/variant/submit') ? { result: { correct: false, outcome: 'unknown' }, remediation: { ...explaining, status: 'variant_ready' } }
        : explaining))
  }
  activateFormalIdentity({ id: 1, learner_id: 11 } as any)
  try {
    await loadFormalRemediationCase(31)
    await changeFormalRemediationExplanation(31, 'switch')
    await changeFormalRemediationExplanation(31, 'steps')
    await changeFormalRemediationExplanation(31, 'example')
    const retry = remediationRetryContext(explaining, { client_submission_id: 'original-retry-1' })
    await submitFormalConceptAnswer(9, 8, { answer_indexes: [1] }, retry)
    await submitFormalExercise(12, 'print(1)', { ...retry, client_submission_id: 'code-retry-1' })
    await prepareFormalRemediationVariant(31)
    const evaluated = await submitFormalRemediationVariant(31, { response_status: 'unknown' }, 'variant-1')
    assert.equal(evaluated.result.outcome, 'unknown')
    assert.equal(evaluated.remediation.status, 'variant_ready')
    assert.deepEqual(calls.filter(call => call.url.endsWith('/explanations')).map(call => call.body.action), ['switch', 'steps', 'example'])
    const originalAttempts = calls.filter(call => /concepts\/8\/submit|exercises\/12\/submit/.test(call.url))
    for (const call of originalAttempts) {
      assert.equal(call.body.remediation_case_id, 31)
      assert.equal(call.body.assistance_level, 'guided')
      assert.equal(call.body.attempt_role, 'retry')
    }
    assert.equal(originalAttempts[0].body.client_submission_id, 'original-retry-1')
    assert.equal(originalAttempts[1].body.client_submission_id, 'code-retry-1')
    const variant = calls.find(call => call.url.endsWith('/variant/submit'))!
    assert.deepEqual(variant.body, { response_status: 'unknown', client_submission_id: 'variant-1' })
    for (const call of calls.filter(call => call.method === 'POST')) {
      assert.equal(call.headers.get('X-CSRF-Token'), 'remediation-fixture')
      assert.equal(call.credentials, 'include')
    }
    const before = calls.length
    await assert.rejects(loadFormalRemediationCase(0), /纠错记录/)
    await assert.rejects(submitFormalRemediationVariant(31, { answer_text: '2' }, ''), /请求标识/)
    assert.equal(calls.length, before, 'invalid case/request IDs never leave the client')
  } finally { invalidateFormalIdentity(); Object.assign(runtime, previousRuntime); globalThis.fetch = originalFetch }
})

test('a lost variant response keeps the same answer-bound identity while the case is reloaded', async () => {
  const originalFetch = globalThis.fetch
  const storage = memoryStorage()
  const key = `${learningFileProgressKey('web:1:11', 'remediation', 31)}:variant-request`
  const body = { answer_indexes: [1], response_status: 'answered' as const }
  const first = await preparePracticeSubmission(storage, key, body, { assistance_level: 'none' })
  const calls: Array<{ url: string; body: any }> = []
  let responses = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/auth/csrf') return new Response(JSON.stringify({ csrf_token: 'fixture' }))
    calls.push({ url, body: JSON.parse(String(init?.body || '{}')) })
    if (url.endsWith('/variant/submit') && responses++ === 0) throw new Error('response lost')
    return new Response(JSON.stringify(url.endsWith('/variant/submit')
      ? { result: { correct: true }, remediation: { ...explaining, status: 'completed' }, idempotent_replay: true }
      : { ...explaining, status: 'completed' }))
  }
  activateFormalIdentity({ id: 1, learner_id: 11 } as any)
  try {
    await assert.rejects(submitFormalRemediationVariant(31, body, first.client_submission_id!), /response lost/)
    assert.equal((await loadFormalRemediationCase(31)).status, 'completed')
    const pending = await preparePracticeSubmission(storage, key, body, { assistance_level: 'none' })
    assert.equal(pending.client_submission_id, first.client_submission_id)
    const replay = await submitFormalRemediationVariant(31, body, pending.client_submission_id!)
    assert.equal(replay.remediation.status, 'completed')
    assert.equal(calls[0].body.client_submission_id, calls[2].body.client_submission_id)
    completePracticeSubmission(storage, key, pending)
    const changed = await preparePracticeSubmission(storage, key, { ...body, answer_indexes: [0] }, {})
    assert.notEqual(changed.client_submission_id, first.client_submission_id)
    const otherCase = await preparePracticeSubmission(storage, `${learningFileProgressKey('web:1:11', 'remediation', 32)}:variant-request`, body, {})
    assert.notEqual(otherCase.client_submission_id, first.client_submission_id)
  } finally { invalidateFormalIdentity(); globalThis.fetch = originalFetch }
})
