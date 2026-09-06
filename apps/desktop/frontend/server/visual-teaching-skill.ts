import {
  VISUAL_TEACHING_BRIEF_VERSION,
  VISUAL_TEACHING_SKILL_ID,
  type VisualTeachingBrief,
  type VisualTeachingBundle,
  type VisualTeachingFailure,
  type VisualTeachingModality,
} from '../src/visual-teaching.ts'
import type { TutorToolRun } from '../src/tooling.ts'
import { VISUAL_STORYBOARD_VERSION, type VisualStoryboardContext } from '../src/visual-storyboard.ts'
import { validateVisualStoryboard } from './visual-storyboard-tool.ts'

const ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

function compact(value: unknown, limit: number) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function jsonPayload(raw: string) {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const candidate = fenced || trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('visual_teaching_brief_json_missing')
  return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>
}

function stringList(value: unknown, limit = 8) {
  return Array.isArray(value)
    ? value.map(item => compact(item, 240)).filter(Boolean).slice(0, limit)
    : []
}

function classifyFailure(run?: TutorToolRun, error?: unknown): VisualTeachingFailure {
  const message = compact(run?.detail || (error instanceof Error ? error.message : error), 300) || '视觉增强未生成成功'
  const stage = run?.visualMeta?.outcomeStage === 'layout'
    ? 'layout'
    : run?.visualMeta?.outcomeStage === 'validation'
      ? 'validation'
      : /render|svg/i.test(message) ? 'render' : 'planner'
  return {
    stage,
    code: /timeout|超时|abort/i.test(message)
      ? 'visual_timeout'
      : /json|syntax|parse|comma/i.test(message)
        ? 'visual_syntax_invalid'
        : /layout|collision|route/i.test(message)
          ? 'visual_layout_invalid'
          : 'visual_generation_failed',
    message,
  }
}

export function visualTeachingExplanationPrompt(modality: VisualTeachingModality, request: string, repair = false) {
  return [
    '你是 LearnFlow 的视觉教学 Skill。当前只形成教学讲解，不调用工具，不输出 JSON、SVG、布局坐标或对视觉产物的占位引用。',
    '讲解必须在没有任何图解或动画时也能独立成立：明确核心对象、对象之间的关系或过程、初始条件、至少两个关键变化、结果和一个事实边界。',
    modality === 'animation'
      ? '学习者后续希望用动画增强，因此请把有顺序的状态变化讲清楚，但不要声称动画已经生成。'
      : '学习者后续希望用图解增强，因此请把需要同时检查的对象和关系讲清楚，但不要声称图解已经生成。',
    '至少三句且不少于 100 个中文字符；避免“输入—处理—输出”式空泛占位内容。无法确认的值或机制不要编造。',
    repair ? '上一版讲解未达到独立教学门槛，请补足真实对象、过程、结果和边界，不要改变主题。' : '',
    `学习者原始请求：${compact(request, 2200)}`,
  ].filter(Boolean).join('\n')
}

export function validateVisualTeachingExplanation(raw: string) {
  const explanation = compact(raw, 5000)
  const errors: string[] = []
  if ([...explanation].length < 100) errors.push('explanation_too_short')
  if (explanation.split(/[。！？.!?]+/).filter(Boolean).length < 3) errors.push('explanation_sentences_insufficient')
  const substance = explanation.match(/(?:对象|关系|初始|状态|过程|变化|更新|移动|比较|交换|传递|聚合|递归|结果|边界|条件|阶段|before|after|state|change|result)/gi)?.length || 0
  if (substance < 3) errors.push('explanation_process_insufficient')
  if (errors.length) throw new Error(`visual_teaching_explanation_invalid:${errors.join(',')}`)
  return explanation
}

export function visualTeachingBriefPrompt(
  modality: VisualTeachingModality,
  request: string,
  explanation: string,
  repair = false,
) {
  const modalityRule = modality === 'animation'
    ? 'storyboard.frames 必须包含至少两个真实状态变化；对象在步骤间保持稳定 id。'
    : 'relations 必须表达至少一个真实关系；initial 与最终状态要概括图解所呈现的同一稳定结构。'
  return [
    '你是 LearnFlow 的视觉教学语义建模 Skill。只输出一个 JSON 对象，不调用工具，不输出 ASCII 画布、SVG、Markdown 代码围栏、HTML、CSS 或坐标。',
    '教学讲解已经独立提交。现在只建模最基本的对象身份、关系、集合和状态变化；后续独立 ASCII Designer 会依据 Tool 重放后的状态自由排版。不得改写、复制、扩张或撤销讲解。',
    'JSON 根字段：topic、learning_goal、modality_rationale、claim_boundary、misconceptions、storyboard。不要输出 explanation。',
    `storyboard.version 必须是 ${VISUAL_STORYBOARD_VERSION}。storyboard 还要包含 id、title、learningGoal、entities、relations、groups、initial、frames、invariants、misconceptions、claimBoundary、presentation、provenance。`,
    'entities: [{id,label,kind:item|actor|state|value|operator|result,detail?}]；relations: [{id,from,to,label?,kind:flow|link|membership|comparison|message}]；groups: [{id,label,layout:row|column|cluster}]。',
    'initial: {visibleIds,groupMembers,orders?,properties?,focusIds?}。frames 每项含 id、title、narration、operations、assertions。',
    'operations 只允许 create_entity/remove_entity(targetId)、connect/disconnect(relationId)、set_property(targetId,key,value)、set_group_members(groupId,memberIds)、reorder(groupId,itemIds)、focus(targetIds)。',
    'assertions 只允许 visible(targetId,equals)、property(targetId,key,equals)、group_members(groupId,equals)、order(groupId,equals)。presentation 固定含 preferredDirection:auto、pacing:step、preserveIdentity:true、showGroupSummary:true、asciiWidth:160、asciiHeight:40；provenance.source=visual_teaching_skill。',
    `请求视觉形式：${modality}。${modalityRule}`,
    '对象 id 只能使用小写 ASCII 字母、数字和下划线；所有引用必须存在。对象和关系全集先声明，初态用 visibleIds 控制；后续创建和连线只改变可见性。无法确认的值、关系或步骤不要编造。禁止坐标、SVG、CSS、动画时长和主题专用模板名。',
    repair ? '上一版未通过结构门。请补齐真实对象、关系、状态与变化，但不要改变学习者主题。' : '',
    `学习者原始请求：${compact(request, 2200)}`,
    `已提交讲解：${compact(explanation, 5000)}`,
  ].filter(Boolean).join('\n')
}

/** Compatibility name for callers that compile a brief from an existing explanation. */
export const visualTeachingPrompt = visualTeachingBriefPrompt

export function parseVisualTeachingBrief(
  raw: string,
  modality: VisualTeachingModality,
  request: string,
  committedExplanation?: string,
): VisualTeachingBrief {
  const payload = jsonPayload(raw)
  const explanation = compact(committedExplanation || payload.explanation, 5000)
  const topic = compact(payload.topic, 240)
  const learningGoal = compact(payload.learning_goal, 360)
  const modalityRationale = compact(payload.modality_rationale, 360)
  const initialState = compact(payload.initial_state, 600)
  const finalState = compact(payload.final_state, 600)
  const claimBoundary = compact(payload.claim_boundary, 600)
  let storyboardContext: VisualStoryboardContext | undefined
  if (payload.storyboard && typeof payload.storyboard === 'object') {
    const candidate = payload.storyboard as VisualStoryboardContext
    storyboardContext = validateVisualStoryboard({
      ...candidate,
      explanation,
      learningGoal: compact(candidate.learningGoal || learningGoal, 260),
      claimBoundary: compact(candidate.claimBoundary || claimBoundary, 600),
      invariants: Array.isArray(candidate.invariants) ? candidate.invariants : stringList(payload.invariants),
      misconceptions: Array.isArray(candidate.misconceptions) ? candidate.misconceptions : stringList(payload.misconceptions),
      provenance: { source: 'visual_teaching_skill', caseId: candidate.provenance?.caseId },
    })
  }
  const objects = Array.isArray(payload.objects)
    ? payload.objects.map(item => {
      const row = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      return { id: compact(row.id, 64), label: compact(row.label, 160), role: compact(row.role, 240) }
    }).filter(item => ID_PATTERN.test(item.id) && item.label && item.role).slice(0, 20)
    : []
  const objectIds = new Set(objects.map(item => item.id))
  const relations = Array.isArray(payload.relations)
    ? payload.relations.map(item => {
      const row = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      return { from: compact(row.from, 64), to: compact(row.to, 64), label: compact(row.label, 200) }
    }).filter(item => objectIds.has(item.from) && objectIds.has(item.to) && item.label).slice(0, 30)
    : []
  const steps = Array.isArray(payload.steps)
    ? payload.steps.map(item => {
      const row = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      return {
        id: compact(row.id, 64), title: compact(row.title, 160), before: compact(row.before, 500),
        change: compact(row.change, 500), after: compact(row.after, 500), why: compact(row.why, 500),
      }
    }).filter(item => ID_PATTERN.test(item.id) && item.title && item.before && item.change && item.after && item.why).slice(0, 12)
    : []

  const errors: string[] = []
  if ([...explanation].length < 100 || explanation.split(/[。！？.!?]+/).filter(Boolean).length < 3) errors.push('explanation_insufficient')
  if (!topic || !learningGoal || !modalityRationale || !claimBoundary) errors.push('brief_identity_missing')
  if (!storyboardContext && objects.length < 2) errors.push('brief_objects_insufficient')
  if (!storyboardContext && (!initialState || !finalState)) errors.push('brief_state_missing')
  if (modality === 'animation' && !storyboardContext && steps.length < 2) errors.push('animation_changes_insufficient')
  if (modality === 'diagram' && !storyboardContext && relations.length < 1) errors.push('diagram_relations_insufficient')
  if (!compact(request, 2200)) errors.push('request_missing')
  if (errors.length) throw new Error(`visual_teaching_brief_invalid:${errors.join(',')}`)

  return {
    version: VISUAL_TEACHING_BRIEF_VERSION,
    topic,
    learningGoal,
    modality,
    modalityRationale,
    explanation,
    objects,
    relations,
    initialState,
    steps,
    finalState,
    invariants: stringList(payload.invariants),
    misconceptions: stringList(payload.misconceptions),
    claimBoundary,
    storyboardContext,
  }
}

export function visualTeachingContext(brief: VisualTeachingBrief) {
  return JSON.stringify({
    version: brief.version,
    topic: brief.topic,
    learning_goal: brief.learningGoal,
    modality: brief.modality,
    modality_rationale: brief.modalityRationale,
    objects: brief.objects,
    relations: brief.relations,
    initial_state: brief.initialState,
    steps: brief.steps,
    final_state: brief.finalState,
    invariants: brief.invariants,
    misconceptions: brief.misconceptions,
    claim_boundary: brief.claimBoundary,
    ...(brief.storyboardContext ? { storyboard: brief.storyboardContext } : {}),
  })
}

export function completeVisualTeachingBundle(
  brief: VisualTeachingBrief,
  run?: TutorToolRun,
  error?: unknown,
): VisualTeachingBundle {
  const modalityMatches = !run?.visualMeta || run.visualMeta.effectiveKind === brief.modality
  const rendered = run?.status === 'completed' && Boolean(run.artifact) && modalityMatches
  const degraded = false
  return {
    skillId: VISUAL_TEACHING_SKILL_ID,
    briefVersion: VISUAL_TEACHING_BRIEF_VERSION,
    explanation: brief.explanation,
    visualBrief: brief,
    requestedModality: brief.modality,
    selectedModality: rendered ? (run?.visualMeta?.effectiveKind || brief.modality) : 'none',
    visualStatus: degraded ? 'degraded' : rendered ? 'rendered' : 'failed',
    terminalState: rendered ? 'bundle_ready' : 'explanation_only',
    explanationPreserved: true,
    ...(!rendered ? { failure: classifyFailure(run, error) } : {}),
  }
}

export function explanationOnlyVisualTeachingBundle(
  explanation: string,
  modality: VisualTeachingModality,
  error?: unknown,
): VisualTeachingBundle {
  return {
    skillId: VISUAL_TEACHING_SKILL_ID,
    briefVersion: VISUAL_TEACHING_BRIEF_VERSION,
    explanation,
    requestedModality: modality,
    selectedModality: 'none',
    visualStatus: 'failed',
    terminalState: 'explanation_only',
    explanationPreserved: true,
    failure: classifyFailure(undefined, error),
  }
}

export function visualTeachingReply(bundle: VisualTeachingBundle) {
  if (bundle.terminalState === 'bundle_ready') {
    const label = bundle.selectedModality === 'animation' ? '动画' : '图解'
    return `${bundle.explanation}\n\n${label}已经生成，可在上方逐步检查；它只是对这段讲解的视觉增强。`
  }
  return `${bundle.explanation}\n\n视觉增强本轮未能生成成功，但上面的讲解已经保留并且仍然有效。你可以继续基于它追问，或稍后单独重试视觉生成。`
}

export const VISUAL_TEACHING_RUNTIME_STATES = [
  'compose_explanation',
  'commit_explanation',
  'compile_visual_brief',
  'render_visual',
  'bundle_ready_or_explanation_only',
] as const
