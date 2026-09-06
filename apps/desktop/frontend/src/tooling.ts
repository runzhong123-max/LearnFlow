import type { LearningPathPlanProposal, PersonalPathNodeProposal } from './learning-path-graph.ts'
import type { ProjectLearningFileProposal, ProjectRoadmapProposal } from './project.ts'
import type { PluginToolResult } from './plugin-api.ts'

export type TutorToolChoice = 'auto' | 'domain' | 'search' | 'image' | 'animation'

export type SearchSource = {
  id?: string
  title: string
  url: string
  snippet: string
  source: string
  quality: 'official' | 'academic' | 'community' | 'repository'
  role: 'standard' | 'reference' | 'textbook' | 'course' | 'definition' | 'research' | 'example' | 'discussion'
  reason: string
  provider?: string
  facetIds?: string[]
  publishedAt?: string
  retrievedAt?: string
  retrievalScore?: number
  readState?: 'catalog_summary' | 'search_snippet' | 'page_excerpt'
}

export type VisualStep = {
  title: string
  text: string
  svg: string
  /** Plain text is the primary canvas for deterministic ASCII visuals. */
  ascii?: string
  durationMs?: number
  stateDescription?: string
  prediction?: {
    id: string
    prompt: string
    choices: Array<{ id: string; label: string }>
    correctChoiceId: string
    explanation: string
  }
  manifest?: {
    viewport: readonly [number, number, number, number]
    regions: Array<{ id: string; role: string; bounds: readonly [number, number, number, number] }>
    objects: Array<{
      id: string
      role: string
      regionId: string
      bounds: readonly [number, number, number, number]
      value?: string | number | boolean | null
      status?: string
    }>
  }
}

export type VisualArtifact = {
  kind: 'image' | 'animation'
  title: string
  subtitle: string
  steps: VisualStep[]
  specVersion?: string
  domain?: 'computer' | 'mathematics' | 'general'
  abstraction?: string
  renderer?: string
  canvasFormat?: 'svg' | 'ascii'
  quality?: { score: number; issues: string[]; repaired: boolean }
  fallbackUsed?: boolean
  readable?: {
    summary: string
    readingOrder: string[]
    frameDescriptions: string[]
    nonColorStateCue: string
  }
}

export type TutorToolRun = {
  id: string
  kind: 'memory' | 'workspace' | 'domain' | 'review' | 'path' | 'project' | 'assessment' | 'file' | 'search' | 'video' | 'image' | 'animation' | 'plugin'
  status: 'running' | 'completed' | 'failed'
  title: string
  detail: string
  durationMs: number
  startedAt?: number
  sequence?: number
  toolName?: string
  toolCallId?: string
  inputSummary?: string
  observationSummary?: string
  errorType?: 'transient' | 'model_recoverable' | 'user_fixable' | 'unexpected'
  visualMeta?: {
    requestedKind: 'diagram' | 'animation'
    effectiveKind: 'diagram' | 'animation'
    contextEnriched: boolean
    generationSource: 'deterministic_compiler' | 'context_compiler' | 'model_plan' | 'deterministic_template' | 'legacy_reader'
    compileStatus: 'exact' | 'illustrative_example' | 'not_applicable' | 'ambiguous' | 'invalid'
    plannerAttempts: number
    syntaxRepairApplied?: boolean
    plannerDiagnostics?: Array<{
      attempt: 1 | 2
      stage: 'planner' | 'repair'
      timeoutMs: number
      durationMs: number
      status: 'accepted' | 'rejected'
      outputChars: number
      errorType?: 'timeout' | 'syntax' | 'validation' | 'provider' | 'unexpected'
    }>
    outcomeStage: 'rendered' | 'planner' | 'validation' | 'layout'
    skillId?: 'visual_teaching_composition'
    briefVersion?: 'learnflow.visual-teaching-brief.v1'
    explanationPreserved?: boolean
  }
  sources?: SearchSource[]
  searchMeta?: {
    intent?: string
    depth?: string
    status?: string
    coverageRatio?: number
    coverageGaps?: string[]
    pageRead?: boolean
  }
  artifact?: VisualArtifact
  pathProposal?: PersonalPathNodeProposal
  pathPlanProposal?: LearningPathPlanProposal
  projectRoadmapProposal?: ProjectRoadmapProposal
  projectLearningFileProposal?: ProjectLearningFileProposal
  assessmentBlueprint?: {
    id: number
    rubricId: number
    title: string
    purpose: string
    itemCount: number
  }
  learningFile?: {
    kind: 'lecture' | 'practice' | 'source'
    ref: string
    title: string
    checkpointId?: number
    questionCount?: number
    qualityStatus?: string
  }
  plugin?: {
    pluginId: string
    toolId: string
    result: PluginToolResult
  }
}

export const TOOL_CHOICE_LABELS: Record<TutorToolChoice, string> = {
  auto: '自动',
  domain: '对话资料',
  search: '联网搜索',
  image: '生成图解',
  animation: '生成动画',
}

export function isTutorToolChoice(value: unknown): value is TutorToolChoice {
  return value === 'auto' || value === 'domain' || value === 'search' || value === 'image' || value === 'animation'
}
