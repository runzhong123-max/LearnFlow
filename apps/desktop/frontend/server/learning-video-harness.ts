import { AI_LATENCY_BUDGETS } from '../src/latency-budgets.ts'

export type LearningVideoPlatform = 'bilibili' | 'youtube'

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
  youtubeApiKey?: string
  offlineCatalog?: LearningVideoCandidate[]
}

export const FIXED_VIDEO_EVAL_CATALOG: LearningVideoCandidate[] = [
  {
    candidateId: 'youtube:offline-python-generators', platform: 'youtube', platformVideoId: 'offline-python-generators',
    title: 'Python generators: iteration without building the whole list',
    url: 'https://www.youtube.com/watch?v=offline-python-generators', author: 'LearnFlow seeded catalog',
    durationSeconds: 420, subtitleAvailable: true, language: 'en', verificationState: 'discovered',
    reasons: ['离线 seeded 候选', '包含可核验字幕与时间点'],
    transcriptSegments: [
      { startSeconds: 0, endSeconds: 42, text: 'A generator produces values lazily instead of building an entire list in memory.' },
      { startSeconds: 42, endSeconds: 110, text: 'A function containing yield returns a generator iterator and resumes after each yield.' },
      { startSeconds: 110, endSeconds: 190, text: 'Use next to request the next value. StopIteration marks exhaustion.' },
      { startSeconds: 190, endSeconds: 300, text: 'Generators are useful for streams and large inputs, but they are normally consumed once.' },
    ],
  },
  {
    candidateId: 'bilibili:offline-tcp-congestion', platform: 'bilibili', platformVideoId: 'offline-tcp-congestion',
    title: 'TCP 拥塞控制：慢启动到拥塞避免',
    url: 'https://www.bilibili.com/video/offline-tcp-congestion', author: 'LearnFlow seeded catalog',
    durationSeconds: 540, subtitleAvailable: true, language: 'zh-Hans', verificationState: 'discovered',
    reasons: ['离线 seeded 候选', '包含可核验字幕与时间点'],
    transcriptSegments: [
      { startSeconds: 0, endSeconds: 55, text: '拥塞窗口 cwnd 限制发送方在途数据量，接收窗口解决的是接收端容量问题。' },
      { startSeconds: 55, endSeconds: 150, text: '慢启动阶段让拥塞窗口按往返轮次近似指数增长，直到门限或检测到拥塞。' },
      { startSeconds: 150, endSeconds: 260, text: '拥塞避免阶段改为线性增长，以更谨慎地探测可用带宽。' },
    ],
  },
]

function clean(value: unknown, limit = 500) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function tokens(value: string) {
  return new Set(clean(value, 1600).toLowerCase().split(/[^\p{L}\p{N}+#.-]+/u).filter(item => item.length > 1))
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
      reasons: ['标题与学习目标相关', '已核验公开可用性，内容仍待字幕核验'],
    }
  }).filter((item: LearningVideoCandidate) => item.platformVideoId && item.title)
}

async function searchYouTube(query: string, configuration: LearningVideoConfiguration): Promise<LearningVideoCandidate[]> {
  if (!configuration.youtubeApiKey) return []
  const fetcher = configuration.fetchImpl || fetch
  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search')
  searchUrl.search = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '12', q: query, key: configuration.youtubeApiKey }).toString()
  const response = await fetcher(searchUrl, { signal: AbortSignal.timeout(AI_LATENCY_BUDGETS.videoProvider) })
  if (!response.ok) throw new Error(`youtube_search_${response.status}`)
  const payload = await response.json() as any
  const items = Array.isArray(payload?.items) ? payload.items : []
  const ids = items.map((item: any) => clean(item?.id?.videoId, 30)).filter(Boolean)
  let details = new Map<string, any>()
  if (ids.length) {
    const detailsUrl = new URL('https://www.googleapis.com/youtube/v3/videos')
    detailsUrl.search = new URLSearchParams({ part: 'contentDetails,statistics,status', id: ids.join(','), key: configuration.youtubeApiKey }).toString()
    const detailResponse = await fetcher(detailsUrl, { signal: AbortSignal.timeout(AI_LATENCY_BUDGETS.videoProvider) })
    if (detailResponse.ok) {
      const detailPayload = await detailResponse.json() as any
      details = new Map((detailPayload.items || []).map((item: any) => [item.id, item]))
    }
  }
  return items.map((item: any) => {
    const videoId = clean(item?.id?.videoId, 30), detail = details.get(videoId)
    return {
      candidateId: `youtube:${videoId}`, platform: 'youtube' as const, platformVideoId: videoId,
      title: clean(item?.snippet?.title, 240), url: `https://www.youtube.com/watch?v=${videoId}`,
      author: clean(item?.snippet?.channelTitle, 120), durationSeconds: parseDuration(detail?.contentDetails?.duration),
      views: Number(detail?.statistics?.viewCount) || undefined, publishedAt: item?.snippet?.publishedAt,
      subtitleAvailable: Boolean(detail?.contentDetails?.caption && detail.contentDetails.caption !== 'false'),
      language: item?.snippet?.defaultAudioLanguage || item?.snippet?.defaultLanguage,
      verificationState: 'discovered' as const,
      reasons: ['标题与学习目标相关', 'YouTube Data API 已核验可用性，内容仍待字幕核验'],
    }
  }).filter((item: LearningVideoCandidate) => item.platformVideoId && item.title)
}

export async function searchLearningVideos(input: LearningVideoSearchInput, configuration: LearningVideoConfiguration = {}) {
  const target = clean(input.target, 500)
  if (!target) throw new Error('target_required')
  const query = clean([target, input.goal, input.level, input.language].filter(Boolean).join(' '), 900)
  const platforms = input.platforms?.length ? input.platforms : ['bilibili', 'youtube']
  const maxResults = Math.max(1, Math.min(10, Number(input.maxResults) || 6))
  const providerStatus: Array<{ platform: LearningVideoPlatform | 'offline'; status: string; count: number }> = []
  const results: LearningVideoCandidate[] = []
  for (const platform of platforms) {
    try {
      const found = platform === 'bilibili' ? await searchBilibili(query, configuration) : await searchYouTube(query, configuration)
      results.push(...found)
      providerStatus.push({ platform, status: found.length ? 'completed' : platform === 'youtube' && !configuration.youtubeApiKey ? 'not_configured' : 'empty', count: found.length })
    } catch {
      providerStatus.push({ platform, status: 'failed', count: 0 })
    }
  }
  const offline = (configuration.offlineCatalog || []).filter(item => platforms.includes(item.platform) && overlapScore(`${item.title} ${item.transcriptSegments?.map(segment => segment.text).join(' ')}`, query) > 0)
  if (!results.length) {
    results.push(...offline)
    providerStatus.push({ platform: 'offline', status: offline.length ? 'completed' : 'empty', count: offline.length })
  }
  const maxSeconds = input.maxDurationMinutes ? Math.max(1, Number(input.maxDurationMinutes)) * 60 : undefined
  const ranked = results.filter(item => !maxSeconds || !item.durationSeconds || item.durationSeconds <= maxSeconds)
    .map(item => ({ item, score: overlapScore(item.title, query) * 10 + (item.subtitleAvailable ? 4 : 0) + Math.log10((item.views || 0) + 1) }))
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
    .slice(0, maxResults).map(({ item }) => item)
  return {
    schemaVersion: 'learnflow.learning-video-search.v1',
    query: { target, goal: clean(input.goal), level: input.level, language: clean(input.language), maxDurationMinutes: input.maxDurationMinutes },
    status: ranked.length ? (providerStatus.some(item => item.status === 'failed') ? 'partial' : 'ok') : 'empty',
    providers: providerStatus,
    candidates: ranked,
    boundary: 'discovered 只表示候选可用且元数据相关；必须 inspect 后才能声称内容覆盖，搜索或观看都不是掌握证据。',
  }
}

async function inspectBilibili(candidate: LearningVideoCandidate, configuration: LearningVideoConfiguration) {
  const fetcher = configuration.fetchImpl || fetch
  const headers = { 'User-Agent': 'Mozilla/5.0 LearnFlow/1.0', Referer: candidate.url }
  const view = await fetcher(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(candidate.platformVideoId)}`, { headers, signal: AbortSignal.timeout(AI_LATENCY_BUDGETS.videoProvider) })
  if (!view.ok) throw new Error(`bilibili_view_${view.status}`)
  const viewPayload = await view.json() as any
  const cid = viewPayload?.data?.cid
  if (!cid) throw new Error('bilibili_cid_missing')
  const player = await fetcher(`https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(candidate.platformVideoId)}&cid=${cid}`, { headers, signal: AbortSignal.timeout(AI_LATENCY_BUDGETS.videoProvider) })
  const playerPayload = player.ok ? await player.json() as any : {}
  const subtitles = Array.isArray(playerPayload?.data?.subtitle?.subtitles) ? playerPayload.data.subtitle.subtitles : []
  const selected = subtitles.find((item: any) => /zh|en/i.test(String(item.lan || ''))) || subtitles[0]
  if (!selected?.subtitle_url) return [] as VideoTranscriptSegment[]
  const subtitleUrl = String(selected.subtitle_url).startsWith('//') ? `https:${selected.subtitle_url}` : String(selected.subtitle_url)
  const subtitleResponse = await fetcher(subtitleUrl, { headers, signal: AbortSignal.timeout(AI_LATENCY_BUDGETS.videoProvider) })
  if (!subtitleResponse.ok) throw new Error(`bilibili_subtitle_${subtitleResponse.status}`)
  const subtitlePayload = await subtitleResponse.json() as any
  return (Array.isArray(subtitlePayload?.body) ? subtitlePayload.body : []).slice(0, 1200).map((item: any) => ({
    startSeconds: Number(item.from) || 0, endSeconds: Number(item.to) || Number(item.from) || 0, text: clean(item.content, 800),
  })).filter((item: VideoTranscriptSegment) => item.text)
}

export async function inspectLearningVideo(
  candidateId: string,
  candidates: LearningVideoCandidate[],
  options: { query?: string; outcomes?: string[]; maxSegments?: number } = {},
  configuration: LearningVideoConfiguration = {},
) {
  const candidate = candidates.find(item => item.candidateId === candidateId)
  if (!candidate) throw new Error('candidate_not_from_current_search')
  let transcript = candidate.transcriptSegments || []
  let transcriptState: 'subtitle' | 'unavailable' | 'asr_required' = transcript.length ? 'subtitle' : 'unavailable'
  if (!transcript.length && candidate.platform === 'bilibili') {
    try { transcript = await inspectBilibili(candidate, configuration) } catch { transcript = [] }
    transcriptState = transcript.length ? 'subtitle' : 'asr_required'
  } else if (!transcript.length && candidate.platform === 'youtube') {
    transcriptState = candidate.subtitleAvailable ? 'asr_required' : 'asr_required'
  }
  const query = clean(options.query || options.outcomes?.join(' ') || candidate.title, 900)
  const maxSegments = Math.max(1, Math.min(16, Number(options.maxSegments) || 8))
  const segments = transcript.map(segment => ({ segment, score: overlapScore(segment.text, query) }))
    .sort((a, b) => b.score - a.score || a.segment.startSeconds - b.segment.startSeconds)
    .slice(0, maxSegments).map(item => item.segment).sort((a, b) => a.startSeconds - b.startSeconds)
  const corpus = transcript.map(item => item.text).join(' ')
  const outcomes = (options.outcomes || []).slice(0, 8).map(outcome => ({
    outcome: clean(outcome, 300), covered: overlapScore(corpus, outcome) > 0,
  }))
  const answerLeakRisk = /(?:正确答案|答案是|标准答案|选项\s*[A-D]|answer is)/i.test(corpus)
  return {
    schemaVersion: 'learnflow.learning-video-inspection.v1',
    candidate: { ...candidate, transcriptSegments: undefined },
    verificationState: transcript.length ? 'content_inspected' : 'metadata_only',
    transcriptState,
    segments,
    outcomes,
    gaps: [
      ...(!transcript.length ? ['没有取得可核验字幕；需要显式 ASR 适配器后才能确认内容覆盖'] : []),
      ...outcomes.filter(item => !item.covered).map(item => `未在字幕中定位：${item.outcome}`),
    ],
    answerLeakRisk,
    boundary: '字幕核验只支持资源选择与带时间点阅读，不形成 LearningAttempt、掌握或迁移证据。',
  }
}
