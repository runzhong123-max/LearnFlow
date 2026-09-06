import assert from 'node:assert/strict'
import test from 'node:test'
import { executeTutorAgentTool } from './tool-runtime.ts'

test('memory tool executes a revised query and preserves evidence context', async () => {
  const requested: string[] = []
  const result = await executeTutorAgentTool('read_learner_context', { query: '上个月的目标' }, {
    message: '我最近怎样', generate: async () => '',
    formalLearnerContext: { snapshot_id: 'old' },
    readLearnerContext: async query => {
      requested.push(query)
      return { snapshot_id: 'new', items: [{ id: 1, text: '目标',
        scope: { project_id: 9 }, occurred_at: '2026-08-01', evidence_refs: [7] }],
        omitted: { candidate_window_may_be_truncated: true } }
    },
  })
  const observation = result.observation as any
  assert.deepEqual(requested, ['上个月的目标'])
  assert.equal(observation.snapshot_id, 'new')
  assert.equal(observation.items[0].scope.project_id, 9)
  assert.equal(observation.items[0].occurred_at, '2026-08-01')
  assert.deepEqual(observation.items[0].evidence_refs, [7])
  assert.equal(observation.omitted.candidate_window_may_be_truncated, true)
})

test('unavailable practice records are never displayed as zero attempts', async () => {
  const result = await executeTutorAgentTool('read_learning_workspace', {}, {
    message: '我练习过什么', generate: async () => '',
  })
  assert.match(result.run.observationSummary || '', /暂不可用/)
  assert.doesNotMatch(result.run.observationSummary || '', /0 次/)
  assert.equal((result.observation as any).evidenceAvailability, 'unavailable')
  assert.equal((result.observation as any).learningEvidence, null)
})
