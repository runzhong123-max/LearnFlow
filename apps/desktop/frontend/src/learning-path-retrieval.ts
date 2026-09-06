export type SearchableLearningPathNode = {
  id: string
  title: string
  summary: string
  aliases: string[]
  domains: string[]
  origin: 'official' | 'personal'
  order: number
}

export type LearningPathMatchReason =
  | 'exact_id'
  | 'exact_title'
  | 'exact_alias'
  | 'title_contains_query'
  | 'query_contains_title'
  | 'spelling_similarity'
  | 'alias_similarity'
  | 'domain_overlap'
  | 'summary_overlap'

export type LearningPathRetrievalCandidate = {
  nodeId: string
  title: string
  origin: 'official' | 'personal'
  confidence: number
  score: number
  rankFusionScore: number
  reasons: LearningPathMatchReason[]
  matchedText: string
  scoreBreakdown: {
    identity: number
    lexical: number
    spelling: number
    topical: number
  }
}

export type LearningPathRetrievalResult = {
  query: string
  normalizedQuery: string
  mode: 'exact' | 'fuzzy'
  resolution: 'resolved' | 'ambiguous' | 'not_found'
  candidates: LearningPathRetrievalCandidate[]
  omittedCandidateCount: number
  policyId: 'vnext-learning-path-retrieval-v3'
  recommendedNextAction: 'use_match' | 'run_fuzzy_search' | 'ask_disambiguation' | 'research_graph_gap'
}

const LEADING_INTENT = /^(?:请你?|麻烦你?|帮我|给我|我想要?|我想|我准备|我打算|我希望|想要?|想|需要)?\s*(?:看看|规划(?:一下)?|深入(?:地)?|完整(?:地)?|从零开始)?\s*(?:学习|学会|了解|研究|掌握|规划|学|做|开发)?\s*/i
const TRAILING_INTENT = /(?:的)?\s*(?:学习)?\s*(?:路线|路径|规划|课程|先修|前置(?:知识|课程)?|怎么学|如何学|该学什么|要学什么|相关内容|相关知识|方向|研究)\s*[？?。！!]*$/i
const GENERIC_TOPICS = new Set(['计算机', '课程', '方向', '未来', '知识', '技能', '学习', '规划'])

export function normalizeLearningPathText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase()
    .replace(/[學習網絡統計數據庫軟體應用開發]/g, character => ({
      學: '学', 習: '习', 網: '网', 絡: '络', 統: '统', 計: '计', 數: '数', 據: '据',
      庫: '库', 軟: '软', 體: '体', 應: '应', 用: '用', 開: '开', 發: '发',
    }[character] || character))
    .replace(/软体/g, '软件')
    .replace(/原里/g, '原理')
    .replace(/人工智能代理/g, 'aiagent')
    .replace(/智能体开发/g, 'agent开发')
    .replace(/[‐-―]/g, '-')
    .replace(/[^a-z0-9+#\u4e00-\u9fff]+/g, '')
}

export function extractLearningPathTopic(message: string) {
  let value = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 240)
  const quoted = value.match(/[“「『\"]([^”」』\"]{2,80})[”」』\"]/)?.[1]
  if (quoted) value = quoted
  value = value.replace(/^(?:(?:作为|身为|我是)?\s*(?:一名)?\s*(?:高职|专科|本科|硕士|博士|大学)?(?:生|学生|研究生)\s*(?:，|,)?\s*)/i, '')
  value = value.replace(/^(?:(?:我)?(?:想|准备|打算|希望|需要)\s*)?(?:(?:用|在|计划用)\s*)?(?:(?:\d{1,2}|半|一|两|三|四|五|六|七|八|九|十)\s*(?:周|个月|月|年)|本学期|这学期|暑假|寒假)\s*/i, '')
  const fromTopic = value.match(/(?:我想)?从\s*([A-Za-z0-9+#.\u4e00-\u9fff ]{2,64}?)\s*(?:走向|转向|深入)/i)?.[1]
  if (fromTopic) value = fromTopic
  const focused = value.match(/^(?:(?:请你?|麻烦你?|帮我|给我)\s*)?(?:(?:我)?(?:想|准备|打算|希望|需要)\s*)?(?:系统(?:地)?学习|深入(?:地)?学习|学习|学会|了解|研究|掌握|规划|做)\s*([A-Za-z0-9+#.\u4e00-\u9fff ]{2,96}?)(?=\s*(?:并|，|。|、|然后|并且|以及|做一个|做项目|路线|路径|规划|$))/i)?.[1]
  if (focused) value = focused
  // “规划 Agent 开发的学习路线”中的“的学习”是路线句式，不是主题本身。
  // 先在 focused 片段上去掉它，避免精确查找被迫退化成模糊检索。
  value = value.replace(/的学习$/i, '').trim()
  value = value
    .replace(/[，,；;：:]\s*(?:需要|要|应该|该|然后|并完成|并做|怎么|如何|有哪些|有什么|请|希望)[\s\S]*$/i, '')
    .replace(/(?:的)?\s*(?:区别|差异|对比)\s*[？?。！!]*$/i, '')
    .replace(LEADING_INTENT, '').replace(TRAILING_INTENT, '').trim()
  value = value.replace(/^(?:一下|关于|一门|一个)/, '').trim()
  if (!value || GENERIC_TOPICS.has(value)) return ''
  return value.slice(0, 96)
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value))
}

function damerauLevenshtein(left: string, right: string) {
  if (left === right) return 0
  if (!left.length) return right.length
  if (!right.length) return left.length
  const matrix = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0))
  for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i
  for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      )
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + cost)
      }
    }
  }
  return matrix[left.length][right.length]
}

function spellingSimilarity(left: string, right: string) {
  const longest = Math.max(left.length, right.length)
  if (!longest) return 0
  return clamp(1 - damerauLevenshtein(left, right) / longest)
}

function grams(value: string) {
  if (value.length <= 2) return new Set(value ? [value] : [])
  const result = new Set<string>()
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2))
  return result
}

function diceSimilarity(left: string, right: string) {
  const leftGrams = grams(left), rightGrams = grams(right)
  if (!leftGrams.size || !rightGrams.size) return 0
  let overlap = 0
  leftGrams.forEach(item => { if (rightGrams.has(item)) overlap += 1 })
  return (2 * overlap) / (leftGrams.size + rightGrams.size)
}

function tokenSet(value: string) {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
  const latin = normalized.match(/[a-z0-9+#]{2,}/g) || []
  const chinese = normalized.match(/[\u4e00-\u9fff]{2,}/g) || []
  return new Set([...latin, ...chinese.flatMap(token => [...grams(token)])])
}

function overlapRatio(query: string, value: string) {
  const queryTokens = tokenSet(query), valueTokens = tokenSet(value)
  if (!queryTokens.size || !valueTokens.size) return 0
  let overlap = 0
  queryTokens.forEach(item => { if (valueTokens.has(item)) overlap += 1 })
  return overlap / queryTokens.size
}

function rankMap(values: Array<{ nodeId: string; score: number }>, minimum: number) {
  const filtered = values.filter(item => item.score >= minimum)
    .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId))
  return new Map(filtered.map((item, index) => [item.nodeId, index + 1]))
}

function exactCandidate(node: SearchableLearningPathNode, normalizedQuery: string): LearningPathRetrievalCandidate | undefined {
  const normalizedId = normalizeLearningPathText(node.id)
  const normalizedTitle = normalizeLearningPathText(node.title)
  const alias = node.aliases.find(item => normalizeLearningPathText(item) === normalizedQuery)
  const reason: LearningPathMatchReason | undefined = normalizedId === normalizedQuery
    ? 'exact_id' : normalizedTitle === normalizedQuery ? 'exact_title' : alias ? 'exact_alias' : undefined
  if (!reason) return undefined
  return {
    nodeId: node.id,
    title: node.title,
    origin: node.origin,
    confidence: reason === 'exact_alias' ? 0.98 : 1,
    score: reason === 'exact_alias' ? 98 : 100,
    rankFusionScore: 1,
    reasons: [reason],
    matchedText: alias || (reason === 'exact_id' ? node.id : node.title),
    scoreBreakdown: { identity: reason === 'exact_alias' ? 0.98 : 1, lexical: 1, spelling: 1, topical: 1 },
  }
}

export function lookupExactLearningPath(
  nodes: SearchableLearningPathNode[],
  rawQuery: string,
  limit = 5,
): LearningPathRetrievalResult {
  const raw = String(rawQuery || '').trim().slice(0, 240)
  const extracted = extractLearningPathTopic(raw)
  const queryCandidates = [...new Set([raw, extracted].filter(Boolean))]
  let query = queryCandidates[0] || ''
  let normalizedQuery = normalizeLearningPathText(query)
  let all: LearningPathRetrievalCandidate[] = []
  for (const candidateQuery of queryCandidates) {
    const normalizedCandidate = normalizeLearningPathText(candidateQuery)
    const matches = normalizedCandidate ? nodes.flatMap(node => {
      const candidate = exactCandidate(node, normalizedCandidate)
      return candidate ? [candidate] : []
    }) : []
    if (matches.length) {
      query = candidateQuery
      normalizedQuery = normalizedCandidate
      all = matches
      break
    }
  }
  all.sort((left, right) => right.confidence - left.confidence || left.title.localeCompare(right.title))
  const resolution = all.length === 1 ? 'resolved' : all.length > 1 ? 'ambiguous' : 'not_found'
  return {
    query,
    normalizedQuery,
    mode: 'exact',
    resolution,
    candidates: all.slice(0, Math.max(1, Math.min(limit, 10))),
    omittedCandidateCount: Math.max(0, all.length - limit),
    policyId: 'vnext-learning-path-retrieval-v3',
    recommendedNextAction: resolution === 'resolved' ? 'use_match'
      : resolution === 'ambiguous' ? 'ask_disambiguation' : 'run_fuzzy_search',
  }
}

export function searchFuzzyLearningPath(
  nodes: SearchableLearningPathNode[],
  rawQuery: string,
  limit = 6,
): LearningPathRetrievalResult {
  const query = extractLearningPathTopic(rawQuery) || String(rawQuery || '').trim().slice(0, 96)
  const normalizedQuery = normalizeLearningPathText(query)
  if (!normalizedQuery) return {
    query, normalizedQuery, mode: 'fuzzy', resolution: 'not_found', candidates: [], omittedCandidateCount: 0,
    policyId: 'vnext-learning-path-retrieval-v3', recommendedNextAction: 'research_graph_gap',
  }

  const scored = nodes.map(node => {
    const labels = [node.title, ...node.aliases]
    const normalizedLabels = labels.map(normalizeLearningPathText).filter(Boolean)
    const exact = exactCandidate(node, normalizedQuery)
    const containment = Math.max(0, ...normalizedLabels.map(label => {
      if (label.includes(normalizedQuery)) return normalizedQuery.length / Math.max(1, label.length)
      if (normalizedQuery.includes(label)) return label.length / Math.max(1, normalizedQuery.length)
      return 0
    }))
    const spelling = Math.max(0, ...normalizedLabels.map(label => Math.max(
      spellingSimilarity(normalizedQuery, label),
      diceSimilarity(normalizedQuery, label),
    )))
    const aliasSpelling = Math.max(0, ...node.aliases.map(alias => Math.max(
      spellingSimilarity(normalizedQuery, normalizeLearningPathText(alias)),
      diceSimilarity(normalizedQuery, normalizeLearningPathText(alias)),
    )))
    const domainOverlap = Math.max(0, ...node.domains.map(domain => overlapRatio(query, domain)))
    const summaryOverlap = overlapRatio(query, `${node.title} ${node.aliases.join(' ')} ${node.domains.join(' ')} ${node.summary}`)
    const identity = exact?.confidence || 0
    const lexical = Math.max(identity, containment)
    const topical = Math.max(domainOverlap, summaryOverlap * 0.82)
    const reasons: LearningPathMatchReason[] = exact ? [...exact.reasons] : []
    let matchedText = exact?.matchedText || node.title
    if (!exact && containment > 0) {
      const queryContains = normalizedLabels.some(label => normalizedQuery.includes(label))
      reasons.push(queryContains ? 'query_contains_title' : 'title_contains_query')
    }
    if (!exact && spelling >= 0.56) reasons.push(aliasSpelling >= spelling - 0.01 ? 'alias_similarity' : 'spelling_similarity')
    if (domainOverlap >= 0.35) reasons.push('domain_overlap')
    if (summaryOverlap >= 0.3) reasons.push('summary_overlap')
    if (aliasSpelling >= spelling - 0.01 && node.aliases.length) {
      matchedText = [...node.aliases].sort((left, right) => {
        const leftScore = spellingSimilarity(normalizedQuery, normalizeLearningPathText(left))
        const rightScore = spellingSimilarity(normalizedQuery, normalizeLearningPathText(right))
        return rightScore - leftScore
      })[0]
    }
    return { node, identity, lexical, spelling, topical, reasons: [...new Set(reasons)], matchedText }
  })

  const identityRanks = rankMap(scored.map(item => ({ nodeId: item.node.id, score: item.lexical })), 0.28)
  const spellingRanks = rankMap(scored.map(item => ({ nodeId: item.node.id, score: item.spelling })), 0.44)
  const topicalRanks = rankMap(scored.map(item => ({ nodeId: item.node.id, score: item.topical })), 0.16)
  const rankConstant = 20
  const maxFusion = 3 / (rankConstant + 1)
  const candidates = scored.flatMap(item => {
    const ranks = [identityRanks.get(item.node.id), spellingRanks.get(item.node.id), topicalRanks.get(item.node.id)]
      .filter((rank): rank is number => Boolean(rank))
    if (!ranks.length) return []
    const rankFusionScore = ranks.reduce((sum, rank) => sum + 1 / (rankConstant + rank), 0) / maxFusion
    const specificityPenalty = item.lexical > 0 && normalizedQuery.includes(normalizeLearningPathText(item.node.title))
      ? Math.max(0, 1 - normalizeLearningPathText(item.node.title).length / normalizedQuery.length) * 0.35 : 0
    const confidence = clamp(
      item.identity
      || (item.lexical * 0.34 + item.spelling * 0.34 + item.topical * 0.12 + rankFusionScore * 0.2 - specificityPenalty),
    )
    if (confidence < 0.28) return []
    return [{
      nodeId: item.node.id,
      title: item.node.title,
      origin: item.node.origin,
      confidence,
      score: Math.round(confidence * 100),
      rankFusionScore,
      reasons: item.reasons,
      matchedText: item.matchedText,
      scoreBreakdown: {
        identity: item.identity,
        lexical: item.lexical,
        spelling: item.spelling,
        topical: item.topical,
      },
    } satisfies LearningPathRetrievalCandidate]
  }).sort((left, right) => right.confidence - left.confidence
    || right.rankFusionScore - left.rankFusionScore
    || nodes.find(node => node.id === left.nodeId)!.order - nodes.find(node => node.id === right.nodeId)!.order
    || left.nodeId.localeCompare(right.nodeId))

  const top = candidates[0], second = candidates[1]
  const margin = top ? top.confidence - (second?.confidence || 0) : 0
  const exactResolved = Boolean(top?.reasons.some(reason => ['exact_id', 'exact_title', 'exact_alias'].includes(reason)))
  const broadAmbiguity = normalizedQuery.length <= 3 && candidates.filter(item => item.confidence >= 0.34).length > 1
  const compoundExtension = Boolean(top?.reasons.includes('query_contains_title')
    && normalizedQuery.length >= normalizeLearningPathText(top.matchedText).length + 2
    && !exactResolved)
  const strongSpellingResolution = Boolean(top && top.scoreBreakdown.spelling >= 0.8 && margin >= 0.12 && !compoundExtension)
  const resolution: LearningPathRetrievalResult['resolution'] = !top || top.confidence < 0.48 || (compoundExtension && top.confidence < 0.72)
    ? 'not_found'
    : exactResolved || strongSpellingResolution || (top.confidence >= 0.67 && margin >= 0.07 && !broadAmbiguity)
      ? 'resolved'
      : 'ambiguous'
  const boundedLimit = Math.max(1, Math.min(limit, 10))
  return {
    query,
    normalizedQuery,
    mode: 'fuzzy',
    resolution,
    candidates: candidates.slice(0, boundedLimit),
    omittedCandidateCount: Math.max(0, candidates.length - boundedLimit),
    policyId: 'vnext-learning-path-retrieval-v3',
    recommendedNextAction: resolution === 'resolved' ? 'use_match'
      : resolution === 'ambiguous' ? 'ask_disambiguation' : 'research_graph_gap',
  }
}
