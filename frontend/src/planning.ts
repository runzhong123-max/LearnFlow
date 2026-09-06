import { evidenceClauses, isAffirmativeEvidence, isDirectLearnerContext, supportedClause } from './self-report-evidence.ts'

export type LearningPlanKind = 'project_seed' | 'direction'
export type LearningPlanStatus = 'active' | 'closed'
export type ValueProposalDecision = 'proposed' | 'accepted' | 'rejected' | 'revision_requested'

export type ProjectPlanningField =
  | 'target_artifact'
  | 'baseline'
  | 'resources'
  | 'time_commitment'
  | 'practice_validation'
  | 'constraints'

export type DirectionPlanningField =
  | 'current_position'
  | 'candidate_directions'
  | 'decision_horizon'
  | 'decision_criteria'
  | 'exploration_evidence'
  | 'constraints'

export type PlanningField = ProjectPlanningField | DirectionPlanningField

export type PlanningSignal = {
  field: PlanningField
  value: string
}

export type PlanningProfileSelfReport = {
  version: 'planning-profile-self-report.v1'
  evidenceQuote: string
  educationStage?: string
  weeklyHours?: { min: number; max: number }
  currentLoad?: 'manageable' | 'constrained'
  knowledgeExposures: Array<{ subject: string; statement: string }>
  knowledgeGaps: Array<{ subject: string; statement: string }>
  practiceExposures: Array<{ subject: string; statement: string }>
  goalCandidate?: string
}

export type ValueClaimProposal = {
  id: string
  currentClaim: string
  proposedClaim: string
  evidenceQuote: string
  rationale: string
  scope: 'long_term_direction_candidate'
  createdAt: number
}

// A planning dialogue collects requirements and proposals. A confirmed
// long-term route is a separate LearningPathPlan object.
export type PlanningDialogue = {
  id: string
  kind: LearningPlanKind
  objective: string
  createdAt: number
}

// Backward-compatible name for existing persisted vNext records.
export type LearningPlan = PlanningDialogue

export type PlanningEventType =
  | 'vnext_learning_plan_started'
  | 'vnext_learning_plan_note_captured'
  | 'vnext_project_seed_ready'
  | 'vnext_direction_plan_ready'
  | 'vnext_value_claim_proposed'
  | 'vnext_value_claim_proposal_accepted'
  | 'vnext_value_claim_proposal_rejected'
  | 'vnext_value_claim_proposal_revision_requested'
  | 'vnext_learning_plan_closed'

export type PlanningEvent = {
  id: string
  planId: string
  sequence: number
  type: PlanningEventType
  detail: string
  at: number
  signals?: PlanningSignal[]
  valueProposal?: ValueClaimProposal
  proposalId?: string
  formalWriteCompleted?: boolean
}

export type LearningPlanProjection = {
  plan: LearningPlan
  status: LearningPlanStatus
  signals: Partial<Record<PlanningField, string>>
  requirements: Array<{ id: PlanningField; label: string }>
  missingRequirements: Array<{ id: PlanningField; label: string }>
  noteCount: number
  eventCount: number
  valueProposal?: ValueClaimProposal & { decision: ValueProposalDecision; formalWriteCompleted: boolean }
}

export type LearningPlanTutorContext = {
  objectType: 'planning_dialogue'
  authority: 'browser_proposal_only'
  planId: string
  kind: LearningPlanKind
  kindLabel: string
  objective: string
  confirmedSignals: Array<{ label: string; value: string }>
  missingRequirements: string[]
  nextQuestion: string
  projectCreationAvailable: false
  valueProposal?: {
    currentClaim: string
    proposedClaim: string
    evidenceQuote: string
    decision: ValueProposalDecision
    formalWriteCompleted: boolean
  }
}

const PROJECT_REQUIREMENTS: LearningPlanProjection['requirements'] = [
  { id: 'target_artifact', label: '目标产物' },
  { id: 'baseline', label: '当前基础' },
  { id: 'resources', label: '来源与资源' },
  { id: 'time_commitment', label: '时间投入' },
  { id: 'practice_validation', label: '实践与验收' },
  { id: 'constraints', label: '现实约束' },
]

const DIRECTION_REQUIREMENTS: LearningPlanProjection['requirements'] = [
  { id: 'current_position', label: '当前位置' },
  { id: 'candidate_directions', label: '候选方向' },
  { id: 'decision_horizon', label: '决策时间' },
  { id: 'decision_criteria', label: '选择标准' },
  { id: 'exploration_evidence', label: '探索证据' },
  { id: 'constraints', label: '现实约束' },
]

const DIRECTION_PATTERN = /(?:未来|以后|职业|就业|工作方向|发展方向|科研方向|读研|升学|转行|从事什么|走什么方向|适合.*方向|成为.{0,24}(?:工程师|研究员|开发者|科学家))/i
const COMPLEX_PLAN_PATTERN = /(?:系统(?:地)?学|完整(?:地)?学|学习规划|学习路线|路线图|从零.*(?:到|学)|几个月|半年|一年|长期学习|做一个.*(?:项目|系统|应用|作品)|构建.*(?:项目|系统|应用)|复现.*论文|围绕.*仓库.*学)/i
const EXPLICIT_VALUE_PATTERN = /(?:我(?:想|希望|打算|倾向|计划)|目标是|(?:未来|以后).*(?:做|从事|研究|方向)|准备(?:走|做|研究))/i

const CURRENT_VALUE_CLAIM = '希望深入机器学习、智能体工程与强化学习；未来可能走智能体相关工作或广义机器学习科研。'

function id(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function compact(value: string, limit = 180) {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit)
}

function directionObjective(input: string) {
  if (!isDirectLearnerContext(input)) return '规划当前发展方向'
  input = evidenceClauses(input).filter(clause => !/(?:不想|不希望|不打算|不计划|不再|没想|并非|未打算)/.test(clause)).join('，')
  const explicit = input.match(/(?:我)?(?:未来)?(?:想|希望|打算|计划)(?:未来)?(?:成为|从事|做|走)?\s*([^，。！？!?\n]{2,60}(?:工程师|工程|研究员|开发者|科学家|方向))/i)
  if (explicit?.[1]) return `探索并规划${compact(explicit[1], 80)}`
  return '规划当前发展方向'
}

export function planningGoalSummary(projection: LearningPlanProjection) {
  const proposal = projection.valueProposal?.proposedClaim
    ?.replace(/^当前方向候选：/, '')
    .replace(/[。！？!?]+$/, '')
    .trim()
  if (projection.plan.kind === 'direction') {
    return compact(proposal || projection.plan.objective || '规划当前发展方向', 160)
  }
  return compact(projection.plan.objective || '形成可验证的项目学习计划', 160)
}

export function extractPlanningProfileSelfReport(
  input: string,
  goalHint = '',
): PlanningProfileSelfReport | undefined {
  if (!isDirectLearnerContext(input)) return undefined
  const evidenceQuote = compact(input, 2_000)
  // Do not emit candidates whose source falls outside the retained evidence.
  input = evidenceClauses(input).filter(clause => evidenceQuote.includes(clause)).join('。')
  const knowledgeExposures: PlanningProfileSelfReport['knowledgeExposures'] = []
  const knowledgeGaps: PlanningProfileSelfReport['knowledgeGaps'] = []
  const practiceExposures: PlanningProfileSelfReport['practiceExposures'] = []
  const add = (
    target: Array<{ subject: string; statement: string }>,
    subject: string,
    pattern: RegExp,
    affirmative = true,
  ) => {
    const statement = supportedClause(input, pattern, affirmative)
    if (!statement) return
    target.push({ subject, statement: compact(statement, 240) })
  }

  add(knowledgeExposures, 'Python', /(?:主要用|熟悉|会用|使用)\s*Python|Python\s*(?:基础|课程|作业|实验)/i)
  add(knowledgeExposures, '机器学习与深度学习', /(?:上过|学过|了解|熟悉|看过|接触过).{0,24}(?:机器学习|深度学习|CNN|RNN|Transformer)/i)
  add(knowledgeExposures, 'PyTorch', /(?:用过|使用过|写过).{0,12}PyTorch/i)
  add(knowledgeExposures, '大模型 API', /(?:调用过|用过|试过).{0,18}(?:OpenAI|大模型).{0,10}API/i)
  add(knowledgeExposures, 'RAG 与 Agent', /(?:RAG|Agent).{0,30}(?:听过|概念|了解)/i)

  add(knowledgeGaps, '生产级软件工程', /没写过生产级代码|(?:单元测试|日志|异常处理).{0,24}(?:不熟|不太熟|没接触)/i, false)
  add(knowledgeGaps, '后端与系统设计', /后端.{0,12}(?:为零|基本为零)|没接触过.{0,24}(?:数据库|系统架构)/i, false)
  add(knowledgeGaps, 'RAG 与 Agent 实践', /(?:RAG|Agent).{0,30}(?:没实际|没有实际|没动手|未实践)/i, false)

  add(practiceExposures, 'Flask 接口', /(?:写过|做过).{0,18}Flask.{0,12}(?:接口|课设)/i)
  add(practiceExposures, 'PyTorch 训练脚本', /(?:用过|使用过|写过|做过|跑通).{0,20}PyTorch.{0,24}(?:训练脚本|跑通实验|简单)|PyTorch.{0,24}(?:写过|跑通实验)/i)
  add(practiceExposures, '大模型 API 调用', /(?:调用过|用过|试过|做过).{0,18}(?:OpenAI|大模型).{0,12}API|(?:OpenAI|大模型).{0,12}API.{0,24}(?:调用过|做过)/i)

  // Generic candidates retain the learner's wording, without inventing a
  // subject taxonomy or declaring mastery from a self report.
  const knownStatements = new Set([...knowledgeExposures, ...practiceExposures].map(item => item.statement))
  for (const clause of evidenceClauses(input)) {
    if (!isAffirmativeEvidence(clause) || knownStatements.has(clause)) continue
    if (/(?:熟悉|学过|会用|用过|接触过|上过|学习过).{1,80}/i.test(clause)) {
      knowledgeExposures.push({ subject: '自述学习背景', statement: compact(clause, 240) })
    }
    if (/(?:写过|做过|开发过|实现过|复现过|工作了|从事).{1,80}/i.test(clause)) {
      practiceExposures.push({ subject: '自述实践经历', statement: compact(clause, 240) })
    }
  }

  const affirmativeInput = evidenceClauses(input).filter(isAffirmativeEvidence).join('，')
  const educationStage = affirmativeInput.match(/(?:大[一二三四]|研[一二三]|本科生|研究生|在校生)/)?.[0]
  const weekly = affirmativeInput.match(/每周.{0,8}?(\d{1,2})\s*(?:-|—|~|～|到|至)\s*(\d{1,2})\s*小时/i)
    || affirmativeInput.match(/每周.{0,8}?(\d{1,2})\s*小时/i)
  const weeklyHours = weekly
    ? { min: Number(weekly[1]), max: Number(weekly[2] || weekly[1]) }
    : undefined
  const loadInput = evidenceClauses(input).filter(clause => !/(?:不是|并非|不再|没有|没觉得|可能|也许|是否)/.test(clause)).join('，')
  const currentLoad = /课业压力(?:还好|不大|可控)|时间(?:比较|较)?充足/i.test(loadInput)
    ? 'manageable' as const
    : /课业压力(?:大|较大)|时间不多|很忙/i.test(loadInput) ? 'constrained' as const : undefined
  const explicitGoal = directionObjective(input)
  const hasProfileFacts = Boolean(
    educationStage || weeklyHours || currentLoad
    || knowledgeExposures.length || knowledgeGaps.length || practiceExposures.length,
  )
  const goalCandidate = explicitGoal !== '规划当前发展方向'
    ? explicitGoal.replace(/^探索并规划/, '')
    : hasProfileFacts ? compact(goalHint, 160) || undefined : undefined

  if (
    !educationStage && !weeklyHours && !currentLoad && !goalCandidate
    && !knowledgeExposures.length && !knowledgeGaps.length && !practiceExposures.length
  ) return undefined
  return {
    version: 'planning-profile-self-report.v1',
    evidenceQuote,
    ...(educationStage ? { educationStage } : {}),
    ...(weeklyHours ? { weeklyHours } : {}),
    ...(currentLoad ? { currentLoad } : {}),
    knowledgeExposures,
    knowledgeGaps,
    practiceExposures,
    ...(goalCandidate ? { goalCandidate } : {}),
  }
}

export function hasPlanningIntent(input: string) {
  const text = compact(input, 500)
  return DIRECTION_PATTERN.test(text) || COMPLEX_PLAN_PATTERN.test(text)
}

export function classifyLearningPlan(input: string): LearningPlanKind {
  return DIRECTION_PATTERN.test(input) ? 'direction' : 'project_seed'
}

export function planningKindLabel(kind: LearningPlanKind) {
  return kind === 'direction' ? '发展方向规划' : '项目雏形规划'
}

function requirementsFor(kind: LearningPlanKind) {
  return kind === 'direction' ? DIRECTION_REQUIREMENTS : PROJECT_REQUIREMENTS
}

function extractSignals(kind: LearningPlanKind, input: string): PlanningSignal[] {
  const text = compact(input)
  const values: PlanningSignal[] = []
  const add = (field: PlanningField, pattern: RegExp) => {
    if (pattern.test(text)) values.push({ field, value: text })
  }
  if (kind === 'project_seed') {
    add('target_artifact', /(?:做|构建|实现|开发|完成|复现|产出|作品|项目|系统|应用)/i)
    add('baseline', /(?:学过|会用|熟悉|基础|目前|现在|专业|大[一二三四]|零基础)/i)
    add('resources', /(?:仓库|repo|github|教材|书|课程|文档|论文|视频|资料)/i)
    add('time_commitment', /(?:每天|每周|周末|小时|天|周|月|半年|一年|学期)/i)
    add('practice_validation', /(?:测试|验证|部署|演示|答辩|作品集|开源|复现|指标|验收|实践)/i)
  } else {
    add('current_position', /(?:目前|现在|专业|大[一二三四]|学过|会用|基础|工作)/i)
    add('candidate_directions', /(?:机器学习|深度学习|强化学习|智能体|agent|算法|工程|科研|读研|就业|方向)/i)
    add('decision_horizon', /(?:今年|明年|毕业|大[一二三四]|学期|月|半年|一年|几年)/i)
    add('decision_criteria', /(?:喜欢|兴趣|擅长|就业|收入|稳定|科研|论文|工程|成长|价值)/i)
    add('exploration_evidence', /(?:项目|实习|科研|比赛|论文|复现|开源|尝试|体验)/i)
  }
  add('constraints', /(?:限制|只能|不能|预算|设备|显卡|时间不多|课程|考试|压力|地点)/i)
  return [...new Map(values.map(signal => [signal.field, signal])).values()]
}

function valueClaimProposal(input: string, now: number): ValueClaimProposal | undefined {
  const quote = compact(input, 140)
  const objective = directionObjective(input)
  if (!EXPLICIT_VALUE_PATTERN.test(quote) || objective === '规划当前发展方向') return undefined
  const claimText = objective.replace(/^探索并规划/, '').trim()
  return {
    id: id('value-proposal'),
    currentClaim: CURRENT_VALUE_CLAIM,
    proposedClaim: `当前方向候选：${claimText || quote.replace(/[。！？!?]+$/, '')}。`,
    evidenceQuote: quote,
    rationale: '只根据你在本轮明确表达的方向生成候选，不从一次选择推断固定职业、人格或能力。',
    scope: 'long_term_direction_candidate',
    createdAt: now,
  }
}

export function appendPlanningEvents(
  events: PlanningEvent[],
  planId: string,
  additions: Array<Omit<PlanningEvent, 'id' | 'planId' | 'sequence' | 'at'>>,
  now = Date.now(),
) {
  let sequence = events.filter(event => event.planId === planId).reduce((max, event) => Math.max(max, event.sequence), 0)
  return [...events, ...additions.map((event, index) => ({
    ...event,
    id: id('plan-event'),
    planId,
    sequence: ++sequence,
    at: now + index,
  }))]
}

export function createLearningPlan(input: string, now = Date.now(), existingEvents: PlanningEvent[] = []) {
  const kind = classifyLearningPlan(input)
  const objective = kind === 'direction'
    ? directionObjective(input)
    : compact(input.replace(/^(?:请|帮我|我想|我希望|给我)?\s*(?:规划|制定)?\s*/i, ''), 160) || '新的学习规划'
  const plan: LearningPlan = { id: id('plan'), kind, objective, createdAt: now }
  const signals = extractSignals(kind, input)
  const proposal = kind === 'direction' ? valueClaimProposal(input, now) : undefined
  const additions: Array<Omit<PlanningEvent, 'id' | 'planId' | 'sequence' | 'at'>> = [
    { type: 'vnext_learning_plan_started', detail: `开始${planningKindLabel(kind)}：${objective}` },
    { type: 'vnext_learning_plan_note_captured', detail: `记录本轮明确规划信息：${signals.length} 项`, signals },
  ]
  if (proposal) additions.push({ type: 'vnext_value_claim_proposed', detail: '提出 Value Claim 修改候选；等待学生决定', valueProposal: proposal })
  return { plan, events: appendPlanningEvents(existingEvents, plan.id, additions, now) }
}

export function projectLearningPlan(plan: LearningPlan, events: PlanningEvent[]): LearningPlanProjection {
  const relevant = events.filter(event => event.planId === plan.id).sort((a, b) => a.sequence - b.sequence)
  const signals: Partial<Record<PlanningField, string>> = {}
  let status: LearningPlanStatus = 'active'
  let proposal: LearningPlanProjection['valueProposal']
  relevant.forEach(event => {
    event.signals?.forEach(signal => { signals[signal.field] = signal.value })
    if (event.type === 'vnext_value_claim_proposed' && event.valueProposal) {
      proposal = { ...event.valueProposal, decision: 'proposed', formalWriteCompleted: false }
    }
    if (proposal && event.proposalId === proposal.id) {
      if (event.type === 'vnext_value_claim_proposal_accepted') {
        proposal.decision = 'accepted'
        proposal.formalWriteCompleted = Boolean(event.formalWriteCompleted)
      }
      if (event.type === 'vnext_value_claim_proposal_rejected') proposal.decision = 'rejected'
      if (event.type === 'vnext_value_claim_proposal_revision_requested') proposal.decision = 'revision_requested'
    }
    if (event.type === 'vnext_learning_plan_closed') status = 'closed'
  })
  const requirements = requirementsFor(plan.kind)
  return {
    plan,
    status,
    signals,
    requirements,
    missingRequirements: requirements.filter(requirement => !signals[requirement.id]),
    noteCount: relevant.filter(event => event.type === 'vnext_learning_plan_note_captured').length,
    eventCount: relevant.length,
    valueProposal: proposal,
  }
}

export function activeLearningPlanProjection(plans: LearningPlan[], events: PlanningEvent[]) {
  return [...plans].reverse().map(plan => projectLearningPlan(plan, events)).find(projection => projection.status === 'active')
}

export function updateLearningPlan(events: PlanningEvent[], projection: LearningPlanProjection, input: string, now = Date.now()) {
  const signals = extractSignals(projection.plan.kind, input)
  const proposal = projection.plan.kind === 'direction' ? valueClaimProposal(input, now) : undefined
  const additions: Array<Omit<PlanningEvent, 'id' | 'planId' | 'sequence' | 'at'>> = [
    { type: 'vnext_learning_plan_note_captured', detail: `记录本轮明确规划信息：${signals.length} 项`, signals },
  ]
  if (proposal) additions.push({ type: 'vnext_value_claim_proposed', detail: '更新 Value Claim 修改候选；等待学生决定', valueProposal: proposal })
  const nextEvents = appendPlanningEvents(events, projection.plan.id, additions, now)
  const next = projectLearningPlan(projection.plan, nextEvents)
  const readinessThreshold = projection.plan.kind === 'project_seed' ? 4 : 4
  const confirmedCount = next.requirements.length - next.missingRequirements.length
  const readyEventType = projection.plan.kind === 'project_seed' ? 'vnext_project_seed_ready' : 'vnext_direction_plan_ready'
  if (confirmedCount >= readinessThreshold && !nextEvents.some(event => event.planId === projection.plan.id && event.type === readyEventType)) {
    return appendPlanningEvents(nextEvents, projection.plan.id, [{
      type: readyEventType,
      detail: projection.plan.kind === 'project_seed' ? '项目启动信息已形成可检查雏形；项目创建尚未接入' : '发展方向信息已形成可比较雏形',
    }], now + 2)
  }
  return nextEvents
}

export function decideValueClaimProposal(
  events: PlanningEvent[], projection: LearningPlanProjection,
  decision: Exclude<ValueProposalDecision, 'proposed'>, now = Date.now(), formalWriteCompleted = false,
) {
  const proposal = projection.valueProposal
  if (!proposal || proposal.decision !== 'proposed') return events
  const type = decision === 'accepted'
    ? 'vnext_value_claim_proposal_accepted'
    : decision === 'rejected'
      ? 'vnext_value_claim_proposal_rejected'
      : 'vnext_value_claim_proposal_revision_requested'
  const detail = decision === 'accepted'
    ? formalWriteCompleted
      ? '学生确认 Value Claim 候选；已通过正式事件入口写入价值核'
      : '学生确认 Value Claim 候选；正式后端不可用，本地保留待同步状态'
    : decision === 'rejected'
      ? '学生拒绝 Value Claim 候选；不写入'
      : '学生要求修改 Value Claim 候选；不写入'
  return appendPlanningEvents(events, projection.plan.id, [{ type, detail, proposalId: proposal.id, formalWriteCompleted }], now)
}

export function closeLearningPlan(events: PlanningEvent[], projection: LearningPlanProjection, now = Date.now()) {
  return appendPlanningEvents(events, projection.plan.id, [{ type: 'vnext_learning_plan_closed', detail: '结束本段规划；未自动创建项目或改写五核' }], now)
}

export function learningPlanTutorContext(projection: LearningPlanProjection): LearningPlanTutorContext {
  const labels = new Map(projection.requirements.map(requirement => [requirement.id, requirement.label]))
  return {
    objectType: 'planning_dialogue',
    authority: 'browser_proposal_only',
    planId: projection.plan.id,
    kind: projection.plan.kind,
    kindLabel: planningKindLabel(projection.plan.kind),
    objective: projection.plan.objective,
    confirmedSignals: Object.entries(projection.signals).map(([field, value]) => ({
      label: labels.get(field as PlanningField) || field,
      value,
    })),
    missingRequirements: projection.missingRequirements.map(requirement => requirement.label),
    nextQuestion: projection.missingRequirements[0]?.label || '请学生检查当前草案并指出要修订之处',
    projectCreationAvailable: false,
    valueProposal: projection.valueProposal ? {
      currentClaim: projection.valueProposal.currentClaim,
      proposedClaim: projection.valueProposal.proposedClaim,
      evidenceQuote: projection.valueProposal.evidenceQuote,
      decision: projection.valueProposal.decision,
      formalWriteCompleted: projection.valueProposal.formalWriteCompleted,
    } : undefined,
  }
}

export function sanitizeLearningPlanTutorContext(value: unknown): LearningPlanTutorContext | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  if (
    typeof item.planId !== 'string'
    || (item.kind !== 'project_seed' && item.kind !== 'direction')
    || typeof item.kindLabel !== 'string'
    || typeof item.objective !== 'string'
    || !Array.isArray(item.confirmedSignals)
    || !Array.isArray(item.missingRequirements)
  ) return undefined
  const confirmedSignals = item.confirmedSignals.filter(signal => {
    if (!signal || typeof signal !== 'object') return false
    const candidate = signal as Record<string, unknown>
    return typeof candidate.label === 'string' && typeof candidate.value === 'string'
  }).slice(0, 8).map(signal => {
    const candidate = signal as Record<string, unknown>
    return { label: String(candidate.label).slice(0, 40), value: String(candidate.value).slice(0, 220) }
  })
  const rawProposal = item.valueProposal && typeof item.valueProposal === 'object'
    ? item.valueProposal as Record<string, unknown>
    : undefined
  const valueProposal = rawProposal
    && typeof rawProposal.currentClaim === 'string'
    && typeof rawProposal.proposedClaim === 'string'
    && typeof rawProposal.evidenceQuote === 'string'
    && ['proposed', 'accepted', 'rejected', 'revision_requested'].includes(String(rawProposal.decision))
    ? {
        currentClaim: rawProposal.currentClaim.slice(0, 300),
        proposedClaim: rawProposal.proposedClaim.slice(0, 300),
        evidenceQuote: rawProposal.evidenceQuote.slice(0, 180),
        decision: rawProposal.decision as ValueProposalDecision,
        formalWriteCompleted: rawProposal.formalWriteCompleted === true,
      }
    : undefined
  return {
    objectType: 'planning_dialogue',
    authority: 'browser_proposal_only',
    planId: item.planId.slice(0, 100),
    kind: item.kind,
    kindLabel: item.kindLabel.slice(0, 60),
    objective: item.objective.slice(0, 300),
    confirmedSignals,
    missingRequirements: item.missingRequirements.filter(entry => typeof entry === 'string').slice(0, 8).map(entry => String(entry).slice(0, 50)),
    nextQuestion: typeof item.nextQuestion === 'string' ? item.nextQuestion.slice(0, 100) : '',
    projectCreationAvailable: false,
    valueProposal,
  }
}
