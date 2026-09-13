import { AI_LATENCY_BUDGETS } from '../src/latency-budgets.ts'

export type LearningVideoPlatform = 'bilibili'

export type VideoTranscriptSegment = {
  startSeconds: number
  endSeconds: number
  text: string
}

export type LearningVideoCandidate = {
  candidateId: string
  platform: LearningVideoPlatform
  platformVideoId: string
  title: string
  url: string
  author: string
  durationSeconds?: number
  views?: number
  publishedAt?: string
  subtitleAvailable: boolean
  language?: string
  reasons: string[]
  verificationState: 'discovered'
  transcriptSegments?: VideoTranscriptSegment[]
}

export type LearningVideoSearchInput = {
  target: string
  goal?: string
  level?: 'beginner' | 'intermediate' | 'advanced'
  language?: string
  maxDurationMinutes?: number
  platforms?: LearningVideoPlatform[]
  maxResults?: number
}

export type LearningVideoConfiguration = {
  fetchImpl?: typeof fetch
  offlineCatalog?: LearningVideoCandidate[]
}

export const FIXED_VIDEO_EVAL_CATALOG: LearningVideoCandidate[] = [
  {
    candidateId: 'bilibili:offline-python-generators', platform: 'bilibili', platformVideoId: 'offline-python-generators',
    title: 'Python generators: iteration without building the whole list',
    url: 'https://www.bilibili.com/video/offline-python-generators', author: 'LearnFlow seeded catalog',
    durationSeconds: 420, subtitleAvailable: false, language: 'en', verificationState: 'discovered',
    reasons: ['离线 seeded 候选', '仅用于标题检索测试'],
  },
  {
    candidateId: 'bilibili:offline-tcp-congestion', platform: 'bilibili', platformVideoId: 'offline-tcp-congestion',
    title: 'TCP 拥塞控制：慢启动到拥塞避免',
    url: 'https://www.bilibili.com/video/offline-tcp-congestion', author: 'LearnFlow seeded catalog',
    durationSeconds: 540, subtitleAvailable: false, language: 'zh-Hans', verificationState: 'discovered',
    reasons: ['离线 seeded 候选', '仅用于标题检索测试'],
  },
]

function clean(value: unknown, limit = 500) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function tokens(value: string) {
  const normalized = clean(value,1600).toLowerCase()
  const result = new Set(normalized.match(/[a-z0-9][a-z0-9+#.-]+/g) || [])
  for (const chunk of normalized.match(/[\u3400-\u9fff]+/g) || []) {
    for (let i=0;i<chunk.length-1;i++) result.add(chunk.slice(i,i+2))
  }
  return result
}

function overlapScore(candidate: string, query: string) {
  const left = tokens(candidate), right = tokens(query)
  let score = 0
  for (const token of right) if (left.has(token) || [...left].some(item => item.includes(token) || token.includes(item))) score += 1
  return score
}

function parseDuration(value: unknown) {
  const parts = String(value || '').split(':').map(Number)
  if (parts.some(Number.isNaN)) return undefined
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  const iso = String(value || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/)
  return iso ? Number(iso[1] || 0) * 3600 + Number(iso[2] || 0) * 60 + Number(iso[3] || 0) : undefined
}

async function searchBilibili(query: string, configuration: LearningVideoConfiguration): Promise<LearningVideoCandidate[]> {
  const fetcher = configuration.fetchImpl || fetch
  const endpoint = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=1&keyword=${encodeURIComponent(query)}`
  const response = await fetcher(endpoint, { headers: { 'User-Agent': 'Mozilla/5.0 LearnFlow/1.0', Referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(AI_LATENCY_BUDGETS.videoProvider) })
  if (!response.ok) throw new Error(`bilibili_search_${response.status}`)
  const payload = await response.json() as any
  if (Number(payload?.code) !== 0) throw new Error(`bilibili_search_${payload?.code || 'invalid'}`)
  return (Array.isArray(payload?.data?.result) ? payload.data.result : []).slice(0, 12).map((item: any) => {
    const bvid = clean(item.bvid || item.id, 40)
    return {
      candidateId: `bilibili:${bvid}`, platform: 'bilibili' as const, platformVideoId: bvid,
      title: clean(item.title, 240), url: `https://www.bilibili.com/video/${bvid}`,
      author: clean(item.author, 120), durationSeconds: parseDuration(item.duration), views: Number(item.play) || undefined,
      publishedAt: item.pubdate ? new Date(Number(item.pubdate) * 1000).toISOString() : undefined,
      subtitleAvailable: false, verificationState: 'discovered' as const,
      reasons: ['仅按标题匹配，未读取视频内容'],
    }
  }).filter((item: LearningVideoCandidate) => item.platformVideoId && item.title)
}

export async function searchLearningVideos(input: LearningVideoSearchInput, configuration: LearningVideoConfiguration = {}) {
  const target = clean(input.target, 500)
  if (!target) throw new Error('target_required')
  const query = target
  const maxResults = Math.max(1, Math.min(10, Number(input.maxResults) || 6))
  const providerStatus: Array<{ platform: LearningVideoPlatform | 'offline'; status: string; count: number }> = []
  let results: LearningVideoCandidate[] = []
  if (configuration.offlineCatalog) {
    results = configuration.offlineCatalog.filter(item => item.platform === 'bilibili')
    providerStatus.push({platform:'offline',status:results.length?'completed':'empty',count:results.length})
  } else {
    try {
      results = await searchBilibili(query, configuration)
      providerStatus.push({platform:'bilibili',status:results.length?'completed':'empty',count:results.length})
    } catch {
      providerStatus.push({platform:'bilibili',status:'failed',count:0})
    }
  }
  const maxSeconds = input.maxDurationMinutes ? Math.max(1, Number(input.maxDurationMinutes)) * 60 : undefined
  const ranked = results.filter(item => !maxSeconds || !item.durationSeconds || item.durationSeconds <= maxSeconds)
    .map(item => ({ item, score: overlapScore(item.title, query) }))
    .filter(({score}) => score > 0)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
    .slice(0, maxResults).map(({ item: {transcriptSegments: _transcript, ...item} }) => ({...item,subtitleAvailable:false,reasons:['仅按标题匹配，未读取视频内容']}))
  return {
    schemaVersion: 'learnflow.learning-video-search.v1',
    query: { target, goal: clean(input.goal), level: input.level, language: clean(input.language), maxDurationMinutes: input.maxDurationMinutes },
    status: ranked.length ? 'ok' : providerStatus.some(item => item.status === 'failed') ? 'failed' : 'empty',
    providers: providerStatus,
    candidates: ranked,
    boundary: '仅检索 Bilibili 视频标题，链接来自搜索结果；未读取字幕、音频或视频内容，不声称内容覆盖、播放可用性或掌握。',
  }
}

/** Compatibility for saved calls; no subtitle, audio or video requests. */
export async function inspectLearningVideo(
  candidateId: string,
  candidates: LearningVideoCandidate[],
  _options: { query?: string; outcomes?: string[]; maxSegments?: number } = {},
  _configuration: LearningVideoConfiguration = {},
) {
  const candidate = candidates.find(item => item.candidateId === candidateId && item.platform === 'bilibili')
  if (!candidate) throw new Error('candidate_not_from_current_search')
  const {transcriptSegments: _transcript, ...metadata} = candidate
  return {
    schemaVersion: 'learnflow.learning-video-inspection.v1',
    candidate: {...metadata,subtitleAvailable:false},
    verificationState: 'metadata_only', transcriptState: 'unavailable',
    segments: [] as VideoTranscriptSegment[], outcomes: [], gaps: ['当前仅支持标题检索，未读取视频内容'],
    answerLeakRisk: false,
    boundary: '仅返回标题检索元数据，不形成内容覆盖或掌握证据。',
  }
}

/** Recover an underspecified follow-up from the preceding user topic. */
export function videoTitleQuery(target: string, messages: Array<{role:string;content:string}> = []) {
  const normalize = (value:string) => clean(value).replace(/^(?:请|帮我|给我|可以|能否|能不能|我想|找|推荐|搜索|检索|看|一个|一些|一段|相关的|相关|的|视频|教程|课程|讲一下|讲解一下|什么是|介绍一下|一下|吗|呢|[，。？！?！\s])+/g,'').replace(/(?:的)?(?:视频|教程)[。？！?！\s]*$/,'').trim()
  const topic = normalize(target)
  if (topic) return topic
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user' || message.content === target) continue
    const prior = normalize(message.content)
    if (prior) return prior
  }
  return ''
}
