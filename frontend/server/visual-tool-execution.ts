import { generateVisualize } from './visualize-artifact.ts'
import type { VisualTransport } from '../src/visualize.ts'
import type { TutorContextMessage } from '../src/tutor.ts'
import type { TutorToolChoice } from '../src/tooling.ts'
import {
  generateLearningVisual,
  type GenerateText,
  type GeneratedLearningVisual,
  type LearningVisualKind,
  type VisualGenerationStage,
} from './learning-visual-spec.ts'
import { hasVisualTopic } from './visual-spec/intent-contract.ts'
import type { VisualTeachingBrief } from '../src/visual-teaching.ts'
import { visualTeachingContext } from './visual-teaching-skill.ts'
import { compileVisualStoryboard, designAsciiStoryboard } from './visual-storyboard-tool.ts'

export type ResolvedVisualRequest = {
  originalRequest: string
  effectiveRequest: string
  contextEnriched: boolean
  contextSummary?: string
  topicAnchor?: {
    topic: string
    source: 'prior_user' | 'prior_assistant' | 'prior_artifact'
  }
}

export type VisualIntent = 'diagram' | 'animation' | 'none'

export function resolveExplicitVisualIntent(toolChoice: TutorToolChoice, message: string): VisualIntent {
  if (toolChoice === 'animation') return 'animation'
  if (toolChoice === 'image') return 'diagram'
  const normalized = compact(message, 2200)
  if (!normalized) return 'none'
  if (/(?:动画|动图|逐帧|逐步演示|演示(?:一下|过程|变化)|播放(?:过程|变化)|状态(?:如何|怎么)?变化|随时间变化)/i.test(normalized)) {
    return 'animation'
  }
  if (/(?:画(?:一张|个|出)?|图解|流程图|时序图|结构图|关系图|示意图|概念图|知识图|可视化|(?:改成|换成|生成|做成|来一张).{0,8}(?:图片|图))/i.test(normalized)) {
    return 'diagram'
  }
  return 'none'
}

function compact(value: unknown, limit: number) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

/**
 * Keep the learner's tool argument verbatim and add a visibly delimited topic
 * only when the current turn is deictic or underspecified. The added topic is
 * selected chronologically: an explicit new user topic supersedes older
 * artifacts; a completed artifact can refine the topic of its own turn.
 * Failed assistant prose is not a source of topic identity.
 */
export function resolveVisualRequest(
  query: string,
  messages: TutorContextMessage[] = [],
): ResolvedVisualRequest {
  const originalRequest = compact(query, 2200)
  if (!originalRequest) return { originalRequest: '', effectiveRequest: '', contextEnriched: false }
  if (hasVisualTopic(originalRequest)) {
    return { originalRequest, effectiveRequest: originalRequest, contextEnriched: false }
  }

  const prior = [...messages]
  const last = prior[prior.length - 1]
  if (last?.role === 'user' && compact(last.content, 2200) === originalRequest) prior.pop()
  let userIndex = -1
  let artifactIndex = -1
  for (let index = prior.length - 1; index >= 0; index -= 1) {
    if (userIndex < 0 && prior[index].role === 'user' && hasVisualTopic(prior[index].content)) userIndex = index
    if (artifactIndex < 0 && prior[index].toolRuns?.some(run => run.status === 'completed' && run.artifact)) artifactIndex = index
  }
  const priorArtifact = artifactIndex > userIndex ? [...(prior[artifactIndex].toolRuns || [])].reverse()
    .find(run => run.status === 'completed' && run.artifact)?.artifact : undefined
  const artifactSummary = priorArtifact
    ? compact([
      priorArtifact.title,
      priorArtifact.subtitle,
      priorArtifact.readable?.summary,
    ].filter(Boolean).join('：'), 520)
    : ''
  const priorUser = userIndex >= 0 ? compact(prior[userIndex].content, 520) : ''
  const contextSummary = artifactSummary || priorUser
  if (!contextSummary) return { originalRequest, effectiveRequest: originalRequest, contextEnriched: false }
  const topicAnchor = {
    topic: contextSummary,
    source: artifactSummary ? 'prior_artifact' as const : 'prior_user' as const,
  }
  return {
    originalRequest,
    effectiveRequest: `${originalRequest}\n【结构化主题锚点】${JSON.stringify(topicAnchor)}`,
    contextEnriched: true,
    contextSummary,
    topicAnchor,
  }
}

export async function executeLearningVisual(
  kind: LearningVisualKind,
  query: string,
  messages: TutorContextMessage[],
  generate: GenerateText,
  onStage?: (stage: VisualGenerationStage) => void,
  teachingBrief?: VisualTeachingBrief,
  transport?: VisualTransport,
): Promise<{ generated: GeneratedLearningVisual | Awaited<ReturnType<typeof generateVisualize>>; request: ResolvedVisualRequest }> {
  const request = resolveVisualRequest(query, messages)
  if (teachingBrief?.visualSpec) {
    if (!transport) throw new Error('visual_host_required')
    return {generated: await generateVisualize(teachingBrief.visualSpec, kind, teachingBrief.explanation, transport), request}
  }
  if (teachingBrief?.storyboardContext) {
    try {
      const designed = await designAsciiStoryboard(teachingBrief.storyboardContext, generate)
      return { generated: compileVisualStoryboard(designed, kind), request }
    } catch (error) {
      const generated = compileVisualStoryboard(teachingBrief.storyboardContext, kind)
      generated.modelError = error instanceof Error ? error.message : 'ascii_storyboard_design_failed'
      generated.degraded = true
      generated.artifact.degraded = true
      generated.artifact.status = 'degraded'
      generated.artifact.fallbackUsed = true
      return { generated, request }
    }
  }
  const preparedBrief = teachingBrief ? compact(visualTeachingContext(teachingBrief), 12_000) : ''
  const enrichedRequest = preparedBrief
    ? {
      ...request,
      effectiveRequest: `${request.effectiveRequest}\n【已校验视觉教学 Brief】${preparedBrief}`,
      contextEnriched: request.contextEnriched,
    }
    : request
  if (!hasVisualTopic(enrichedRequest.effectiveRequest)) {
    throw new Error('visual_generation_needs_input:visual_topic_context_required')
  }
  const generated = await generateLearningVisual(kind, enrichedRequest.effectiveRequest, generate, { onStage })
  return { generated, request: enrichedRequest }
}
