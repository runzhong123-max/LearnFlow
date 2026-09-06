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
  if (/(?:画(?:一张|个|出)?|图解|流程图|时序图|结构图|关系图|示意图|概念图|知识图|可视化)/i.test(normalized)) {
    return 'diagram'
  }
  return 'none'
}

const VISUAL_ONLY = /(?:动画|动图|逐帧|演示|画|图解|流程图|时序图|结构图|关系图|示意图|概念图|知识图|可视化)/gi
const DEICTIC = /(?:这个|那个|它|他(?:的)?|上面|刚才|前面|演示出来|画出来|这个流程|该过程|这种变化)/i
const TOPIC_SIGNAL = /(?:算法|协议|网络|矩阵|函数|概率|贝叶斯|梯度|卷积|cnn|transformer|事件循环|dijkstra|迪杰斯特拉|tcp|http|数据结构|状态机|联邦学习|神经网络)/i

function compact(value: unknown, limit: number) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function subjectStrength(value: string) {
  const withoutVisualWords = value.replace(VISUAL_ONLY, '').replace(/[：:，,。.!！?？\s]/g, '')
  if (TOPIC_SIGNAL.test(value)) return 3
  if (!DEICTIC.test(value) && withoutVisualWords.length >= 10) return 2
  if (!DEICTIC.test(value) && withoutVisualWords.length >= 5) return 1
  return 0
}

/**
 * Keep the learner's tool argument verbatim and add a visibly delimited topic
 * only when the current turn is deictic or underspecified. The added topic is
 * selected from the latest validated visual artifact first, then prior user
 * turns; assistant text is a last-resort hint.
 */
export function resolveVisualRequest(
  query: string,
  messages: TutorContextMessage[] = [],
): ResolvedVisualRequest {
  const originalRequest = compact(query, 2200)
  if (!originalRequest) return { originalRequest: '', effectiveRequest: '', contextEnriched: false }
  if (hasVisualTopic(originalRequest) && !DEICTIC.test(originalRequest)) {
    return { originalRequest, effectiveRequest: originalRequest, contextEnriched: false }
  }

  const prior = [...messages]
    .reverse()
    .filter(message => compact(message.content, 2200) !== originalRequest)
  const priorArtifact = prior
    .flatMap(message => [...(message.toolRuns || [])].reverse())
    .find(run => run.status === 'completed' && run.artifact)
    ?.artifact
  const artifactSummary = priorArtifact
    ? compact([
      priorArtifact.title,
      priorArtifact.subtitle,
      priorArtifact.readable?.summary,
    ].filter(Boolean).join('：'), 520)
    : ''
  const priorUser = prior
    .filter(message => message.role === 'user')
    .map(message => compact(message.content, 280))
    .find(candidate => subjectStrength(candidate) >= 1 && hasVisualTopic(candidate))
  const priorAssistant = prior
    .filter(message => message.role === 'assistant')
    .map(message => compact(message.content, 240).split(/[。！？\n]/)[0])
    .find(candidate => subjectStrength(candidate) >= 1 && hasVisualTopic(candidate))
  const contextSummary = artifactSummary || priorUser || priorAssistant
  if (!contextSummary) return { originalRequest, effectiveRequest: originalRequest, contextEnriched: false }
  const topicAnchor = {
    topic: contextSummary,
    source: artifactSummary ? 'prior_artifact' as const : priorUser ? 'prior_user' as const : 'prior_assistant' as const,
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
): Promise<{ generated: GeneratedLearningVisual; request: ResolvedVisualRequest }> {
  const request = resolveVisualRequest(query, messages)
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
