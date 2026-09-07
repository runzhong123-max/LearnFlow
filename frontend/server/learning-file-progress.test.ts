import assert from 'node:assert/strict'
import test from 'node:test'
import {
  completePracticeSubmission,
  learningFileProgressKey,
  notifyLearningFileProgress,
  practiceSubmissionContext,
  preparePracticeSubmission,
  readFileProgress,
  restoredLecturePosition,
  saveFileProgress,
} from '../src/learning-file-progress.ts'
import {
  activateFormalIdentity,
  actOnFormalLearningSkillRun,
  generateFormalLearningFiles,
  invalidateFormalIdentity,
  markFormalLectureRead,
  submitFormalConceptAnswer,
  submitFormalExercise,
} from '../src/formal-runtime.ts'

function memoryStorage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
}

test('lecture positions restore within learner, file and version boundaries', () => {
  const storage = memoryStorage()
  const key = learningFileProgressKey('web:account-1:learner-1', 'lecture', 17, 3)
  saveFileProgress(storage, key, '4')
  assert.equal(restoredLecturePosition(readFileProgress(storage, key), 8), 4)
  for (const other of [
    learningFileProgressKey('web:account-2:learner-2', 'lecture', 17, 3),
    learningFileProgressKey('web:account-1:learner-1', 'lecture', 18, 3),
    learningFileProgressKey('web:account-1:learner-1', 'lecture', 17, 4),
    learningFileProgressKey('desktop:account-1:learner-1', 'lecture', 17, 3),
  ]) assert.equal(restoredLecturePosition(readFileProgress(storage, other), 8), 0)
  assert.equal(restoredLecturePosition('99', 3), 2)
  assert.equal(restoredLecturePosition('bad-cache', 3), 0)
  assert.equal(restoredLecturePosition(null, 3, 1), 1)
  assert.equal(restoredLecturePosition('9', 0), 0)
})

test('support and existing attempts cannot become independent original submissions after refresh', () => {
  assert.deepEqual(practiceSubmissionContext(undefined, false), { assistance_level: 'none', attempt_role: 'original' })
  assert.deepEqual(practiceSubmissionContext(undefined, false, 'worked_example'), { assistance_level: 'guided', attempt_role: 'original' })
  assert.deepEqual(practiceSubmissionContext(undefined, false, 'step_by_step'), { assistance_level: 'guided', attempt_role: 'original' })
  assert.deepEqual(practiceSubmissionContext(undefined, false, '', true), { assistance_level: 'hint', attempt_role: 'original' })
  assert.deepEqual(practiceSubmissionContext({ attempt_count: 1 }, false), { assistance_level: 'hint', attempt_role: 'retry' })
  assert.deepEqual(practiceSubmissionContext({ latest_attempt_id: 24, latest_assistance_level: 'guided' }, false), { assistance_level: 'guided', attempt_role: 'retry' })
  assert.deepEqual(practiceSubmissionContext(undefined, true), { assistance_level: 'hint', attempt_role: 'retry' })
})

test('uncertain submissions reuse their request identity across refresh and preserve original assistance', async () => {
  const storage = memoryStorage()
  const first = await preparePracticeSubmission(storage, 'learner-1:q-7', { response: 'learner answer' }, { assistance_level: 'guided', attempt_role: 'original' })
  const retry = await preparePracticeSubmission(storage, 'learner-1:q-7', { response: 'learner answer' }, { assistance_level: 'none', attempt_role: 'retry' })
  assert.deepEqual(retry, first)
  assert.doesNotMatch(storage.getItem('learner-1:q-7') || '', /learner answer/)
  completePracticeSubmission(storage, 'learner-1:q-7', first)
  const nextAttempt = await preparePracticeSubmission(storage, 'learner-1:q-7', { response: 'learner answer' }, { assistance_level: 'hint', attempt_role: 'retry' })
  assert.notEqual(nextAttempt.client_submission_id, first.client_submission_id)
  const otherLearner = await preparePracticeSubmission(storage, 'learner-2:q-7', { response: 'learner answer' }, { assistance_level: 'none', attempt_role: 'original' })
  assert.notEqual(otherLearner.client_submission_id, first.client_submission_id)
})

test('progress callbacks finish before returning and callback failure remains distinct from file persistence', async () => {
  const calls: string[] = []
  await notifyLearningFileProgress(async () => { calls.push('synced') }, 'chat-1')
  assert.deepEqual(calls, ['synced'])
  await assert.rejects(notifyLearningFileProgress(async () => { throw new Error('progress unavailable') }), /progress unavailable/)
})

test('embedded practice without a callback notifies its owning conversation', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const target = new EventTarget()
  const ids: string[] = []
  target.addEventListener('learnflow-learning-file-progress', event => ids.push((event as CustomEvent).detail.conversationId))
  Object.defineProperty(globalThis, 'window', { value: target, configurable: true })
  try {
    await notifyLearningFileProgress(undefined, 'chat-17')
    await notifyLearningFileProgress(undefined)
    assert.deepEqual(ids, ['chat-17'])
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('file API forwards kinds, read scope, artifact sync, and honest submission context', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; body: any }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/auth/csrf') return new Response(JSON.stringify({ csrf_token: 'fixture' }))
    requests.push({ url, body: JSON.parse(String(init?.body || '{}')) })
    return new Response(JSON.stringify({ id: 7, correct: false, passed: false, attempt_id: 99, answer_indexes: [] }))
  }) as typeof fetch
  activateFormalIdentity({ id: 1, learner_id: 11 } as any)
  try {
    const task = { id: 7, version: 3 } as any
    await generateFormalLearningFiles(task, ['practice'])
    await generateFormalLearningFiles(task)
    await markFormalLectureRead(17, { session_id: 4, learning_task_id: 7 })
    await actOnFormalLearningSkillRun(4, { id: 19, version: 2 }, 'sync_artifacts')
    await submitFormalConceptAnswer(9, 8, { answer_indexes: [1], helpful_format: 'worked_example' }, { assistance_level: 'guided', attempt_role: 'retry', client_submission_id: 'fixed-concept' })
    await submitFormalExercise(12, 'print(1)', { assistance_level: 'hint', attempt_role: 'retry', client_submission_id: 'fixed-code' })
    assert.deepEqual(requests[0].body.file_kinds, ['practice'])
    assert.deepEqual(requests[1].body.file_kinds, ['lecture', 'practice'])
    assert.equal(requests[2].body.session_id, 4)
    assert.equal(requests[2].body.learning_task_id, 7)
    assert.equal(requests[3].body.action, 'sync_artifacts')
    assert.equal(requests[4].body.assistance_level, 'guided')
    assert.equal(requests[4].body.attempt_role, 'retry')
    assert.equal(requests[4].body.client_submission_id, 'fixed-concept')
    assert.equal(requests[5].body.assistance_level, 'hint')
    assert.equal(requests[5].body.attempt_role, 'retry')
    assert.equal(requests[5].body.client_submission_id, 'fixed-code')
  } finally {
    invalidateFormalIdentity()
    globalThis.fetch = originalFetch
  }
})
