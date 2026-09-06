import type { LearningVisualSpec } from './types.ts'

const STRUCTURED_TOPIC_ANCHOR = /【结构化主题锚点】(\{[^\n]+\})/u
const VISUAL_INSTRUCTION_WORDS = /(?:我希望你|我想要|我想|希望|想要|请|帮我|给我|可以|能否|能不能|来|用|做|生成|制作|画|展示|演示|播放|看|讲|讲解|解释|说明|一下|一张|一个|这个|那个|上面|刚才|前面|逐帧|逐步|动态|动画|动图|图解|流程图|时序图|结构图|关系图|示意图|概念图|知识图|可视化|示例|例子|过程|流程|步骤|变化|出来|如何|怎么|的)/gu
const GENERIC_VISUAL_TERMS = new Set([
  'input', 'output', 'process', 'step', 'state', 'example', 'diagram', 'animation',
  '输入', '输出', '处理', '阶段', '状态', '示例', '过程', '流程', '步骤', '变化',
])

function compact(value: unknown, limit = 2200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function anchoredTopic(request: string) {
  const matched = request.match(STRUCTURED_TOPIC_ANCHOR)?.[1]
  if (!matched) return ''
  try {
    const parsed = JSON.parse(matched) as { topic?: unknown }
    return compact(parsed.topic, 700)
  } catch {
    return ''
  }
}

/**
 * Extract a small request-specific vocabulary without maintaining a domain or
 * algorithm allow-list. These terms form a contract between the learner's
 * request and the generated semantic payload; visual UI words never count as
 * subject matter.
 */
export function extractVisualTopicTerms(request: string): string[] {
  const source = anchoredTopic(request) || request.replace(STRUCTURED_TOPIC_ANCHOR, ' ')
  const latin = source.toLowerCase().match(/[a-z][a-z0-9+.#_-]{2,}/g) || []
  const cleaned = source
    .replace(/[a-z][a-z0-9+.#_-]*/gi, ' ')
    .replace(VISUAL_INSTRUCTION_WORDS, ' ')
    .replace(/[\p{P}\p{S}\s]+/gu, ' ')
    .trim()
  const chineseChunks = cleaned
    .split(/(?:从|到|与|和|及|为|把|对|中|里|后|前|再|并|形成|完成|\s+)/u)
    .map(item => item.trim())
    .filter(item => item.length >= 2)
  const chinese = chineseChunks.flatMap(item => {
    if (item.length < 4) return [item]
    const fragments = [item]
    for (const size of [4, 3, 2]) {
      for (let index = 0; index + size <= item.length; index += 1) fragments.push(item.slice(index, index + size))
    }
    return fragments
  })
  return Array.from(new Set([...latin, ...chinese]))
    .filter(term => !GENERIC_VISUAL_TERMS.has(term))
    .sort((left, right) => right.length - left.length)
    .slice(0, 32)
}

export function hasVisualTopic(request: string) {
  return extractVisualTopicTerms(request).length > 0
}

function normalized(value: unknown) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  return compact(serialized, 24_000).toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
}

/** Reject structurally valid but topically empty visuals such as input -> process -> output. */
export function assertVisualTopicCoverage(spec: LearningVisualSpec, request: string) {
  const terms = extractVisualTopicTerms(request)
  if (!terms.length) throw new Error('visual_topic_context_required')
  const content = {
    semantic: spec.semantic,
    frames: spec.kind === 'animation'
      ? spec.frames.map(frame => ({ title: frame.title, narration: frame.narration }))
      : [],
    accessibility: spec.accessibility,
    explanation: spec.explanation,
  }
  const declarativeProcess = spec.generation.repairs.some(repair => repair.code === 'declarative_process_timeline_compiled')
  const corpus = normalized(declarativeProcess ? content : { ...content, title: spec.title, subtitle: spec.subtitle })
  const covered = terms.filter(term => corpus.includes(normalized(term)))
  if (!covered.length) {
    throw new Error(`visual_topic_coverage_missing:${terms.slice(0, 4).join('|')}`)
  }
  return { terms, covered }
}
