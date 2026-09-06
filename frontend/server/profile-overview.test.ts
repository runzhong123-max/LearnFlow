import assert from 'node:assert/strict'
import test from 'node:test'
import type { FormalLearnerSnapshot } from '../src/formal-runtime.ts'
import { buildProfileOverview, profileGrowthArea, profilePreferredModeLabel, profileTimeLabel } from '../src/profile-overview.ts'

function snapshot(): FormalLearnerSnapshot {
  return {
    profile: { background: '', focus_areas: [], weekly_hours: 0, preferred_modes: [], career_goal: '', career_goal_status: 'exploring' },
    learning_tasks: [], concept_graph: { nodes: [] },
  } as unknown as FormalLearnerSnapshot
}

test('empty or missing presentation data does not assert no practice or invent dates', () => {
  const sections = buildProfileOverview(snapshot())
  assert.deepEqual(sections.map(section => section.title), ['当前重点', '已有基础', '最近进展', '如何帮助我'])
  assert.ok(sections.every(section => section.items.length === 0))
  assert.match(sections[2].empty, /不代表你没有练习或进步/)
  assert.equal(profileTimeLabel(undefined), '未提供时间')
  assert.equal(profileTimeLabel('invalid'), '未提供时间')
})

test('current goals distinguish confirmed and exploratory sources and active tasks from priorities', () => {
  const value = snapshot()
  value.profile.career_goal = '研究检索系统'
  value.learning_tasks = [
    { id: 1, title: '旧任务', status: 'completed' },
    { id: 2, title: '目前的任务', status: 'active', updated_at: '2026-09-05T01:00:00Z' },
  ] as FormalLearnerSnapshot['learning_tasks']
  const focus = buildProfileOverview(value)[0]
  assert.equal(focus.items.length, 2)
  assert.equal(focus.items[0].source, '资料中的探索方向')
  assert.match(focus.items[1].source, /不代表长期优先级/)
  assert.equal(focus.items[1].time, '2026-09-05T01:00:00Z')
  value.profile.career_goal_status = 'confirmed'
  assert.equal(buildProfileOverview(value)[0].items[0].source, '你已确认的方向')
})

test('progress uses evidence timestamps, deduplicates facts and keeps self reports distinct', () => {
  const value = snapshot()
  value.concept_graph.nodes = [{
    name: '链式法则', knowledge: { timeline: [
      { fact_id: 1, statement: '看过公式', verification: 'self_reported', occurred_at: '2026-09-01T01:00:00Z' },
      { fact_id: 2, statement: '完成原题', verification: 'verified', occurred_at: '2026-09-05T01:00:00Z' },
    ] },
  }, {
    name: '重复引用', knowledge: { timeline: [
      { fact_id: 2, statement: '完成原题', verification: 'verified', occurred_at: '2026-09-05T01:00:00Z' },
    ] },
  }] as FormalLearnerSnapshot['concept_graph']['nodes']
  const sections = buildProfileOverview(value)
  assert.equal(sections[2].items.length, 2)
  assert.match(sections[2].items[0].source, /学习证据记录/)
  assert.match(sections[2].items[1].source, /自述更新/)
  assert.equal(sections[1].items[0].text, '链式法则：看过公式')
  assert.ok(sections[2].items.every(item => !/掌握|可迁移/.test(item.source)))
})

test('support settings remain editable settings rather than inferred stable learning traits', () => {
  const value = snapshot()
  value.profile.preferred_modes = ['先举例']
  value.profile.weekly_hours = 8
  const support = buildProfileOverview(value)[3]
  assert.equal(support.items[0].text, '先举例')
  assert.match(support.items[0].source, /可随时修改/)
  assert.match(support.items[1].source, /当前资料设置/)
  assert.ok(support.items.every(item => item.time === undefined))
})

test('actual backend growth-area IDs expose the matching memories for every kernel', () => {
  const cases = [
    ['structure', 'progress'], ['knowledge', 'understanding'], ['practice', 'ability'], ['human', 'rhythm'], ['value', 'direction'],
  ] as const
  const areas = cases.map(([, id]) => ({ id, title: id, active_count: 1, memories: [{
    memory_id: `memory-${id}`, title: id, summary: '真实记录', retention: 'long' as const,
    retention_label: '长期', source_kind: 'self_reported', source_label: '你告诉我的', related_record_count: 1, status: 'active' as const,
  }] }))
  for (const [kernel, id] of cases) {
    const area = profileGrowthArea(areas, kernel)
    assert.equal(area?.active_count, 1)
    assert.equal(area?.memories[0].memory_id, `memory-${id}`)
  }
  assert.equal(profileGrowthArea([], 'human'), undefined)
})

test('known support enums are readable while custom preferences remain unchanged', () => {
  assert.deepEqual(['practice', 'explanation', 'example', 'project', 'reflection', '先给反例'].map(profilePreferredModeLabel),
    ['动手练习', '概念讲解', '具体例子', '项目实践', '复盘反思', '先给反例'])
  const value = snapshot()
  value.profile.preferred_modes = ['practice', '先给反例']
  assert.equal(buildProfileOverview(value)[3].items[0].text, '动手练习、先给反例')
})

test('archived profile memories stay editable but are not presented as active personalization', () => {
  const value = snapshot()
  value.profile = { ...value.profile, preferred_modes: ['practice'], weekly_hours: 8, career_goal: '研发工程师', background: '学过数学' }
  const area = (id: string, memoryId: string) => ({ id, title: id, active_count: 0, memories: [{
    memory_id: memoryId, title: '资料', summary: '已保存', retention: 'long' as const,
    retention_label: '长期', source_kind: 'self_reported', source_label: '你告诉我的', related_record_count: 1, status: 'archived' as const,
  }] })
  value.growth = { overview: {}, stats: {}, evidence: [], areas: [
    area('rhythm', 'human:long_term:learning_preferences'),
    area('direction', 'value:long_term:career_goal'),
    area('understanding', 'knowledge:short_term:declared_background'),
  ] }
  let sections = buildProfileOverview(value)
  for (const item of [sections[0].items[0], sections[1].items[0], ...sections[3].items]) {
    assert.equal(item.source, '已停止用于个性化，可在记忆管理中恢复')
    assert.ok(item.text)
  }
  value.growth.areas[0] = area('rhythm', 'human:short_term:weekly_hours')
  sections = buildProfileOverview(value)
  assert.match(sections[3].items[0].source, /形式偏好/)
  assert.match(sections[3].items[1].source, /已停止/)
  value.growth.areas[0] = area('rhythm', 'human:short_term:preferred_modes')
  sections = buildProfileOverview(value)
  assert.match(sections[3].items[0].source, /已停止/)
  assert.match(sections[3].items[1].source, /用于安排学习量/)
  value.growth.areas[0].memories[0].status = 'active'
  assert.match(buildProfileOverview(value)[3].items[0].source, /形式偏好/)
})
