import type { FormalClaim, FormalMemoryModule, KernelName } from './formal-runtime'

const KERNEL_LABELS: Record<KernelName, string> = {
  structure: '学习位置与路线',
  knowledge: '知识理解',
  human: '学习支持方式',
  value: '目标与优先级',
  practice: '实践表现',
}

const VERIFICATION_LABELS: Record<string, string> = {
  supported: '有证据支持',
  confirmed: '你已确认',
  learner_confirmed: '你已确认',
  challenged: '等待核对',
  corrected: '已经纠正',
  unverified: '尚待验证',
  self_reported: '来自你的自述',
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function lastMemoryField(text: string, field: string) {
  const escaped = escapeRegExp(field)
  const values: string[] = []
  for (const pattern of [
    new RegExp(`"${escaped}"\\s*:\\s*"([^"\\n]+)"`, 'g'),
    new RegExp(`(?:^|[;；]\\s*)${escaped}\\s*:\\s*([^;；\\n]+)`, 'g'),
  ]) {
    for (const match of text.matchAll(pattern)) {
      const value = String(match[1] || '').trim().replace(/^["']|["'}\]]+$/g, '')
      if (value) values.push(value)
    }
  }
  return values[values.length - 1] || ''
}

function moduleSource(module: FormalMemoryModule) {
  return [module.summary, ...module.claims.map(claim => claim.text)].filter(Boolean).join('；')
}

export function presentModuleTitle(module: FormalMemoryModule) {
  const source = moduleSource(module)
  if (module.subject_key === 'global') return `整体${KERNEL_LABELS[module.kernel]}`
  if ((module.subject_key === 'learning' || module.subject_key.endsWith(':learning')) && module.kernel === 'human') return '学习节奏与支持'
  if (module.subject_key.startsWith('project:')) {
    const projectName = lastMemoryField(source, 'project_name')
    return projectName ? `项目：${projectName}` : `项目 ${module.subject_key.split(':')[1]} 的学习进度`
  }
  if (module.subject_key.startsWith('checkpoint:')) {
    const checkpointTitle = lastMemoryField(source, 'checkpoint_title')
    return checkpointTitle ? `学习关卡：${checkpointTitle}` : '当前学习关卡'
  }
  const subjectParts = module.subject_key.split(':')
  const readable = subjectParts[subjectParts.length - 1]?.replace(/[-_]+/g, ' ').trim()
  return readable || KERNEL_LABELS[module.kernel]
}

export function presentModuleScope(module: FormalMemoryModule) {
  if (module.subject_key === 'global') return '全局主题'
  if (module.subject_key.startsWith('project:')) return '项目主题'
  if (module.subject_key.startsWith('checkpoint:')) return '关卡主题'
  return KERNEL_LABELS[module.kernel]
}

export function presentClaimText(module: FormalMemoryModule, claim: FormalClaim) {
  const source = `${module.summary}；${claim.text}`
  const currentTask = lastMemoryField(source, 'current_task')
  const currentGoal = lastMemoryField(source, 'current_goal') || lastMemoryField(source, 'career_goal')
  const projectName = lastMemoryField(source, 'project_name')
  const preference = lastMemoryField(source, 'preference') || lastMemoryField(source, 'preferred_mode')
  const support = lastMemoryField(source, 'support_needed') || lastMemoryField(source, 'adaptation')
  const concept = lastMemoryField(source, 'concept') || lastMemoryField(source, 'concept_key')
  const gap = lastMemoryField(source, 'knowledge_gap') || lastMemoryField(source, 'misconception')
  const artifact = lastMemoryField(source, 'artifact') || lastMemoryField(source, 'current_artifact')
  const weeklyHours = lastMemoryField(source, 'weekly_hours')
  const currentPriority = lastMemoryField(source, 'current_priority')
  const focusAreas = lastMemoryField(source, 'focus_areas')

  if (module.subject_key.startsWith('project:') && currentTask) {
    return projectName
      ? `你目前在“${projectName}”项目中学习“${currentTask}”，下次可以从这里继续。`
      : `你目前正在学习“${currentTask}”，下次可以从这里继续。`
  }
  if (currentGoal) return `你当前确认的学习目标是：${currentGoal}。`
  if (module.kernel === 'human' && weeklyHours) {
    return `你目前计划每周投入约 ${weeklyHours} 小时学习，Tutor 可以据此控制任务长度和节奏。`
  }
  if (module.kernel === 'human' && (preference || support)) {
    return `更适合你的学习支持方式是：${preference || support}。`
  }
  if (module.kernel === 'value' && currentPriority) return `你当前优先想学习：${currentPriority}。`
  if (module.kernel === 'value' && focusAreas) return `你当前关注的学习方向包括：${focusAreas}。`
  if (module.kernel === 'knowledge' && (gap || concept)) {
    return gap ? `目前需要继续澄清：${gap}。` : `当前知识认识与“${concept}”有关。`
  }
  if (module.kernel === 'practice' && artifact) return `当前可检查的实践产物是：${artifact}。`

  const withoutPrefix = claim.text
    .replace(/^.+?的(?:structure|knowledge|human|value|practice)动作已形成稳定片段[：:]\s*/i, '')
    .trim()
  return withoutPrefix.length > 240 ? `${withoutPrefix.slice(0, 237)}…` : withoutPrefix
}

export function presentVerification(claim: FormalClaim) {
  return VERIFICATION_LABELS[claim.verification_status]
    || VERIFICATION_LABELS[claim.status]
    || '可由你核对'
}

export function presentEvidenceCount(module: FormalMemoryModule) {
  const count = module.evidence_fact_ids.length
  return count ? `由 ${count} 条事实依据凝练而成` : '由相关学习记录凝练而成'
}
