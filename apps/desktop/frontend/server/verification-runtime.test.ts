import assert from 'node:assert/strict'
import test from 'node:test'
import { createVerificationRuntime, validateTeachBack, verificationPresentation, verificationRequestId, type VerificationRun, type VerificationTransport } from '../src/verification-runtime.ts'

function run(overrides: Partial<VerificationRun> = {}): VerificationRun {
  return { id: 12, goal: '程序链接', status: 'active', state: 'learning_card', version: 3,
    project_id: 4, checkpoint_id: 8, session_id: 9, learning_card: { quality_status: 'ready' },
    teach_back: {}, verification: { question_ids: [21, 22] }, summary: {}, ...overrides }
}

test('verification stages and completion follow server state, not question counts', () => {
  assert.deepEqual(verificationPresentation(run()).actions, ['complete_card', 'pause'])
  assert.deepEqual(verificationPresentation(run({ learning_card: { quality_status: 'blocked' } })).actions, ['pause'])
  assert.equal(verificationPresentation(run({ state: 'teach_back' })).canTeachBack, true)
  assert.deepEqual(verificationPresentation(run({ state: 'teach_back_feedback' })).actions, ['continue_after_feedback', 'pause'])
  assert.equal(verificationPresentation(run({ state: 'verification' })).practiceRef, 'questions-8')
  assert.equal(verificationPresentation(run({ state: 'remediation' })).practiceRef, 'questions-8')
  assert.deepEqual(verificationPresentation(run({ state: 'paused', status: 'paused' })).actions, ['resume'])
  assert.equal(verificationPresentation(run({ state: 'verification', verification: { question_ids: [21], completed_question_ids: [21] } })).completed, false)
  assert.equal(verificationPresentation(run({ state: 'completed', status: 'active' })).completed, false)
  const completed = verificationPresentation(run({ state: 'completed', status: 'completed' }))
  assert.equal(completed.completed, true)
  assert.equal(completed.practiceRef, null)
  assert.deepEqual(completed.actions, [])
})

test('load validates the requested run identity and uses the authenticated transport', async () => {
  const calls: string[] = []
  const transport: VerificationTransport = async <T>(path: string) => { calls.push(path); return run() as T }
  assert.equal((await createVerificationRuntime(transport).load(12)).version, 3)
  assert.deepEqual(calls, ['/api/micro-learning/runs/12'])
  await assert.rejects(createVerificationRuntime(transport).load(19), /响应不完整/)
  await assert.rejects(createVerificationRuntime(transport).load(-1), /记录无效/)
})

test('advance retries preserve the exact operation id and expected version', async () => {
  const calls: Array<{ path: string; method?: string; body: Record<string, unknown> }> = []
  const transport: VerificationTransport = async <T>(path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method, body: JSON.parse(String(init?.body)) })
    if (calls.length === 1) throw new Error('response lost')
    return run({ state: 'teach_back', version: 4 }) as T
  }
  const runtime = createVerificationRuntime(transport)
  await assert.rejects(runtime.advance(run(), 'complete_card'), /response lost/)
  assert.equal((await runtime.advance(run(), 'complete_card')).state, 'teach_back')
  assert.deepEqual(calls[0], calls[1])
  assert.equal(calls[0].path, '/api/micro-learning/runs/12/advance')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].body.expected_version, 3)
  assert.equal(calls[0].body.action, 'complete_card')
  assert.equal(String(calls[0].body.client_action_id).length <= 120, true)
  assert.throws(() => runtime.advance(run(), 'continue_after_feedback'), /当前步骤/)
})

test('teach-back validates the real 20-character contract and uses content-bound stable ids', async () => {
  const response = '链接器找到目标文件中的符号定义，并根据最终布局修正引用地址。'
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const runtime = createVerificationRuntime(async <T>(path: string, init?: RequestInit) => {
    calls.push({ path, body: JSON.parse(String(init?.body)) })
    return run({ state: 'teach_back_feedback', version: 4 }) as T
  })
  assert.throws(() => validateTeachBack('字'.repeat(19)), /至少写20/)
  assert.throws(() => validateTeachBack('😀'.repeat(10)), /至少写20/)
  assert.throws(() => validateTeachBack('字'.repeat(6001)), /6000/)
  assert.equal(validateTeachBack(` ${'字'.repeat(20)} `).length, 20)
  await runtime.teachBack(run({ state: 'teach_back' }), ` ${response} `)
  await runtime.teachBack(run({ state: 'teach_back' }), response)
  assert.deepEqual(calls[0], calls[1])
  assert.equal(calls[0].path, '/api/micro-learning/runs/12/teach-back')
  assert.equal(calls[0].body.response, response)
  assert.equal(calls[0].body.expected_version, 3)
  assert.notEqual(verificationRequestId(run(), 'teach-back', response), verificationRequestId(run(), 'teach-back', `${response}另外的解释`))
})

test('practice synchronization preserves expected version and accepts only server completion', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const runtime = createVerificationRuntime(async <T>(path: string, init?: RequestInit) => {
    calls.push({ path, body: JSON.parse(String(init?.body)) })
    return run({ status: 'completed', state: 'completed', version: 4, summary: { mastery_claim: 'not_stable_yet' } }) as T
  })
  const current = run({ state: 'verification' })
  const updated = await runtime.sync(current)
  assert.equal(current.state, 'verification')
  assert.equal(updated.state, 'completed')
  assert.equal(updated.summary.mastery_claim, 'not_stable_yet')
  assert.equal(calls[0].path, '/api/micro-learning/runs/12/sync')
  assert.equal(calls[0].body.expected_version, 3)
  assert.equal(calls[0].body.client_action_id, verificationRequestId(current, 'sync'))
})

test('pause and resume use explicit server actions without creating a new run', async () => {
  const calls: Record<string, unknown>[] = []
  const runtime = createVerificationRuntime(async <T>(_path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    calls.push(body)
    return run(body.action === 'pause' ? { status: 'paused', state: 'paused', version: 4 } : { state: 'verification', version: 5 }) as T
  })
  const paused = await runtime.advance(run({ state: 'verification' }), 'pause')
  const resumed = await runtime.advance(paused, 'resume')
  assert.equal(resumed.id, paused.id)
  assert.deepEqual(calls.map(body => [body.action, body.expected_version]), [['pause', 3], ['resume', 4]])
  assert.notEqual(calls[0].client_action_id, calls[1].client_action_id)
})
