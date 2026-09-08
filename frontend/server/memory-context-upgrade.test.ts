import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
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


test('memory tool preserves original excerpt provenance, distant limits and two-hop metadata', async () => {
  const qualification = '仅单线程通过，并发未验证。'
  const target = 'pulserail 异步取消后留下句柄泄漏。'
  const original = qualification + '重复过程备注。'.repeat(130) + target
  const ranges = [[0, qualification.length], [original.length - target.length, original.length]]
  const text = ranges.map(([a, b]) => original.slice(a, b)).join(' … ')
  const sourceText = {
    sha256: createHash('sha256').update(original, 'utf8').digest('hex'),
    chars: original.length, ranges, truncated: true, qualifier_spans_omitted: 0,
  }
  const packet = {
    snapshot_id: 'bounded-original-evidence',
    items: [{ id: 31, text, scope: { project_id: 9 }, evidence_refs: [7],
      detail: { evidence_grade: 'observed', source_text: sourceText } }],
    relation_paths: [{ relation: 'BLOCKS', source: { id: 33, text: '归档签字' },
      target: { id: 32, text: '接口确认' }, hop: 2, root_anchor_id: 31, via_node_ids: [31, 32, 33] }],
    manifest: { direct_memory_evidence: true, retrieval_version: 'read-contract-fixture' },
  }
  const result = await executeTutorAgentTool('read_learner_context', { query: 'pulserail' }, {
    message: '查看取消故障', generate: async () => '', readLearnerContext: async () => packet,
  })
  const observation = result.observation as any
  const observed = observation.items[0]
  assert.ok(observed.text.length <= 640)
  assert.match(observed.text, /仅单线程通过，并发未验证/)
  assert.match(observed.text, /pulserail 异步取消后留下句柄泄漏/)
  assert.deepEqual(observed.detail.source_text, sourceText)
  assert.equal(observed.text, observed.detail.source_text.ranges
    .map(([a, b]: number[]) => original.slice(a, b)).join(' … '))
  assert.equal(observed.detail.evidence_grade, 'observed')
  assert.equal(observation.manifest.direct_memory_evidence, true)
  assert.deepEqual(observation.relation_paths[0], packet.relation_paths[0])
})

test('memory tool preserves explicit lack of direct evidence without substituting demo facts', async () => {
  const result = await executeTutorAgentTool('read_learner_context', { query: '学习记录和证据' }, {
    message: '查记录', generate: async () => '', readLearnerContext: async () => ({
      snapshot_id: 'no-direct-match', items: [], relation_paths: [],
      manifest: { direct_memory_evidence: false },
    }),
  })
  const observation = result.observation as any
  assert.equal(observation.snapshot_id, 'no-direct-match')
  assert.deepEqual(observation.items, [])
  assert.deepEqual(observation.relation_paths, [])
  assert.equal(observation.manifest.direct_memory_evidence, false)
  assert.notEqual(observation.authority, 'local_demo_fallback')
})
