import { visualSpecPrompt, OFFLINE_VISUAL_CATALOG, requestsFreshVisual, type VisualCatalog, type VisualAuthoringTransport } from './visualize-authoring.ts'
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
    code: /visual_unsupported/.test(message) ? 'visual_unsupported'
      : /visual_needs_clarification|needs_input/.test(message) ? 'visual_needs_clarification'
      : /timeout|超时|abort/i.test(message)
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
  // This is committed Markdown, not a label: whitespace is significant in code/math.
  const explanation = String(raw || '').trim()
  const errors: string[] = []
  if (explanation.length > 5000) errors.push('explanation_too_long')
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
  context?: Parameters<typeof visualSpecPrompt>[4],
) {
  return visualSpecPrompt(modality, request, explanation, repair, context)
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
  const explanation = String(committedExplanation ?? payload.explanation ?? '').trim()
  if (payload.unsupported) throw new Error('visual_unsupported:' + compact(typeof payload.unsupported === 'object' ? (payload.unsupported as any).reason : payload.unsupported, 600))
  if (payload.needs_clarification) throw new Error('visual_needs_clarification:' + compact(typeof payload.needs_clarification === 'object' ? (payload.needs_clarification as any).question : payload.needs_clarification, 600))
  const visualSpec = payload.visual_spec as import('../src/visualize.ts').VisualSpec | undefined
  if (visualSpec && !['0.1.0','0.2.0'].includes(visualSpec.spec_version)) throw new Error('visual_spec_version_invalid')
  const ref = payload.template_ref as {id?: unknown; version?: unknown} | undefined
  const templateRef = ref && typeof ref.id === 'string' && typeof ref.version === 'string' ? {id:ref.id,version:ref.version} : undefined
  if (ref && !templateRef) throw new Error('visual_template_ref_invalid:/template_ref')
  if (templateRef && requestsFreshVisual(request)) throw new Error('visual_fresh_required:不得在从零生成请求中使用template_ref')
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
  if (explanation.length > 5000) errors.push('explanation_too_long')
  if (visualSpec || templateRef) {
    if (explanation && [...explanation].length < 20) errors.push('explanation_insufficient')
  } else if ([...explanation].length < 100 || explanation.split(/[。！？.!?]+/).filter(Boolean).length < 3) errors.push('explanation_insufficient')
  if (!topic || !learningGoal || !modalityRationale || !claimBoundary) errors.push('brief_identity_missing')
  if (!visualSpec && !templateRef && !storyboardContext && objects.length < 2) errors.push('brief_objects_insufficient')
  if (!visualSpec && !templateRef && !storyboardContext && (!initialState || !finalState)) errors.push('brief_state_missing')
  if (modality === 'animation' && !visualSpec && !templateRef && !storyboardContext && steps.length < 2) errors.push('animation_changes_insufficient')
  if (modality === 'diagram' && !visualSpec && !templateRef && !storyboardContext && relations.length < 1) errors.push('diagram_relations_insufficient')
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
    visualSpec,
    templateRef,
    adaptTemplate: payload.adapt === true,
    adaptationGoal: compact(payload.adaptation_goal, 1000),
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
  const degraded = rendered && run?.artifact?.fallbackUsed === true
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
  const prefix = bundle.explanation ? `${bundle.explanation}\n\n` : ''
  if (bundle.failure?.code === 'visual_unsupported') return `${prefix}当前图解工具无法完成这一要求：${bundle.failure.message.replace(/^visual_unsupported:/, '')}`
  if (bundle.failure?.code === 'visual_needs_clarification') return `${prefix}当前信息不足，暂时无法构建：${bundle.failure.message.replace(/^visual_needs_clarification:/, '')}`
  return `${prefix}图解构建失败，在${bundle.failure?.stage === 'validation' ? '校验' : '规划或构建'}阶段未通过：${bundle.failure?.message || '未返回可用产物'}。${bundle.explanation ? '已提交的讲解已保留。' : ''}`
}

export const VISUAL_TEACHING_RUNTIME_STATES = [
  'catalog',
  'plan_and_build',
  'validate_and_simulate',
  'commit_explanation',
  'render_visual',
  'bundle_ready_or_explanation_only',
] as const


export function retryableVisualError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return !/visual_unsupported|visual_needs_clarification|visual_auth_required|visual_host_required|401|403|timeout|deadline|abort|network|fetch failed/i.test(message)
}

/** Router → Plan/Builder → host validation. A failed lookup never disables fresh composition. */
export async function prepareVisualTeachingBrief(options: {
  modality: VisualTeachingModality
  request: string
  explanation?: string
  transport: VisualAuthoringTransport
  generate: (prompt: string) => Promise<string>
  onStage?: (stage: string, detail: string) => void
}) {
  let catalog: VisualCatalog = OFFLINE_VISUAL_CATALOG
  options.onStage?.('catalog', '读取已安装能力与相关维护案例')
  try {
    const result = await options.transport('catalog', {query: options.request, kind: options.modality, templates: !requestsFreshVisual(options.request)})
    if (result && typeof result.capabilities === 'object' && Array.isArray(result.templates)) {
      catalog = {...result, templates: requestsFreshVisual(options.request) ? [] : result.templates.slice(0, 5)}
    }
  } catch (error) {
    if (/401|403|visual_auth_required/.test(String(error))) throw error
    options.onStage?.('catalog', '目录暂不可用，使用本版本计算契约从零规划；最终仍由后端校验')
  }
  let previousCandidate = ''
  let validationError = ''
  let selectedTemplate: any
  let adaptedRef: {id:string;version:string} | undefined
  let plannerAttempts = 0
  let repairAttempted = false
  // One optional adaptation call plus one actual schema/compile repair, never unbounded retry.
  for (let cycle = 0; cycle < 3; cycle += 1) {
    options.onStage?.(repairAttempted ? 'repair' : 'planning', repairAttempted ? '根据具体错误修复一次' : selectedTemplate ? '按当前要求改编维护案例' : '选择教学模式并组合视觉对象')
    plannerAttempts += 1
    const raw = await options.generate(visualTeachingBriefPrompt(options.modality, options.request, options.explanation || '', repairAttempted, {
      catalog, error: validationError, previousCandidate, selectedTemplate,
    }))
    try {
      const brief = parseVisualTeachingBrief(raw, options.modality, options.request, options.explanation || undefined)
      if (adaptedRef && !brief.visualSpec) throw new Error('visual_template_adaptation_requires_spec:/visual_spec:改编必须提供修改后的完整规格')
      if (adaptedRef && brief.templateRef && (brief.templateRef.id !== adaptedRef.id || brief.templateRef.version !== adaptedRef.version)) throw new Error('visual_template_adaptation_source_conflict:/template_ref')
      if (brief.templateRef) {
        const match = catalog.templates.find(item => item.id === brief.templateRef!.id && item.version === brief.templateRef!.version)
        if (!match && !(adaptedRef?.id === brief.templateRef.id && adaptedRef.version === brief.templateRef.version)) throw new Error('visual_template_not_retrieved:/template_ref:必须选择已检索精确版本，或从零输出visual_spec')
        if (!selectedTemplate || selectedTemplate.id !== brief.templateRef.id || selectedTemplate.version !== brief.templateRef.version) {
          options.onStage?.('template', '读取所选维护案例的精确版本')
          selectedTemplate = await options.transport('template', brief.templateRef)
          if (selectedTemplate.id !== brief.templateRef.id || selectedTemplate.version !== brief.templateRef.version || !selectedTemplate.spec) throw new Error('visual_template_version_conflict')
        }
        if (brief.adaptTemplate && !brief.visualSpec) {
          if (adaptedRef) throw new Error('visual_template_adaptation_requires_spec:/visual_spec')
          adaptedRef = brief.templateRef
          selectedTemplate = {...selectedTemplate, adaptation_goal: brief.adaptationGoal, instruction: '按用户要求修改完整visual_spec，并保留template_ref。不要再次返回adapt:true。'}
          previousCandidate = raw
          continue
        }
        brief.visualSpec ||= selectedTemplate.spec
      }
      if (adaptedRef && brief.visualSpec) brief.templateRef = adaptedRef
      if (brief.visualSpec) {
        if (!brief.explanation) brief.explanation = [brief.visualSpec.teaching.goal, ...brief.visualSpec.teaching.assumptions, brief.claimBoundary].filter(Boolean).join('。')
        options.onStage?.('validation', '后端检查规格、绑定、计算状态与验证范围')
        const bundle = await options.transport('compile', {spec: brief.visualSpec, params: {}, ...(brief.templateRef ? {template_ref: brief.templateRef} : {})})
        if (bundle.verification?.status !== 'pass' || !bundle.frames?.length) throw new Error('visual_verification_required')
        if (options.modality === 'animation' && bundle.frames.length < 3) throw new Error('visual_animation_requires_semantic_transitions:/model:动画需要至少两次有意义变化')
      }
      brief.plannerAttempts = plannerAttempts
      brief.repairAttempted = repairAttempted
      return brief
    } catch (error) {
      if (!retryableVisualError(error) || repairAttempted || cycle >= 2) throw error
      repairAttempted = true
      validationError = (error instanceof Error ? error.message : String(error)).slice(0, 1800)
      previousCandidate = raw
    }
  }
  throw new Error('visual_generation_budget_exhausted')
}
