import type { FormalGrowthArea, FormalLearnerSnapshot, KernelName } from './formal-runtime.ts'

const GROWTH_AREA_IDS: Record<KernelName, string> = {
  structure: 'progress', knowledge: 'understanding', practice: 'ability', human: 'rhythm', value: 'direction',
}

export function profileGrowthArea(areas: FormalGrowthArea[], kernel: KernelName): FormalGrowthArea | undefined {
  return areas.find(area => area.id === GROWTH_AREA_IDS[kernel])
    || areas.find(area => area.id === kernel)
}

const PREFERRED_MODE_LABELS: Record<string, string> = {
  practice: '动手练习', explanation: '概念讲解', example: '具体例子', project: '项目实践', reflection: '复盘反思',
}

export function profilePreferredModeLabel(mode: string): string {
  return PREFERRED_MODE_LABELS[mode] || mode
}

export type ProfileOverviewItem = {
  id: string
  text: string
  source: string
  time?: string | null
}
export type ProfileOverviewSection = {
  id: string
  title: string
  kernel: KernelName
  empty: string
  items: ProfileOverviewItem[]
}

export function profileTimeLabel(value?: string | null): string {
  if (!value) return '未提供时间'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '未提供时间'
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function buildProfileOverview(snapshot: FormalLearnerSnapshot): ProfileOverviewSection[] {
  const sourceFor = (kernel: KernelName, memoryIds: string[], activeSource: string): string => {
    const archived = profileGrowthArea(snapshot.growth?.areas || [], kernel)?.memories
      .some(memory => memory.status === 'archived' && memoryIds.includes(memory.memory_id))
    return archived ? '已停止用于个性化，可在记忆管理中恢复' : activeSource
  }
  const focus: ProfileOverviewItem[] = []
  if (snapshot.profile.career_goal) focus.push({
    id: 'goal', text: snapshot.profile.career_goal,
    source: sourceFor('value', ['value:long_term:career_goal', 'value:short_term:career_goal_candidate'],
      snapshot.profile.career_goal_status === 'confirmed' ? '你已确认的方向' : '资料中的探索方向'),
  })
  if (snapshot.profile.focus_areas.length) focus.push({ id: 'interests', text: snapshot.profile.focus_areas.join('、'), source: '资料中的关注方向' })
  snapshot.learning_tasks.filter(task => task.status === 'active').slice(0, 3).forEach(task => focus.push({
    id: `task-${task.id}`, text: task.title, source: '正在进行的任务 · 不代表长期优先级', time: task.updated_at,
  }))

  const background: ProfileOverviewItem[] = snapshot.profile.background
    ? [{ id: 'background', text: snapshot.profile.background, source: sourceFor('knowledge', ['knowledge:short_term:declared_background'], '资料中的背景自述 · 用于选择讲解起点') }] : []
  const timelines = snapshot.concept_graph.nodes.flatMap(node => node.knowledge.timeline.map(entry => ({ node, entry })))
  const seen = new Set<number>()
  const recent = timelines.filter(({ entry }) => {
    if (seen.has(entry.fact_id)) return false
    seen.add(entry.fact_id)
    return true
  }).sort((a, b) => (Date.parse(b.entry.occurred_at) || 0) - (Date.parse(a.entry.occurred_at) || 0))
  recent.filter(({ entry }) => entry.verification === 'self_reported').slice(0, 2).forEach(({ node, entry }) => background.push({
    id: `background-${entry.fact_id}`, text: `${node.name}：${entry.statement}`, source: '来自你的自述', time: entry.occurred_at,
  }))
  const progress = recent.slice(0, 4).map(({ node, entry }) => ({
    id: `progress-${entry.fact_id}`, text: `${node.name}：${entry.statement}`,
    source: entry.verification === 'self_reported' ? '自述更新 · 不等同验证结果'
      : /^(verified|independent_verified|supported|confirmed)$/.test(entry.verification) ? '学习证据记录 · 具体表现见依据'
        : '学习观察 · 待进一步核对',
    time: entry.occurred_at,
  }))
  const support: ProfileOverviewItem[] = []
  if (snapshot.profile.preferred_modes.length) support.push({ id: 'modes', text: snapshot.profile.preferred_modes.map(profilePreferredModeLabel).join('、'), source: sourceFor('human', ['human:long_term:learning_preferences', 'human:short_term:preferred_modes'], '资料中的形式偏好 · 可随时修改') })
  if (Number.isFinite(snapshot.profile.weekly_hours) && snapshot.profile.weekly_hours > 0) support.push({ id: 'hours', text: `每周可投入 ${snapshot.profile.weekly_hours} 小时`, source: sourceFor('human', ['human:long_term:learning_preferences', 'human:short_term:weekly_hours'], '当前资料设置 · 用于安排学习量') })
  return [
    { id: 'focus', title: '当前重点', kernel: 'value', empty: '当前资料没有明确方向或进行中的任务。', items: focus },
    { id: 'background', title: '已有基础', kernel: 'knowledge', empty: '当前资料没有可展示的背景自述，可以补充你接触过的内容。', items: background },
    { id: 'progress', title: '最近进展', kernel: 'knowledge', empty: '本次资料没有可展示的概念学习记录；这不代表你没有练习或进步。', items: progress },
    { id: 'support', title: '如何帮助我', kernel: 'human', empty: '当前资料没有可展示的学习支持设置。', items: support },
  ]
}
