import assert from 'node:assert/strict'
import test from 'node:test'
import { explicitProjectGuidanceMode, projectGuidanceChoicePrompt, projectGuidanceConfirmationPrompt, projectGuidanceDirectRequest, projectGuidanceConfirmation } from './contract.ts'
import { confirmProjectGuidance, prepareProjectGuidance } from './runtime.ts'

const brief = { rawInput: '实现 CSV 数据校验', projectMode: 'experiment', name: 'CSV 校验实验', objective: '独立实现数据校验',
  deliverables: ['校验器代码', '测试报告'], constraints: ['使用隔离样例数据'], successCriteria: ['有效数据保留，无效数据说明原因'] }
const scope = { learnerId: 3, conversationId: 'chat-4', sessionId: 17, sheetId: 'sheet-2' }
const candidate = { schema_version: 'learnflow.project-guidance.v1', candidate_id: 'pg_example', root_hash: 'a'.repeat(64),
  candidate: { project_mode: 'experiment', name: brief.name, objective: brief.objective, project_brief: {
    deliverables: brief.deliverables, constraints: brief.constraints, success_criteria: brief.successCriteria,
  } }, requires_confirmation: true }

test('unspecified project mode presents three choices without backend or model work', async () => {
  const calls: any[] = []
  const result = await prepareProjectGuidance({ rawInput: '帮我把部署工作变成学习项目' }, { scope,
    projectIntegration: { request: async (...args) => { calls.push(args); return null } } })
  assert.equal((result.payload as any).status, 'needs_mode_selection')
  assert.equal((result.payload as any).choices.length, 3)
  assert.deepEqual(calls, [])
  assert.equal(explicitProjectGuidanceMode('编程与测试'), undefined)
  assert.equal(explicitProjectGuidanceMode('知识学习项目或实验项目'), undefined)
  assert.equal(explicitProjectGuidanceMode(projectGuidanceChoicePrompt('experiment', '数据学习任务')), 'experiment')
})

test('experiment preparation uses the LearnFlow candidate gateway and host-bound conversation source', async () => {
  const calls: any[] = []
  const context = { scope, projectIntegration: { request: async (...args: any[]) => { calls.push(args); return candidate as any } } }
  const first = await prepareProjectGuidance({ ...brief, source_refs: [{ session_id: 99 }], sessionId: 99 }, context)
  await prepareProjectGuidance(brief, context)
  assert.equal(calls[0][0], 'prepare_project_guidance')
  assert.deepEqual(calls[0][1].source_refs, [{ type: 'conversation', id: 'chat-4', session_id: 17, sheet_id: 'sheet-2' }])
  assert.equal(calls[0][1].client_action_id, calls[1][1].client_action_id)
  assert.equal((first.payload as any).status, 'ready_for_confirmation')
  assert.equal((first.payload as any).mastery_inference, false)
  assert.equal((first.payload as any).project_id, undefined)
  assert.equal((first.payload as any).navigation, undefined)
})

test('a browser-only conversation does not invent a formal session source', async () => {
  let request: any
  await prepareProjectGuidance(brief, { scope: { conversationId: 'local-chat' }, projectIntegration: {
    request: async (_operation, payload) => { request = payload; return candidate as any },
  } })
  assert.deepEqual(request.source_refs, [])
})

test('practice does not silently select a fixed case and never calls Xingchen', async () => {
  let requests = 0
  const result = await prepareProjectGuidance({ ...brief, projectMode: 'practice' }, { scope, projectIntegration: {
    request: async () => { requests += 1; return candidate as any },
  } })
  assert.equal(requests, 0)
  assert.equal((result.payload as any).status, 'needs_case_selection')
  const ready = await prepareProjectGuidance({ ...brief, projectMode: 'practice', caseId: 'chosen-case', caseVersion: '1.0', caseRootHash: 'b'.repeat(64) }, {
    scope, projectIntegration: { request: async (operation, payload: any) => {
      assert.equal(operation, 'prepare_project_guidance')
      assert.equal(payload.case_id, 'chosen-case')
      return candidate as any
    } },
  })
  assert.equal((ready.payload as any).case_root_hash, 'b'.repeat(64))
})

test('confirmation is bound to a previously displayed candidate and cannot claim project creation', async () => {
  const prepared = await prepareProjectGuidance(brief, { scope, projectIntegration: { request: async () => candidate as any } })
  const objects = prepared.objects
  const prompt = projectGuidanceConfirmationPrompt(candidate.candidate_id, candidate.root_hash)
  assert.equal(projectGuidanceConfirmation(prompt, [])?.confirmed, undefined)
  assert.equal(projectGuidanceConfirmation(prompt.replace(candidate.root_hash, 'b'.repeat(64)), objects), undefined)
  assert.equal(projectGuidanceConfirmation(prompt, objects)?.confirmed, true)
  const confirmed = await confirmProjectGuidance({ candidateId: candidate.candidate_id, expectedRootHash: candidate.root_hash, confirmed: true }, {
    scope, projectIntegration: { request: async () => ({ requires_desktop_confirmation: true, candidate: prepared.payload }) },
  })
  assert.equal((confirmed.payload as any).status, 'ready_for_confirmation')
  assert.equal((confirmed.payload as any).project_id, undefined)
  await assert.rejects(confirmProjectGuidance({ candidateId: candidate.candidate_id, expectedRootHash: candidate.root_hash, confirmed: false }, { scope }), /confirmation_required/)
})

test('new project routing preserves explicit knowledge intake and routes experimental follow-up to Tutor', () => {
  const options = { activePluginIds: ['learning_task_conversion'], messages: [], mode: 'learning_plan' }
  assert.equal(projectGuidanceDirectRequest({ ...options, message: '生成学习型任务：部署服务' }), undefined)
  assert.equal(projectGuidanceDirectRequest({ ...options, message: '部署服务' })?.arguments.projectMode, undefined)
  assert.equal(projectGuidanceDirectRequest({ ...options, message: '我选择实验项目。原始工作任务：部署服务' })?.arguments.projectMode, 'experiment')
  assert.equal(projectGuidanceDirectRequest({ ...options, message: '我的实验项目交付是一个文件', messages: [{ toolRuns: [{ status: 'completed', plugin: { pluginId: 'learning_task_conversion', result: { objects: [{ objectType: 'project_guidance', value: { project_mode: 'experiment' } }] } } }] }] }), undefined)
  assert.equal(projectGuidanceDirectRequest({ ...options, mode: 'guided_learning', message: '实验项目' }), undefined)
})


test('candidate input bounds match the formal API and do not silently discard requirements', async () => {
  const context = { scope, projectIntegration: { request: async () => { throw new Error('must not send invalid candidate') } } }
  await assert.rejects(prepareProjectGuidance({ ...brief, constraints: Array.from({length:13}, (_, i) => `constraint ${i}`) }, context), /list_too_long/)
  await assert.rejects(prepareProjectGuidance({ ...brief, expectedOutcome: 'x'.repeat(1201) }, context), /text_too_long/)
})
