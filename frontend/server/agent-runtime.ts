import type {
  AgentContextEnvelope,
  AgentDecisionSummary,
  AgentKnowledgeDomain,
  AgentTaskQueueItem,
  AgentToolCall,
  AgentToolDefinition,
  AgentTrajectoryEvent,
  AgentTurnResponse,
  AgentTurnStreamEvent,
} from '../src/agent-contracts.ts'
import type { TutorContextMessage, TutorMode } from '../src/tutor.ts'
import {
  auditSearchCitations,
  buildTutorInstructions,
  endpointFor,
  ensureSearchCitations,
  incompleteTutorProviderReason,
  isDisplayableTutorReply,
  textFromTutorProviderResponse,
} from '../src/tutor.ts'
import type { SearchSource, TutorToolChoice, TutorToolRun } from '../src/tooling.ts'
import type { LearningTaskTutorContext } from '../src/learning.ts'
import type { LearningPlanTutorContext } from '../src/planning.ts'
import type { LearnerPathState } from '../src/learning-path-graph.ts'
import {
  executeTutorAgentTool,
  TUTOR_AGENT_TOOL_DEFINITIONS,
  type TutorAgentToolExecution,
  type TutorAgentToolRuntimeOptions,
} from './tool-runtime.ts'
import type { SearchProviderConfiguration } from './computer-knowledge-search.ts'
import type { LearningVideoCandidate } from './learning-video-harness.ts'
import type { AgentProjectContext } from '../src/project.ts'
import { resolveExplicitVisualIntent, resolveVisualRequest } from './visual-tool-execution.ts'
import { AI_LATENCY_BUDGETS } from '../src/latency-budgets.ts'
import { runGenerationWithinDeadline } from './generation-deadline.ts'
import {
  pluginObjectReferenceUri,
  type LearnFlowPluginObject,
  type LearnFlowPluginRegistry,
  type PluginActivationContext,
} from '../src/plugin-api.ts'
import { stickyConversationPluginIds, lockedConversationPluginIds } from '../src/conversation-plugin-state.ts'
import {
  completeVisualTeachingBundle,
  explanationOnlyVisualTeachingBundle,
  parseVisualTeachingBrief,
  validateVisualTeachingExplanation,
  visualTeachingBriefPrompt,
  visualTeachingExplanationPrompt,
  visualTeachingReply,
} from './visual-teaching-skill.ts'
import {
  VISUAL_TEACHING_BRIEF_VERSION,
  VISUAL_TEACHING_SKILL_ID,
  type VisualTeachingBrief,
  type VisualTeachingBundle,
} from '../src/visual-teaching.ts'
import { parseLearningTaskDraftConfirmation } from '../plugins/learning_task_conversion/intake.ts'
import {
  learningTaskPreflightInput,
  learningTaskPreflightInstructions,
  parseLearningTaskPreflightResult,
  preflightResultToIntakeInput,
} from '../plugins/learning_task_conversion/preflight-model.ts'

export type TutorAgentBudget = {
  maxModelRounds: number
  maxToolCalls: number
  maxWallTimeMs: number
  maxOutputTokens: number
  recoveryMaxOutputTokens: number
  contextMessageLimit: number
  contextEnvelopeChars: number
  contextObservationChars: number
  contextObservationTotalChars: number
  toolDescriptionChars: number
  finalizationAttempts: number
  finalizationGraceMs: number
}

export type TutorAgentGenerationConfig = {
  maxOutputTokens?: number
  planningMaxOutputTokens?: number
  planningRecoveryMaxOutputTokens?: number
  planningContextMessages?: number
  planningContextEnvelopeChars?: number
  planningContextObservationChars?: number
  planningContextObservationTotalChars?: number
  planningToolDescriptionChars?: number
}

export const DEFAULT_TUTOR_GENERATION_CONFIG = Object.freeze({
  maxOutputTokens: 6_000,
  planningMaxOutputTokens: 12_000,
  planningRecoveryMaxOutputTokens: 6_000,
  planningContextMessages: 12,
  planningContextEnvelopeChars: 12_000,
  planningContextObservationChars: 2_400,
  planningContextObservationTotalChars: 8_000,
  planningToolDescriptionChars: 360,
})

function boundedGenerationValue(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback
}

function normalizedTutorGenerationConfig(config: TutorAgentGenerationConfig = {}) {
  return {
    maxOutputTokens: boundedGenerationValue(config.maxOutputTokens, DEFAULT_TUTOR_GENERATION_CONFIG.maxOutputTokens, 400, 32_768),
    planningMaxOutputTokens: boundedGenerationValue(config.planningMaxOutputTokens, DEFAULT_TUTOR_GENERATION_CONFIG.planningMaxOutputTokens, 400, 32_768),
    planningRecoveryMaxOutputTokens: boundedGenerationValue(config.planningRecoveryMaxOutputTokens, DEFAULT_TUTOR_GENERATION_CONFIG.planningRecoveryMaxOutputTokens, 400, 32_768),
    planningContextMessages: boundedGenerationValue(config.planningContextMessages, DEFAULT_TUTOR_GENERATION_CONFIG.planningContextMessages, 4, 18),
    planningContextEnvelopeChars: boundedGenerationValue(config.planningContextEnvelopeChars, DEFAULT_TUTOR_GENERATION_CONFIG.planningContextEnvelopeChars, 2_000, 24_000),
    planningContextObservationChars: boundedGenerationValue(config.planningContextObservationChars, DEFAULT_TUTOR_GENERATION_CONFIG.planningContextObservationChars, 400, 8_000),
    planningContextObservationTotalChars: boundedGenerationValue(config.planningContextObservationTotalChars, DEFAULT_TUTOR_GENERATION_CONFIG.planningContextObservationTotalChars, 1_000, 24_000),
    planningToolDescriptionChars: boundedGenerationValue(config.planningToolDescriptionChars, DEFAULT_TUTOR_GENERATION_CONFIG.planningToolDescriptionChars, 120, 2_000),
  }
}

export function tutorAgentBudget(
  mode: TutorMode,
  visualIntent: 'diagram' | 'animation' | 'none' = 'none',
  generationConfig: TutorAgentGenerationConfig = {},
): TutorAgentBudget {
  const generation = normalizedTutorGenerationConfig(generationConfig)
  const visualWallTimeMs = visualIntent === 'animation'
    ? AI_LATENCY_BUDGETS.agentTurn.animation
    : visualIntent === 'diagram' ? AI_LATENCY_BUDGETS.agentTurn.diagram : 0
  if (mode === 'guided_learning') {
    return {
      maxModelRounds: 9,
      maxToolCalls: 14,
      maxWallTimeMs: Math.max(AI_LATENCY_BUDGETS.agentTurn.guided, visualWallTimeMs),
      maxOutputTokens: generation.maxOutputTokens,
      recoveryMaxOutputTokens: generation.maxOutputTokens,
      contextMessageLimit: 18,
      contextEnvelopeChars: 12_000,
      contextObservationChars: 5_000,
      contextObservationTotalChars: 24_000,
      toolDescriptionChars: 2_000,
      finalizationAttempts: 2,
      finalizationGraceMs: 45_000,
    }
  }
  if (mode === 'learning_plan') {
    return {
      maxModelRounds: 7,
      maxToolCalls: 12,
      maxWallTimeMs: Math.max(AI_LATENCY_BUDGETS.agentTurn.planning, visualWallTimeMs),
      maxOutputTokens: generation.planningMaxOutputTokens,
      recoveryMaxOutputTokens: generation.planningRecoveryMaxOutputTokens,
      contextMessageLimit: generation.planningContextMessages,
      contextEnvelopeChars: generation.planningContextEnvelopeChars,
      contextObservationChars: generation.planningContextObservationChars,
      contextObservationTotalChars: generation.planningContextObservationTotalChars,
      toolDescriptionChars: generation.planningToolDescriptionChars,
      finalizationAttempts: 2,
      finalizationGraceMs: 40_000,
    }
  }
  return {
    maxModelRounds: 5,
    maxToolCalls: 8,
    maxWallTimeMs: Math.max(AI_LATENCY_BUDGETS.agentTurn.standard, visualWallTimeMs),
    maxOutputTokens: generation.maxOutputTokens,
    recoveryMaxOutputTokens: generation.maxOutputTokens,
    contextMessageLimit: 18,
    contextEnvelopeChars: 12_000,
    contextObservationChars: 5_000,
    contextObservationTotalChars: 24_000,
    toolDescriptionChars: 2_000,
    finalizationAttempts: 1,
    finalizationGraceMs: 25_000,
  }
}

type RuntimeMessage =
  | { role: 'user' | 'assistant'; content: string; toolCalls?: AgentToolCall[]; reasoningContent?: string }
  | { role: 'tool'; content: string; toolCallId: string; toolName: string }

type ProviderInvoke = (request: {
  endpoint: string
  body: unknown
  timeoutMs: number
  onTextDelta?: (delta: string) => void
}) => Promise<unknown>

export type TutorAgentRuntimeInput = {
  baseUrl: string
  model: string
  mode: TutorMode
  messages: TutorContextMessage[]
  toolChoice: TutorToolChoice
  selectionContext?: string
  activeArtifactContext?: {
    kind: 'lecture' | 'practice' | 'source'
    ref: string
    title: string
    projectId?: number
  }
  learningTaskContext?: LearningTaskTutorContext
  learningPlanContext?: LearningPlanTutorContext
  learnerPathState?: LearnerPathState
  taskQueue?: AgentTaskQueueItem[]
  knowledgeDomains?: AgentKnowledgeDomain[]
  formalLearnerContext?: unknown
  formalWorkspaceContext?: unknown
  formalDomainKnowledgeContext?: unknown
  formalReviewContext?: unknown
  formalProjectContext?: AgentProjectContext
  /** Authoritative scope from the current request; project context loading is best-effort. */
  formalProjectId?: number
  formalCheckpointId?: number
  conversationId?: string
  sheetId?: string
  formalSessionId?: number
  referencedPluginObjects?: LearnFlowPluginObject[]
  backendBase?: string
  requestCookie?: string
  generate: TutorAgentToolRuntimeOptions['generate']
  searchConfiguration?: SearchProviderConfiguration
  invokeProvider: ProviderInvoke
  executeTool?: (
    name: string,
    args: Record<string, unknown>,
    options: TutorAgentToolRuntimeOptions,
    meta?: { callId?: string; sequence?: number; sourceUrls?: string[]; searchSources?: SearchSource[]; videoCandidates?: LearningVideoCandidate[] },
  ) => Promise<TutorAgentToolExecution>
  pluginRegistry?: LearnFlowPluginRegistry
  activePluginIds?: string[]
  generationConfig?: TutorAgentGenerationConfig
  observe?: (event: AgentTurnStreamEvent) => void
}

function turnId() {
  return `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function compactDecisionText(value: unknown, fallback: string, limit = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return (text || fallback).slice(0, limit)
}

function toolDecisionReason(call: AgentToolCall, definitions: AgentToolDefinition[] = TUTOR_AGENT_TOOL_DEFINITIONS) {
  const reasons: Record<string, string> = {
    read_learner_context: '先确认与当前问题相关的基础、目标和已记录学习线索，避免使用不合适的讲法',
    read_learning_workspace: '先确认当前任务、练习、错题和复习位置，避免脱离正在进行的学习现场',
    read_project_workspace: '先读取当前项目目标、关卡和来源范围，保证回答只服务于这个项目',
    read_project_roadmap: '先核对项目关卡图与当前位置，再决定是否调整尚未学习的部分',
    read_project_sources: '先核对项目已接入的来源，避免重复搜索或引用项目外材料',
    read_active_learning_file: '先读取当前纸张中的讲义或练习锚点，让回答延续正在看的内容',
    read_domain_knowledge: '先从本对话资料中取得带来源的上下文，再判断是否仍需联网',
    read_review_context: '先读取复习与错题状态，再安排本轮回忆或纠错动作',
    lookup_learning_path_node: '先精确匹配正式学习路径节点，避免把相近课程误当成目标',
    search_learning_path_graph: '精确匹配不足，转为模糊读取学习路径候选与关系',
    search_computer_knowledge: '现有上下文不足以支撑可靠讲解，补充计算机领域的高质量来源',
    read_web_evidence: '搜索摘要不足以直接支撑结论，继续读取候选页面中的相关原文',
    search_learning_videos: '当前目标适合演示或分步讲解，先取得可用的视频候选',
    inspect_learning_video: '标题和热度不能证明内容适合学习，继续用字幕与时间点核验覆盖',
    generate_dynamic_practice: '当前学习动作需要可作答的检测，因此生成受任务约束的练习文件',
    generate_similar_practice: '需要检查迁移而不是重复原题，因此生成同构但不相同的练习',
    inspect_practice_quality: '题目投入学习前先检查结构、答案确定性和目标覆盖',
    generate_learning_lecture: '当前概念需要一份可留存、可作为纸张展开的讲义',
    generate_learning_diagram: '文字不足以同时表达当前对象与关系，因此补充一张可检查的结构图解',
    generate_learning_animation: '当前机制包含不可交换的状态变化，因此用可暂停的逐帧动画呈现',
  }
  const definition = definitions.find(tool => tool.name === call.name)
  return compactDecisionText(reasons[call.name], `为完成当前学习动作，调用“${definition?.title || call.name}”取得结构化观察`)
}

function pluginActivation(input: TutorAgentRuntimeInput): PluginActivationContext {
  return {
    mode: input.mode,
    activePluginIds: stickyConversationPluginIds(
      input.activePluginIds,
      lockedConversationPluginIds({ messages: input.messages }),
    ),
    projectId: input.formalProjectId || input.formalProjectContext?.project?.id,
    checkpointId: input.formalCheckpointId || input.formalProjectContext?.checkpoint_id || undefined,
  }
}

const PROJECT_PLUGIN_INTEGRATION_OPERATIONS = {
  learning_task_conversion: {
    create_candidate: { method: 'POST', suffix: '' },
    read_candidate: { method: 'GET', suffix: '' },
    inspect_evidence: { method: 'GET', suffix: '/evidence' },
    audit_candidate: { method: 'GET', suffix: '/audit' },
    prepare_handoff: { method: 'GET', suffix: '/handoff' },
    confirm_candidate: { method: 'POST', suffix: '/confirm' },
  },
} as const

export function projectPluginIntegrationRequestBody(
  route: { method: 'GET' | 'POST'; suffix: string },
  body: Record<string, unknown>,
) {
  if (route.method !== 'POST' || !route.suffix) return body
  // Candidate operations address the candidate in the URL. The backend
  // confirmation contract forbids unknown JSON fields, so the routing-only
  // candidateId must not be duplicated in the request body.
  const { candidateId: _candidateId, ...requestBody } = body
  return requestBody
}

async function requestProjectPluginIntegration(options: {
  input: TutorAgentRuntimeInput
  pluginId: string
  operation: string
  payload?: unknown
  signal: AbortSignal
}) {
  const projectId = options.input.formalProjectContext?.project?.id
  if (!projectId) throw new Error('plugin_integration_error:project_required:当前插件操作需要项目作用域')
  if (!options.input.backendBase) throw new Error('plugin_integration_error:backend_unavailable:LearnFlow 后端地址不可用')
  const pluginRoutes = PROJECT_PLUGIN_INTEGRATION_OPERATIONS[
    options.pluginId as keyof typeof PROJECT_PLUGIN_INTEGRATION_OPERATIONS
  ] as Record<string, { method: 'GET' | 'POST'; suffix: string }> | undefined
  const route = pluginRoutes?.[options.operation]
  if (!route) throw new Error('plugin_integration_error:operation_forbidden:插件请求了未授权的项目集成操作')
  const body = options.payload && typeof options.payload === 'object' && !Array.isArray(options.payload)
    ? options.payload as Record<string, unknown> : {}
  const candidateId = typeof body.candidateId === 'string' && /^ltc_[A-Za-z0-9_-]{1,72}$/.test(body.candidateId)
    ? body.candidateId : ''
  if ((route.method === 'GET' || route.suffix) && !candidateId) {
    throw new Error('plugin_integration_error:candidate_id_required:候选操作缺少 candidateId')
  }
  const basePath = `/api/projects/${projectId}/integrations/xingchen/learning-task-candidates`
  const path = route.method === 'POST' && !route.suffix
    ? basePath
    : `${basePath}/${encodeURIComponent(candidateId)}${route.suffix}`
  let csrfToken = ''
  if (route.method === 'POST') {
    const csrfResponse = await fetch(`${options.input.backendBase}/api/auth/csrf`, {
      headers: options.input.requestCookie ? { Cookie: options.input.requestCookie } : {},
      signal: options.signal,
    })
    const csrfBody = await csrfResponse.json().catch(() => ({})) as Record<string, unknown>
    csrfToken = typeof csrfBody.csrf_token === 'string' ? csrfBody.csrf_token : ''
    if (!csrfResponse.ok || !csrfToken) {
      throw new Error(`plugin_integration_error:csrf_unavailable:无法取得项目集成写请求所需的 CSRF 令牌`)
    }
  }
  const response = await fetch(`${options.input.backendBase}${path}`, {
    method: route.method,
    headers: {
      ...(route.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      ...(options.input.requestCookie ? { Cookie: options.input.requestCookie } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    ...(route.method === 'POST' ? { body: JSON.stringify(projectPluginIntegrationRequestBody(route, body)) } : {}),
    signal: options.signal,
  })
  const text = await response.text()
  let result: unknown = null
  try {
    result = JSON.parse(text)
  } catch {
    result = { detail: { code: 'invalid_backend_response', message: text.slice(0, 500) } }
  }
  if (!response.ok) {
    const detail = result && typeof result === 'object'
      ? (result as Record<string, any>).detail || result : {}
    const code = String(detail?.code || `http_${response.status}`).slice(0, 100)
    const message = String(detail?.message || '项目集成请求失败').slice(0, 500)
    throw new Error(`plugin_integration_error:${code}:${message}`)
  }
  return result as any
}

function runtimeToolDefinitions(input: TutorAgentRuntimeInput) {
  const pluginTools = input.pluginRegistry?.toolDefinitions(pluginActivation(input)) || []
  return [
    ...pluginTools,
    ...TUTOR_AGENT_TOOL_DEFINITIONS,
  ]
}

function toolDecisionNextAction(run: TutorToolRun) {
  if (run.status === 'failed') return '保留失败原因，调整工具路线；最终回答必须透明说明仍存在的缺口'
  if (run.kind === 'file' || run.learningFile) return '把文件作为当前对话的学习对象，并继续决定阅读、练习或验证动作'
  if (run.kind === 'search') return '把来源与证据覆盖回灌给 Tutor，再判断是否需要读取原文或形成讲解'
  return '把这条结构化观察回灌给 Tutor，继续选择下一个学习动作或形成回答'
}

function deterministicTutorFallback(input: TutorAgentRuntimeInput, runs: TutorToolRun[]) {
  const failedRuns = runs.filter(run => run.status === 'failed')
  const failureNote = failedRuns.length
    ? `\n\n本轮有 ${failedRuns.length} 个工具没有成功（${failedRuns.map(run => run.title).join('、')}），我不会用猜测补齐这些缺口。`
    : ''
  if (input.mode === 'guided_learning' && input.learningTaskContext) {
    const task = input.learningTaskContext
    if (task.skillId === 'learning_file_study' && task.stepId === 'selecting_learning_artifact') {
      const hasExistingFile = runs.some(run => run.learningFile)
      const hasProposal = runs.some(run => run.projectLearningFileProposal)
      const handoff = hasExistingFile
        ? '我已经把现有的完整学习文件放在本轮卡片里；打开后，我们从第一处阅读锚点开始。'
        : hasProposal
          ? '本轮确认卡会生成完整讲义与练习；确认后，主要学习会在文件纸张中进行。'
          : '当前还没有可打开的正式学习文件；我会保留任务位置，等文件可用后从讲义开始。'
      return `先抓住一个起点：${task.objective}会被拆成“核心概念、最小例子、正式练习”三部分。${handoff}${failureNote}`
    }
    const formalPrompt = task.authority === 'formal_learning_task' && task.stepInstruction.trim()
      ? task.stepInstruction.trim()
      : ''
    const nextPrompt = formalPrompt || `当前来到“${task.stepTitle}”。请先说出你已经能确认的一点，或者直接指出卡住的位置；我会从你的回答继续推进，而不要求你手动切换步骤。`
    return `我们保留当前学习进度，继续完成「${task.objective}」。\n\n${nextPrompt}${failureNote}`
  }
  if (input.mode === 'learning_plan') {
    return `这轮模型正文没有稳定返回，但已经取得的观察会保留。请先确认你最想达成的产物或方向，我会从该目标继续收紧路线。${failureNote}`
  }
  return `这轮模型正文没有稳定返回，已保留工具观察和上下文。你可以直接继续追问，我会从当前位置重试。${failureNote}`
}

export function repairTutorDraftForObservedGaps(reply: string, runs: TutorToolRun[]) {
  let repaired = ensureSearchCitations(reply, runs).trim()
  if (!repaired) return repaired

  const unresolvedFailures = runs.filter(run => (
    run.status === 'failed'
    && !runs.some(candidate => (
      (run.toolName ? candidate.toolName === run.toolName : candidate.kind === run.kind)
      && candidate.status === 'completed'
    ))
  ))
  if (
    unresolvedFailures.length
    && !/(?:失败|暂时|无法|未能|没有拿到|资料缺口|证据不足|连接问题)/i.test(repaired)
  ) {
    const titles = [...new Set(unresolvedFailures.map(run => run.title))].slice(0, 3).join('、')
    repaired += `\n\n说明：本轮“${titles}”暂时未能成功，因此我先用已经取得的可靠观察完成这一教学动作，不把缺失产物冒充为已生成。`
  }

  const searched = runs.some(run => run.kind === 'search' && run.status === 'completed' && run.sources?.length)
  if (searched) {
    const citationAudit = auditSearchCitations(repaired, runs)
    if (citationAudit.evidenceGap && !citationAudit.acknowledgesGap) {
      repaired += '\n\n检索说明：本轮资料覆盖仍有缺口，以上只采用已经读取到的来源支撑核心辨析，不把未覆盖内容当作检索结论。'
    }
  }

  const pendingLearningFiles = runs.some(run => run.projectLearningFileProposal)
    && !runs.some(run => run.status === 'completed' && Boolean(run.learningFile))
  if (pendingLearningFiles && /(?:打开|进入|阅读|查看)(?:这|该|刚才)?(?:份|个)?(?:讲义|练习|学习文件)|(?:讲义|练习|学习文件)(?:已经|已)(?:生成|准备|放入|加入)/i.test(repaired)) {
    repaired = repaired.replace(
      /(?:你可以|请|现在)?(?:先)?(?:打开|进入|阅读|查看)(?:这|该|刚才)?(?:份|个)?(?:讲义|练习|学习文件)[^。！？!?\n]*[。！？!?]?/gi,
      '',
    ).trim()
    repaired += '\n\n讲义与练习目前只是待确认的生成提案，尚未生成；确认卡成功完成后，我再从文件中的第一个锚点继续带你学习。'
  }

  const pluginGroundingDisclosures = runs.flatMap(run => {
    const payload = run.plugin?.result.payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
    const grounding = (payload as Record<string, unknown>).grounding
    if (!grounding || typeof grounding !== 'object' || Array.isArray(grounding)) return []
    const disclosure = (grounding as Record<string, unknown>).requiredDisclosure
    return typeof disclosure === 'string' && disclosure.trim() ? [disclosure.trim()] : []
  })
  if (pluginGroundingDisclosures.length && !/(?:固定快照|数据快照|事实版本|非岗位快照|非插件结论)/i.test(repaired)) {
    repaired += `\n\n事实边界：${pluginGroundingDisclosures[0]}`
  }

  return repaired
}

function structurallyCompact(value: unknown, depth = 0, tight = false): unknown {
  if (typeof value === 'string') {
    const max = tight ? 320 : 1600
    return value.length > max ? `${value.slice(0, max - 1)}…` : value
  }
  if (value === null || typeof value !== 'object') return value
  if (depth >= (tight ? 4 : 7)) return { omitted: true, reason: 'depth_budget' }
  if (Array.isArray(value)) {
    const max = tight ? 8 : 24
    const items = value.slice(0, max).map(item => structurallyCompact(item, depth + 1, tight))
    return value.length > max ? [...items, { omittedItems: value.length - max }] : items
  }
  const entries = Object.entries(value as Record<string, unknown>)
  const max = tight ? 24 : 60
  const result = Object.fromEntries(entries.slice(0, max).map(([key, item]) => [
    key,
    structurallyCompact(item, depth + 1, tight),
  ]))
  if (entries.length > max) result.__omittedFields = entries.length - max
  return result
}

function safeJson(value: unknown, limit = 18_000) {
  const normal = JSON.stringify(structurallyCompact(value))
  if (normal.length <= limit) return normal
  const tight = JSON.stringify(structurallyCompact(value, 0, true))
  if (tight.length <= limit) return tight
  return JSON.stringify({
    truncated: true,
    reason: 'context_budget',
    topLevelKeys: value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).slice(0, 80) : [],
  })
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return { __invalid_arguments: value.slice(0, 600) }
  }
}

export function toolCallsFromProviderResponse(payload: unknown): AgentToolCall[] {
  if (!payload || typeof payload !== 'object') return []
  const root = payload as Record<string, any>
  const result: AgentToolCall[] = []
  const choice = Array.isArray(root.choices) ? root.choices[0] : undefined
  const message = choice?.message && typeof choice.message === 'object' ? choice.message : undefined
  for (const raw of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
    const fn = raw?.function && typeof raw.function === 'object' ? raw.function : {}
    if (!fn.name) continue
    result.push({
      id: String(raw.id || `call-${result.length + 1}`),
      name: String(fn.name),
      arguments: parseArguments(fn.arguments),
    })
  }
  for (const raw of Array.isArray(root.output) ? root.output : []) {
    if (!raw || typeof raw !== 'object' || raw.type !== 'function_call' || !raw.name) continue
    result.push({
      id: String(raw.call_id || raw.id || `call-${result.length + 1}`),
      name: String(raw.name),
      arguments: parseArguments(raw.arguments),
    })
  }
  return result
}

export function reasoningContentFromProviderResponse(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const root = payload as Record<string, any>
  const choice = Array.isArray(root.choices) ? root.choices[0] : undefined
  const reasoningContent = choice?.message?.reasoning_content
  return typeof reasoningContent === 'string' ? reasoningContent : ''
}

function chatToolDefinitions(tools: AgentToolDefinition[]) {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: `${tool.description} [${tool.toolClass}; ${tool.risk}]`,
      parameters: tool.inputSchema,
    },
  }))
}

function responsesToolDefinitions(tools: AgentToolDefinition[]) {
  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: `${tool.description} [${tool.toolClass}; ${tool.risk}]`,
    parameters: tool.inputSchema,
  }))
}

function providerInput(messages: RuntimeMessage[]) {
  const input: Array<Record<string, unknown>> = []
  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content })
      continue
    }
    if (message.toolCalls?.length) {
      for (const call of message.toolCalls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        })
      }
      if (message.content.trim()) input.push({ role: 'assistant', content: message.content })
      continue
    }
    input.push({ role: message.role, content: message.content })
  }
  return input
}

function chatMessages(instructions: string, messages: RuntimeMessage[]) {
  return [
    { role: 'system', content: instructions },
    ...messages.map(message => {
      if (message.role === 'tool') {
        return { role: 'tool', tool_call_id: message.toolCallId, name: message.toolName, content: message.content }
      }
      if (message.toolCalls?.length) {
        return {
          role: 'assistant',
          content: message.content || null,
          ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
          tool_calls: message.toolCalls.map(call => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        }
      }
      return {
        role: message.role,
        content: message.content,
        ...(message.role === 'assistant' && message.reasoningContent
          ? { reasoning_content: message.reasoningContent }
          : {}),
      }
    }),
  ]
}

export function buildAgentProviderRequest(options: {
  baseUrl: string
  model: string
  instructions: string
  messages: RuntimeMessage[]
  tools: AgentToolDefinition[]
  includeTools: boolean
  responseFormat?: 'json_object'
  maxOutputTokens?: number
}) {
  const endpoint = endpointFor(options.baseUrl)
  const responsesApi = endpoint.endsWith('/responses')
  if (responsesApi) {
    return {
      endpoint,
      body: {
        model: options.model,
        instructions: options.instructions,
        input: providerInput(options.messages),
        max_output_tokens: options.maxOutputTokens || 6_000,
        ...(options.responseFormat ? { text: { format: { type: options.responseFormat } } } : {}),
        ...(options.includeTools ? { tools: responsesToolDefinitions(options.tools), tool_choice: 'auto' } : {}),
      },
    }
  }
  return {
    endpoint,
    body: {
      model: options.model,
      messages: chatMessages(options.instructions, options.messages),
      max_tokens: options.maxOutputTokens || 6_000,
      ...(options.responseFormat ? { response_format: { type: options.responseFormat } } : {}),
      ...(options.includeTools ? { tools: chatToolDefinitions(options.tools), tool_choice: 'auto' } : {}),
    },
  }
}

function compactPriorRuns(messages: TutorContextMessage[]) {
  return messages.flatMap(message => message.toolRuns || []).slice(-8).map(run => ({
    id: run.id,
    toolName: run.toolName,
    kind: run.kind,
    status: run.status,
    detail: run.detail.slice(0, 360),
    observationSummary: run.observationSummary,
    ...(run.plugin ? {
      plugin: {
        pluginId: run.plugin.pluginId,
        toolId: run.plugin.toolId,
        result: {
          summary: run.plugin.result.summary.slice(0, 500),
          presentation: run.plugin.result.presentation,
          objects: (run.plugin.result.objects || []).slice(0, 16).map(object => ({
            protocol: object.protocol,
            pluginId: object.pluginId,
            objectType: object.objectType,
            objectId: object.objectId,
            schemaVersion: object.schemaVersion,
            label: object.label,
            value: object.value,
          })),
        },
      },
    } : {}),
  })) as TutorToolRun[]
}

function envelopePrompt(envelope: AgentContextEnvelope, limits: {
  envelopeChars?: number
  observationChars?: number
  observationTotalChars?: number
} = {}) {
  const envelopeChars = limits.envelopeChars || 12_000
  const observationChars = limits.observationChars || 5_000
  const observationTotalChars = limits.observationTotalChars || 24_000
  const observationDetails = envelope.observations
    .map((observation, index) => [
      `### 观察 ${index + 1} · ${observation.source}`,
      safeJson(observation.data, observationChars),
    ].join('\n'))
    .join('\n')
    .slice(0, observationTotalChars)
  const envelopeSummary = {
    ...envelope,
    observations: envelope.observations.map(observation => ({ ...observation, data: undefined })),
  }
  return [
    '## 本轮 Agent ContextEnvelope',
    '这是 Harness 提供的有界运行状态，不是新的长期记忆权威。',
    safeJson(envelopeSummary, envelopeChars),
    observationDetails ? '\n## 宿主预取的结构化观察\n这些观察由 Harness 直接提供，不是模型曾经发出的工具调用。\n' : '',
    observationDetails,
    '',
    '## 工具策略',
    '只有需要外部观察时才调用工具。可以连续调用不同读取工具，但不得重复相同调用。',
    '读取工具可自主调用；项目路线和文件工具只产生 learner-visible proposal，绝不直接写入。',
    '联网搜索先用 search_computer_knowledge 取得候选证据、覆盖缺口和来源状态；需要据此陈述精确机制、版本行为、日期、数值或排错结论时，再用 read_web_evidence 读取最相关的 1-3 个候选页面。搜索摘要不等于已读全文。',
    '视频推荐先用 search_learning_videos 取得 discovered 候选；推荐前必须用 inspect_learning_video 核验本轮候选的字幕、时间点、目标覆盖和内容缺口。元数据、播放量、搜索或观看都不是掌握证据；metadata_only 候选只能标为待核验。',
    envelope.current.learningTask?.skillId === 'learning_file_study'
      ? '当前是文件共学：聊天只做不超过一个短段落的直接导入，再把主体交给完整讲义与练习。不要在聊天中展开完整课程、资源清单或多选菜单；Harness 已负责复用文件或提供生成确认卡。只有学习者明确要求外部资源，或 DomainKnowledgePacket 显示关键覆盖、时效或冲突缺口时，才可搜索网页；视频仍需学习者明确要求。'
      : '',
    'quick 只用于单一事实，standard 用于普通讲解、比较、实现与排错，deep 只用于论文综述、项目调研或多来源复杂决策。deep 仍有查询、页面和补搜预算，不能无限研究。',
    '搜索或读取返回 partial、empty、coverage gaps、circuit_open 时必须在回答中显式保留证据缺口；不得用模型常识伪装成已检索证据。',
    '评估目标、题型组合或成功条件不清时，先调用 design_assessment_blueprint；它返回可检查的蓝图与确定性量表，但不评分。动态习题工具只可在带领学习态且绑定正式 LearningTask/Checkpoint 时调用；生成题目是零目标 artifact 事件，不得声称形成掌握。需要动态练习、诊断或变式验证时，可生成正式练习文件，再让学习者在答案安全工作台提交。',
    '处于项目 scope 时，所有规划、来源选择、讲义与练习都必须锚定 envelope.scope.projectId 对应的项目主题；不得偷换为通用课程规划。',
    '若学习者观察中存在 Claim 冲突，必须明确说明冲突并把纠正留给学习者确认；不得静默选择一边或声称已经改写画像。',
    '若工作区观察含 sourceConstraint，路线和讲解必须受当前项目来源覆盖范围约束；超出范围只能标为资料缺口，并在检索到新证据后补充。',
    '工作区中没有 Attempt 只表示当前作用域没有可见记录，不能推断学生第一次学习、从未练习或没有相关经历。',
    '学习路径必须先调用 lookup_learning_path_node 做精确读取；只有它未命中、存在错别字/近义表达或候选歧义时才调用 search_learning_path_graph。模糊结果为 ambiguous 时应呈现候选让学习者选择，不能直接形成路线。只有模糊检索明确返回 graph_gap 且联网来源已取得后，才可调用 propose_personal_path_node；提案绝不等于已写入。',
    '工具失败时先依据错误类型决定重试、换工具或明确告知缺口。拿到足够证据后直接回答。',
  ].join('\n')
}

function compactToolDefinitions(tools: AgentToolDefinition[], descriptionLimit: number) {
  return tools.map(tool => tool.description.length <= descriptionLimit ? tool : {
    ...tool,
    description: `${tool.description.slice(0, Math.max(1, descriptionLimit - 1)).trimEnd()}…`,
  })
}

function hasExplicitExternalResourceRequest(input: TutorAgentRuntimeInput) {
  const message = [...input.messages].reverse().find(item => item.role === 'user')?.content || ''
  return input.toolChoice !== 'auto'
    || /(?:联网|搜索|查找|检索|资料|资源|教材|课程推荐|视频|b站|bilibili|youtube|来源|论文|文档|仓库|官网|最新)/i.test(message)
}

function compactKnowledgeGate(input: TutorAgentRuntimeInput) {
  const personal = input.formalDomainKnowledgeContext && typeof input.formalDomainKnowledgeContext === 'object'
    ? (input.formalDomainKnowledgeContext as any).domain_knowledge_packet : null
  const project = input.formalProjectContext?.domain_knowledge_packet
  const packet = project || personal
  const observed = Boolean(input.formalProjectContext || input.formalDomainKnowledgeContext)
  if (!packet || typeof packet !== 'object') return { observed, status: 'unavailable', gaps: ['missing_packet'], conflicts: 0 }
  return {
    observed: true,
    status: String((packet as any).status || 'unavailable'),
    gaps: Array.isArray((packet as any).unresolved_gaps) ? (packet as any).unresolved_gaps : [],
    conflicts: Array.isArray((packet as any).conflicts) ? (packet as any).conflicts.length : 0,
  }
}

function shouldAutoSupplementKnowledge(input: TutorAgentRuntimeInput, message: string) {
  if (!['simple_explain', 'guided_learning', 'learning_plan'].includes(input.mode)) return false
  const gate = compactKnowledgeGate(input)
  const currentRisk = /(?:最新|当前版本|截至|论文|政策|价格|行业现状|发布|变更|迁移|精确数值|官方行为)/i.test(message)
  const correction = /(?:不对|错了|过时|不准确|重新核验|来源冲突)/i.test(message)
  if (input.activeArtifactContext && !currentRisk && !correction) return false
  return currentRisk || correction
    || gate.observed && (
      !['ready', 'ready_with_gaps'].includes(gate.status)
      || gate.gaps.length > 0 || gate.conflicts > 0
    )
}

function availableTools(input: TutorAgentRuntimeInput) {
  const projectTutor = input.formalProjectContext?.tool_policy?.roadmap_tool_access === 'project_tutor'
  const latestMessage = [...input.messages].reverse().find(item => item.role === 'user')?.content || ''
  const visualIntent = resolveExplicitVisualIntent(input.toolChoice, latestMessage)
  const coreTools = TUTOR_AGENT_TOOL_DEFINITIONS.filter(tool => (
    (!['lookup_learning_path_node', 'search_learning_path_graph', 'propose_personal_path_node'].includes(tool.name) || Boolean(input.learnerPathState))
    && (tool.name !== 'read_domain_knowledge' || Boolean(input.formalDomainKnowledgeContext))
    && (tool.name !== 'read_review_context' || Boolean(input.formalReviewContext))
    && (tool.name !== 'read_active_learning_file' || Boolean(input.activeArtifactContext))
    && (!tool.name.startsWith('read_project_') || Boolean(input.formalProjectContext))
    && (tool.name !== 'read_project_roadmap' || projectTutor)
    && (tool.name !== 'propose_project_roadmap' || projectTutor && input.mode === 'learning_plan')
    && (tool.name !== 'propose_project_learning_files' || Boolean(input.formalProjectContext) && input.mode === 'guided_learning')
    && (!['design_assessment_blueprint', 'generate_dynamic_practice', 'generate_similar_practice'].includes(tool.name)
      || Boolean(input.formalProjectContext?.checkpoint_id) && input.mode === 'guided_learning' && Boolean(input.learningTaskContext))
    && (tool.name !== 'inspect_practice_quality' || Boolean(input.formalProjectContext) && input.mode === 'guided_learning')
    && (tool.name !== 'generate_learning_diagram' || visualIntent === 'diagram')
    && (tool.name !== 'generate_learning_animation' || visualIntent === 'animation')
  ))
  const pluginTools = input.pluginRegistry?.toolDefinitions(pluginActivation(input)) || []
  const tools = [...pluginTools, ...coreTools]
  if (visualIntent !== 'none') {
    const visualToolName = visualIntent === 'animation' ? 'generate_learning_animation' : 'generate_learning_diagram'
    return tools.filter(tool => tool.name === visualToolName)
  }
  const fileStudy = input.mode === 'guided_learning' && input.learningTaskContext?.skillId === 'learning_file_study'
  if (!fileStudy || hasExplicitExternalResourceRequest(input)) return tools
  const gate = compactKnowledgeGate(input)
  const knowledgeSupplementNeeded = gate.observed && (
    !['ready', 'ready_with_gaps'].includes(gate.status) || gate.gaps.length > 0 || gate.conflicts > 0
  )
  const allowed = new Set([
    'read_domain_knowledge', 'read_project_sources',
  ])
  if (visualIntent === 'diagram') allowed.add('generate_learning_diagram')
  if (visualIntent === 'animation') allowed.add('generate_learning_animation')
  if (knowledgeSupplementNeeded) {
    allowed.add('search_computer_knowledge')
    allowed.add('read_web_evidence')
  }
  if (input.learningTaskContext?.stepId === 'practicing_in_file') {
    allowed.add('design_assessment_blueprint')
    allowed.add('generate_dynamic_practice')
    allowed.add('generate_similar_practice')
    allowed.add('inspect_practice_quality')
  }
  return tools.filter(tool => allowed.has(tool.name) || Boolean(input.pluginRegistry?.resolveTool(tool.name, pluginActivation(input))))
}

function explicitToolCall(choice: TutorToolChoice, message: string, projectScoped = false): AgentToolCall | undefined {
  if (choice === 'auto') return undefined
  if (choice === 'domain') return {
    id: `explicit-domain-${Date.now()}`,
    name: projectScoped ? 'read_project_sources' : 'read_domain_knowledge',
    arguments: { query: message },
  }
  if (choice === 'search') return {
    id: `explicit-search-${Date.now()}`,
    name: /视频|课程视频|b站|bilibili|youtube/i.test(message) ? 'search_learning_videos' : 'search_computer_knowledge',
    arguments: /视频|课程视频|b站|bilibili|youtube/i.test(message)
      ? { target: message, platforms: /b站|bilibili/i.test(message) ? ['bilibili'] : /youtube/i.test(message) ? ['youtube'] : ['bilibili', 'youtube'], max_results: 6 }
      : { query: message, depth: /深度研究|系统调研|文献综述|研究综述|多来源|全面研究|deep research/i.test(message) ? 'deep' : 'standard' },
  }
  return {
    id: `explicit-visual-${Date.now()}`,
    name: choice === 'animation' ? 'generate_learning_animation' : 'generate_learning_diagram',
    arguments: { query: message },
  }
}

export function directLearningTaskIntakeRequest(
  activePluginIds: readonly string[] | undefined,
  _projectId: number | undefined,
  message: string,
  referencedPluginObjects: readonly LearnFlowPluginObject[] = [],
  mode?: TutorMode,
) {
  // Conversation plugins stay enabled so historical tool results can be
  // replayed. Once a formal lesson starts, that sticky activation must not
  // reinterpret ordinary learner answers as fresh WF03 conversion requests.
  if (mode === 'guided_learning') return undefined
  // Preparing and clarifying a WF03 task is conversation-scoped. Requiring a
  // project here made the explicitly selected plugin silently fall back to
  // Tutor's generic tools in a new/global conversation.
  if (!activePluginIds?.includes('learning_task_conversion')) return undefined
  const referencedTasks = referencedPluginObjects.flatMap(object => {
    const value = object.value && typeof object.value === 'object' && !Array.isArray(object.value)
      ? object.value as Record<string, unknown> : {}
    const data = value.data && typeof value.data === 'object' && !Array.isArray(value.data)
      ? value.data as Record<string, unknown> : {}
    const category = String(value.category || data.type || data.kind || '')
    if (category !== 'task') return []
    const title = String(object.label || data.label || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    if (title.length < 2) return []
    const description = String(data.summary || data.description || '')
      .replace(/\s+/g, ' ').trim().slice(0, 2_000)
    return [{
      id: object.objectId,
      title,
      description,
      source: 'role_package' as const,
      sourceRef: pluginObjectReferenceUri(object),
    }]
  })
  if (referencedTasks.length === 1) {
    const task = referencedTasks[0]
    return {
      rawInput: task.title,
      taskDescription: task.description,
      candidateTasks: [task],
      selectedTaskTitle: task.title,
      selectedTaskDescription: task.description,
    }
  }
  const quoted = message.match(/[“"]([^”"]{2,300})[”"]/)?.[1]?.trim()
  const normalized = message.replace(/^(?:请|帮我|请帮我|麻烦你)?\s*/i, '').trim()
  if (/^(?:生成|转化|转换|创建)(?:一个|一份)?(?:学习型任务|学习任务)[。！!？?]*$/i.test(normalized)) {
    return undefined
  }
  if (/(?:解释|介绍|说明).{0,12}(?:学习型任务|这个插件)|(?:学习型任务|这个插件).{0,12}(?:是什么|怎么用|有何作用)/i.test(normalized)) {
    return undefined
  }
  // Once a candidate exists, review/audit/handoff prompts belong to Tutor's
  // ordinary tool-selection loop.  Treating them as a fresh intake would run
  // the semantic preflight again and hide the candidate operation the learner
  // explicitly requested.
  if (
    /learning_task_conversion__(?:read_learning_task_candidate|inspect_learning_task_evidence|audit_learning_task_candidate|prepare_learning_handoff|confirm_learning_task_candidate)/i.test(normalized)
    || /(?:检查|审计|审阅|复核).{0,24}候选\s+ltc_/i.test(normalized)
    || /候选\s+ltc_.{0,40}(?:来源证据|grounding|审阅包|交接包|确定性校验)/i.test(normalized)
  ) {
    return undefined
  }
  const taskAfterIntent = normalized.match(
    /^(?:为我|给我)?\s*(?:转化|转换|生成|拆解)(?:一个|一份)?(?:学习型任务|学习任务|学习步骤|可验收步骤)\s*[：:,，;；\s]+(.{2,300})$/i,
  )?.[1]?.trim()
  const taskBeforeIntent = normalized.match(
    /^(?:把|将)?\s*(.{2,300}?)\s*(?:转化|转换|生成|拆解)(?:为|成)?(?:一个|一份)?(?:学习型任务|学习任务|学习步骤|可验收步骤)\s*$/i,
  )?.[1]?.trim()
  // Selecting this plugin is the user's routing decision, like choosing a
  // Codex plugin for the next message.  Do not require them to repeat a
  // command such as “生成学习型任务”; plain task/role/topic text goes through
  // the same semantic preflight and confirmation gates.
  const taskTitle = (quoted || taskAfterIntent || taskBeforeIntent || normalized).slice(0, 300)
  if (taskTitle.length < 2) return undefined
  return {
    rawInput: taskTitle,
    taskDescription: message.slice(0, 2_000),
  }
}

export function directLearningTaskDraftConfirmationRequest(
  activePluginIds: readonly string[] | undefined,
  projectId: number | undefined,
  message: string,
) {
  if (!projectId || !activePluginIds?.includes('learning_task_conversion')) return undefined
  return parseLearningTaskDraftConfirmation(message)
}

export function directLearningTaskCandidateOperationRequest(
  activePluginIds: readonly string[] | undefined,
  projectId: number | undefined,
  message: string,
): { toolName: string; arguments: Record<string, unknown> } | undefined {
  if (!projectId || !activePluginIds?.includes('learning_task_conversion')) return undefined
  const candidateId = message.match(/\b(ltc_[a-z0-9]+)\b/i)?.[1]
  if (!candidateId) return undefined
  if (/learning_task_conversion__inspect_learning_task_evidence|检查.{0,12}(?:来源|证据)|来源证据|grounding/i.test(message)) {
    return {
      toolName: 'learning_task_conversion__inspect_learning_task_evidence',
      arguments: { candidateId },
    }
  }
  if (/learning_task_conversion__audit_learning_task_candidate|(?:重新)?审计|确定性校验/i.test(message)) {
    return {
      toolName: 'learning_task_conversion__audit_learning_task_candidate',
      arguments: { candidateId },
    }
  }
  if (/learning_task_conversion__prepare_learning_handoff|Tutor\s*审阅|审阅包|交接包/i.test(message)) {
    return {
      toolName: 'learning_task_conversion__prepare_learning_handoff',
      arguments: { candidateId },
    }
  }
  const expectedRootHash = message.match(/(?:rootHash|expectedRootHash)\s*[:：]?\s*([a-f0-9]{64})/i)?.[1]
  if (
    expectedRootHash
    && /learning_task_conversion__confirm_learning_task_candidate|确认.{0,16}(?:候选|正式任务)|创建正式(?:学习)?任务/i.test(message)
  ) {
    return {
      toolName: 'learning_task_conversion__confirm_learning_task_candidate',
      arguments: { candidateId, expectedRootHash, confirmed: true },
    }
  }
  return undefined
}

export function directLearningTaskCandidateSelectionRequest(
  activePluginIds: readonly string[] | undefined,
  _projectId: number | undefined,
  message: string,
  history: TutorContextMessage[],
) {
  if (!activePluginIds?.includes('learning_task_conversion')) return undefined
  const match = message.trim().match(
    /^生成学习型任务：[“"](.{2,300}?)[”"]（来源于[“"](.{2,500}?)[”"]的已选任务候选）$/,
  )
  if (!match) return undefined
  const [, selectedTitle, originalInput] = match
  for (const historyMessage of [...history].reverse()) {
    for (const run of [...(historyMessage.toolRuns || [])].reverse()) {
      if (run.plugin?.pluginId !== 'learning_task_conversion') continue
      const intakeObject = run.plugin.result.objects?.find(object => object.objectType === 'learning_task_intake')
      const intake = intakeObject?.value as Record<string, any> | undefined
      if (!intake || String(intake.originalInput) !== originalInput) continue
      const selected = Array.isArray(intake.candidateTasks)
        ? intake.candidateTasks.find((candidate: any) => String(candidate?.title) === selectedTitle)
        : undefined
      if (!selected) return undefined
      return {
        rawInput: originalInput,
        roleName: String(intake.roleName || ''),
        candidateTasks: [selected],
        selectedTaskTitle: selectedTitle,
        selectedTaskDescription: String(selected.description || ''),
        modelAssessment: intake.preflight?.method === 'semantic_model' ? {
          schemaVersion: String(intake.preflight.schemaVersion || 'learning-task-intake-model.v1'),
          model: String(intake.preflight.model || 'semantic-preflight'),
          assessedKind: String(intake.preflight.assessedKind || 'ambiguous'),
          confidence: Number(intake.preflight.confidence || 0),
          rationale: String(intake.preflight.rationale || ''),
          nextQuestion: '',
        } : undefined,
      }
    }
  }
  return undefined
}

export function verifyTutorTurnOutcome(options: {
  reply: string
  mode: TutorMode
  toolRuns: TutorToolRun[]
  learningTaskContext?: LearningTaskTutorContext
  observations?: AgentContextEnvelope['observations']
}) {
  const violations: string[] = []
  const reply = options.reply.trim()
  if (!isDisplayableTutorReply(reply)) violations.push('display_protocol')
  const hasUncommittedProposal = options.toolRuns.some(run => run.pathProposal || run.pathPlanProposal || run.projectRoadmapProposal || run.projectLearningFileProposal)
  if (
    hasUncommittedProposal
    && /(?:已经|已)[^。！!？?\n]{0,24}(?:保存|加入|写入|更新|创建)(?:了)?[^。！!？?\n]{0,20}(?:路径|节点|规划)/i.test(reply)
    && !/(?:尚未|没有|并未|等待|需要|只有.*确认)/i.test(reply)
  ) violations.push('unconfirmed_path_write_claim')
  const masteryClaim = /(?:你|这说明你)[^。！!？?\n]{0,18}(?:已经|已)?(?:完全|稳定|真正)?掌握/i.test(reply)
    && !/(?:尚未|还没|没有|未能|并未)[^。！!？?\n]{0,10}掌握/i.test(reply)
  if (
    (options.mode === 'guided_learning' || Boolean(options.learningTaskContext))
    && masteryClaim
  ) violations.push('unsupported_mastery_claim')
  const failedKeys = new Set(options.toolRuns.filter(run => run.status === 'failed').map(run => run.toolName || `kind:${run.kind}`))
  const unresolvedFailure = [...failedKeys].some(key => !options.toolRuns.some(run => (
    (run.toolName || `kind:${run.kind}`) === key && run.status === 'completed'
  )))
  if (unresolvedFailure && !/(?:失败|暂时|无法|未能|没有拿到|资料缺口|证据不足|连接问题)/i.test(reply)) {
    violations.push('hidden_tool_failure')
  }
  const searched = options.toolRuns.some(run => run.kind === 'search' && run.status === 'completed' && run.sources?.length)
  if (searched) {
    const citationAudit = auditSearchCitations(reply, options.toolRuns)
    const hasNonSearchSourceObservation = options.toolRuns.some(run => (
      run.status === 'completed'
      && run.kind !== 'search'
      && ['domain', 'project', 'file'].includes(run.kind)
    ))
    if (!citationAudit.citedAllowedUrls.length) violations.push('missing_search_citation')
    if (citationAudit.citationLikeUnknownUrls.length && !hasNonSearchSourceObservation) violations.push('unverified_search_citation')
    if (citationAudit.evidenceGap && !citationAudit.acknowledgesGap) violations.push('hidden_search_coverage_gap')
  }
  const learnerContext = options.observations?.find(observation => observation.source === 'read_learner_context')?.data
  const learnerConflicts = learnerContext && typeof learnerContext === 'object'
    ? (learnerContext as Record<string, unknown>).conflicts
    : undefined
  const hasLearnerConflict = Array.isArray(learnerConflicts) && learnerConflicts.length > 0
  const acknowledgesConflict = /(?:冲突|不一致|相互矛盾|需要你确认|请你确认|保留原记录|不会静默覆盖|纠正候选)/i.test(reply)
  if (hasLearnerConflict && !acknowledgesConflict) violations.push('silent_memory_conflict')
  const workspaceContext = options.observations?.find(observation => observation.source === 'read_learning_workspace')?.data
  const evidenceManifest = workspaceContext && typeof workspaceContext === 'object'
    ? ((workspaceContext as Record<string, any>).learningEvidence?.manifest || {})
    : {}
  const noScopedAttempts = evidenceManifest && Number(evidenceManifest.attempt_count) === 0
  const unsupportedHistoryInference = /(?:说明|所以|因此|可见)?[^。！!？?\n]{0,18}(?:你(?:是|这)?[^。！!？?\n]{0,8})?(?:第一次(?:正式)?学|从未(?:学|练习)|没有(?:学过|练习过))/i.test(reply)
    && !/(?:记录|数据|当前作用域|这里)[^。！!？?\n]{0,18}(?:没有|暂无|未找到|不可见)/i.test(reply)
  if (noScopedAttempts && unsupportedHistoryInference) violations.push('unsupported_learning_history_claim')
  const fileSelection = options.learningTaskContext?.skillId === 'learning_file_study'
    && options.learningTaskContext.stepId === 'selecting_learning_artifact'
  if (fileSelection && options.learningTaskContext?.formalTaskId) {
    const hasFileHandoff = options.toolRuns.some(run => run.learningFile || run.projectLearningFileProposal)
    if (!hasFileHandoff) violations.push('missing_learning_file_handoff')
    if (reply.length > 520) violations.push('learning_file_chat_overflow')
  }
  const pendingLearningFiles = options.toolRuns.some(run => run.projectLearningFileProposal)
    && !options.toolRuns.some(run => run.status === 'completed' && Boolean(run.learningFile))
  if (
    pendingLearningFiles
    && /(?:打开|进入|阅读|查看)(?:这|该|刚才)?(?:份|个)?(?:讲义|练习|学习文件)|(?:讲义|练习|学习文件)(?:已经|已)(?:生成|准备|放入|加入)/i.test(reply)
    && !/(?:尚未|还未|没有|并未|待确认|确认后|生成后)/i.test(reply)
  ) violations.push('unmaterialized_learning_file_claim')
  const unverifiedVideo = options.toolRuns.some(run => run.toolName === 'inspect_learning_video' && run.status !== 'completed')
  if (unverifiedVideo && /(?:推荐|很适合|值得看|优先看|建议看|可以看)/i.test(reply)) {
    violations.push('unverified_video_recommendation')
  }
  return { valid: violations.length === 0, violations }
}

export async function runTutorAgentTurn(input: TutorAgentRuntimeInput): Promise<AgentTurnResponse> {
  const id = turnId()
  const startedAt = Date.now()
  const latestMessage = [...input.messages].reverse().find(message => message.role === 'user')?.content || ''
  const visualIntent = resolveExplicitVisualIntent(input.toolChoice, latestMessage)
  const budget = tutorAgentBudget(input.mode, visualIntent, input.generationConfig)
  const deadline = startedAt + budget.maxWallTimeMs
  const trajectory: AgentTrajectoryEvent[] = []
  const decisionSummaries: AgentDecisionSummary[] = []
  const runs: TutorToolRun[] = []
  const requiresReasoningReplay = /deepseek/i.test(`${input.baseUrl} ${input.model}`)
  const runtimeMessages: RuntimeMessage[] = input.messages.slice(-budget.contextMessageLimit)
    // Conversations created before reasoning persistence cannot legally replay
    // their assistant turns to DeepSeek thinking models. The user's messages,
    // tool snapshots and formal state remain available; only the unreplayable
    // legacy assistant prose is omitted.
    .filter(message => !(requiresReasoningReplay && message.role === 'assistant' && !message.reasoningContent))
    .map(message => ({
    role: message.role,
    content: message.content,
    ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
    }))
  const observations: AgentContextEnvelope['observations'] = []
  const signatures = new Set<string>()
  let modelRounds = 0
  let toolCalls = 0
  let sequence = 0
  let stopReason: AgentTurnResponse['trace']['stopReason'] = 'error'
  let fallbackReply = ''
  let freshFinalizationRequired = false
  let committedText = ''
  let visibleDraft = ''
  let visualTeaching: VisualTeachingBundle | undefined
  let replyReasoningContent = ''
  let firstTextDeltaAt: number | undefined
  let pathGapPending = false
  let pathFuzzyPending = false
  let pathResolution: 'unknown' | 'resolved' | 'ambiguous' | 'not_found' | 'overview' = 'unknown'
  let currentVideoCandidates: LearningVideoCandidate[] = []
  const explicitlyRequestsExternalResources = hasExplicitExternalResourceRequest(input)

  const record = (event: Omit<AgentTrajectoryEvent, 'sequence' | 'at'>) => {
    const recorded = { ...event, sequence: ++sequence, at: Date.now() }
    trajectory.push(recorded)
    input.observe?.({ type: 'trajectory', event: recorded })
  }
  const emitTextDelta = (delta: string) => {
    if (!delta) return
    if (!firstTextDeltaAt) firstTextDeltaAt = Date.now()
    visibleDraft += delta
    input.observe?.({ type: 'text_delta', delta })
  }
  const resetVisibleDraft = (reason: 'tool_call' | 'retry' | 'verification' | 'reconcile') => {
    if (!visibleDraft) return
    visibleDraft = ''
    input.observe?.({ type: 'text_reset', reason })
  }
  const reconcileVisibleDraft = (candidate: string) => {
    if (!input.observe) return
    const mutableCandidate = committedText && candidate.startsWith(committedText)
      ? candidate.slice(committedText.length)
      : candidate
    if (mutableCandidate.startsWith(visibleDraft)) {
      emitTextDelta(mutableCandidate.slice(visibleDraft.length))
      return
    }
    resetVisibleDraft('reconcile')
    emitTextDelta(mutableCandidate)
  }
  const commitTeachingSegment = (explanation: string, modality: 'diagram' | 'animation') => {
    if (!firstTextDeltaAt) firstTextDeltaAt = Date.now()
    committedText = explanation
    visibleDraft = ''
    input.observe?.({
      type: 'teaching_segment_committed',
      segmentId: `visual-teaching-${id}`,
      skillId: VISUAL_TEACHING_SKILL_ID,
      briefVersion: VISUAL_TEACHING_BRIEF_VERSION,
      modality,
      content: explanation,
    })
  }
  const toolOptions: TutorAgentToolRuntimeOptions = {
    message: latestMessage,
    recentMessages: input.messages,
    generate: input.generate,
    searchConfiguration: input.searchConfiguration,
    mode: input.mode,
    learningTaskContext: input.learningTaskContext,
    learningPlanContext: input.learningPlanContext,
    taskQueue: input.taskQueue,
    knowledgeDomains: input.knowledgeDomains,
    learnerPathState: input.learnerPathState,
    formalLearnerContext: input.formalLearnerContext,
    formalWorkspaceContext: input.formalWorkspaceContext,
    formalDomainKnowledgeContext: input.formalDomainKnowledgeContext,
    formalReviewContext: input.formalReviewContext,
    formalProjectContext: input.formalProjectContext,
    activeArtifactContext: input.activeArtifactContext,
    backendBase: input.backendBase,
    requestCookie: input.requestCookie,
    onVisualStage: stage => {
      const labels: Record<string, string> = {
        compiling: '正在尝试确定性视觉编译',
        planner_started: '正在生成结构化视觉计划',
        planner_received: '视觉计划已返回，准备校验',
        syntax_repaired: '已在本地修复有限 JSON 标点错误',
        validation_started: '正在校验语义、引用、布局与安全性',
        repair_started: '首轮计划未通过，正在进行一次限次修复',
        fallback_started: '规划不可用，正在验证确定性降级产物',
        rendered: '视觉产物已通过校验并完成渲染',
      }
      record({ phase: 'act', detail: labels[stage] || stage, status: 'started' })
    },
  }
  const toolDefinitions = runtimeToolDefinitions(input)

  const executeRegisteredPluginTool = async (
    call: AgentToolCall,
    callSequence: number,
  ): Promise<TutorAgentToolExecution> => {
    const activation = pluginActivation(input)
    const registered = input.pluginRegistry?.resolveTool(call.name, activation)
    if (!registered || !input.pluginRegistry) {
      return executeTutorAgentTool(call.name, call.arguments, toolOptions, {
        callId: call.id,
        sequence: callSequence,
      })
    }
    const pluginStartedAt = Date.now()
    try {
      const execution = await input.pluginRegistry.execute(call.name, call.arguments, {
        ...activation,
        scope: {
          mode: input.mode,
          learnerId: Number((input.formalLearnerContext as any)?.scope?.learner_id) || undefined,
          sessionId: input.formalSessionId,
          conversationId: input.conversationId,
          sheetId: input.sheetId,
          projectId: activation.projectId,
          checkpointId: activation.checkpointId,
        },
        signal: AbortSignal.timeout(registered.contribution.timeoutMs || 30_000),
        projectIntegration: {
          request: (operation, payload) => requestProjectPluginIntegration({
            input,
            pluginId: registered.pluginId,
            operation,
            payload,
            signal: AbortSignal.timeout(registered.contribution.timeoutMs || 30_000),
          }),
        },
      })
      return {
        run: {
          id: `plugin-tool-${pluginStartedAt}-${callSequence}`,
          kind: 'plugin',
          status: 'completed',
          title: execution.contribution.title,
          detail: execution.result.summary,
          observationSummary: execution.result.summary.slice(0, 500),
          durationMs: Date.now() - pluginStartedAt,
          startedAt: pluginStartedAt,
          sequence: callSequence,
          toolName: call.name,
          toolCallId: call.id,
          inputSummary: safeJson(call.arguments, 500),
          plugin: {
            pluginId: execution.pluginId,
            toolId: execution.contribution.id,
            result: execution.result,
          },
        },
        observation: {
          authority: 'learnflow_plugin_tool',
          pluginId: execution.pluginId,
          toolId: execution.contribution.id,
          ...execution.result,
        },
      }
    } catch (error) {
      const message = compactDecisionText(error instanceof Error ? error.message : error, '插件工具调用失败', 500)
      return {
        run: {
          id: `plugin-tool-${pluginStartedAt}-${callSequence}`,
          kind: 'plugin',
          status: 'failed',
          title: registered.contribution.title,
          detail: message,
          observationSummary: '插件工具失败，未产生可信对象',
          errorType: /plugin_contract_invalid|missing|unknown fields|unavailable/i.test(message) ? 'user_fixable' : 'unexpected',
          durationMs: Date.now() - pluginStartedAt,
          startedAt: pluginStartedAt,
          sequence: callSequence,
          toolName: call.name,
          toolCallId: call.id,
          inputSummary: safeJson(call.arguments, 500),
        },
        observation: { error: message, recoverableByModel: false },
      }
    }
  }

  const execute = async (
    call: AgentToolCall,
    searchSources: SearchSource[] = [],
    recordAssistantMessage = true,
    recordRuntimeMessages = true,
  ) => {
    if (
      (call.name === 'generate_learning_diagram' && visualIntent !== 'diagram')
      || (call.name === 'generate_learning_animation' && visualIntent !== 'animation')
    ) {
      const blocked = {
        error: 'visual_intent_required',
        guidance: '图解和动画只在学习者本轮明确要求对应视觉形式时调用；普通讲解请直接使用文字、例子或既有学习文件。',
      }
      if (recordRuntimeMessages && recordAssistantMessage) runtimeMessages.push({ role: 'assistant', content: '', toolCalls: [call] })
      if (recordRuntimeMessages) runtimeMessages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: safeJson(blocked) })
      record({ phase: 'act', detail: `阻止缺少明确视觉意图的 ${call.name}`, toolCallId: call.id, toolName: call.name, status: 'blocked' })
      return [] as string[]
    }
    // Artifact generators are expensive and have side effects. Treat a second
    // request for the same formal task as a duplicate even when the model only
    // changes a title or difficulty after a failure. Recovery must use the
    // existing observation or end transparently, not burn the whole turn on
    // near-identical generation attempts.
    const practiceGenerationKey = ['generate_dynamic_practice', 'generate_similar_practice'].includes(call.name)
      ? `${call.name}:learning-task:${String(call.arguments.learning_task_id || '')}`
      : ''
    const visualGenerationKey = ['generate_learning_diagram', 'generate_learning_animation'].includes(call.name)
      ? `${call.name}:visual-intent:${visualIntent}`
      : ''
    const signature = practiceGenerationKey || visualGenerationKey || `${call.name}:${JSON.stringify(call.arguments)}`
    if (signatures.has(signature)) {
      const duplicate = {
        error: 'duplicate_tool_call',
        guidance: '相同工具和参数本轮已经执行；请使用已有观察、修改参数或结束回答。',
      }
      if (recordRuntimeMessages && recordAssistantMessage) runtimeMessages.push({ role: 'assistant', content: '', toolCalls: [call] })
      if (recordRuntimeMessages) runtimeMessages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: safeJson(duplicate) })
      record({ phase: 'act', detail: '阻止重复工具调用', toolCallId: call.id, toolName: call.name, status: 'blocked' })
      return [] as string[]
    }
    if (toolCalls >= budget.maxToolCalls) {
      record({ phase: 'act', detail: '达到工具调用预算', toolCallId: call.id, toolName: call.name, status: 'blocked' })
      return [] as string[]
    }
    signatures.add(signature)
    toolCalls += 1
    input.observe?.({
      type: 'tool_started', toolCallId: call.id, toolName: call.name,
      title: toolDefinitions.find(tool => tool.name === call.name)?.title || call.name,
      startedAt: Date.now(),
    })
    record({ phase: 'act', detail: `调用 ${call.name}`, toolCallId: call.id, toolName: call.name, status: 'started' })
    if (recordRuntimeMessages && recordAssistantMessage) runtimeMessages.push({ role: 'assistant', content: '', toolCalls: [call] })
    const visualCall = ['generate_learning_diagram', 'generate_learning_animation'].includes(call.name)
    const toolStartedAt = Date.now()
    let acceptingVisualStages = true
    const executionOptions = visualCall ? {
      ...toolOptions,
      generate: ((instructions, prompt, timeoutMs, maxTokens, options) => runGenerationWithinDeadline(deadline, remaining =>
        input.generate(instructions, prompt, Math.min(timeoutMs || remaining, remaining), maxTokens, options))) as TutorAgentToolRuntimeOptions['generate'],
      onVisualStage: (stage: Parameters<NonNullable<TutorAgentToolRuntimeOptions['onVisualStage']>>[0]) => {
        if (acceptingVisualStages) toolOptions.onVisualStage?.(stage)
      },
    } : toolOptions
    const invokeTool = () => input.executeTool
      ? input.executeTool(call.name, call.arguments, executionOptions, {
        callId: call.id,
        sequence: toolCalls,
        sourceUrls: searchSources.map(source => source.url),
        searchSources,
        videoCandidates: currentVideoCandidates,
      })
      : input.pluginRegistry?.resolveTool(call.name, pluginActivation(input))
        ? executeRegisteredPluginTool(call, toolCalls)
        : executeTutorAgentTool(call.name, call.arguments, executionOptions, {
          callId: call.id,
          sequence: toolCalls,
          sourceUrls: searchSources.map(source => source.url),
          searchSources,
          videoCandidates: currentVideoCandidates,
        })
    let result: TutorAgentToolExecution
    try {
      result = visualCall ? await runGenerationWithinDeadline(deadline, invokeTool) : await invokeTool()
    } catch (error) {
      if (!visualCall) throw error
      const detail = error instanceof Error ? error.message.slice(0, 500) : 'visual_tool_failed'
      result = {
        run: { id: call.id, toolCallId: call.id, toolName: call.name,
          kind: call.name === 'generate_learning_animation' ? 'animation' : 'image',
          status: 'failed', title: toolDefinitions.find(tool => tool.name === call.name)?.title || call.name,
          detail, observationSummary: detail, durationMs: Date.now() - toolStartedAt,
          startedAt: toolStartedAt, sequence: toolCalls },
        observation: { error: detail, terminalState: 'failed' },
      }
    } finally {
      acceptingVisualStages = false
    }
    if (result.videoCandidates) currentVideoCandidates = result.videoCandidates
    runs.push(result.run)
    input.observe?.({ type: 'tool_completed', run: result.run })
    const decisionSummary: AgentDecisionSummary = {
      id: `decision-${id}-${toolCalls}`,
      sequence: toolCalls,
      round: modelRounds,
      at: Date.now(),
      toolCallId: call.id,
      toolName: call.name,
      reason: toolDecisionReason(call, toolDefinitions),
      observation: compactDecisionText(
        result.run.observationSummary || result.run.detail,
        result.run.status === 'completed' ? '工具返回了结构化观察' : '工具没有返回可用观察',
      ),
      nextAction: toolDecisionNextAction(result.run),
    }
    decisionSummaries.push(decisionSummary)
    input.observe?.({ type: 'decision_summary', summary: decisionSummary })
    if (call.name === 'lookup_learning_path_node') {
      pathFuzzyPending = Boolean((result.observation as any)?.needsFuzzySearch)
      pathResolution = ((result.observation as any)?.retrieval?.resolution || pathResolution) as typeof pathResolution
    }
    if (call.name === 'search_learning_path_graph') {
      pathFuzzyPending = false
      pathGapPending = Boolean((result.observation as any)?.needsExternalResearch)
      pathResolution = ((result.observation as any)?.retrieval?.resolution || pathResolution) as typeof pathResolution
    }
    if (call.name === 'propose_personal_path_node' && result.run.status === 'completed') {
      pathGapPending = false
    }
    observations.push({
      source: call.name,
      authority: String((result.observation as any)?.authority || 'tool_observation'),
      answerFree: call.name === 'read_learner_context'
        || call.name === 'read_learning_workspace'
        || call.name === 'read_domain_knowledge'
        || call.name === 'lookup_learning_path_node'
        || call.name === 'search_learning_path_graph'
        || call.name === 'read_review_context'
        || call.name === 'read_project_workspace'
        || call.name === 'read_project_roadmap'
        || call.name === 'read_project_sources'
        || call.name === 'read_project_learning_file'
        || call.name === 'read_active_learning_file'
        || call.name === 'search_learning_videos'
        || call.name === 'inspect_learning_video',
      data: result.observation,
    })
    if (recordRuntimeMessages) {
      runtimeMessages.push({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: safeJson(result.observation),
      })
    }
    if (result.directReply) fallbackReply = result.directReply
    record({
      phase: 'act',
      detail: result.run.status === 'completed' ? `${call.name} 返回观察` : `${call.name} 执行失败`,
      toolCallId: call.id,
      toolName: call.name,
      status: result.run.status,
    })
    return result.searchSources || []
  }

  const refreshPathAfterSearch = async (sources: SearchSource[], recordRuntimeMessages = true) => {
    if (!pathGapPending || !sources.length || !input.learnerPathState) return
    await execute({
      id: `path-evidence-refresh-${id}-${toolCalls + 1}`,
      name: 'propose_personal_path_node',
      arguments: { query: latestMessage, source_urls: sources.map(source => source.url) },
    }, sources, recordRuntimeMessages, recordRuntimeMessages)
  }

  const directCandidateOperation = directLearningTaskCandidateOperationRequest(
    input.activePluginIds,
    pluginActivation(input).projectId,
    latestMessage,
  )
  if (directCandidateOperation && input.pluginRegistry?.resolveTool(
    directCandidateOperation.toolName,
    pluginActivation(input),
  )) {
    record({ phase: 'observe', detail: '已识别候选卡片操作，直接调用学习型任务转化插件', status: 'completed' })
    await execute({
      id: `direct-learning-task-candidate-operation-${id}`,
      name: directCandidateOperation.toolName,
      arguments: directCandidateOperation.arguments,
    })
    const run = runs[runs.length - 1]
    const reply = run?.status === 'completed'
      ? run.detail
      : `候选操作失败：${run?.detail || '插件没有返回可用观察'}`
    stopReason = run?.status === 'completed' ? 'final_answer' : 'error'
    record({
      phase: 'finalize',
      detail: run?.status === 'completed' ? '候选操作已由插件直接完成' : '候选操作失败',
      status: run?.status === 'completed' ? 'completed' : 'failed',
    })
    reconcileVisibleDraft(reply)
    return {
      reply,
      toolRuns: runs,
      trace: {
        version: 'vnext-agent-trace.v1',
        turnId: id,
        modelRounds: 0,
        toolCalls,
        stopReason,
        events: trajectory,
        decisionSummaries,
        timings: {
          ...(firstTextDeltaAt ? { firstTextDeltaMs: firstTextDeltaAt - startedAt } : {}),
          totalMs: Date.now() - startedAt,
        },
      },
    }
  }

  const directSelection = directLearningTaskCandidateSelectionRequest(
    input.activePluginIds,
    pluginActivation(input).projectId,
    latestMessage,
    input.messages,
  )
  if (directSelection && input.pluginRegistry?.resolveTool(
    'learning_task_conversion__prepare_learning_task_intake',
    pluginActivation(input),
  )) {
    record({ phase: 'observe', detail: '已读取上一张准备单中的学习者所选任务，直接固化确认契约', status: 'completed' })
    await execute({
      id: `direct-learning-task-selection-${id}`,
      name: 'learning_task_conversion__prepare_learning_task_intake',
      arguments: directSelection as unknown as Record<string, unknown>,
    })
    const run = runs[runs.length - 1]
    const reply = run?.status === 'completed'
      ? `${run.detail}\n\n已沿用上一张准备单中的原文、候选描述与语义预检结果；请在确认卡上核对后再调用讯飞。`
      : `任务候选选择失败：${run?.detail || '插件没有返回可用观察'}`
    stopReason = run?.status === 'completed' ? 'final_answer' : 'error'
    record({
      phase: 'finalize',
      detail: run?.status === 'completed' ? '所选任务已形成待确认契约' : '所选任务未能形成确认契约',
      status: run?.status === 'completed' ? 'completed' : 'failed',
    })
    reconcileVisibleDraft(reply)
    return {
      reply,
      toolRuns: runs,
      trace: {
        version: 'vnext-agent-trace.v1',
        turnId: id,
        modelRounds: 0,
        toolCalls,
        stopReason,
        events: trajectory,
        decisionSummaries,
        timings: {
          ...(firstTextDeltaAt ? { firstTextDeltaMs: firstTextDeltaAt - startedAt } : {}),
          totalMs: Date.now() - startedAt,
        },
      },
    }
  }

  const directDraft = directLearningTaskDraftConfirmationRequest(
    input.activePluginIds,
    pluginActivation(input).projectId,
    latestMessage,
  )
  if (directDraft && input.pluginRegistry?.resolveTool(
    'learning_task_conversion__draft_learning_task',
    pluginActivation(input),
  )) {
    record({ phase: 'observe', detail: '已核对准备单确认信息，开始生成学习型任务候选', status: 'completed' })
    await execute({
      id: `direct-learning-task-draft-${id}`,
      name: 'learning_task_conversion__draft_learning_task',
      arguments: directDraft,
    })
    const run = runs[runs.length - 1]
    const reply = run?.status === 'completed'
      ? `${run.detail}\n\n这是尚未提交的候选；请先检查步骤、知识技能映射与来源，再决定是否创建正式学习任务。`
      : `学习型任务候选生成失败：${run?.detail || '插件没有返回可用观察'}`
    stopReason = run?.status === 'completed' ? 'final_answer' : 'error'
    record({
      phase: 'finalize',
      detail: run?.status === 'completed' ? '学习型任务候选已返回，等待复核' : '学习型任务候选生成失败',
      status: run?.status === 'completed' ? 'completed' : 'failed',
    })
    reconcileVisibleDraft(reply)
    return {
      reply,
      toolRuns: runs,
      trace: {
        version: 'vnext-agent-trace.v1',
        turnId: id,
        modelRounds: 0,
        toolCalls,
        stopReason,
        events: trajectory,
        decisionSummaries,
        timings: {
          ...(firstTextDeltaAt ? { firstTextDeltaMs: firstTextDeltaAt - startedAt } : {}),
          totalMs: Date.now() - startedAt,
        },
      },
    }
  }

  const directIntake = directLearningTaskIntakeRequest(
    input.activePluginIds,
    pluginActivation(input).projectId,
    latestMessage,
    input.referencedPluginObjects,
    input.mode,
  )
  if (directIntake && input.pluginRegistry?.resolveTool(
    'learning_task_conversion__prepare_learning_task_intake',
    pluginActivation(input),
  )) {
    record({ phase: 'observe', detail: '已识别学习型任务转化请求，先调用独立语义模型预检', status: 'completed' })
    const preflightText = await input.generate(
      learningTaskPreflightInstructions(),
      learningTaskPreflightInput(directIntake.rawInput, directIntake.taskDescription),
      30_000,
      1_400,
      { responseFormat: 'json_object' },
    )
    const preflight = parseLearningTaskPreflightResult(preflightText, directIntake.rawInput)
    const preparedInput = {
      ...preflightResultToIntakeInput(preflight, directIntake.taskDescription, input.model),
      ...(directIntake.candidateTasks ? {
        candidateTasks: directIntake.candidateTasks,
        selectedTaskTitle: directIntake.selectedTaskTitle,
        selectedTaskDescription: directIntake.selectedTaskDescription,
      } : {}),
    }
    record({
      phase: 'reason',
      detail: `独立语义模型判定为 ${preflight.input_kind}，置信度 ${Math.round(preflight.confidence * 100)}%`,
      status: 'completed',
    })
    await execute({
      id: `direct-learning-task-intake-${id}`,
      name: 'learning_task_conversion__prepare_learning_task_intake',
      arguments: preparedInput as unknown as Record<string, unknown>,
    })
    const run = runs[runs.length - 1]
    const reply = run?.status === 'completed'
      ? `${run.detail}\n\n独立语义模型已完成一次真实预检；这仍只是任务转化准备单，你确认前不会调用讯飞，也不会创建候选或正式任务。`
      : `任务转化准备失败：${run?.detail || '插件没有返回可用观察'} `
    stopReason = run?.status === 'completed' ? 'final_answer' : 'error'
    record({
      phase: 'finalize',
      detail: run?.status === 'completed' ? '任务转化准备单已返回，等待学习者选择或确认' : '任务转化准备失败',
      status: run?.status === 'completed' ? 'completed' : 'failed',
    })
    reconcileVisibleDraft(reply)
    return {
      reply,
      toolRuns: runs,
      trace: {
        version: 'vnext-agent-trace.v1',
        turnId: id,
        modelRounds: 1,
        toolCalls,
        stopReason,
        events: trajectory,
        decisionSummaries,
        timings: {
          ...(firstTextDeltaAt ? { firstTextDeltaMs: firstTextDeltaAt - startedAt } : {}),
          totalMs: Date.now() - startedAt,
        },
      },
    }
  }

  record({ phase: 'observe', detail: '开始组装本轮观察空间', status: 'started' })
  const selectingLearningFile = input.mode === 'guided_learning'
    && input.learningTaskContext?.skillId === 'learning_file_study'
    && input.learningTaskContext.stepId === 'selecting_learning_artifact'
  const needsLearnerContext = (input.mode === 'guided_learning' && !selectingLearningFile)
    || input.mode === 'learning_plan'
    || /(?:根据我|适合我|我的基础|我的情况|我之前|我学过|我不会|我总是|记得我|偏好|目标|熟练度|掌握度|薄弱|错题)/i.test(latestMessage)
  if (needsLearnerContext) {
    await execute({ id: `observe-memory-${id}`, name: 'read_learner_context', arguments: { query: latestMessage } }, [], false, false)
  }
  if (input.formalProjectContext) {
    await execute({ id: `observe-project-${id}`, name: 'read_project_workspace', arguments: { query: latestMessage } }, [], false, false)
    if (['simple_explain', 'guided_learning', 'learning_plan'].includes(input.mode)) {
      await execute({ id: `observe-project-sources-${id}`, name: 'read_project_sources', arguments: { query: latestMessage } }, [], false, false)
    }
    if (input.formalProjectContext.tool_policy?.roadmap_tool_access === 'project_tutor' && input.mode === 'learning_plan') {
      await execute({ id: `observe-roadmap-${id}`, name: 'read_project_roadmap', arguments: { query: latestMessage } }, [], false, false)
    }
  }
  if (input.mode === 'guided_learning' || input.mode === 'learning_plan') {
    await execute({ id: `observe-workspace-${id}`, name: 'read_learning_workspace', arguments: { query: latestMessage } }, [], false, false)
  }
  if (
    selectingLearningFile
    && input.learningTaskContext?.formalTaskId
    && !input.activeArtifactContext
    && !runs.some(run => run.learningFile)
  ) {
    await execute({
      id: `prepare-learning-files-${id}`,
      name: 'propose_project_learning_files',
      arguments: {
        learning_task_id: input.learningTaskContext.formalTaskId,
        file_kinds: ['lecture', 'practice'],
      },
    }, [], false, false)
  }
  if (input.activeArtifactContext) {
    await execute({ id: `observe-active-file-${id}`, name: 'read_active_learning_file', arguments: {} }, [], false, false)
  }
  if (input.formalDomainKnowledgeContext && ['simple_explain', 'guided_learning', 'learning_plan'].includes(input.mode) && input.toolChoice === 'auto') {
    await execute({ id: `observe-domain-${id}`, name: 'read_domain_knowledge', arguments: { query: latestMessage } }, [], false, false)
  }
  if (input.toolChoice === 'auto' && shouldAutoSupplementKnowledge(input, latestMessage)) {
    const sources = await execute({
      id: `auto-knowledge-search-${id}`, name: 'search_computer_knowledge',
      arguments: { query: latestMessage, depth: /(?:论文|研究|综述|全面|深度)/i.test(latestMessage) ? 'deep' : 'standard' },
    }, [], false, false)
    for (const [index, source] of sources.filter(item => item.url).slice(0, 2).entries()) {
      await execute({
        id: `auto-knowledge-read-${id}-${index + 1}`, name: 'read_web_evidence',
        arguments: { url: source.url, query: latestMessage },
      }, sources, false, false)
    }
  }
  if (input.mode === 'learning_plan' && input.learnerPathState) {
    await execute({ id: `observe-path-exact-${id}`, name: 'lookup_learning_path_node', arguments: { query: latestMessage } }, [], false, false)
    if (pathFuzzyPending) {
      await execute({ id: `observe-path-fuzzy-${id}`, name: 'search_learning_path_graph', arguments: { query: latestMessage, limit: 6 } }, [], false, false)
    }
  }
  if (input.formalReviewContext && /复习|错题|遗忘|记不住|熟练度|掌握度|记忆曲线|间隔|回忆|薄弱/i.test(latestMessage)) {
    await execute({ id: `observe-review-${id}`, name: 'read_review_context', arguments: { query: latestMessage } }, [], false, false)
  }
  const explicit = explicitToolCall(input.toolChoice, latestMessage, Boolean(input.formalProjectContext))
    || (visualIntent === 'none' ? undefined : {
      id: `explicit-visual-intent-${Date.now()}`,
      name: visualIntent === 'animation' ? 'generate_learning_animation' : 'generate_learning_diagram',
      arguments: { query: latestMessage },
  })
  // Both visual modalities are deferred to visual_teaching_composition. The
  // Skill commits an independent explanation before either renderer runs.
  if (explicit && !['generate_learning_diagram', 'generate_learning_animation'].includes(explicit.name)) {
    const sources = await execute(explicit, [], false, false)
    if (explicit.name === 'search_computer_knowledge') await refreshPathAfterSearch(sources, false)
  }
  record({ phase: 'observe', detail: `观察空间已就绪：${observations.length} 个结构化观察`, status: 'completed' })

  const envelope: AgentContextEnvelope = {
    version: 'vnext-agent-context.v1',
    scope: {
      mode: input.mode, conversationId: input.conversationId, sheetId: input.sheetId,
      projectId: input.formalProjectContext?.project?.id,
      checkpointId: input.formalProjectContext?.checkpoint_id || undefined,
    },
    current: {
      userMessage: latestMessage,
      selection: input.selectionContext,
      activeArtifact: input.activeArtifactContext,
      learningTask: input.learningTaskContext,
      learningPlan: input.learningPlanContext,
    },
    // Host-prefetched observations are carried in the bounded instruction
    // envelope. They must not be forged as assistant tool calls: DeepSeek
    // thinking mode requires every replayed assistant tool call to include the
    // provider's original reasoning_content.
    observations,
    recentToolObservations: compactPriorRuns(input.messages),
    budgets: {
      maxModelRounds: budget.maxModelRounds,
      maxToolCalls: budget.maxToolCalls,
      maxWallTimeMs: budget.maxWallTimeMs,
    },
  }
  const visualAlreadyAttempted = visualIntent !== 'none' && (
    runs.some(run => run.toolName === (visualIntent === 'animation' ? 'generate_learning_animation' : 'generate_learning_diagram'))
    || ['generate_learning_diagram', 'generate_learning_animation'].includes(explicit?.name || '')
  )
  const tools = availableTools(input).filter(tool => !visualAlreadyAttempted || !['generate_learning_diagram', 'generate_learning_animation'].includes(tool.name))
  const promptTools = input.mode === 'learning_plan'
    ? compactToolDefinitions(tools, budget.toolDescriptionChars)
    : tools
  const modelVisibleToolNames = new Set(tools.map(tool => tool.name))
  const coreInstructions = buildTutorInstructions({
    mode: input.mode,
    selectionContext: input.selectionContext,
    activeArtifactContext: input.activeArtifactContext,
    learningTaskContext: input.learningTaskContext,
    learningPlanContext: input.learningPlanContext,
    toolContext: envelopePrompt(envelope, {
      envelopeChars: budget.contextEnvelopeChars,
      observationChars: budget.contextObservationChars,
      observationTotalChars: budget.contextObservationTotalChars,
    }),
    toolContextLimit: input.mode === 'learning_plan' ? budget.contextEnvelopeChars : 16_000,
  })
  const pluginInstructions = input.pluginRegistry?.skillInstructions(pluginActivation(input)) || ''
  const instructions = pluginInstructions ? `${coreInstructions}\n\n${pluginInstructions}` : coreInstructions

  let reply = ''
  let continuationPrefix = ''
  let visualBrief: VisualTeachingBrief | undefined
  let searchSources: SearchSource[] = runs.flatMap(run => run.sources || [])
  const invokeModel = async (
    request: ReturnType<typeof buildAgentProviderRequest>,
    requestDeadline = deadline,
    streamText = true,
  ) => {
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const remainingMs = requestDeadline - Date.now()
        if (remainingMs <= 0) throw new Error('agent_turn_deadline_exceeded')
        const payload = await input.invokeProvider({
          ...request,
          timeoutMs: Math.min(AI_LATENCY_BUDGETS.providerRequest, remainingMs),
          onTextDelta: streamText ? emitTextDelta : undefined,
        })
        return payload
      } catch (error) {
        lastError = error
        if (streamText) resetVisibleDraft('retry')
        const message = error instanceof Error ? error.message : String(error || '')
        const transient = /timeout|超时|429|rate|network|fetch|ECONN|temporar|503|502/i.test(message)
        if (!transient || attempt > 0 || Date.now() >= requestDeadline - 1_000) throw error
        record({ phase: 'decide', detail: '模型请求遇到暂时故障，使用剩余预算重试一次', status: 'retrying' })
      }
    }
    throw lastError
  }
  try {
    if (explicit && ['generate_learning_diagram', 'generate_learning_animation'].includes(explicit.name)) {
      const modality = explicit.name === 'generate_learning_animation' ? 'animation' as const : 'diagram' as const
      const visualRequest = resolveVisualRequest(latestMessage, input.messages)
      const visualQuery = visualRequest.effectiveRequest
      explicit.arguments = { ...explicit.arguments, query: visualQuery }
      if (visualRequest.contextEnriched) record({ phase: 'observe', detail: `视觉主题已从${visualRequest.topicAnchor?.source === 'prior_user' ? '前文用户请求' : '同主题已完成产物'}恢复`, status: 'completed' })
      record({ phase: 'decide', detail: '视觉教学 Skill 正在形成可独立成立的讲解与结构化 VisualBrief', status: 'started' })
      let explanation = ''
      try {
        modelRounds += 1
        let explanationPayload = await invokeModel(buildAgentProviderRequest({
          baseUrl: input.baseUrl,
          model: input.model,
          instructions,
          messages: [...runtimeMessages, { role: 'user', content: visualTeachingExplanationPrompt(modality, visualQuery) }],
          tools: [],
          includeTools: false,
          maxOutputTokens: budget.maxOutputTokens,
        }), deadline, false)
        explanation = textFromTutorProviderResponse(explanationPayload).trim()
        let explanationReasoningContent = reasoningContentFromProviderResponse(explanationPayload)
        try {
          explanation = validateVisualTeachingExplanation(explanation)
        } catch (firstError) {
          if (Date.now() >= deadline - 1_000) throw firstError
          record({ phase: 'decide', detail: '独立讲解未通过教学门，进行一次限次修复', status: 'retrying' })
          modelRounds += 1
          explanationPayload = await invokeModel(buildAgentProviderRequest({
            baseUrl: input.baseUrl,
            model: input.model,
            instructions,
            messages: [
              ...runtimeMessages,
              { role: 'assistant' as const, content: explanation, ...(explanationReasoningContent ? { reasoningContent: explanationReasoningContent } : {}) },
              { role: 'user' as const, content: visualTeachingExplanationPrompt(modality, visualQuery, true) },
            ],
            tools: [],
            includeTools: false,
            maxOutputTokens: budget.maxOutputTokens,
          }), deadline, false)
          explanation = validateVisualTeachingExplanation(textFromTutorProviderResponse(explanationPayload).trim())
          explanationReasoningContent = reasoningContentFromProviderResponse(explanationPayload)
        }

        commitTeachingSegment(explanation, modality)
        runtimeMessages.push({ role: 'assistant', content: explanation, ...(explanationReasoningContent ? { reasoningContent: explanationReasoningContent } : {}) })
        replyReasoningContent = explanationReasoningContent
        record({ phase: 'decide', detail: '独立讲解已提交；后续 Brief 或视觉失败不得撤销', status: 'completed' })

        try {
          modelRounds += 1
          let rawBriefPayload = await invokeModel(buildAgentProviderRequest({
            baseUrl: input.baseUrl,
            model: input.model,
            instructions,
            messages: [...runtimeMessages, { role: 'user', content: visualTeachingBriefPrompt(modality, visualQuery, explanation) }],
            tools: [],
            includeTools: false,
            responseFormat: 'json_object',
            maxOutputTokens: budget.maxOutputTokens,
          }), deadline, false)
          let rawBrief = textFromTutorProviderResponse(rawBriefPayload).trim()
          let rawBriefReasoningContent = reasoningContentFromProviderResponse(rawBriefPayload)
          try {
            visualBrief = parseVisualTeachingBrief(rawBrief, modality, visualQuery, explanation)
            if (visualBrief.explanation !== explanation) throw new Error('visual_teaching_explanation_mismatch')
          } catch (firstError) {
            if (Date.now() >= deadline - 1_000) throw firstError
            record({ phase: 'decide', detail: 'VisualBrief 未通过结构门，进行一次限次修复', status: 'retrying' })
            modelRounds += 1
            rawBriefPayload = await invokeModel(buildAgentProviderRequest({
              baseUrl: input.baseUrl,
              model: input.model,
              instructions,
              messages: [
                ...runtimeMessages,
                { role: 'assistant', content: rawBrief, ...(rawBriefReasoningContent ? { reasoningContent: rawBriefReasoningContent } : {}) },
                { role: 'user', content: visualTeachingBriefPrompt(modality, visualQuery, explanation, true) },
              ],
              tools: [],
              includeTools: false,
              responseFormat: 'json_object',
              maxOutputTokens: budget.maxOutputTokens,
            }), deadline, false)
            rawBrief = textFromTutorProviderResponse(rawBriefPayload).trim()
            rawBriefReasoningContent = reasoningContentFromProviderResponse(rawBriefPayload)
            visualBrief = parseVisualTeachingBrief(rawBrief, modality, visualQuery, explanation)
            if (visualBrief.explanation !== explanation) throw new Error('visual_teaching_explanation_mismatch')
          }
        } catch (briefError) {
          visualTeaching = explanationOnlyVisualTeachingBundle(explanation, modality, briefError)
          reply = visualTeachingReply(visualTeaching)
          stopReason = 'final_answer'
          reconcileVisibleDraft(reply)
          record({ phase: 'verify', detail: 'VisualBrief 失败，已以 explanation_only 保留讲解', status: 'completed' })
        }

        if (visualBrief) {
          toolOptions.visualTeachingBrief = visualBrief
          record({ phase: 'decide', detail: 'VisualBrief 已通过对象、关系与过程门', status: 'completed' })

          let visualError: unknown
          try {
            await execute(explicit)
          } catch (error) {
            visualError = error
            record({ phase: 'act', detail: `视觉工具异常：${compactDecisionText(error instanceof Error ? error.message : error, '视觉工具异常')}`, status: 'failed' })
          }
          const run = [...runs].reverse().find(item => item.toolName === explicit.name)
          visualTeaching = completeVisualTeachingBundle(visualBrief, run, visualError)
          reply = visualTeachingReply(visualTeaching)
          stopReason = 'final_answer'
          reconcileVisibleDraft(reply)
          record({
            phase: 'verify',
            detail: visualTeaching.terminalState === 'bundle_ready'
              ? '视觉教学组合产物通过终态校验'
              : '视觉失败已降级为 explanation_only；已提交讲解保持不变',
            status: 'completed',
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'visual_teaching_brief_failed'
        record({ phase: 'act', detail: `视觉教学 Skill 未达到讲解提交门槛：${message.slice(0, 220)}`, status: 'failed' })
      }
    }
    for (let round = 0; !reply && round < budget.maxModelRounds && Date.now() < deadline; round += 1) {
      modelRounds += 1
      record({ phase: 'decide', detail: `模型决策第 ${modelRounds} 轮`, status: 'started' })
      const request = buildAgentProviderRequest({
        baseUrl: input.baseUrl,
        model: input.model,
        instructions,
        messages: runtimeMessages,
        tools: promptTools,
        includeTools: !continuationPrefix && toolCalls < budget.maxToolCalls,
        maxOutputTokens: budget.maxOutputTokens,
      })
      const payload = await invokeModel(request)
      const calls = toolCallsFromProviderResponse(payload)
      const reasoningContent = reasoningContentFromProviderResponse(payload)
      const text = textFromTutorProviderResponse(payload)
      if (calls.length) {
        resetVisibleDraft('tool_call')
        record({ phase: 'decide', detail: `模型选择 ${calls.length} 个工具`, status: 'completed' })
        const acceptedCalls = calls.slice(0, budget.maxToolCalls - toolCalls)
        if (acceptedCalls.length) {
          runtimeMessages.push({
            role: 'assistant',
            content: text,
            toolCalls: acceptedCalls,
            ...(reasoningContent ? { reasoningContent } : {}),
          })
        }
        for (const call of acceptedCalls) {
          if (!modelVisibleToolNames.has(call.name)) {
            const observation = {
              error: 'tool_not_available',
              requestedTool: call.name,
              guidance: '该工具没有向当前状态或作用域开放。请只使用本轮 tools 列表中的工具。',
            }
            runtimeMessages.push({
              role: 'tool', toolCallId: call.id, toolName: call.name, content: safeJson(observation),
            })
            record({
              phase: 'act', detail: `阻止未开放工具 ${call.name}`,
              toolCallId: call.id, toolName: call.name, status: 'blocked',
            })
            continue
          }
          if (
            call.name === 'search_computer_knowledge'
            && input.mode === 'learning_plan'
            && input.toolChoice === 'auto'
            && !explicitlyRequestsExternalResources
            && (pathResolution === 'resolved' || pathResolution === 'ambiguous')
          ) {
            const observation = {
              error: 'path_retrieval_already_sufficient',
              pathResolution,
              guidance: pathResolution === 'resolved'
                ? '学习路径目标已经由正式图谱可靠定位。请直接基于已有图谱回答，不要为补充一般背景重复联网。'
                : '当前目标存在多个正式图谱候选。请先让学习者消歧，不要用联网结果替学习者选择方向。',
            }
            runtimeMessages.push({
              role: 'tool', toolCallId: call.id, toolName: call.name, content: safeJson(observation),
            })
            record({
              phase: 'act', detail: `阻止路径已${pathResolution === 'resolved' ? '定位' : '进入消歧'}后的冗余联网`,
              toolCallId: call.id, toolName: call.name, status: 'blocked',
            })
            continue
          }
          const sources = await execute(call, searchSources, false)
          if (sources.length) {
            const byUrl = new Map([...searchSources, ...sources].map(source => [source.url, source]))
            searchSources = [...byUrl.values()]
          }
          if (call.name === 'search_computer_knowledge') await refreshPathAfterSearch(sources)
        }
        continue
      }
      const combinedText = `${continuationPrefix}${text}`
      const incompleteReason = incompleteTutorProviderReason(payload)
      if (incompleteReason) {
        if (!text.trim()) {
          if (input.mode === 'learning_plan') {
            freshFinalizationRequired = true
            continuationPrefix = ''
            resetVisibleDraft('retry')
            record({ phase: 'verify', detail: `模型输出仅包含不完整思考（${incompleteReason}），将以精简请求重新生成正文`, status: 'retrying' })
            break
          }
          throw new Error(`模型输出未完成且没有可续接正文：${incompleteReason}`)
        }
        continuationPrefix = combinedText
        runtimeMessages.push({ role: 'assistant', content: text, ...(reasoningContent ? { reasoningContent } : {}) })
        runtimeMessages.push({
          role: 'user',
          content: '上一段正文因模型输出上限中断。请从断点后继续，只输出尚未完成的后半部分，不要重写或重复已经输出的内容；把当前回答自然完整地收束。',
        })
        record({ phase: 'verify', detail: `检测到模型输出上限中断（${incompleteReason}），保留已输出正文并续接`, status: 'retrying' })
        continue
      }
      const candidate = repairTutorDraftForObservedGaps(combinedText, runs)
      continuationPrefix = ''
      const verification = verifyTutorTurnOutcome({
        reply: candidate,
        mode: input.mode,
        toolRuns: runs,
        learningTaskContext: input.learningTaskContext,
        observations,
      })
      if (verification.valid) {
        reply = candidate
        replyReasoningContent = reasoningContent
        reconcileVisibleDraft(candidate)
        stopReason = 'final_answer'
        record({ phase: 'verify', detail: '最终回复通过展示协议校验', status: 'completed' })
        break
      }
      runtimeMessages.push({ role: 'assistant', content: text, ...(reasoningContent ? { reasoningContent } : {}) })
      resetVisibleDraft('verification')
      runtimeMessages.push({
        role: 'user',
        content: `上一次输出未通过终态校验（${verification.violations.join('、')}）。请只输出自然的中文教学正文；不得冒充已写入状态、不得无证据宣布掌握，工具失败和搜索覆盖缺口要透明说明；联网事实只能引用本轮工具返回的精确 URL，不得补写链接；观察到记忆冲突时必须把冲突和确认权告诉学习者；没有可见 Attempt 只能说暂无记录，不能推断学生第一次学习或从未练习。`,
      })
      record({ phase: 'verify', detail: `回复未通过终态校验：${verification.violations.join('、')}`, status: 'failed' })
    }

    if (!reply) {
      stopReason = Date.now() >= deadline ? 'model_budget' : toolCalls >= budget.maxToolCalls ? 'tool_budget' : 'forced_finalize'
      record({ phase: 'finalize', detail: '进入无工具最终收束', status: 'started' })
      const finalizationDeadline = Math.max(Date.now(), deadline) + budget.finalizationGraceMs
      const freshPlanningRecovery = freshFinalizationRequired && input.mode === 'learning_plan'
      let freshRecoveryPrefix = ''
      for (let attempt = 0; attempt < budget.finalizationAttempts && Date.now() < finalizationDeadline && !reply; attempt += 1) {
        modelRounds += 1
        const finalizationPrompt = attempt === 0
          ? '请直接给出完整、自然的中文教学回复；明确资料缺口，不要调用工具，不要输出协议文本。'
          : '上一轮仍没有形成可展示正文。现在只完成当前教学动作：先自然回应，再给最小必要解释或问题；不要调用工具，不要输出协议文本。'
        const finalizationMessages: RuntimeMessage[] = freshPlanningRecovery
          ? [{
              role: 'user',
              content: [
                latestMessage,
                finalizationPrompt,
                freshRecoveryPrefix ? `已有草稿：${freshRecoveryPrefix}\n只补全缺失的结尾，不要重复草稿。` : '',
              ].filter(Boolean).join('\n\n'),
            }]
          : (() => {
              runtimeMessages.push({ role: 'user', content: finalizationPrompt })
              return runtimeMessages.slice(-24)
            })()
        const request = buildAgentProviderRequest({
          baseUrl: input.baseUrl,
          model: input.model,
          instructions: freshPlanningRecovery
            ? buildTutorInstructions({ mode: 'learning_plan', learningPlanContext: input.learningPlanContext })
            : instructions,
          messages: finalizationMessages,
          tools: promptTools,
          includeTools: false,
          maxOutputTokens: budget.recoveryMaxOutputTokens,
        })
        const payload = await invokeModel(request, finalizationDeadline)
        const text = textFromTutorProviderResponse(payload)
        const reasoningContent = reasoningContentFromProviderResponse(payload)
        const combinedText = `${continuationPrefix}${text}`
        const incompleteReason = incompleteTutorProviderReason(payload)
        if (incompleteReason) {
          if (text.trim()) {
            if (freshPlanningRecovery) {
              freshRecoveryPrefix = combinedText
              continuationPrefix = ''
            } else {
              continuationPrefix = combinedText
              runtimeMessages.push({ role: 'assistant', content: text, ...(reasoningContent ? { reasoningContent } : {}) })
              runtimeMessages.push({
                role: 'user',
                content: '回答仍因输出上限中断。只续写缺失的结尾并自然收束，不要重复前文。',
              })
            }
          }
          record({ phase: 'verify', detail: `最终收束仍检测到输出中断（${incompleteReason}）`, status: 'retrying' })
          continue
        }
        const candidateText = freshPlanningRecovery ? `${freshRecoveryPrefix}${text}` : combinedText
        const candidate = repairTutorDraftForObservedGaps(candidateText, runs)
        continuationPrefix = ''
        if (verifyTutorTurnOutcome({
          reply: candidate,
          mode: input.mode,
          toolRuns: runs,
          learningTaskContext: input.learningTaskContext,
          observations,
        }).valid) {
          reply = candidate
          replyReasoningContent = reasoningContent
          reconcileVisibleDraft(candidate)
        } else {
          resetVisibleDraft('verification')
          record({ phase: 'verify', detail: `第 ${attempt + 1} 次最终收束未形成可展示正文`, status: 'failed' })
        }
      }
      if (!reply && fallbackReply) reply = fallbackReply
      if (!reply) {
        reply = deterministicTutorFallback(input, runs)
        reconcileVisibleDraft(reply)
        record({ phase: 'finalize', detail: '模型正文缺失，使用确定性教学续接保护学习现场', status: 'completed' })
      }
      record({ phase: 'finalize', detail: '最终回复已收束', status: 'completed' })
    }
  } catch (error) {
    record({ phase: 'error', detail: error instanceof Error ? error.message.slice(0, 240) : 'Agent Runtime 失败', status: 'failed' })
    stopReason = 'error'
    if (!reply && fallbackReply) reply = fallbackReply
    if (!reply && input.mode === 'guided_learning') {
      reply = deterministicTutorFallback(input, runs)
      stopReason = 'forced_finalize'
      reconcileVisibleDraft(reply)
      record({ phase: 'finalize', detail: '模型或工具异常，使用确定性教学续接保护学习现场', status: 'completed' })
    }
    if (!reply) throw error
  }

  reply = ensureSearchCitations(reply, runs)
  const finalVerification = verifyTutorTurnOutcome({
    reply,
    mode: input.mode,
    toolRuns: runs,
    learningTaskContext: input.learningTaskContext,
    observations,
  })
  if (!finalVerification.valid) {
    record({ phase: 'error', detail: `终态校验失败：${finalVerification.violations.join('、')}`, status: 'failed' })
    throw new Error(`模型回复未通过终态安全校验：${finalVerification.violations.join('、')}`)
  }
  reconcileVisibleDraft(reply)
  return {
    reply,
    ...(replyReasoningContent ? { reasoningContent: replyReasoningContent } : {}),
    toolRuns: runs,
    ...(visualTeaching ? { visualTeaching } : {}),
    trace: {
      version: 'vnext-agent-trace.v1',
      turnId: id,
      modelRounds,
      toolCalls,
      stopReason,
      events: trajectory,
      decisionSummaries,
      timings: {
        ...(firstTextDeltaAt ? { firstTextDeltaMs: firstTextDeltaAt - startedAt } : {}),
        totalMs: Date.now() - startedAt,
      },
    },
  }
}
