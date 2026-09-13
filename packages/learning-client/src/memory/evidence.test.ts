import test from 'node:test'
import assert from 'node:assert/strict'
import { createEvidenceReader, evidenceUrl, qualificationLabel } from './evidence.ts'

test('requests carry object scope and reject unsafe identifiers', () => {
  assert.equal(evidenceUrl({ reviewScheduleId: 3, projectId: 8 }), '/api/memory/evidence?review_schedule_id=3&project_id=8')
  assert.equal(evidenceUrl({ nodeId: 4, checkpointId: 7 }), '/api/memory/evidence/4?checkpoint_id=7')
  for (const value of [-1, 0, NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => evidenceUrl({ nodeId: value }))
    assert.throws(() => evidenceUrl({ projectId: value }))
  }
})
test('history, invalidation and current qualification remain distinct', () => {
  assert.match(qualificationLabel({ availability: 'historical', qualification: null }), /历史/)
  assert.match(qualificationLabel({ availability: 'invalidated', qualification: null }), /重新验证/)
  assert.match(qualificationLabel({ availability: 'current', qualification: null }), /具体证据等级/)
})
test('reader forwards cancellation and cookie ownership with no caller learner id', async () => {
  const controller = new AbortController()
  const reader = createEvidenceReader(async (url, init) => {
    assert.equal(url, '/api/memory/evidence?review_schedule_id=3')
    assert.equal(init?.signal, controller.signal)
    assert.equal(init?.credentials, 'include')
    return Response.json({ schema_version: 'learnflow.memory-evidence.v1', cards: [], next_before_id: null })
  })
  assert.deepEqual((await reader({ reviewScheduleId: 3 }, controller.signal)).cards, [])
})
test('failed or incompatible reads never become empty success', async () => {
  for (const response of [new Response('', { status: 404 }), new Response('', { status: 500 }), Response.json({ schema_version: 'future' })]) {
    await assert.rejects(createEvidenceReader(async () => response)({}))
  }
})
