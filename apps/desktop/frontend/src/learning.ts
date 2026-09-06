import skillManifest from './generated/learning-skill-manifest.json' with { type: 'json' }

export type LearningSkillId = keyof typeof skillManifest.skills

// Kept only to project browser events written by v0.5. New tasks do not use a universal phase model.
export type LegacyLearningPhase = 'learn' | 'practice' | 'verify' | 'consolidate'
export type LearningTaskStatus = 'active' | 'paused' | 'completed'
export type LearningSubstateId =
  | 'guidance'
  | 'demonstration'
  | 'inquiry'
  | 'teachback'
  | 'diagnosis'
  | 'revision'
  | 'practice'
  | 'transfer'
  | 'independent'
  | 'synthesis'
  | 'reflection'

export type FeynmanCalibration = Partial<{
  audience_level: string
  cognitive_demand: string
  scaffold_level: string
  representation_mode: string
}>

export type TeachBackDiagnostic = Partial<{
  learner_wording: string
  candidate_gap: string
  candidate_gap_label: string
  status: string
  verification: string
  mastery_inference: boolean
}>

// Browser-side binding to a formal LearningTask, or an explicitly labelled
// offline fallback. This object is not a second learning-task authority.
export type LearningTaskBinding = {
  id: string
  objective: string
  createdAt: number
  formalTaskId?: number
  formalTaskVersion?: number
  formalSkillRunId?: number
  formalSkillRunVersion?: number
  formalSkillStatus?: string
  formalSkillState?: string
  formalSkillStageLabel?: string
  formalSkillDirective?: string
  formalSkillTurnCount?: number
  formalSkillTurnBudget?: number
  formalSkillGapLoopCount?: number
  formalSkillCalibration?: FeynmanCalibration
  formalTeachBackDiagnostic?: TeachBackDiagnostic
}

// Backward-compatible name for existing persisted vNext records.
export type LearningTask = LearningTaskBinding

export type LearningSkillStep = {
  id: string
  title: string
  shortTitle: string
  substateId: LearningSubstateId
  substateLabel: string
  tutorInstruction: string
  nextAction: string
  canLoop?: boolean
  requiresLearnerReply?: boolean
  loopInstruction?: string
}

export type LearningSkillDefinition = {
  name: string
  description: string
  bestFor: string
  boundState: 'guided_learning'
  steps: readonly LearningSkillStep[]
  calibrationAxes: readonly {
    id: string
    title: string
    description: string
    default: string
    options: readonly { id: string; label: string }[]
  }[]
}

export type LearningEventType =
  | 'vnext_learning_task_created'
  | 'vnext_learning_task_started'
  | 'vnext_learning_task_phase_entered'
  | 'vnext_learning_skill_step_entered'
  | 'vnext_learning_skill_looped'
  | 'vnext_learning_task_learner_replied'
  | 'vnext_learning_support_requested'
  | 'vnext_learning_skill_selected'
  | 'vnext_learning_task_paused'
  | 'vnext_learning_task_resumed'
  | 'vnext_learning_task_completed'

export type LearningEvent = {
  id: string
  sequence: number
  taskId: string
  type: LearningEventType
  at: number
  detail: string
  phase?: LegacyLearningPhase
  skillId?: LearningSkillId
  stepId?: string
}

export type LearningTaskProjection = {
  task: LearningTask
  status: LearningTaskStatus
  skillId: LearningSkillId
  stepId: string
  stepIndex: number
  eventCount: number
  learnerReplyCount: number
  learnerRepliesInStep: number
  supportCount: number
  loopCount: number
  totalLoopCount: number
}

export type LearningTaskTutorContext = {
  objectType: 'learning_task_binding'
  authority: 'formal_learning_task' | 'local_offline_fallback'
  formalTaskId?: number
  formalSkillRunId?: number
  formalSkillRunVersion?: number
  formalSkillStatus?: string
  formalSkillState?: string
  formalSkillStageLabel?: string
  formalSkillCalibration?: FeynmanCalibration
  formalTeachBackDiagnostic?: TeachBackDiagnostic
  taskId: string
  objective: string
  skillId: LearningSkillId
  skillName: string
  substateId: LearningSubstateId
  substateLabel: string
  stepId: string
  stepTitle: string
  stepIndex: number
  stepCount: number
  stepInstruction: string
  nextAction: string
  loopCount: number
  loopInstruction: string
}

export type FormalSkillRunBindingInput = {
  id: number
  version: number
  status: string
  state: string
  stage_label?: string
  next_prompt?: string
  step_index?: number
  turn_count?: number
  turn_budget?: number
  gap_loop_count?: number
  calibration?: Record<string, string>
  teach_back_diagnostic?: Record<string, unknown>
  learning_task?: {
    id: number
    version?: number
  } | null
}

export type FormalLearningTaskBindingInput = {
  id: number
  objective: string
  version: number
  preferred_skills?: string[]
}

type ManifestSkillState = {
  id: string
  title: string
  short_title: string
  substate_id: string
  substate_label: string
  tutor_instruction: string
  next_action: string
  can_loop: boolean
  requires_learner_reply: boolean
  loop_instruction: string
}

function skillFromManifest(
  skill: (typeof skillManifest.skills)[LearningSkillId],
): LearningSkillDefinition {
  const runtime = skill.runtime
  if (!runtime) throw new Error(`Skill ${skill.id} 缺少 SkillSpec v2 runtime`)
  return {
    name: skill.name,
    description: skill.description,
    bestFor: skill.best_for.join('、'),
    boundState: 'guided_learning',
    calibrationAxes: ((runtime as unknown as {
      calibration_axes?: Array<{
        id: string
        title: string
        description: string
        default: string
        options: Array<[string, string]>
      }>
    }).calibration_axes || []).map(axis => ({
      ...axis,
      options: axis.options.map(([id, label]) => ({ id, label })),
    })),
    steps: (runtime.states as readonly ManifestSkillState[]).map(state => ({
      id: state.id,
      title: state.title,
      shortTitle: state.short_title,
      substateId: state.substate_id as LearningSubstateId,
      substateLabel: state.substate_label,
      tutorInstruction: state.tutor_instruction,
      nextAction: state.next_action,
      canLoop: state.can_loop,
      requiresLearnerReply: state.requires_learner_reply,
      loopInstruction: state.loop_instruction,
    })),
  }
}

export const LEARNING_SKILLS = Object.fromEntries(
  (Object.keys(skillManifest.skills) as LearningSkillId[]).map(skillId => [
    skillId,
    skillFromManifest(skillManifest.skills[skillId]),
  ]),
) as Record<LearningSkillId, LearningSkillDefinition>

const LEGACY_SKILL_STEP_ALIASES: Record<LearningSkillId, Record<string, string>> = {
  guided_explanation: {
    anchor_model: 'presenting_core_model',
    inspect_example: 'checking_minimal_example',
    learner_explain: 'repairing_explanation',
    transfer_check: 'verification_ready',
  },
  socratic_dialogue: {
    ground_context: 'eliciting_prior_model',
    hypothesis: 'eliciting_prior_model',
    probe_reason: 'testing_assumption',
    test_boundary: 'testing_assumption',
    synthesize_reasoning: 'building_explanation',
  },
  feynman_dialogue: {
    knowledge_anchor: 'awaiting_teach_back',
    first_teachback: 'awaiting_teach_back',
    diagnose_gap: 'locating_gap',
    revised_teachback: 'revising_explanation',
    example_or_boundary: 'verification_ready',
  },
  worked_example_fading: {
    worked_example: 'studying_worked_example',
    complete_last_step: 'completing_last_step',
    complete_middle_step: 'solving_faded_example',
    independent_problem: 'solving_faded_example',
    reflect_strategy: 'verification_ready',
  },
  learning_file_study: {},
}

function canonicalSkillStepId(skillId: LearningSkillId, stepId: string) {
  return LEGACY_SKILL_STEP_ALIASES[skillId][stepId] || stepId
}

const LEARNING_INTENT = /(?:带我(?:学|学习|弄懂|理解|练习|做|写|实现|完成)|教我(?:学会|理解|弄懂)|陪我(?:学|练)|让我练习|(?:开始|创建|建立|加入)(?:一个)?学习任务|练习并(?:检查|验证)|从头学会)/
const SUPPORT_REQUEST = /(?:不会|不知道|没懂|不明白|想不出来|给个提示|提示一下|举个例子|直接讲|跳过)/
const PROCEDURAL_GOAL = /(?:代码|编程|算法|配置|命令|调试|实现|写一个|手写|步骤|操作|SQL|指针)/i
const REASONING_GOAL = /(?:为什么|证明|推导|不变量|因果|判断)/

function eventId() {
  return `learning-event-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
}

function taskId() {
  return `learning-task-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
}

export function hasExplicitLearningIntent(input: string) {
  return LEARNING_INTENT.test(input.replace(/\s+/g, ''))
}

export function isSupportRequest(input: string) {
  return SUPPORT_REQUEST.test(input.replace(/\s+/g, ''))
}

export function learningObjectiveFromInput(input: string) {
  const cleaned = input
    .replace(/^(?:请|可以|能不能|你能)?\s*带我(?=(?:写|实现|完成))/i, '')
    .replace(/^(?:请|可以|能不能|你能)?\s*(?:带我(?:学习|练习|弄懂|理解|学|做)|教我(?:学会|理解|弄懂)|陪我(?:学|练)|让我练习)\s*/i, '')
    .replace(/^(?:一下|关于)\s*/i, '')
    .replace(/[。！？!?]+$/g, '')
    .trim()
  return (cleaned || input.trim() || '完成当前学习目标').slice(0, 180)
}

export function recommendedLearningSkill(objective: string): LearningSkillId {
  if (PROCEDURAL_GOAL.test(objective)) return 'worked_example_fading'
  if (REASONING_GOAL.test(objective)) return 'socratic_dialogue'
  return 'guided_explanation'
}

export function createLearningTask(objective: string, now = Date.now(), existingEvents: LearningEvent[] = [], preferredSkillId?: LearningSkillId) {
  const task: LearningTask = { id: taskId(), objective: learningObjectiveFromInput(objective), createdAt: now }
  const skillId = preferredSkillId || recommendedLearningSkill(task.objective)
  const firstStep = LEARNING_SKILLS[skillId].steps[0]
  const events = appendLearningEvents(existingEvents, task.id, [
    { type: 'vnext_learning_task_created', detail: `建立任务：${task.objective}`, skillId },
    { type: 'vnext_learning_task_started', detail: '开始在当前对话中学习' },
    { type: 'vnext_learning_skill_selected', detail: `使用${LEARNING_SKILLS[skillId].name}`, skillId },
    { type: 'vnext_learning_skill_step_entered', detail: `进入${firstStep.substateLabel}：${firstStep.title}`, skillId, stepId: firstStep.id },
  ], now)
  return { task, events }
}

/**
 * Project one formal queue task into the browser conversation that executes it.
 * The browser object is only a binding: the backend LearningTask remains the
 * authority and its numeric id is carried into every formal SkillRun request.
 */
export function activateFormalLearningTask(
  formalTask: FormalLearningTaskBindingInput,
  existingTasks: LearningTask[],
  existingEvents: LearningEvent[],
  now = Date.now(),
) {
  const id = `formal-learning-task-${formalTask.id}`
  const preferredSkillId = (formalTask.preferred_skills || []).find(isLearningSkillId)
    || recommendedLearningSkill(formalTask.objective)
  let events = existingEvents

  for (const task of existingTasks) {
    if (task.id === id) continue
    const projection = projectLearningTask(task, events)
    if (projection.status === 'active') {
      events = appendLearningEvents(events, task.id, [{
        type: 'vnext_learning_task_paused',
        detail: `切换到正式 LearningTask #${formalTask.id}`,
      }], now)
    }
  }

  const existing = existingTasks.find(task => task.id === id || task.formalTaskId === formalTask.id)
  if (existing) {
    const binding: LearningTask = {
      ...existing,
      id,
      objective: formalTask.objective,
      formalTaskId: formalTask.id,
      formalTaskVersion: formalTask.version,
    }
    const projection = projectLearningTask(binding, events)
    if (projection.status === 'paused') {
      events = appendLearningEvents(events, binding.id, [{
        type: 'vnext_learning_task_resumed',
        detail: `恢复正式 LearningTask #${formalTask.id}`,
      }], now + 1)
    }
    return {
      task: binding,
      tasks: existingTasks.map(task => task === existing ? binding : task),
      events,
    }
  }

  const binding: LearningTask = {
    id,
    objective: formalTask.objective.slice(0, 300),
    createdAt: now,
    formalTaskId: formalTask.id,
    formalTaskVersion: formalTask.version,
  }
  const firstStep = LEARNING_SKILLS[preferredSkillId].steps[0]
  events = appendLearningEvents(events, binding.id, [
    { type: 'vnext_learning_task_created', detail: `绑定正式 LearningTask #${formalTask.id}`, skillId: preferredSkillId },
    { type: 'vnext_learning_task_started', detail: '从任务队列进入原对话继续学习' },
    { type: 'vnext_learning_skill_selected', detail: `使用${LEARNING_SKILLS[preferredSkillId].name}`, skillId: preferredSkillId },
    { type: 'vnext_learning_skill_step_entered', detail: `进入${firstStep.substateLabel}：${firstStep.title}`, skillId: preferredSkillId, stepId: firstStep.id },
  ], now)
  return { task: binding, tasks: [...existingTasks, binding], events }
}

export function appendLearningEvents(
  existing: LearningEvent[],
  targetTaskId: string,
  additions: Array<Omit<LearningEvent, 'id' | 'sequence' | 'taskId' | 'at'>>,
  now = Date.now(),
) {
  let sequence = existing.reduce((highest, item) => Math.max(highest, item.sequence || 0), 0)
  return [
    ...existing,
    ...additions.map((addition, index) => ({
      ...addition,
      id: eventId(),
      sequence: ++sequence,
      taskId: targetTaskId,
      at: now + index,
    })),
  ]
}

function legacyStepIndex(phase: LegacyLearningPhase, stepCount: number) {
  if (phase === 'learn') return 0
  if (phase === 'practice') return Math.min(1, stepCount - 1)
  if (phase === 'verify') return Math.max(0, stepCount - 2)
  return Math.max(0, stepCount - 1)
}

export function projectLearningTask(task: LearningTask, events: LearningEvent[]): LearningTaskProjection {
  const taskEvents = events.filter(event => event.taskId === task.id).sort((left, right) => left.sequence - right.sequence)
  let status: LearningTaskStatus = 'active'
  let skillId: LearningSkillId = recommendedLearningSkill(task.objective)
  let stepId = LEARNING_SKILLS[skillId].steps[0].id
  let legacyPhase: LegacyLearningPhase = 'learn'
  let hasSkillStep = false
  let learnerReplyCount = 0
  let learnerRepliesInStep = 0
  let supportCount = 0
  let loopCount = 0
  let totalLoopCount = 0

  taskEvents.forEach(event => {
    if (event.type === 'vnext_learning_task_paused') status = 'paused'
    if (event.type === 'vnext_learning_task_resumed' || event.type === 'vnext_learning_task_started') status = 'active'
    if (event.type === 'vnext_learning_task_completed') status = 'completed'
    if (event.type === 'vnext_learning_task_phase_entered' && event.phase) legacyPhase = event.phase
    if (event.type === 'vnext_learning_skill_selected' && event.skillId) {
      skillId = event.skillId
      stepId = LEARNING_SKILLS[skillId].steps[0].id
      loopCount = 0
      learnerRepliesInStep = 0
    }
    if (event.type === 'vnext_learning_skill_step_entered' && event.stepId) {
      const eventSkillId = event.skillId || skillId
      const eventStepId = isLearningSkillId(eventSkillId)
        ? canonicalSkillStepId(eventSkillId, event.stepId)
        : event.stepId
      if (isLearningSkillId(eventSkillId) && LEARNING_SKILLS[eventSkillId].steps.some(step => step.id === eventStepId)) {
        skillId = eventSkillId
        stepId = eventStepId
        hasSkillStep = true
        loopCount = 0
        learnerRepliesInStep = 0
      }
    }
    if (event.type === 'vnext_learning_skill_looped') {
      loopCount += 1
      totalLoopCount += 1
      learnerRepliesInStep = 0
    }
    if (event.type === 'vnext_learning_task_learner_replied') {
      learnerReplyCount += 1
      learnerRepliesInStep += 1
    }
    if (event.type === 'vnext_learning_support_requested') supportCount += 1
  })

  const steps = LEARNING_SKILLS[skillId].steps
  if (!hasSkillStep) stepId = steps[legacyStepIndex(legacyPhase, steps.length)].id
  const stepIndex = Math.max(0, steps.findIndex(step => step.id === stepId))
  return { task, status, skillId, stepId, stepIndex, eventCount: taskEvents.length, learnerReplyCount, learnerRepliesInStep, supportCount, loopCount, totalLoopCount }
}

export function latestLearningTaskProjection(tasks: LearningTask[], events: LearningEvent[]) {
  const task = [...tasks].sort((left, right) => right.createdAt - left.createdAt)[0]
  return task ? projectLearningTask(task, events) : undefined
}

export function activeLearningTaskProjection(tasks: LearningTask[], events: LearningEvent[]) {
  return [...tasks]
    .sort((left, right) => right.createdAt - left.createdAt)
    .map(task => projectLearningTask(task, events))
    .find(item => item.status === 'active')
}

export function currentLearningSkillStep(projection: LearningTaskProjection) {
  return LEARNING_SKILLS[projection.skillId].steps[projection.stepIndex]
}

export function nextLearningSkillStep(projection: LearningTaskProjection) {
  return LEARNING_SKILLS[projection.skillId].steps[projection.stepIndex + 1]
}

export function canAdvanceLearningSkillStep(projection: LearningTaskProjection) {
  const step = currentLearningSkillStep(projection)
  return !step.requiresLearnerReply || projection.learnerRepliesInStep > 0
}

export function advanceLearningSkillStep(events: LearningEvent[], projection: LearningTaskProjection, now = Date.now()) {
  if (!canAdvanceLearningSkillStep(projection)) return events
  const next = nextLearningSkillStep(projection)
  if (!next) return events
  return appendLearningEvents(events, projection.task.id, [{
    type: 'vnext_learning_skill_step_entered',
    detail: `进入${next.substateLabel}：${next.title}；不表示上一动作通过`,
    skillId: projection.skillId,
    stepId: next.id,
  }], now)
}

export function loopLearningSkillStep(events: LearningEvent[], projection: LearningTaskProjection, reason = '重复当前教学动作', now = Date.now()) {
  const step = currentLearningSkillStep(projection)
  return appendLearningEvents(events, projection.task.id, [{
    type: 'vnext_learning_skill_looped', detail: `${reason}：${step.title}`, skillId: projection.skillId, stepId: step.id,
  }], now)
}

export function switchLearningSkill(events: LearningEvent[], projection: LearningTaskProjection, skillId: LearningSkillId, now = Date.now()) {
  const firstStep = LEARNING_SKILLS[skillId].steps[0]
  return appendLearningEvents(events, projection.task.id, [
    { type: 'vnext_learning_skill_selected', detail: `切换为${LEARNING_SKILLS[skillId].name}`, skillId },
    { type: 'vnext_learning_skill_step_entered', detail: `进入${firstStep.substateLabel}：从${firstStep.title}开始`, skillId, stepId: firstStep.id },
  ], now)
}

export function learningTaskTutorContext(projection: LearningTaskProjection): LearningTaskTutorContext {
  const skill = LEARNING_SKILLS[projection.skillId]
  const step = skill.steps[projection.stepIndex]
  return {
    objectType: 'learning_task_binding',
    authority: projection.task.formalTaskId ? 'formal_learning_task' : 'local_offline_fallback',
    formalTaskId: projection.task.formalTaskId,
    formalSkillRunId: projection.task.formalSkillRunId,
    formalSkillRunVersion: projection.task.formalSkillRunVersion,
    formalSkillStatus: projection.task.formalSkillStatus,
    formalSkillState: projection.task.formalSkillState,
    formalSkillStageLabel: projection.task.formalSkillStageLabel,
    formalSkillCalibration: projection.task.formalSkillCalibration,
    formalTeachBackDiagnostic: projection.task.formalTeachBackDiagnostic,
    taskId: projection.task.id,
    objective: projection.task.objective,
    skillId: projection.skillId,
    skillName: skill.name,
    substateId: step.substateId,
    substateLabel: step.substateLabel,
    stepId: step.id,
    stepTitle: step.title,
    stepIndex: projection.stepIndex,
    stepCount: skill.steps.length,
    stepInstruction: projection.task.formalSkillDirective || step.tutorInstruction,
    nextAction: step.nextAction,
    loopCount: projection.loopCount,
    loopInstruction: step.loopInstruction || '继续当前动作并缩小问题范围。',
  }
}

export function bindFormalSkillRun(task: LearningTask, run: FormalSkillRunBindingInput): LearningTask {
  return {
    ...task,
    formalTaskId: run.learning_task?.id || task.formalTaskId,
    formalTaskVersion: run.learning_task?.version || task.formalTaskVersion,
    formalSkillRunId: run.id,
    formalSkillRunVersion: run.version,
    formalSkillStatus: run.status.slice(0, 40),
    formalSkillState: run.state.slice(0, 80),
    formalSkillStageLabel: String(run.stage_label || run.state).slice(0, 100),
    formalSkillDirective: String(run.next_prompt || '').slice(0, 1800),
    formalSkillTurnCount: Math.max(0, Math.floor(run.turn_count || 0)),
    formalSkillTurnBudget: Math.max(0, Math.floor(run.turn_budget || 0)),
    formalSkillGapLoopCount: Math.max(0, Math.floor(run.gap_loop_count || 0)),
    formalSkillCalibration: { ...(run.calibration || {}) },
    formalTeachBackDiagnostic: { ...(run.teach_back_diagnostic || {}) },
  }
}

export function reconcileLearningEventsWithFormalSkillRun(
  events: LearningEvent[],
  projection: LearningTaskProjection,
  run: FormalSkillRunBindingInput,
  now = Date.now(),
) {
  const steps = LEARNING_SKILLS[projection.skillId].steps
  const targetIndex = Math.max(0, Math.min(steps.length - 1, Math.floor((run.step_index || 1) - 1)))
  if (targetIndex <= projection.stepIndex) return events
  const additions = steps.slice(projection.stepIndex + 1, targetIndex + 1).map(step => ({
    type: 'vnext_learning_skill_step_entered' as const,
    detail: `正式 SkillRun 推进到${step.substateLabel}：${step.title}`,
    skillId: projection.skillId,
    stepId: step.id,
  }))
  return appendLearningEvents(events, projection.task.id, additions, now)
}

export function isLearningSkillId(value: unknown): value is LearningSkillId {
  return typeof value === 'string' && value in LEARNING_SKILLS
}

export function sanitizeLearningTaskTutorContext(value: unknown): LearningTaskTutorContext | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  if (
    typeof item.taskId !== 'string'
    || typeof item.objective !== 'string'
    || !isLearningSkillId(item.skillId)
    || typeof item.skillName !== 'string'
    || typeof item.substateId !== 'string'
    || typeof item.substateLabel !== 'string'
    || typeof item.stepId !== 'string'
    || typeof item.stepTitle !== 'string'
    || typeof item.stepIndex !== 'number'
    || typeof item.stepCount !== 'number'
    || typeof item.stepInstruction !== 'string'
    || typeof item.nextAction !== 'string'
    || typeof item.loopCount !== 'number'
    || typeof item.loopInstruction !== 'string'
  ) return undefined
  const maxStepIndex = Math.max(0, LEARNING_SKILLS[item.skillId].steps.length - 1)
  return {
    objectType: 'learning_task_binding',
    authority: item.authority === 'formal_learning_task' ? 'formal_learning_task' : 'local_offline_fallback',
    formalTaskId: typeof item.formalTaskId === 'number' ? Math.floor(item.formalTaskId) : undefined,
    formalSkillRunId: typeof item.formalSkillRunId === 'number' ? Math.floor(item.formalSkillRunId) : undefined,
    formalSkillRunVersion: typeof item.formalSkillRunVersion === 'number' ? Math.floor(item.formalSkillRunVersion) : undefined,
    formalSkillStatus: typeof item.formalSkillStatus === 'string' ? item.formalSkillStatus.slice(0, 40) : undefined,
    formalSkillState: typeof item.formalSkillState === 'string' ? item.formalSkillState.slice(0, 80) : undefined,
    formalSkillStageLabel: typeof item.formalSkillStageLabel === 'string' ? item.formalSkillStageLabel.slice(0, 100) : undefined,
    formalSkillCalibration: item.formalSkillCalibration && typeof item.formalSkillCalibration === 'object'
      ? { ...(item.formalSkillCalibration as FeynmanCalibration) }
      : undefined,
    formalTeachBackDiagnostic: item.formalTeachBackDiagnostic && typeof item.formalTeachBackDiagnostic === 'object'
      ? { ...(item.formalTeachBackDiagnostic as TeachBackDiagnostic) }
      : undefined,
    taskId: item.taskId.slice(0, 120),
    objective: item.objective.slice(0, 500),
    skillId: item.skillId,
    skillName: item.skillName.slice(0, 80),
    substateId: LEARNING_SKILLS[item.skillId].steps.some(step => step.substateId === item.substateId)
      ? item.substateId as LearningSubstateId
      : LEARNING_SKILLS[item.skillId].steps[0].substateId,
    substateLabel: item.substateLabel.slice(0, 40),
    stepId: item.stepId.slice(0, 80),
    stepTitle: item.stepTitle.slice(0, 100),
    stepIndex: Math.max(0, Math.min(Math.floor(item.stepIndex), maxStepIndex)),
    stepCount: LEARNING_SKILLS[item.skillId].steps.length,
    stepInstruction: item.stepInstruction.slice(0, 1400),
    nextAction: item.nextAction.slice(0, 100),
    loopCount: Math.max(0, Math.min(Math.floor(item.loopCount), 99)),
    loopInstruction: item.loopInstruction.slice(0, 1000),
  }
}
