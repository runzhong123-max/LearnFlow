import type { LearningPlanTutorContext } from './planning.ts'
import type { LearningTaskTutorContext } from './learning.ts'
import type { LearnerPathState } from './learning-path-graph.ts'
import type { TutorMode, TutorContextMessage } from './tutor.ts'
import type { TutorToolChoice, TutorToolRun } from './tooling.ts'
import type { AgentProjectContext } from './project.ts'

export type AgentToolClass =
  | 'perception'
  | 'execution'
  | 'collaboration'
  | 'event'
  | 'communication'

export type AgentToolRisk = 'read_only' | 'artifact' | 'proposal' | 'confirmation_required'

export type AgentToolDefinition = {
  name: string
  title: string
  description: string
  toolClass: AgentToolClass
  risk: AgentToolRisk
  inputSchema: {
    type: 'object'
    properties: Record<string, Record<string, unknown>>
    required?: string[]
    additionalProperties: false
  }
}

export type AgentToolCall = {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type AgentTrajectoryEvent = {
  sequence: number
  phase: 'observe' | 'decide' | 'act' | 'verify' | 'finalize' | 'error'
  detail: string
  at: number
  toolCallId?: string
  toolName?: string
  status?: 'started' | 'completed' | 'failed' | 'blocked' | 'retrying'
}

// A bounded, user-visible projection of the runtime decision. This is not the
// provider's hidden chain of thought: it contains only the tool rationale,
// verified observation summary and the next operational action.
export type AgentDecisionSummary = {
  id: string
  sequence: number
  round: number
  at: number
  toolCallId: string
  toolName: string
  reason: string
  observation: string
  nextAction: string
}

export type AgentContextEnvelope = {
  version: 'vnext-agent-context.v1'
  scope: {
    mode: TutorMode
    conversationId?: string
    sheetId?: string
    projectId?: number
    checkpointId?: number
  }
  current: {
    userMessage: string
    selection?: string
    activeArtifact?: {
      kind: 'lecture' | 'practice' | 'source'
      ref: string
      title: string
      projectId?: number
    }
    learningTask?: LearningTaskTutorContext
    learningPlan?: LearningPlanTutorContext
  }
  observations: Array<{
    source: string
    authority: string
    answerFree: boolean
    data: unknown
  }>
  recentToolObservations: TutorToolRun[]
  budgets: {
    maxModelRounds: number
    maxToolCalls: number
    maxWallTimeMs: number
  }
}

export type AgentTurnTrace = {
  version: 'vnext-agent-trace.v1'
  turnId: string
  modelRounds: number
  toolCalls: number
  stopReason: 'final_answer' | 'tool_budget' | 'model_budget' | 'forced_finalize' | 'error'
  events: AgentTrajectoryEvent[]
  decisionSummaries?: AgentDecisionSummary[]
  timings?: {
    firstTextDeltaMs?: number
    totalMs: number
  }
}

export type AgentTaskQueueItem = {
  id: number
  objective: string
  status: string
  sourceType?: string
  sourceId?: string
  version?: number
  artifactRefs?: Array<{
    kind?: string
    ref?: string | number
    title?: string
  }>
  updatedAt?: string
}

export type AgentKnowledgeDomain = {
  id: string
  title: string
  summary?: string
  labels?: string[]
  sourceIds?: string[]
}

export type AgentFormalScope = {
  sessionId?: number
  projectId?: number
  checkpointId?: number
  projectRole?: 'tutor' | 'checkpoint' | 'free'
}

export type AgentTurnRequest = {
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
  formalScope?: AgentFormalScope
  formalProjectContext?: AgentProjectContext
  conversationId?: string
  sheetId?: string
  activePluginIds?: string[]
}

export type AgentTurnResponse = {
  reply: string
  /** Opaque provider payload. Persist and return it to thinking models, but never render it. */
  reasoningContent?: string
  toolRuns: TutorToolRun[]
  trace: AgentTurnTrace
  visualTeaching?: import('./visual-teaching.ts').VisualTeachingBundle
}

export type AgentTurnStreamEvent =
  | { type: 'trajectory'; event: AgentTrajectoryEvent }
  | { type: 'decision_summary'; summary: AgentDecisionSummary }
  | { type: 'tool_started'; toolCallId: string; toolName: string; title: string; startedAt: number }
  | { type: 'tool_completed'; run: TutorToolRun }
  | {
    type: 'teaching_segment_committed'
    segmentId: string
    skillId: typeof import('./visual-teaching.ts').VISUAL_TEACHING_SKILL_ID
    briefVersion: typeof import('./visual-teaching.ts').VISUAL_TEACHING_BRIEF_VERSION
    modality: import('./visual-teaching.ts').VisualTeachingModality
    content: string
  }
  | { type: 'text_delta'; delta: string }
  | { type: 'text_reset'; reason: 'tool_call' | 'retry' | 'verification' | 'reconcile' }
  | { type: 'done'; result: AgentTurnResponse; requestId?: string }
  | { type: 'error'; error: string; requestId?: string }
