import test from 'node:test'
import assert from 'node:assert/strict'
import { prefillBrief } from './brief-prefill.ts'
import type { ConversionBrief } from './client.ts'

const brief = (): ConversionBrief => ({task_title:'云平台项目方案设计与实施交付', task_description:'按项目要求完成方案设计、脚本制作与方案实施。（对象：云平台相关项目方案与脚本；交付：项目方案与实施脚本；完成标准：方案实施完成并处理疑难问题）', work_context:'', deliverable:'', acceptance_criteria:[], constraints:[], learner_level:''})
const draft = () => ({brief:brief(), original_input:'云平台项目方案设计与实施交付'})

test('screenshot task details populate separate editable fields without mutating the saved draft', () => {
  const input = draft()
  const result = prefillBrief(input)
  assert.equal(result.brief.work_context, '云平台相关项目方案与脚本')
  assert.equal(result.brief.deliverable, '项目方案与实施脚本')
  assert.deepEqual(result.brief.acceptance_criteria, ['方案实施完成并处理疑难问题'])
  assert.match(result.brief.learner_level, /尚未说明/)
  assert.equal(input.brief.deliverable, '')
  assert.equal(result.suggested.length, 5)
})

test('existing user edits and source identities survive repeated preparation', () => {
  const input = draft()
  input.brief.work_context = '学校机房'
  input.brief.learner_level = '学过 Linux'
  input.brief.acceptance_criteria = ['三个节点连通']
  input.brief.source_refs = [{package_id:'fixed'}]
  const first = prefillBrief(input)
  const second = prefillBrief({...input, brief:first.brief})
  assert.deepEqual(second.brief, first.brief)
  assert.deepEqual(second.suggested, [])
  assert.equal(first.brief.work_context, '学校机房')
  assert.equal(first.brief.learner_level, '学过 Linux')
  assert.deepEqual(first.brief.acceptance_criteria, ['三个节点连通'])
  assert.deepEqual(first.brief.source_refs, input.brief.source_refs)
})

test('unstructured tasks get explicitly tentative defaults, not claims of learner ability', () => {
  const input = draft()
  input.brief.task_description = '部署云平台（已有基础：熟练掌握 Linux）'
  const {brief: result} = prefillBrief(input)
  assert.match(result.work_context, /^建议情境/)
  assert.match(result.deliverable, /^建议交付/)
  assert.match(result.acceptance_criteria[0], /^建议验收/)
  assert.match(result.constraints[0], /^建议限制/)
  assert.match(result.learner_level, /尚未说明/)
})

test('generated, handed off and running drafts are not silently changed', () => {
  for (const state of [{candidate:{title:'已有方案'}}, {selection:{action:'discuss'}}, {generation:{status:'running'}}]) {
    const input = {...draft(), ...state}
    assert.deepEqual(prefillBrief(input), {brief:input.brief, suggested:[]})
  }
})
