import {
  extractLearningPathTopic,
  lookupExactLearningPath,
  normalizeLearningPathText,
  searchFuzzyLearningPath,
  type LearningPathRetrievalCandidate,
  type LearningPathRetrievalResult,
} from './learning-path-retrieval.ts'

export type PathNodeOrigin = 'official' | 'personal'
export type PathEdgeKind = 'hard_prerequisite' | 'soft_prerequisite' | 'co_learning'
export type LearnerPathStatus = 'unmarked' | 'exploring' | 'self_reported_exposed' | 'self_reported_mastered'
export type PathAudience = 'vocational' | 'undergraduate' | 'graduate' | 'self_directed'
export type PathStage = 'foundation' | 'core' | 'domain' | 'advanced' | 'research'

export type LearningPathSource = {
  id: string
  title: string
  institution: string
  url: string
  kind: 'framework' | 'university' | 'vocational' | 'emerging'
}

export type LearningPathNode = {
  id: string
  title: string
  summary: string
  aliases: string[]
  domains: string[]
  audiences: PathAudience[]
  stage: PathStage
  order: number
  origin: PathNodeOrigin
  sourceRefs: string[]
  sourceProposalId?: string
}

export type LearningPathEdge = {
  id: string
  from: string
  to: string
  kind: PathEdgeKind
  rationale: string
  origin: PathNodeOrigin
}

export type PersonalPathNodeProposal = {
  id: string
  policyId: 'vnext-personal-path-node-proposer-v3'
  generatedFromSnapshotId: string
  title: string
  summary: string
  aliases: string[]
  domains: string[]
  stage: PathStage
  order: number
  sourceUrls: string[]
  sourceEvidence: PersonalPathNodeEvidenceAssessment[]
  connections: Array<{ nodeId: string; kind: PathEdgeKind; rationale: string }>
  requiresLearnerConfirmation: true
  masteryUnchanged: true
}

export type PersonalPathNodeEvidence = {
  url: string
  title?: string
  snippet?: string
  source?: string
  quality?: 'official' | 'academic' | 'community' | 'repository'
  role?: 'standard' | 'reference' | 'textbook' | 'course' | 'definition' | 'research' | 'example' | 'discussion'
}

export type PersonalPathNodeEvidenceAssessment = {
  url: string
  title: string
  source: string
  quality: NonNullable<PersonalPathNodeEvidence['quality']>
  relevance: number
  matchedTerms: string[]
}

export type PersonalPathNodeEvidenceReport = {
  valid: boolean
  accepted: PersonalPathNodeEvidenceAssessment[]
  rejected: Array<{ url: string; reason: 'invalid_url' | 'insufficient_metadata' | 'off_topic' | 'weak_source' }>
  policyId: 'vnext-personal-path-evidence-v1'
}

export type LearningPathPlan = {
  id: string
  title: string
  objective: string
  horizon: string
  targetNodeIds: string[]
  routeNodeIds: string[]
  milestoneNodeIds: string[]
  rationale: string
  evidenceQuote: string
  sourcePlanId?: string
  status: 'active' | 'archived'
  revision: number
}

export type LearningPathPlanProposal = Omit<LearningPathPlan, 'status' | 'revision'> & {
  policyId: 'vnext-learning-path-planner-v2'
  generatedFromSnapshotId: string
}

export type LearningPathEvent = {
  id: string
  sequence: number
  at: number
  type: 'vnext_learning_path_node_status_set' | 'vnext_personal_path_node_added' | 'vnext_personal_path_node_removed'
    | 'vnext_learning_path_plan_committed' | 'vnext_learning_path_plan_revised' | 'vnext_learning_path_plan_archived'
  detail: string
  nodeId?: string
  status?: LearnerPathStatus
  node?: LearningPathNode
  edges?: LearningPathEdge[]
  plan?: LearningPathPlan
  planId?: string
}

export type LearnerPathState = {
  version: 1
  events: LearningPathEvent[]
}

export type LearnerPathProjection = {
  nodes: LearningPathNode[]
  edges: LearningPathEdge[]
  statuses: Record<string, LearnerPathStatus>
  personalNodeIds: string[]
  plans: LearningPathPlan[]
  activePlan?: LearningPathPlan
  eventCount: number
}

export type ConceptPathAlignment = {
  conceptKey: string
  conceptName: string
  pathNodeId: string
  pathNodeTitle: string
  match: 'declared_official_anchor' | 'exact_key' | 'exact_name_or_alias'
  confidence: number
  authority: 'deterministic_alignment_projection'
}

export type ConceptAnchorLike = {
  concept_key?: string
  name?: string
  official_node_id?: string | null
}

export type SourceKnowledgeDomainLike = {
  id: string
  title: string
  summary?: string
  labels?: string[]
  sourceIds?: string[]
}

export type LearningGraphKind =
  | 'source_knowledge_domain'
  | 'official_course_graph'
  | 'personal_course_overlay'
  | 'learning_path_plan'
  | 'personal_concept_graph'

export type LearningGraphAlignment = {
  id: string
  fromGraph: LearningGraphKind
  toGraph: LearningGraphKind
  fromId: string
  toId: string
  relation: 'covers' | 'personalizes' | 'routes_through' | 'anchors_concept'
  match: 'declared' | 'exact_key' | 'exact_name_or_alias' | 'deterministic_topic_match'
  confidence: number
  authority: 'deterministic_alignment_projection'
  carriesMastery: false
}

export type LearningGraphAlignmentProjection = {
  version: 'vnext-graph-alignment.v1'
  alignments: LearningGraphAlignment[]
  gaps: Array<{
    graph: 'source_knowledge_domain' | 'personal_concept_graph'
    objectId: string
    title: string
    reason: 'no_reliable_official_course_match'
  }>
  manifest: {
    sourceDomainCount: number
    courseNodeCount: number
    overlayStatusCount: number
    planCount: number
    conceptCount: number
    masteryInference: false
  }
}

export type LearningPathReadPacket = {
  snapshotId: string
  policyId: 'vnext-learning-path-reader-v2'
  query: string
  topicCandidate: string
  matchKind: 'official_match' | 'personal_match' | 'graph_gap' | 'unresolved' | 'overview'
  retrievalMode: 'exact' | 'fuzzy' | 'overview'
  resolution: 'resolved' | 'ambiguous' | 'not_found' | 'overview'
  candidates: LearningPathRetrievalCandidate[]
  omittedCandidateCount: number
  recommendedNextAction: LearningPathRetrievalResult['recommendedNextAction'] | 'show_overview'
  matchedNodeIds: string[]
  contextNodeIds: string[]
  suggestedAnchorIds: string[]
  needsFuzzySearch: boolean
  needsExternalResearch: boolean
  nodes: Array<{
    id: string
    title: string
    origin: PathNodeOrigin
    status: LearnerPathStatus
    stage: PathStage
    prerequisites: Array<{ id: string; title: string; kind: PathEdgeKind }>
    successors: Array<{ id: string; title: string; kind: PathEdgeKind }>
  }>
  manifest: {
    officialNodeCount: number
    personalNodeCount: number
    selfReportedMasteredCount: number
    noKnowledgeMasteryInference: true
  }
}

export const PATH_EDGE_LABELS: Record<PathEdgeKind, string> = {
  hard_prerequisite: '硬前置',
  soft_prerequisite: '软前置',
  co_learning: '建议共学',
}

export const PATH_STATUS_LABELS: Record<LearnerPathStatus, string> = {
  unmarked: '未标记',
  exploring: '正在学习',
  self_reported_exposed: '自报学过',
  self_reported_mastered: '自报掌握',
}

export const PATH_STAGE_LABELS: Record<PathStage, string> = {
  foundation: '入门与基础',
  core: '计算机核心',
  domain: '专业方向',
  advanced: '高阶与新兴',
  research: '研究与产出',
}

export const LEARNING_PATH_SOURCES: LearningPathSource[] = [
  { id: 'acm-cs2023', title: 'Computer Science Curricula 2023', institution: 'ACM / IEEE-CS / AAAI', url: 'https://csed.acm.org/', kind: 'framework' },
  { id: 'mit-6-3', title: 'Computer Science and Engineering (6-3)', institution: 'MIT EECS', url: 'https://catalog.mit.edu/degree-charts/computer-science-engineering-course-6-3/', kind: 'university' },
  { id: 'cornell-cs', title: 'B.S. in Computer Science', institution: 'Cornell Bowers', url: 'https://www.cs.cornell.edu/bachelor-science-computer-science', kind: 'university' },
  { id: 'cmu-ai', title: 'B.S. in Artificial Intelligence Curriculum', institution: 'Carnegie Mellon SCS', url: 'https://www.cs.cmu.edu/bs-in-artificial-intelligence/curriculum', kind: 'university' },
  { id: 'cmu-mscs', title: 'M.S. in Computer Science Curriculum', institution: 'Carnegie Mellon CSD', url: 'https://www.csd.cs.cmu.edu/ms-in-computer-science-curriculum', kind: 'university' },
  { id: 'stanford-ms', title: 'M.S. Computer Science Specializations', institution: 'Stanford Computer Science', url: 'https://www.cs.stanford.edu/masters-specializations', kind: 'university' },
  { id: 'tsinghua-2023', title: '计算机科学与技术专业本科培养方案 2023级', institution: '清华大学计算机系', url: 'https://www.cs.tsinghua.edu.cn/info/1043/5969.htm', kind: 'university' },
  { id: 'zju-cs', title: 'Bachelor of Engineering in Computer Science and Technology', institution: '浙江大学计算机学院', url: 'https://www.en.cs.zju.edu.cn/22145/list.htm', kind: 'university' },
  { id: 'hust-2024', title: '计算机科学与技术学院2024级本科生培养方案', institution: '华中科技大学', url: 'https://cs.hust.edu.cn/info/1076/4512.htm', kind: 'university' },
  { id: 'whu-computing', title: '计算机大类课程设置与关联关系', institution: '武汉大学计算机学院', url: 'https://uc.whu.edu.cn/info/1310/9846.htm', kind: 'university' },
  { id: 'moe-vocational-2025', title: '职业教育专业教学标准 2025', institution: '中华人民共和国教育部', url: 'https://www.moe.gov.cn/s78/A07/zcs_ztzl/2017_zt06/17zt06_bznr/bznr_zyjyzyjxbz/', kind: 'vocational' },
  { id: 'moe-computer-app-510201', title: '计算机应用技术专业教学标准（高职专科）', institution: '中华人民共和国教育部', url: 'https://www.moe.gov.cn/s78/A07/zcs_ztzl/2017_zt06/17zt06_bznr/bznr_zyjyzyjxbz/gdzyjy_zk/zk_dzyxxdl/dzxxdl_jsjl/202502/P020250207533801162064.pdf', kind: 'vocational' },
  { id: 'moe-software-510203', title: '软件技术专业教学标准（高职专科）', institution: '中华人民共和国教育部', url: 'https://www.moe.gov.cn/s78/A07/zcs_ztzl/2017_zt06/17zt06_bznr/bznr_zyjyzyjxbz/gdzyjy_zk/zk_dzyxxdl/dzxxdl_jsjl/202502/P020250207533323690137.pdf', kind: 'vocational' },
  { id: 'moe-bigdata-510205', title: '大数据技术专业教学标准（高职专科）', institution: '中华人民共和国教育部', url: 'https://www.moe.gov.cn/s78/A07/zcs_ztzl/2017_zt06/17zt06_bznr/bznr_zyjyzyjxbz/gdzyjy_zk/zk_dzyxxdl/dzxxdl_jsjl/202502/P020250207532993683513.pdf', kind: 'vocational' },
  { id: 'moe-cloud-510206', title: '云计算技术应用专业教学标准（高职专科）', institution: '中华人民共和国教育部', url: 'https://www.moe.gov.cn/s78/A07/zcs_ztzl/2017_zt06/17zt06_bznr/bznr_zyjyzyjxbz/gdzyjy_zk/zk_dzyxxdl/dzxxdl_jsjl/202502/P020250207532853321417.pdf', kind: 'vocational' },
  { id: 'moe-ai-510209', title: '人工智能技术应用专业教学标准（高职专科）', institution: '中华人民共和国教育部', url: 'https://www.moe.gov.cn/s78/A07/zcs_ztzl/2017_zt06/17zt06_bznr/bznr_zyjyzyjxbz/gdzyjy_zk/zk_dzyxxdl/dzxxdl_jsjl/202502/P020250207532415004946.pdf', kind: 'vocational' },
  { id: 'moe-network-510202', title: '计算机网络技术专业教学标准（高职专科）', institution: '中华人民共和国教育部', url: 'https://hudong.moe.gov.cn/s78/A07/zcs_ztzl/2017_zt06/17zt06_bznr/bznr_zyjyzyjxbz/gdzyjy_zk/zk_dzyxxdl/dzxxdl_jsjl/202502/P020250207533459609558.pdf', kind: 'vocational' },
  { id: 'moe-security-510207', title: '信息安全技术应用专业教学标准（高职专科）', institution: '中华人民共和国教育部', url: 'https://www.moe.gov.cn/s78/A07/zcs_ztzl/2017_zt06/17zt06_bznr/bznr_zyjyzyjxbz/gdzyjy_zk/zk_dzyxxdl/dzxxdl_jsjl/202502/P020250207532704599869.pdf', kind: 'vocational' },
  { id: 'moe-mobile-510213', title: '移动应用开发专业教学标准（高职专科）', institution: '中华人民共和国教育部', url: 'https://www.moe.gov.cn/s78/A07/zcs_ztzl/2017_zt06/17zt06_bznr/bznr_zyjyzyjxbz/gdzyjy_zk/zk_dzyxxdl/dzxxdl_jsjl/202502/P020250207531781244062.pdf', kind: 'vocational' },
  { id: 'nyu-agents', title: 'Foundations of AI Agents', institution: 'NYU Stern', url: 'https://aiagents.stern.nyu.edu/', kind: 'emerging' },
  { id: 'swebok-v4', title: 'Guide to the Software Engineering Body of Knowledge v4', institution: 'IEEE Computer Society', url: 'https://www.computer.org/education/bodies-of-knowledge/software-engineering', kind: 'framework' },
  { id: 'google-sre', title: 'Site Reliability Engineering', institution: 'Google', url: 'https://sre.google/sre-book/table-of-contents/', kind: 'emerging' },
  { id: 'nist-ssdf', title: 'Secure Software Development Framework', institution: 'NIST', url: 'https://csrc.nist.gov/pubs/sp/800/218/final', kind: 'framework' },
  { id: 'nist-ai-evaluation', title: 'Assessing Risks and Impacts of AI', institution: 'NIST', url: 'https://ai-challenges.nist.gov/aria', kind: 'framework' },
  { id: 'cncf-platform-engineering', title: 'Cloud Native Platform Engineering', institution: 'Cloud Native Computing Foundation', url: 'https://www.cncf.io/training/certification/cnpa/', kind: 'emerging' },
]

export function alignPersonalConceptsToLearningPath(concepts: ConceptAnchorLike[]): ConceptPathAlignment[] {
  const seen = new Set<string>()
  const result: ConceptPathAlignment[] = []
  for (const concept of concepts) {
    const key = String(concept.concept_key || '').trim()
    const name = String(concept.name || key).trim()
    const declared = String(concept.official_node_id || '').trim()
    let node = declared ? OFFICIAL_PATH_NODES.find(candidate => candidate.id === declared) : undefined
    let match: ConceptPathAlignment['match'] = 'declared_official_anchor'
    if (!node && key) {
      node = OFFICIAL_PATH_NODES.find(candidate => candidate.id === key)
      match = 'exact_key'
    }
    if (!node && name) {
      const normalized = name.toLocaleLowerCase()
      node = OFFICIAL_PATH_NODES.find(candidate => (
        candidate.title.toLocaleLowerCase() === normalized
        || candidate.aliases.some(alias => alias.toLocaleLowerCase() === normalized)
      ))
      match = 'exact_name_or_alias'
    }
    if (!node) continue
    const identity = `${key || name}:${node.id}`
    if (seen.has(identity)) continue
    seen.add(identity)
    result.push({
      conceptKey: key || node.id,
      conceptName: name || node.title,
      pathNodeId: node.id,
      pathNodeTitle: node.title,
      match,
      confidence: match === 'declared_official_anchor' ? 1 : match === 'exact_key' ? 0.98 : 0.94,
      authority: 'deterministic_alignment_projection',
    })
  }
  return result
}

function alignmentTopicScore(node: LearningPathNode, values: string[]) {
  const names = [node.id, node.title, ...node.aliases].map(normalize).filter(Boolean)
  let best = 0
  for (const raw of values) {
    const value = normalize(raw)
    if (!value) continue
    for (const name of names) {
      if (name === value) best = Math.max(best, 100)
      else if (name.length >= 2 && value.includes(name)) best = Math.max(best, 78)
      else if (value.length >= 2 && name.includes(value)) best = Math.max(best, 72)
    }
    for (const domain of node.domains.map(normalize)) {
      if (domain && (value.includes(domain) || domain.includes(value))) best = Math.max(best, 68)
    }
  }
  return best
}

export function buildLearningGraphAlignments(
  state: LearnerPathState,
  concepts: ConceptAnchorLike[] = [],
  sourceDomains: SourceKnowledgeDomainLike[] = [],
): LearningGraphAlignmentProjection {
  const projection = projectLearnerPath(state)
  const officialNodes = projection.nodes.filter(node => node.origin === 'official')
  const alignments: LearningGraphAlignment[] = []
  const gaps: LearningGraphAlignmentProjection['gaps'] = []
  const push = (alignment: Omit<LearningGraphAlignment, 'id' | 'authority' | 'carriesMastery'>) => {
    const identity = `${alignment.fromGraph}:${alignment.fromId}:${alignment.relation}:${alignment.toGraph}:${alignment.toId}`
    if (alignments.some(item => item.id === identity)) return
    alignments.push({
      ...alignment,
      id: identity,
      authority: 'deterministic_alignment_projection',
      carriesMastery: false,
    })
  }

  for (const [nodeId, status] of Object.entries(projection.statuses)) {
    if (status === 'unmarked' || !projection.nodes.some(node => node.id === nodeId)) continue
    push({
      fromGraph: 'official_course_graph', toGraph: 'personal_course_overlay',
      fromId: nodeId, toId: `overlay:${nodeId}`, relation: 'personalizes',
      match: 'declared', confidence: 1,
    })
  }
  for (const plan of projection.plans) {
    for (const nodeId of plan.routeNodeIds) {
      if (!projection.nodes.some(node => node.id === nodeId)) continue
      push({
        fromGraph: 'learning_path_plan', toGraph: 'official_course_graph',
        fromId: plan.id, toId: nodeId, relation: 'routes_through',
        match: 'declared', confidence: 1,
      })
    }
  }
  const conceptMatches = alignPersonalConceptsToLearningPath(concepts)
  for (const match of conceptMatches) {
    push({
      fromGraph: 'personal_concept_graph', toGraph: 'official_course_graph',
      fromId: match.conceptKey, toId: match.pathNodeId, relation: 'anchors_concept',
      match: match.match === 'declared_official_anchor' ? 'declared' : match.match,
      confidence: match.confidence,
    })
  }
  const matchedConcepts = new Set(conceptMatches.map(item => item.conceptKey))
  for (const concept of concepts) {
    const key = String(concept.concept_key || concept.name || '').trim()
    if (key && !matchedConcepts.has(key)) gaps.push({
      graph: 'personal_concept_graph', objectId: key,
      title: String(concept.name || concept.concept_key || key),
      reason: 'no_reliable_official_course_match',
    })
  }
  for (const domain of sourceDomains) {
    const values = [domain.title, ...(domain.labels || []), domain.summary || '']
    const ranked = officialNodes.map(node => ({ node, score: alignmentTopicScore(node, values) }))
      .filter(item => item.score >= 72)
      .sort((left, right) => right.score - left.score || left.node.order - right.node.order)
      .slice(0, 3)
    if (!ranked.length) {
      gaps.push({
        graph: 'source_knowledge_domain', objectId: domain.id, title: domain.title,
        reason: 'no_reliable_official_course_match',
      })
      continue
    }
    for (const { node, score } of ranked) push({
      fromGraph: 'source_knowledge_domain', toGraph: 'official_course_graph',
      fromId: domain.id, toId: node.id, relation: 'covers',
      match: 'deterministic_topic_match', confidence: Math.min(0.96, score / 100),
    })
  }
  return {
    version: 'vnext-graph-alignment.v1',
    alignments,
    gaps,
    manifest: {
      sourceDomainCount: sourceDomains.length,
      courseNodeCount: projection.nodes.length,
      overlayStatusCount: Object.values(projection.statuses).filter(status => status !== 'unmarked').length,
      planCount: projection.plans.length,
      conceptCount: concepts.length,
      masteryInference: false,
    },
  }
}

const n = (
  id: string, title: string, order: number, stage: PathStage, domains: string[],
  aliases: string[], sources: string[], audiences: PathAudience[] = stage === 'advanced' || stage === 'research'
    ? ['undergraduate', 'graduate', 'self_directed']
    : ['undergraduate', 'self_directed'],
  summary = `${title}的核心概念、方法与基本实践。`,
): LearningPathNode => ({ id, title, summary, aliases, domains, audiences, stage, order, origin: 'official', sourceRefs: sources })

export const OFFICIAL_PATH_NODES: LearningPathNode[] = [
  n('digital-literacy', '信息技术与数字素养', 0, 'foundation', ['通识', '高职'], ['计算机基础', '信息技术基础'], ['moe-vocational-2025'], ['vocational', 'undergraduate', 'self_directed']),
  n('computer-introduction', '计算机科学导论', 0, 'foundation', ['通识', '计算机'], ['计算概论', 'CS导论'], ['acm-cs2023', 'cmu-ai']),
  n('computing-ethics', '计算伦理与职业责任', 0, 'foundation', ['通识', '伦理'], ['AI伦理基础', '职业伦理'], ['acm-cs2023', 'cmu-ai']),
  n('programming-foundations', '程序设计基础', 1, 'foundation', ['编程', '软件'], ['编程入门', '程序设计'], ['mit-6-3', 'tsinghua-2023', 'moe-vocational-2025'], ['vocational', 'undergraduate', 'self_directed']),
  n('python-programming', 'Python 程序设计', 1, 'foundation', ['编程', 'AI', '高职'], ['Python', 'Python开发'], ['mit-6-3', 'moe-ai-510209'], ['vocational', 'undergraduate', 'self_directed']),
  n('c-programming', 'C 语言与底层程序设计', 1, 'foundation', ['编程', '系统'], ['C语言', 'C和汇编'], ['mit-6-3', 'tsinghua-2023']),
  n('calculus', '微积分', 1, 'foundation', ['数学', 'AI'], ['高等数学', 'Calculus'], ['mit-6-3', 'tsinghua-2023', 'cmu-ai']),
  n('linear-algebra', '线性代数', 1, 'foundation', ['数学', 'AI'], ['矩阵论基础', 'Linear Algebra'], ['mit-6-3', 'cmu-ai', 'tsinghua-2023']),
  n('discrete-mathematics', '离散数学', 1, 'foundation', ['数学', '理论'], ['计算机数学', '离散结构'], ['acm-cs2023', 'tsinghua-2023', 'zju-cs']),
  n('probability-statistics', '概率论与数理统计', 1, 'foundation', ['数学', 'AI', '数据'], ['概率统计', 'Probability'], ['mit-6-3', 'cmu-ai', 'tsinghua-2023']),
  n('linux-fundamentals', 'Linux 基础', 1, 'foundation', ['系统', '运维', '高职'], ['Linux入门', '命令行'], ['moe-ai-510209', 'moe-network-510202'], ['vocational', 'undergraduate', 'self_directed']),
  n('web-foundations', 'Web 与互联网基础', 1, 'foundation', ['软件', 'Web', '高职'], ['网页设计', 'HTML CSS JavaScript'], ['moe-vocational-2025'], ['vocational', 'undergraduate', 'self_directed']),
  n('computer-maintenance', '计算机组成与维护', 2, 'foundation', ['硬件', '运维', '高职'], ['计算机组装与维护', '微机维护'], ['moe-computer-app-510201'], ['vocational', 'self_directed'], '识别计算机部件，完成整机装配、系统安装、故障诊断与日常维护。'),
  n('windows-server-administration', 'Windows Server 管理', 2, 'foundation', ['系统', '网络', '高职'], ['网络操作系统', 'Windows服务器管理'], ['moe-computer-app-510201', 'moe-network-510202'], ['vocational', 'self_directed'], '配置服务器角色、目录与权限、网络服务，并完成基础运行维护。'),
  n('network-cabling', '网络综合布线', 2, 'foundation', ['网络', '硬件', '高职'], ['信息网络布线', '综合布线'], ['moe-network-510202'], ['vocational', 'self_directed'], '完成铜缆与光纤布线设计、端接、测试、验收和工程文档。'),
  n('object-oriented-programming', '面向对象程序设计', 2, 'foundation', ['编程', '软件'], ['OOP', '面向对象'], ['cornell-cs', 'zju-cs']),
  n('data-structures', '数据结构', 2, 'core', ['算法', '编程'], ['Data Structures', '高级数据结构基础'], ['cornell-cs', 'tsinghua-2023', 'zju-cs']),
  n('digital-logic', '数字逻辑', 2, 'foundation', ['系统', '硬件'], ['数字电路', '逻辑设计'], ['zju-cs', 'tsinghua-2023']),
  n('computer-organization', '计算机组成原理', 2, 'core', ['系统', '硬件'], ['计算机组成', 'Computation Structures'], ['mit-6-3', 'tsinghua-2023', 'zju-cs']),
  n('database-foundations', '数据库技术基础', 2, 'foundation', ['数据', '高职'], ['SQL基础', '数据库应用'], ['moe-ai-510209', 'moe-security-510207'], ['vocational', 'undergraduate', 'self_directed']),
  n('networking-foundations', '计算机网络基础', 2, 'foundation', ['网络', '高职'], ['网络技术基础', 'TCP/IP基础'], ['moe-network-510202', 'moe-security-510207'], ['vocational', 'undergraduate', 'self_directed']),
  n('software-development-foundations', '软件开发基础', 2, 'foundation', ['软件', '工程'], ['Git与测试基础', '软件构造'], ['mit-6-3', 'moe-vocational-2025']),
  n('data-processing', '数据采集与处理', 2, 'foundation', ['数据', 'AI', '高职'], ['数据清洗', '数据标注'], ['moe-ai-510209'], ['vocational', 'undergraduate', 'self_directed']),
  n('hci-foundations', '人机交互基础', 2, 'foundation', ['HCI', '软件'], ['交互设计', '用户体验'], ['acm-cs2023']),
  n('frontend-design-development', '前端设计与开发', 3, 'domain', ['软件', 'Web', '高职'], ['Web前端开发', '响应式页面开发'], ['moe-computer-app-510201', 'moe-software-510203'], ['vocational', 'undergraduate', 'self_directed'], '从页面结构、样式和交互出发，完成响应式前端与组件化界面开发。'),
  n('software-modeling-design', '软件建模与设计', 3, 'domain', ['软件', '工程', '高职'], ['UML建模', '面向对象建模'], ['moe-software-510203', 'moe-mobile-510213'], ['vocational', 'undergraduate', 'self_directed'], '从需求、用例和领域对象出发，使用 UML 与设计模式形成可实现的软件设计。'),
  n('system-deployment-operations', '系统部署与运维', 4, 'domain', ['系统', '运维', '高职'], ['信息系统运维', '应用部署'], ['moe-computer-app-510201'], ['vocational', 'undergraduate', 'self_directed'], '部署应用、数据库与基础网络服务，实施监控、备份、升级和故障处理。'),
  n('enterprise-application-development', '企业级项目开发', 4, 'domain', ['软件', 'Web', '工程', '高职'], ['企业应用开发', '服务端框架开发'], ['moe-software-510203', 'moe-mobile-510213'], ['vocational', 'undergraduate', 'self_directed'], '用服务端框架、持久化和会话机制实现可部署的企业级业务应用。'),
  n('software-testing', '软件测试', 4, 'domain', ['软件', '工程', '高职'], ['功能测试', '自动化测试', '软件质量保证'], ['moe-software-510203', 'moe-mobile-510213'], ['vocational', 'undergraduate', 'self_directed'], '设计测试计划与用例，执行功能、性能和自动化测试并形成缺陷报告。'),
  n('mobile-cross-platform', '移动端跨平台开发', 4, 'domain', ['软件', '移动', '高职'], ['跨平台开发', 'uni-app'], ['moe-mobile-510213'], ['vocational', 'self_directed'], '使用组件、路由、状态管理和跨平台构建能力交付移动应用。'),
  n('mini-program-development', '小程序开发', 4, 'domain', ['软件', '移动', 'Web', '高职'], ['微信小程序', '小程序云开发'], ['moe-mobile-510213'], ['vocational', 'self_directed'], '完成小程序页面、数据交互、云端能力接入、测试和发布。'),
  n('data-acquisition-technology', '数据采集技术', 3, 'domain', ['数据', '高职'], ['在线离线数据采集', '日志采集'], ['moe-bigdata-510205'], ['vocational', 'undergraduate', 'self_directed'], '针对数据库、日志和互联网数据设计并实施在线或离线采集任务。'),
  n('data-preprocessing-etl', '数据预处理与 ETL', 3, 'domain', ['数据', '高职'], ['数据清洗', '数据抽取转换加载'], ['moe-bigdata-510205'], ['vocational', 'undergraduate', 'self_directed'], '识别缺失、重复和不一致数据，完成多源数据抽取、清洗、转换和装载。'),
  n('data-analysis-applications', '大数据分析技术应用', 4, 'domain', ['数据', '高职'], ['批流数据分析', '业务数据分析'], ['moe-bigdata-510205'], ['vocational', 'undergraduate', 'self_directed'], '围绕业务指标完成统计分析、批量与实时计算，并撰写分析报告。'),
  n('data-visualization-applications', '数据可视化技术与应用', 4, 'domain', ['数据', 'HCI', '高职'], ['可视化大屏', '数据图表设计'], ['moe-bigdata-510205', 'moe-computer-app-510201'], ['vocational', 'undergraduate', 'self_directed'], '选择合适图表与交互方式，构建可解释的数据展示并输出分析结论。'),
  n('big-data-platform-operations', '大数据平台部署与运维', 5, 'advanced', ['数据', '系统', '运维', '高职'], ['Hadoop平台运维', '大数据平台管理'], ['moe-bigdata-510205'], ['vocational', 'undergraduate', 'self_directed'], '部署和维护分布式存储与计算组件，监测平台运行并处理常见故障。'),
  n('algorithms', '算法设计与分析', 3, 'core', ['算法', '理论'], ['算法', 'Algorithm Analysis'], ['mit-6-3', 'cornell-cs', 'zju-cs']),
  n('operating-systems', '操作系统', 3, 'core', ['系统'], ['OS', '操作系统原理'], ['mit-6-3', 'tsinghua-2023', 'zju-cs']),
  n('database-systems', '数据库系统', 3, 'core', ['数据', '系统'], ['DBMS', '数据库原理'], ['mit-6-3', 'tsinghua-2023', 'zju-cs']),
  n('computer-networks', '计算机网络', 3, 'core', ['网络', '系统'], ['网络原理', 'Computer Networks'], ['tsinghua-2023', 'zju-cs', 'whu-computing']),
  n('software-engineering', '软件工程', 3, 'core', ['软件', '工程'], ['软件工程方法', 'Software Engineering'], ['acm-cs2023', 'tsinghua-2023', 'zju-cs']),
  n('theory-of-computation', '计算理论', 3, 'core', ['理论', '算法'], ['可计算性与复杂性', '形式语言'], ['mit-6-3', 'zju-cs']),
  n('programming-languages', '程序设计语言原理', 3, 'core', ['编程', '理论'], ['PL', '编程语言基础'], ['acm-cs2023', 'cmu-mscs']),
  n('computer-security', '信息安全基础', 3, 'core', ['安全', '网络'], ['网络空间安全导论', '计算机安全'], ['acm-cs2023', 'zju-cs', 'moe-security-510207']),
  n('web-development', 'Web 应用开发', 3, 'domain', ['软件', 'Web', '高职'], ['前后端开发', 'Web开发'], ['moe-security-510207', 'moe-vocational-2025'], ['vocational', 'undergraduate', 'self_directed']),
  n('mobile-development', '移动应用开发', 3, 'domain', ['软件', '移动', '高职'], ['Android开发', '移动开发'], ['moe-vocational-2025'], ['vocational', 'undergraduate', 'self_directed']),
  n('network-routing-switching', '路由交换技术', 3, 'domain', ['网络', '高职'], ['路由器交换机配置', '网络设备配置'], ['moe-network-510202'], ['vocational', 'undergraduate', 'self_directed']),
  n('linux-administration', 'Linux 系统管理', 3, 'domain', ['系统', '运维', '高职'], ['Linux运维', '服务器管理'], ['moe-network-510202'], ['vocational', 'undergraduate', 'self_directed']),
  n('wireless-networking', '无线网络技术应用', 4, 'domain', ['网络', '高职'], ['WLAN规划', '无线组网'], ['moe-network-510202'], ['vocational', 'undergraduate', 'self_directed'], '完成无线局域网勘测、规划、组网、安全配置、管理与优化。'),
  n('network-automation', '网络自动化运维', 4, 'domain', ['网络', '运维', '编程', '高职'], ['自动化网络运维', 'Python网络运维'], ['moe-network-510202'], ['vocational', 'undergraduate', 'self_directed'], '使用脚本、接口和配置管理工具批量实施网络配置、巡检和变更。'),
  n('network-virtualization', '网络虚拟化技术应用', 4, 'domain', ['网络', '云', '高职'], ['SDN基础', '虚拟网络'], ['moe-network-510202', 'moe-cloud-510206'], ['vocational', 'undergraduate', 'self_directed'], '理解虚拟交换、网络隔离、隧道和软件定义网络，并完成基础部署。'),
  n('network-systems-integration', '网络系统集成', 5, 'advanced', ['网络', '工程', '高职'], ['网络规划与系统集成', '网络工程实施'], ['moe-network-510202'], ['vocational', 'undergraduate', 'self_directed'], '完成需求分析、拓扑与布线设计、设备选型、实施、测试和工程验收。'),
  n('computer-graphics', '计算机图形学', 3, 'domain', ['图形', '视觉'], ['图形学基础', 'Graphics'], ['acm-cs2023', 'tsinghua-2023']),
  n('embedded-systems', '嵌入式系统', 3, 'domain', ['系统', '硬件', '物联网'], ['嵌入式开发', 'MCU'], ['acm-cs2023', 'moe-vocational-2025']),
  n('artificial-intelligence', '人工智能导论', 4, 'domain', ['AI'], ['AI基础', '人工智能'], ['cmu-ai', 'zju-cs', 'acm-cs2023']),
  n('machine-learning', '机器学习', 4, 'domain', ['AI', '数据'], ['ML', '机器学习基础算法'], ['cmu-ai', 'stanford-ms', 'zju-cs']),
  n('data-mining', '数据挖掘', 4, 'domain', ['数据', 'AI'], ['知识发现', 'Data Mining'], ['tsinghua-2023', 'stanford-ms']),
  n('distributed-systems', '分布式系统', 4, 'domain', ['系统', '云'], ['Distributed Systems', '分布式计算'], ['cmu-mscs', 'acm-cs2023']),
  n('cloud-computing', '云计算', 4, 'domain', ['云', '系统', '高职'], ['云平台', '云计算技术应用'], ['moe-vocational-2025', 'cmu-mscs'], ['vocational', 'undergraduate', 'graduate', 'self_directed']),
  n('virtualization-technology', '虚拟化技术基础', 3, 'domain', ['云', '系统', '高职'], ['计算虚拟化', '存储虚拟化'], ['moe-cloud-510206'], ['vocational', 'undergraduate', 'self_directed'], '理解计算、存储与网络虚拟化，创建和管理虚拟机、镜像与资源池。'),
  n('cloud-platform-operations', '云平台架构与运维', 4, 'domain', ['云', '系统', '运维', '高职'], ['私有云运维', '公有云运维'], ['moe-cloud-510206'], ['vocational', 'undergraduate', 'self_directed'], '规划并运维私有云和公有云中的计算、网络、存储、数据库与监控服务。'),
  n('container-cloud-operations', '容器云架构与运维', 5, 'advanced', ['云', '系统', '运维', '高职'], ['容器编排', 'Kubernetes运维'], ['moe-cloud-510206'], ['vocational', 'undergraduate', 'self_directed'], '管理镜像、容器网络、存储、编排、监控和应用发布。'),
  n('cloud-security-applications', '云安全技术应用', 5, 'advanced', ['云', '安全', '高职'], ['云安全运维', '云平台安全'], ['moe-cloud-510206'], ['vocational', 'undergraduate', 'self_directed'], '配置身份认证、云扫描、防护、监控与安全运营能力，保护云平台和云服务。'),
  n('devops', 'DevOps 与持续交付', 4, 'domain', ['软件', '运维'], ['CI/CD', '持续集成'], ['acm-cs2023', 'moe-network-510202']),
  n('compilers', '编译原理', 4, 'domain', ['编程', '系统', '理论'], ['编译器', 'Compiler Design'], ['zju-cs', 'cmu-mscs']),
  n('parallel-computing', '并行计算', 4, 'domain', ['系统', '计算'], ['并行程序设计', 'PDC'], ['acm-cs2023', 'cmu-mscs']),
  n('cybersecurity-engineering', '网络安全工程', 4, 'domain', ['安全', '网络'], ['安全工程与实践', '安全产品配置'], ['zju-cs', 'moe-security-510207']),
  n('web-security', 'Web 应用安全', 4, 'domain', ['安全', 'Web'], ['Web安全与防护', '代码审计'], ['moe-security-510207']),
  n('operating-system-security', '操作系统安全', 4, 'domain', ['安全', '系统', '高职'], ['系统安全加固', '主机安全'], ['moe-security-510207'], ['vocational', 'undergraduate', 'self_directed'], '检查账户、权限、文件系统和服务配置，实施主流操作系统安全加固。'),
  n('security-product-configuration', '信息安全产品配置与应用', 4, 'domain', ['安全', '网络', '高职'], ['防火墙配置', '安全审计产品'], ['moe-security-510207'], ['vocational', 'undergraduate', 'self_directed'], '部署和管理防火墙、入侵检测、漏洞扫描、安全审计等防护产品。'),
  n('storage-disaster-recovery', '数据存储与容灾', 4, 'domain', ['安全', '数据', '系统', '高职'], ['备份恢复', 'RAID与容灾'], ['moe-security-510207'], ['vocational', 'undergraduate', 'self_directed'], '设计存储、备份与 RAID 方案，实施数据恢复和信息系统容灾。'),
  n('digital-forensics', '电子数据取证技术应用', 5, 'advanced', ['安全', '实践', '高职'], ['计算机取证', '数据恢复取证'], ['moe-security-510207'], ['vocational', 'undergraduate', 'self_directed'], '依法获取、固定、恢复和分析电子数据，形成可检查的取证过程与结果。'),
  n('security-risk-assessment', '信息安全风险评估', 5, 'advanced', ['安全', '工程', '高职'], ['安全测评', '风险分析'], ['moe-security-510207'], ['vocational', 'undergraduate', 'self_directed'], '识别资产、威胁与脆弱性，完成主机、网络、应用和数据安全评估报告。'),
  n('applied-cryptography', '现代密码学', 4, 'domain', ['安全', '数学'], ['应用密码学', 'Cryptography'], ['tsinghua-2023', 'zju-cs']),
  n('data-engineering', '数据工程', 4, 'domain', ['数据', '系统'], ['数据管道', 'Data Engineering'], ['acm-cs2023', 'cmu-mscs']),
  n('software-architecture', '软件架构与大型系统设计', 4, 'domain', ['软件', '工程'], ['系统设计', '软件架构'], ['acm-cs2023', 'cmu-mscs']),
  n('optimization', '优化方法', 5, 'advanced', ['数学', 'AI'], ['最优化', 'Optimization'], ['cmu-ai', 'stanford-ms']),
  n('statistical-learning', '统计学习理论', 5, 'advanced', ['AI', '数学', '研究'], ['学习理论', 'Statistical Learning'], ['stanford-ms', 'cmu-mscs'], ['undergraduate', 'graduate', 'self_directed']),
  n('deep-learning', '深度学习', 5, 'advanced', ['AI'], ['神经网络', 'DL'], ['cmu-ai', 'moe-ai-510209', 'stanford-ms'], ['vocational', 'undergraduate', 'graduate', 'self_directed']),
  n('computer-vision', '计算机视觉', 5, 'advanced', ['AI', '视觉'], ['CV', '视觉感知'], ['cmu-ai', 'stanford-ms', 'moe-ai-510209']),
  n('natural-language-processing', '自然语言处理', 5, 'advanced', ['AI', '语言'], ['NLP', '语言技术'], ['cmu-ai', 'stanford-ms', 'moe-ai-510209']),
  n('reinforcement-learning', '强化学习', 5, 'advanced', ['AI', '决策'], ['RL', '序贯决策'], ['cmu-ai', 'stanford-ms']),
  n('robotics', '机器人学', 5, 'advanced', ['AI', '机器人'], ['Robotics', '智能机器人'], ['cmu-ai', 'stanford-ms']),
  n('mlops', 'MLOps 与模型部署', 5, 'advanced', ['AI', '工程', '运维'], ['模型部署', 'AI系统运维'], ['moe-ai-510209', 'cmu-mscs']),
  n('llm-foundations', '大语言模型基础', 6, 'advanced', ['AI', '语言'], ['LLM', 'Transformer大模型'], ['stanford-ms', 'nyu-agents'], ['undergraduate', 'graduate', 'self_directed']),
  n('ai-safety-ethics', 'AI 安全、伦理与治理', 6, 'advanced', ['AI', '安全', '伦理'], ['AI安全', '负责任AI'], ['acm-cs2023', 'cmu-ai', 'zju-cs']),
  n('advanced-algorithms', '高等算法', 6, 'advanced', ['算法', '研究'], ['研究生算法', 'Graduate Algorithms'], ['cmu-mscs', 'stanford-ms'], ['graduate', 'self_directed']),
  n('advanced-systems', '高阶系统专题', 6, 'advanced', ['系统', '研究'], ['高级操作系统', '高级分布式系统'], ['cmu-mscs'], ['graduate', 'self_directed']),
  n('formal-methods', '形式化方法与程序验证', 6, 'advanced', ['理论', '软件', '安全'], ['模型检测', '程序验证'], ['cmu-mscs', 'acm-cs2023'], ['graduate', 'self_directed']),
  n('security-operations', '安全运营与应急响应', 6, 'advanced', ['安全', '实践'], ['风险评估', '数字取证'], ['moe-security-510207'], ['vocational', 'undergraduate', 'graduate', 'self_directed']),
  n('engineering-debugging-observability', '工程调试与可观测性', 4, 'domain', ['软件', '系统', '运维', '实践'], ['调试方法', '日志指标链路', 'Observability'], ['swebok-v4', 'google-sre'], ['vocational', 'undergraduate', 'graduate', 'self_directed'], '系统学习复现、假设、定位和验证故障，并使用日志、指标、追踪与剖析建立可解释的运行证据，最终能够完成一次有依据的故障归因。'),
  n('api-design-evolution', 'API 设计与演进', 4, 'domain', ['软件', '工程', 'Web'], ['接口设计', 'API版本治理', '契约测试'], ['swebok-v4'], ['vocational', 'undergraduate', 'graduate', 'self_directed'], '围绕接口契约、错误模型、兼容性、版本、幂等与弃用策略设计可长期演进的服务边界，并通过契约测试验证调用方和服务方的共同预期。'),
  n('software-maintenance-evolution', '软件维护与演化', 4, 'domain', ['软件', '工程'], ['遗留系统维护', '重构', '技术债'], ['swebok-v4'], ['vocational', 'undergraduate', 'graduate', 'self_directed'], '阅读既有系统，安全重构与迁移，管理依赖和技术债，并用回归证据控制长期变更风险，能够为一次真实演化说明边界、迁移步骤和回退策略。'),
  n('open-source-collaboration', '开源协作与工程沟通', 3, 'domain', ['软件', '工程', '实践'], ['开源贡献', '代码评审', '技术写作'], ['swebok-v4'], ['vocational', 'undergraduate', 'graduate', 'self_directed'], '通过问题描述、提交、代码评审、文档、许可证和社区协作完成可被他人检查与接续的工程贡献，并理解维护者、贡献者与用户之间的责任边界。'),
  n('performance-engineering', '性能工程', 5, 'advanced', ['系统', '软件', '工程'], ['性能分析', '基准测试', '容量规划'], ['swebok-v4', 'google-sre'], ['vocational', 'undergraduate', 'graduate', 'self_directed'], '从工作负载与服务目标出发测量延迟、吞吐和资源成本，使用剖析、基准和容量模型定位瓶颈，并验证优化是否改善真实负载而非单一样例。'),
  n('reliability-incident-response', '可靠性工程与生产事件响应', 5, 'advanced', ['系统', '运维', '工程', '实践'], ['SRE', '故障响应', '复盘'], ['google-sre'], ['vocational', 'undergraduate', 'graduate', 'self_directed'], '定义服务目标和错误预算，设计降级与恢复机制，并通过值守、事件指挥和无责复盘改善真实生产系统。'),
  n('secure-software-supply-chain', '安全软件开发与软件供应链', 5, 'advanced', ['安全', '软件', '工程'], ['安全开发生命周期', '依赖安全', '软件供应链安全'], ['nist-ssdf', 'swebok-v4'], ['vocational', 'undergraduate', 'graduate', 'self_directed'], '把威胁建模、安全编码、依赖与构建来源、制品签名、漏洞响应嵌入软件全生命周期，并以可追溯清单和验证流程降低交付风险。'),
  n('information-retrieval', '信息检索', 5, 'advanced', ['数据', 'AI', '语言'], ['搜索引擎原理', '检索模型', 'Information Retrieval'], ['acm-cs2023', 'stanford-ms'], ['undergraduate', 'graduate', 'self_directed'], '学习索引、召回与排序、相关性判断、离线评测和交互反馈，理解从关键词检索到语义检索的共同骨架。'),
  n('data-governance-privacy', '数据治理与隐私工程', 5, 'advanced', ['数据', '安全', '伦理', '工程'], ['数据质量治理', '隐私工程', '数据血缘'], ['acm-cs2023', 'nist-ssdf'], ['vocational', 'undergraduate', 'graduate', 'self_directed'], '管理数据质量、目录、血缘、访问、保留与删除，并把隐私风险和合规约束转化为可验证的工程控制。'),
  n('ai-system-evaluation', 'AI 系统评测', 7, 'research', ['AI', '工程', '研究'], ['模型评测', 'Agent评测', '红队测试'], ['nist-ai-evaluation', 'cmu-ai'], ['undergraduate', 'graduate', 'self_directed'], '从任务定义、数据切分、指标、基线和不确定性出发评估模型与智能体，并检查鲁棒性、安全性和真实使用效果。'),
  n('platform-engineering', '平台工程', 6, 'advanced', ['系统', '云', '运维', '工程'], ['开发者平台', '内部开发平台', 'Platform Engineering'], ['cncf-platform-engineering', 'google-sre'], ['undergraduate', 'graduate', 'self_directed'], '把基础设施、交付、可观测性和安全能力组织成自助式开发者平台，以产品思维降低团队认知负担，并用内部用户反馈和交付指标持续验证平台价值。'),
  n('numerical-scientific-computing', '数值与科学计算', 5, 'advanced', ['数学', '计算', '研究'], ['数值分析', '科学计算', 'Numerical Computing'], ['acm-cs2023', 'cmu-mscs'], ['undergraduate', 'graduate', 'self_directed'], '研究浮点误差、数值稳定性、线性方程与迭代方法，并用向量化、误差分析和对照实验验证计算结果是否可靠、可复现。'),
  n('research-methods', '计算机研究方法', 6, 'research', ['研究', '通识'], ['论文阅读', '实验设计', '科研方法'], ['cmu-mscs', 'tsinghua-2023', 'zju-cs'], ['undergraduate', 'graduate', 'self_directed']),
  n('retrieval-augmented-generation', '检索增强生成（RAG）', 7, 'advanced', ['AI', '数据', '工程'], ['RAG', '向量检索'], ['nyu-agents'], ['undergraduate', 'graduate', 'self_directed']),
  n('agent-engineering', '智能体工程', 8, 'advanced', ['AI', '工程', '智能体'], ['Agent开发', 'AI Agent', '工具调用', 'agent development'], ['nyu-agents'], ['undergraduate', 'graduate', 'self_directed'], '围绕工具调用、状态、记忆、编排、评测和真实用户交付构建 AI 智能体。'),
  n('multi-agent-systems', '多智能体系统', 9, 'advanced', ['AI', '智能体', '研究'], ['Multi-Agent', 'MAS', '多Agent'], ['nyu-agents', 'stanford-ms'], ['graduate', 'self_directed']),
  n('capstone-project', '综合工程项目', 10, 'research', ['实践', '工程'], ['毕业设计', 'Capstone', '作品集项目'], ['cornell-cs', 'tsinghua-2023', 'moe-vocational-2025'], ['vocational', 'undergraduate', 'graduate', 'self_directed']),
  n('thesis-research', '研究课题与学位论文', 10, 'research', ['研究'], ['论文研究', 'Thesis'], ['cmu-mscs', 'stanford-ms', 'tsinghua-2023'], ['graduate', 'self_directed']),
]

const e = (from: string, to: string, kind: PathEdgeKind, rationale: string): LearningPathEdge => ({
  id: `${from}--${to}`, from, to, kind, rationale, origin: 'official',
})

export const OFFICIAL_PATH_EDGES: LearningPathEdge[] = [
  e('digital-literacy', 'programming-foundations', 'soft_prerequisite', '先建立基本数字工具与信息素养'),
  e('computer-introduction', 'programming-foundations', 'co_learning', '导论帮助理解程序设计在学科中的位置'),
  e('programming-foundations', 'python-programming', 'hard_prerequisite', '需要基本变量、控制流与函数概念'),
  e('programming-foundations', 'c-programming', 'hard_prerequisite', '需要基本程序设计能力'),
  e('programming-foundations', 'object-oriented-programming', 'hard_prerequisite', '面向对象建立在基础编程之上'),
  e('programming-foundations', 'data-structures', 'hard_prerequisite', '数据结构需要可实现的程序设计基础'),
  e('discrete-mathematics', 'data-structures', 'soft_prerequisite', '集合、关系与递归支撑结构化推理'),
  e('c-programming', 'computer-organization', 'soft_prerequisite', '底层语言帮助连接机器表示'),
  e('digital-logic', 'computer-organization', 'hard_prerequisite', '组成原理依赖逻辑电路与数据表示'),
  e('web-foundations', 'web-development', 'hard_prerequisite', 'Web 应用开发依赖协议与前端基础'),
  e('database-foundations', 'database-systems', 'hard_prerequisite', '先具备数据模型与 SQL 操作经验'),
  e('networking-foundations', 'computer-networks', 'hard_prerequisite', '先建立协议、寻址与网络设备概念'),
  e('networking-foundations', 'network-routing-switching', 'hard_prerequisite', '设备配置依赖基础网络概念'),
  e('linux-fundamentals', 'linux-administration', 'hard_prerequisite', '系统管理依赖命令行与文件权限基础'),
  e('software-development-foundations', 'software-engineering', 'hard_prerequisite', '工程过程建立在版本、测试与协作基础上'),
  e('object-oriented-programming', 'software-engineering', 'soft_prerequisite', '常见工程设计使用对象与抽象'),
  e('data-structures', 'algorithms', 'hard_prerequisite', '算法设计需要结构与复杂度分析对象'),
  e('discrete-mathematics', 'algorithms', 'hard_prerequisite', '证明、图与组合方法是算法基础'),
  e('discrete-mathematics', 'theory-of-computation', 'hard_prerequisite', '形式语言与可计算性依赖离散结构'),
  e('computer-organization', 'operating-systems', 'hard_prerequisite', '操作系统依赖处理器、存储与中断模型'),
  e('data-structures', 'database-systems', 'soft_prerequisite', '索引与执行结构需要数据结构'),
  e('data-structures', 'programming-languages', 'soft_prerequisite', '抽象数据类型帮助理解语言设计'),
  e('programming-foundations', 'computer-security', 'hard_prerequisite', '安全实践至少需要读写程序'),
  e('networking-foundations', 'computer-security', 'co_learning', '网络边界是安全问题的重要载体'),
  e('programming-foundations', 'mobile-development', 'hard_prerequisite', '移动开发依赖通用编程能力'),
  e('computer-organization', 'embedded-systems', 'hard_prerequisite', '嵌入式系统需要硬件与机器接口基础'),
  e('linear-algebra', 'computer-graphics', 'hard_prerequisite', '图形变换依赖向量与矩阵'),
  e('data-structures', 'computer-graphics', 'soft_prerequisite', '几何与场景表示需要数据结构'),
  e('operating-systems', 'distributed-systems', 'hard_prerequisite', '分布式系统依赖并发、进程与资源管理'),
  e('computer-networks', 'distributed-systems', 'hard_prerequisite', '分布式通信依赖网络协议'),
  e('operating-systems', 'cloud-computing', 'soft_prerequisite', '云平台建立在虚拟化与资源管理之上'),
  e('computer-networks', 'cloud-computing', 'soft_prerequisite', '云服务依赖网络与服务通信'),
  e('software-engineering', 'devops', 'hard_prerequisite', '持续交付扩展软件工程过程'),
  e('linux-administration', 'devops', 'soft_prerequisite', '部署与自动化通常依赖 Linux 环境'),
  e('theory-of-computation', 'compilers', 'soft_prerequisite', '形式语言支撑词法语法分析'),
  e('programming-languages', 'compilers', 'hard_prerequisite', '编译器实现依赖语言语义与运行时'),
  e('algorithms', 'parallel-computing', 'soft_prerequisite', '并行算法需要复杂度与分解能力'),
  e('operating-systems', 'parallel-computing', 'soft_prerequisite', '线程、同步和内存模型是实践基础'),
  e('computer-security', 'cybersecurity-engineering', 'hard_prerequisite', '安全工程建立在威胁与控制基础上'),
  e('computer-networks', 'cybersecurity-engineering', 'hard_prerequisite', '网络防护需要协议与拓扑知识'),
  e('web-development', 'web-security', 'hard_prerequisite', '理解 Web 应用结构才能分析漏洞'),
  e('computer-security', 'web-security', 'hard_prerequisite', '需要基本威胁模型与防护原则'),
  e('discrete-mathematics', 'applied-cryptography', 'soft_prerequisite', '密码学使用离散结构与证明'),
  e('probability-statistics', 'applied-cryptography', 'soft_prerequisite', '随机性与安全参数需要概率基础'),
  e('database-systems', 'data-engineering', 'hard_prerequisite', '数据工程依赖存储、查询与事务基础'),
  e('software-engineering', 'software-architecture', 'hard_prerequisite', '大型设计建立在工程过程与模块化之上'),
  e('algorithms', 'artificial-intelligence', 'soft_prerequisite', '搜索与推理需要算法基础'),
  e('discrete-mathematics', 'artificial-intelligence', 'soft_prerequisite', '逻辑与关系支撑符号推理'),
  e('python-programming', 'machine-learning', 'hard_prerequisite', '需要可实现数据处理与模型实验'),
  e('linear-algebra', 'machine-learning', 'hard_prerequisite', '模型表示与计算依赖矩阵方法'),
  e('probability-statistics', 'machine-learning', 'hard_prerequisite', '学习与评估依赖概率统计'),
  e('calculus', 'machine-learning', 'soft_prerequisite', '优化与连续模型需要微积分'),
  e('algorithms', 'machine-learning', 'soft_prerequisite', '复杂度与实现需要算法基础'),
  e('data-processing', 'machine-learning', 'co_learning', '真实建模需同步学习数据质量与特征处理'),
  e('database-systems', 'data-mining', 'soft_prerequisite', '数据挖掘经常依赖数据组织与查询'),
  e('probability-statistics', 'data-mining', 'hard_prerequisite', '模式发现与评估需要统计基础'),
  e('calculus', 'optimization', 'hard_prerequisite', '连续优化依赖导数与梯度'),
  e('linear-algebra', 'optimization', 'hard_prerequisite', '数值优化依赖向量空间与矩阵'),
  e('machine-learning', 'statistical-learning', 'hard_prerequisite', '理论课程建立在基础模型与泛化问题之上'),
  e('probability-statistics', 'statistical-learning', 'hard_prerequisite', '泛化界与估计依赖统计基础'),
  e('machine-learning', 'deep-learning', 'hard_prerequisite', '先理解训练、泛化与评估'),
  e('optimization', 'deep-learning', 'soft_prerequisite', '深度模型训练依赖优化方法'),
  e('linear-algebra', 'deep-learning', 'hard_prerequisite', '神经网络主要计算以张量和矩阵为基础'),
  e('deep-learning', 'computer-vision', 'hard_prerequisite', '现代视觉课程通常使用深度模型'),
  e('computer-graphics', 'computer-vision', 'co_learning', '图形生成与视觉理解可互相补充'),
  e('deep-learning', 'natural-language-processing', 'hard_prerequisite', '现代 NLP 依赖表示学习与 Transformer'),
  e('machine-learning', 'reinforcement-learning', 'hard_prerequisite', 'RL 需要基本学习与函数逼近概念'),
  e('probability-statistics', 'reinforcement-learning', 'hard_prerequisite', '序贯决策依赖随机过程与期望'),
  e('optimization', 'reinforcement-learning', 'soft_prerequisite', '策略优化需要最优化基础'),
  e('artificial-intelligence', 'robotics', 'soft_prerequisite', '规划、搜索与决策是机器人智能基础'),
  e('linear-algebra', 'robotics', 'hard_prerequisite', '运动学与坐标变换依赖线性代数'),
  e('machine-learning', 'mlops', 'hard_prerequisite', '需要理解训练、评估和模型工件'),
  e('devops', 'mlops', 'hard_prerequisite', '模型交付扩展持续集成、部署与监控'),
  e('deep-learning', 'llm-foundations', 'hard_prerequisite', 'LLM 建立在深度学习与 Transformer 之上'),
  e('natural-language-processing', 'llm-foundations', 'soft_prerequisite', 'NLP 提供语言任务、表示与评估背景'),
  e('computing-ethics', 'ai-safety-ethics', 'hard_prerequisite', '先建立计算技术责任边界'),
  e('artificial-intelligence', 'ai-safety-ethics', 'soft_prerequisite', '理解 AI 能力与失效模式后再分析治理'),
  e('algorithms', 'advanced-algorithms', 'hard_prerequisite', '研究生算法以本科算法为基础'),
  e('distributed-systems', 'advanced-systems', 'hard_prerequisite', '高阶系统专题需要系统与分布式基础'),
  e('theory-of-computation', 'formal-methods', 'hard_prerequisite', '形式验证依赖逻辑与形式语义'),
  e('programming-languages', 'formal-methods', 'soft_prerequisite', '程序语义帮助定义验证对象'),
  e('cybersecurity-engineering', 'security-operations', 'hard_prerequisite', '运营与响应需要安全控制实践'),
  e('computer-organization', 'computer-maintenance', 'co_learning', '组成原理与部件装配、故障定位可以相互验证'),
  e('digital-literacy', 'computer-maintenance', 'soft_prerequisite', '先具备基本设备与操作系统使用能力'),
  e('networking-foundations', 'windows-server-administration', 'soft_prerequisite', '服务器角色配置需要基本网络服务概念'),
  e('digital-literacy', 'windows-server-administration', 'soft_prerequisite', '服务器管理建立在系统操作与信息素养之上'),
  e('networking-foundations', 'network-cabling', 'hard_prerequisite', '综合布线需要理解介质、拓扑和网络接口'),
  e('web-foundations', 'frontend-design-development', 'hard_prerequisite', '前端设计与开发需要 HTML、CSS 和浏览器基础'),
  e('frontend-design-development', 'web-development', 'co_learning', '前端交互与后端应用能力应在完整 Web 场景中协同'),
  e('software-development-foundations', 'software-modeling-design', 'hard_prerequisite', '建模设计需要基本版本、需求和软件构造经验'),
  e('object-oriented-programming', 'software-modeling-design', 'hard_prerequisite', '对象、职责与关系是 UML 建模和设计模式的基础'),
  e('software-modeling-design', 'enterprise-application-development', 'hard_prerequisite', '企业级项目需要先形成需求模型和模块设计'),
  e('web-development', 'enterprise-application-development', 'soft_prerequisite', '企业应用常建立在 Web 请求、会话与 API 机制上'),
  e('database-systems', 'enterprise-application-development', 'soft_prerequisite', '业务应用需要数据库设计、事务与持久化能力'),
  e('software-development-foundations', 'software-testing', 'hard_prerequisite', '测试需要理解版本、构建、缺陷与工程过程'),
  e('enterprise-application-development', 'software-testing', 'co_learning', '在真实企业项目中设计测试才能形成完整质量证据'),
  e('mobile-development', 'mobile-cross-platform', 'hard_prerequisite', '跨平台开发需要移动界面、数据和发布基础'),
  e('web-foundations', 'mini-program-development', 'hard_prerequisite', '小程序页面与交互建立在 Web 基础之上'),
  e('mobile-development', 'mini-program-development', 'soft_prerequisite', '移动应用生命周期与接口经验可迁移到小程序'),
  e('python-programming', 'data-acquisition-technology', 'hard_prerequisite', '数据采集任务需要脚本、接口和解析能力'),
  e('database-foundations', 'data-acquisition-technology', 'soft_prerequisite', '采集数据库数据需要基本 SQL 与数据模型经验'),
  e('data-acquisition-technology', 'data-preprocessing-etl', 'hard_prerequisite', '预处理与 ETL 以可获得的多源数据为输入'),
  e('database-foundations', 'data-preprocessing-etl', 'soft_prerequisite', '抽取、转换和装载需要理解表、类型与约束'),
  e('data-preprocessing-etl', 'data-analysis-applications', 'hard_prerequisite', '可靠分析需要经过清洗和一致化的数据'),
  e('probability-statistics', 'data-analysis-applications', 'soft_prerequisite', '描述统计和指标解释需要概率统计基础'),
  e('data-analysis-applications', 'data-visualization-applications', 'co_learning', '分析与可视化应围绕同一业务问题迭代'),
  e('hci-foundations', 'data-visualization-applications', 'soft_prerequisite', '可视化交互与信息呈现需要基本用户体验原则'),
  e('database-systems', 'big-data-platform-operations', 'soft_prerequisite', '大数据平台仍需要存储、查询和数据管理基础'),
  e('linux-administration', 'big-data-platform-operations', 'hard_prerequisite', '分布式平台部署运维依赖 Linux 系统管理'),
  e('data-engineering', 'big-data-platform-operations', 'hard_prerequisite', '平台运维需要理解数据管道与分布式处理任务'),
  e('networking-foundations', 'wireless-networking', 'hard_prerequisite', '无线组网需要寻址、协议和局域网基础'),
  e('network-routing-switching', 'wireless-networking', 'soft_prerequisite', '无线接入最终需要进入可路由交换的网络'),
  e('python-programming', 'network-automation', 'hard_prerequisite', '网络自动化需要脚本、数据结构与接口调用能力'),
  e('network-routing-switching', 'network-automation', 'hard_prerequisite', '自动化配置前必须理解设备命令和网络行为'),
  e('network-routing-switching', 'network-virtualization', 'hard_prerequisite', '虚拟网络建立在二三层转发和隔离概念上'),
  e('network-cabling', 'network-systems-integration', 'soft_prerequisite', '网络工程实施包含布线、测试与验收'),
  e('network-routing-switching', 'network-systems-integration', 'hard_prerequisite', '系统集成需要设备选型、地址规划和路由交换能力'),
  e('wireless-networking', 'network-systems-integration', 'soft_prerequisite', '现代园区网络通常包含无线接入与优化'),
  e('network-automation', 'network-systems-integration', 'co_learning', '自动化巡检与配置可提升集成项目的交付质量'),
  e('operating-systems', 'virtualization-technology', 'hard_prerequisite', '虚拟化建立在处理器、内存与操作系统资源管理之上'),
  e('networking-foundations', 'virtualization-technology', 'soft_prerequisite', '虚拟机和虚拟网络需要基本网络配置能力'),
  e('virtualization-technology', 'cloud-platform-operations', 'hard_prerequisite', '云平台运维需要先掌握虚拟资源与镜像管理'),
  e('cloud-computing', 'cloud-platform-operations', 'co_learning', '云计算概念与实际平台服务应同步建立'),
  e('linux-administration', 'cloud-platform-operations', 'soft_prerequisite', '多数云平台节点和服务依赖 Linux 管理能力'),
  e('cloud-platform-operations', 'container-cloud-operations', 'hard_prerequisite', '容器云运维需要云平台资源、网络、存储和监控基础'),
  e('linux-administration', 'container-cloud-operations', 'hard_prerequisite', '容器运行、镜像和编排依赖 Linux 系统能力'),
  e('computer-security', 'cloud-security-applications', 'hard_prerequisite', '云安全需要基本威胁、身份和控制原则'),
  e('cloud-platform-operations', 'cloud-security-applications', 'hard_prerequisite', '先理解云资源与服务边界才能实施安全运维'),
  e('windows-server-administration', 'system-deployment-operations', 'soft_prerequisite', '系统部署需要服务器角色、权限和服务管理经验'),
  e('linux-administration', 'system-deployment-operations', 'hard_prerequisite', '部署运维需要命令行、权限、服务和日志管理能力'),
  e('database-foundations', 'system-deployment-operations', 'soft_prerequisite', '业务系统部署通常包含数据库服务与备份'),
  e('linux-administration', 'operating-system-security', 'hard_prerequisite', '主机安全加固需要账户、权限、服务与日志管理基础'),
  e('computer-security', 'operating-system-security', 'hard_prerequisite', '系统加固需要基本威胁与安全控制原则'),
  e('network-routing-switching', 'security-product-configuration', 'hard_prerequisite', '安全产品部署需要网络地址、路由和交换配置能力'),
  e('computer-security', 'security-product-configuration', 'hard_prerequisite', '产品策略配置需要理解安全边界和控制目标'),
  e('database-foundations', 'storage-disaster-recovery', 'soft_prerequisite', '数据备份恢复需要理解数据组织、权限和一致性'),
  e('operating-systems', 'storage-disaster-recovery', 'soft_prerequisite', '存储、文件系统和 RAID 与操作系统资源管理相关'),
  e('storage-disaster-recovery', 'digital-forensics', 'soft_prerequisite', '取证中的介质恢复和数据提取需要存储基础'),
  e('computer-security', 'digital-forensics', 'hard_prerequisite', '电子取证需要安全事件、证据边界和攻击痕迹基础'),
  e('operating-system-security', 'security-risk-assessment', 'soft_prerequisite', '风险评估需要能够检查主机安全控制'),
  e('security-product-configuration', 'security-risk-assessment', 'soft_prerequisite', '理解防护产品有助于评估网络与边界控制'),
  e('cybersecurity-engineering', 'security-risk-assessment', 'hard_prerequisite', '系统化风险评估建立在安全工程与控制实施之上'),
  e('software-development-foundations', 'open-source-collaboration', 'hard_prerequisite', '参与协作前需要版本控制、测试和基本软件构造能力'),
  e('software-engineering', 'engineering-debugging-observability', 'hard_prerequisite', '系统调试需要可测试的软件边界和工程过程'),
  e('linux-administration', 'engineering-debugging-observability', 'soft_prerequisite', '系统日志、进程和资源观察通常依赖操作系统管理能力'),
  e('software-engineering', 'api-design-evolution', 'hard_prerequisite', '接口契约与演进建立在模块、测试和变更管理基础上'),
  e('web-development', 'api-design-evolution', 'soft_prerequisite', 'Web 请求、状态和服务边界为 API 设计提供真实语境'),
  e('software-engineering', 'software-maintenance-evolution', 'hard_prerequisite', '维护与演化需要需求、架构、测试和配置管理基础'),
  e('open-source-collaboration', 'software-maintenance-evolution', 'co_learning', '真实维护往往通过问题、评审、文档和增量提交完成'),
  e('engineering-debugging-observability', 'performance-engineering', 'hard_prerequisite', '性能优化必须先建立可复现、可观测和可验证的测量方法'),
  e('computer-organization', 'performance-engineering', 'soft_prerequisite', '缓存、内存和处理器模型帮助解释底层性能现象'),
  e('engineering-debugging-observability', 'reliability-incident-response', 'hard_prerequisite', '生产响应依赖日志、指标、追踪和系统化故障定位'),
  e('devops', 'reliability-incident-response', 'hard_prerequisite', '可靠性实践建立在自动化交付、部署与变更控制之上'),
  e('distributed-systems', 'reliability-incident-response', 'soft_prerequisite', '分布式故障模型帮助设计降级、恢复与演练'),
  e('software-development-foundations', 'secure-software-supply-chain', 'hard_prerequisite', '安全供应链需要版本、构建、依赖和测试基础'),
  e('computer-security', 'secure-software-supply-chain', 'hard_prerequisite', '安全开发必须建立在威胁、身份和控制原则上'),
  e('devops', 'secure-software-supply-chain', 'soft_prerequisite', '构建和交付流水线是供应链控制的主要执行位置'),
  e('data-structures', 'information-retrieval', 'hard_prerequisite', '倒排索引、向量索引和排序结构依赖数据结构'),
  e('probability-statistics', 'information-retrieval', 'soft_prerequisite', '相关性评估和排序实验需要统计判断'),
  e('machine-learning', 'information-retrieval', 'soft_prerequisite', '学习排序与语义检索会使用机器学习方法'),
  e('database-systems', 'data-governance-privacy', 'hard_prerequisite', '治理数据之前需要理解模型、查询、事务和权限'),
  e('data-engineering', 'data-governance-privacy', 'hard_prerequisite', '目录、血缘和质量控制依附于真实数据管道'),
  e('computing-ethics', 'data-governance-privacy', 'soft_prerequisite', '隐私工程需要责任、用途和影响边界'),
  e('machine-learning', 'ai-system-evaluation', 'hard_prerequisite', '评测 AI 系统需要理解训练、推断、泛化和基线'),
  e('research-methods', 'ai-system-evaluation', 'hard_prerequisite', '可靠评测需要实验设计、证据质量和不确定性表达'),
  e('ai-safety-ethics', 'ai-system-evaluation', 'co_learning', '能力评测应与风险、失效和真实影响评测同步'),
  e('cloud-platform-operations', 'platform-engineering', 'hard_prerequisite', '平台工程建立在可运行的计算、网络、存储和权限能力上'),
  e('devops', 'platform-engineering', 'hard_prerequisite', '内部平台需要承载构建、交付和开发工作流'),
  e('reliability-incident-response', 'platform-engineering', 'soft_prerequisite', '平台能力必须用可靠性目标和生产反馈持续改进'),
  e('calculus', 'numerical-scientific-computing', 'hard_prerequisite', '数值方法以连续问题、导数与积分为主要对象'),
  e('linear-algebra', 'numerical-scientific-computing', 'hard_prerequisite', '科学计算广泛依赖矩阵分解与线性方程求解'),
  e('parallel-computing', 'numerical-scientific-computing', 'co_learning', '大规模科学计算常需并行实现与性能验证'),
  e('research-methods', 'thesis-research', 'hard_prerequisite', '课题研究需要问题、证据和实验设计'),
  e('llm-foundations', 'retrieval-augmented-generation', 'hard_prerequisite', 'RAG 需要理解生成模型的输入输出边界'),
  e('database-systems', 'retrieval-augmented-generation', 'soft_prerequisite', '检索增强涉及索引、查询与数据治理'),
  e('software-architecture', 'agent-engineering', 'hard_prerequisite', '智能体工程需要状态、边界和系统组合能力'),
  e('llm-foundations', 'agent-engineering', 'hard_prerequisite', '需要理解模型调用、上下文和不确定性'),
  e('retrieval-augmented-generation', 'agent-engineering', 'soft_prerequisite', '知识型智能体常需要受控检索'),
  e('information-retrieval', 'retrieval-augmented-generation', 'hard_prerequisite', 'RAG 的检索部分依赖索引、召回、排序与离线评测'),
  e('ai-system-evaluation', 'agent-engineering', 'co_learning', '智能体交付需要同步建立任务成功、轨迹、安全和用户效果评测'),
  e('computing-ethics', 'agent-engineering', 'co_learning', '工具行动与用户影响需要责任边界'),
  e('agent-engineering', 'multi-agent-systems', 'hard_prerequisite', '多智能体建立在单智能体状态与工具编排之上'),
  e('distributed-systems', 'multi-agent-systems', 'soft_prerequisite', '并发通信与故障模型可帮助理解多体协作'),
  e('software-engineering', 'capstone-project', 'soft_prerequisite', '综合产物需要版本、测试与协作过程'),
  e('research-methods', 'capstone-project', 'co_learning', '项目应保留问题定义、证据和反思'),
  e('advanced-algorithms', 'thesis-research', 'soft_prerequisite', '理论方向研究常需高阶算法能力'),
  e('advanced-systems', 'thesis-research', 'soft_prerequisite', '系统方向研究常需高阶系统背景'),
]

function stableHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function eventId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[\s·（）()_\-/]+/g, '')
}

function unique<T>(values: T[]) {
  return [...new Set(values)]
}

export function createInitialLearnerPathState(): LearnerPathState {
  const exposed = ['calculus', 'probability-statistics', 'data-structures', 'c-programming', 'python-programming', 'linear-algebra', 'discrete-mathematics']
  return {
    version: 1,
    events: exposed.map((nodeId, index) => ({
      id: `seed-exposure-${nodeId}`,
      sequence: index + 1,
      at: index + 1,
      type: 'vnext_learning_path_node_status_set' as const,
      detail: '由学习者既有自述初始化为“学过”；不代表掌握',
      nodeId,
      status: 'self_reported_exposed' as const,
    })),
  }
}

export function appendLearningPathEvent(
  state: LearnerPathState,
  event: Omit<LearningPathEvent, 'id' | 'sequence' | 'at'>,
  now = Date.now(),
): LearnerPathState {
  const sequence = state.events.reduce((max, item) => Math.max(max, item.sequence), 0) + 1
  return { version: 1, events: [...state.events, { ...event, id: eventId('path-event'), sequence, at: now }] }
}

export function projectLearnerPath(state: LearnerPathState): LearnerPathProjection {
  const statuses: Record<string, LearnerPathStatus> = {}
  const personalNodes = new Map<string, LearningPathNode>()
  const personalEdges = new Map<string, LearningPathEdge>()
  const removed = new Set<string>()
  const plans = new Map<string, LearningPathPlan>()
  let activePlanId = ''
  const events = [...state.events].sort((a, b) => a.sequence - b.sequence)
  events.forEach(event => {
    if (event.type === 'vnext_personal_path_node_added' && event.node) {
      personalNodes.set(event.node.id, event.node)
      event.edges?.forEach(edge => personalEdges.set(edge.id, edge))
      removed.delete(event.node.id)
    }
    if (event.type === 'vnext_personal_path_node_removed' && event.nodeId) {
      removed.add(event.nodeId)
      personalNodes.delete(event.nodeId)
      delete statuses[event.nodeId]
      for (const [edgeId, edge] of personalEdges) {
        if (edge.from === event.nodeId || edge.to === event.nodeId) personalEdges.delete(edgeId)
      }
    }
    if (event.type === 'vnext_learning_path_node_status_set' && event.nodeId && event.status && !removed.has(event.nodeId)) {
      statuses[event.nodeId] = event.status
    }
    if ((event.type === 'vnext_learning_path_plan_committed' || event.type === 'vnext_learning_path_plan_revised') && event.plan) {
      plans.set(event.plan.id, { ...event.plan, status: 'active' })
      activePlanId = event.plan.id
    }
    if (event.type === 'vnext_learning_path_plan_archived' && event.planId) {
      const previous = plans.get(event.planId)
      if (previous) plans.set(event.planId, { ...previous, status: 'archived' })
      if (activePlanId === event.planId) activePlanId = ''
    }
  })
  const nodes = [...OFFICIAL_PATH_NODES, ...personalNodes.values()]
  const nodeIds = new Set(nodes.map(node => node.id))
  const edges = [...OFFICIAL_PATH_EDGES, ...personalEdges.values()].filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to))
  const projectedPlans = [...plans.values()]
  return {
    nodes, edges, statuses, personalNodeIds: [...personalNodes.keys()],
    plans: projectedPlans,
    activePlan: projectedPlans.find(plan => plan.id === activePlanId && plan.status === 'active'),
    eventCount: events.length,
  }
}

export function setLearnerPathStatus(state: LearnerPathState, nodeId: string, status: LearnerPathStatus) {
  const projection = projectLearnerPath(state)
  if (!projection.nodes.some(node => node.id === nodeId)) return state
  return appendLearningPathEvent(state, {
    type: 'vnext_learning_path_node_status_set', nodeId, status,
    detail: `学习者把课程节点标记为“${PATH_STATUS_LABELS[status]}”；仅作自述与结构导航`,
  })
}

export function addPersonalPathNode(state: LearnerPathState, proposal: PersonalPathNodeProposal) {
  const projection = projectLearnerPath(state)
  const duplicate = projection.nodes.find(node => normalize(node.title) === normalize(proposal.title))
  if (duplicate) return state
  const nodeId = `personal-${stableHash(`${proposal.id}:${proposal.title}`)}`
  const maxAnchorOrder = Math.max(0, ...proposal.connections.map(connection => projection.nodes.find(node => node.id === connection.nodeId)?.order || 0))
  const node: LearningPathNode = {
    id: nodeId,
    title: proposal.title.slice(0, 80),
    summary: proposal.summary.slice(0, 260),
    aliases: proposal.aliases.slice(0, 8).map(item => item.slice(0, 60)),
    domains: proposal.domains.slice(0, 6).map(item => item.slice(0, 30)),
    audiences: ['self_directed'],
    stage: proposal.stage,
    order: Math.max(proposal.order, maxAnchorOrder + 1),
    origin: 'personal',
    sourceRefs: proposal.sourceUrls.slice(0, 6),
    sourceProposalId: proposal.id,
  }
  const edges = proposal.connections.slice(0, 6).flatMap((connection, index) => {
    const anchor = projection.nodes.find(item => item.id === connection.nodeId)
    if (!anchor || anchor.order >= node.order) return []
    return [{
      id: `personal-edge-${stableHash(`${node.id}:${anchor.id}:${index}`)}`,
      from: anchor.id,
      to: node.id,
      kind: connection.kind,
      rationale: connection.rationale.slice(0, 180),
      origin: 'personal' as const,
    }]
  })
  return appendLearningPathEvent(state, {
    type: 'vnext_personal_path_node_added', node, edges,
    detail: `学习者确认加入个人节点“${node.title}”，连接 ${edges.length} 个已有节点`,
  })
}

export function removePersonalPathNode(state: LearnerPathState, nodeId: string) {
  const projection = projectLearnerPath(state)
  const node = projection.nodes.find(item => item.id === nodeId && item.origin === 'personal')
  if (!node) return state
  return appendLearningPathEvent(state, {
    type: 'vnext_personal_path_node_removed', nodeId,
    detail: `学习者移除个人节点“${node.title}”；官方图不受影响`,
  })
}

function packetFromRetrieval(
  message: string,
  state: LearnerPathState,
  retrieval: LearningPathRetrievalResult | undefined,
  maxNodes = 10,
): LearningPathReadPacket {
  const projection = projectLearnerPath(state)
  const candidate = extractLearningPathTopic(message)
  const query = candidate || message.replace(/\s+/g, ' ').trim().slice(0, 180)
  const overview = !candidate
  const resolution = overview ? 'overview' : retrieval?.resolution || 'not_found'
  const candidateNodes = (retrieval?.candidates || []).flatMap(item => {
    const node = projection.nodes.find(candidateNode => candidateNode.id === item.nodeId)
    return node ? [node] : []
  })
  const matched = resolution === 'resolved' ? candidateNodes.slice(0, 1) : []
  const gap = retrieval?.mode === 'fuzzy' && resolution === 'not_found'
  const unresolved = !overview && retrieval?.mode === 'exact' && resolution !== 'resolved'
  const seedNodes = matched.length
    ? matched
    : candidateNodes.length
      ? candidateNodes.slice(0, 3)
    : projection.nodes.filter(node => projection.statuses[node.id] && projection.statuses[node.id] !== 'unmarked').slice(0, 5)
  const relatedIds = new Set(seedNodes.map(node => node.id))
  projection.edges.forEach(edge => {
    if (relatedIds.has(edge.from) || relatedIds.has(edge.to)) {
      if (relatedIds.size < maxNodes) relatedIds.add(edge.from)
      if (relatedIds.size < maxNodes) relatedIds.add(edge.to)
    }
  })
  const contextNodes = [
    ...seedNodes,
    ...projection.nodes.filter(node => relatedIds.has(node.id) && !seedNodes.some(seed => seed.id === node.id)),
  ].slice(0, Math.max(3, Math.min(maxNodes, 14)))
  const anchorPool = candidateNodes.filter(node => node.origin === 'official').slice(0, 3).map(node => node.id)
  const fallbackAnchors = ['programming-foundations', 'software-engineering', 'machine-learning'].filter(id => projection.nodes.some(node => node.id === id))
  const suggestedAnchorIds = unique((anchorPool.length ? anchorPool : fallbackAnchors).slice(0, 3))
  const nodeMap = new Map(projection.nodes.map(node => [node.id, node]))
  const packetNodes = contextNodes.map(node => ({
    id: node.id,
    title: node.title,
    origin: node.origin,
    status: projection.statuses[node.id] || 'unmarked' as LearnerPathStatus,
    stage: node.stage,
    prerequisites: projection.edges.filter(edge => edge.to === node.id).slice(0, 6).flatMap(edge => {
      const source = nodeMap.get(edge.from)
      return source ? [{ id: source.id, title: source.title, kind: edge.kind }] : []
    }),
    successors: projection.edges.filter(edge => edge.from === node.id).slice(0, 6).flatMap(edge => {
      const target = nodeMap.get(edge.to)
      return target ? [{ id: target.id, title: target.title, kind: edge.kind }] : []
    }),
  }))
  const matchKind: LearningPathReadPacket['matchKind'] = gap
    ? 'graph_gap'
    : unresolved || resolution === 'ambiguous'
      ? 'unresolved'
    : matched[0]?.origin === 'personal'
      ? 'personal_match'
      : matched.length ? 'official_match' : 'overview'
  const signature = `${retrieval?.policyId || 'overview'}|${retrieval?.mode || 'overview'}|${query}|${packetNodes.map(node => `${node.id}:${node.status}`).join('|')}|${projection.eventCount}`
  return {
    snapshotId: `path-${stableHash(signature)}`,
    policyId: 'vnext-learning-path-reader-v2',
    query,
    topicCandidate: candidate,
    matchKind,
    retrievalMode: overview ? 'overview' : retrieval?.mode || 'fuzzy',
    resolution,
    candidates: retrieval?.candidates || [],
    omittedCandidateCount: retrieval?.omittedCandidateCount || 0,
    recommendedNextAction: overview ? 'show_overview' : retrieval?.recommendedNextAction || 'research_graph_gap',
    matchedNodeIds: matched.map(node => node.id),
    contextNodeIds: packetNodes.map(node => node.id),
    suggestedAnchorIds,
    needsFuzzySearch: Boolean(retrieval?.recommendedNextAction === 'run_fuzzy_search'),
    needsExternalResearch: gap,
    nodes: packetNodes,
    manifest: {
      officialNodeCount: OFFICIAL_PATH_NODES.length,
      personalNodeCount: projection.personalNodeIds.length,
      selfReportedMasteredCount: Object.values(projection.statuses).filter(status => status === 'self_reported_mastered').length,
      noKnowledgeMasteryInference: true,
    },
  }
}

export function lookupLearningPathGraph(message: string, state: LearnerPathState, maxNodes = 10) {
  const projection = projectLearnerPath(state)
  const topic = extractLearningPathTopic(message)
  if (!topic) return packetFromRetrieval(message, state, undefined, maxNodes)
  return packetFromRetrieval(message, state, lookupExactLearningPath(projection.nodes, message), maxNodes)
}

export function searchLearningPathGraph(message: string, state: LearnerPathState, maxNodes = 10) {
  const projection = projectLearnerPath(state)
  const topic = extractLearningPathTopic(message) || message
  return packetFromRetrieval(message, state, searchFuzzyLearningPath(projection.nodes, topic), maxNodes)
}

export function readLearningPathGraph(message: string, state: LearnerPathState, maxNodes = 10): LearningPathReadPacket {
  const exact = lookupLearningPathGraph(message, state, maxNodes)
  return exact.resolution === 'resolved' || exact.resolution === 'overview'
    ? exact
    : searchLearningPathGraph(message, state, maxNodes)
}

function planningHorizon(message: string) {
  if (/半年/.test(message)) return '6 个月'
  const match = message.match(/(?:用|在|计划)?\s*(\d{1,2}|一|两|三|四|五|六|七|八|九|十)\s*(周|个月|月|年)/)
  if (match) return `${match[1]} ${match[2] === '月' ? '个月' : match[2]}`
  if (/本学期|这学期/.test(message)) return '本学期'
  if (/暑假|寒假/.test(message)) return message.match(/暑假|寒假/)?.[0] || '阶段性'
  return '长期滚动规划'
}

export function topologicallyOrderLearningPathRoute(
  nodeIds: string[],
  nodes: LearningPathNode[],
  edges: LearningPathEdge[],
) {
  const selected = new Set(nodeIds)
  const nodeMap = new Map(nodes.map(node => [node.id, node]))
  const indegree = new Map([...selected].map(nodeId => [nodeId, 0]))
  const outgoing = new Map([...selected].map(nodeId => [nodeId, [] as string[]]))
  const seenEdges = new Set<string>()
  edges.forEach(edge => {
    if (edge.kind === 'co_learning' || !selected.has(edge.from) || !selected.has(edge.to)) return
    const key = `${edge.from}:${edge.to}`
    if (seenEdges.has(key)) return
    seenEdges.add(key)
    outgoing.get(edge.from)?.push(edge.to)
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1)
  })
  const compare = (left: string, right: string) => {
    const leftNode = nodeMap.get(left), rightNode = nodeMap.get(right)
    return (leftNode?.order || 0) - (rightNode?.order || 0)
      || left.localeCompare(right)
  }
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([nodeId]) => nodeId).sort(compare)
  const ordered: string[] = []
  while (ready.length) {
    const current = ready.shift()!
    ordered.push(current)
    for (const successor of outgoing.get(current) || []) {
      const next = (indegree.get(successor) || 0) - 1
      indegree.set(successor, next)
      if (next === 0) {
        ready.push(successor)
        ready.sort(compare)
      }
    }
  }
  if (ordered.length !== selected.size) {
    ordered.push(...[...selected].filter(nodeId => !ordered.includes(nodeId)).sort(compare))
  }
  return ordered
}

export function learningPathAudienceNodeIds(
  nodes: LearningPathNode[],
  edges: LearningPathEdge[],
  audience: PathAudience,
) {
  const visible = new Set(nodes.filter(node => node.audiences.includes(audience)).map(node => node.id))
  const incomingHard = new Map<string, string[]>()
  edges.forEach(edge => {
    if (edge.kind !== 'hard_prerequisite') return
    incomingHard.set(edge.to, [...(incomingHard.get(edge.to) || []), edge.from])
  })
  const queue = [...visible]
  while (queue.length) {
    const current = queue.shift()!
    for (const prerequisite of incomingHard.get(current) || []) {
      if (visible.has(prerequisite)) continue
      visible.add(prerequisite)
      queue.push(prerequisite)
    }
  }
  return visible
}

export function buildLearningPathPlanProposal(
  message: string,
  state: LearnerPathState,
  packet = readLearningPathGraph(message, state, 14),
): LearningPathPlanProposal | undefined {
  if (packet.needsExternalResearch || packet.matchedNodeIds.length === 0) return undefined
  const projection = projectLearnerPath(state)
  const nodeMap = new Map(projection.nodes.map(node => [node.id, node]))
  const targets = packet.matchedNodeIds.filter(nodeId => nodeMap.has(nodeId)).slice(0, 3)
  if (!targets.length) return undefined

  const reverse = new Map<string, LearningPathEdge[]>()
  projection.edges.forEach(edge => {
    if (edge.kind === 'co_learning') return
    reverse.set(edge.to, [...(reverse.get(edge.to) || []), edge])
  })
  const distance = new Map<string, number>(targets.map(nodeId => [nodeId, 0]))
  const approachKind = new Map<string, PathEdgeKind>()
  const queue = [...targets]
  while (queue.length) {
    const current = queue.shift()!
    const currentDistance = distance.get(current) || 0
    if (currentDistance >= 5) continue
    for (const edge of reverse.get(current) || []) {
      const step = edge.kind === 'hard_prerequisite' ? 1 : 1.6
      const nextDistance = currentDistance + step
      if (nextDistance > 5.4 || (distance.has(edge.from) && distance.get(edge.from)! <= nextDistance)) continue
      distance.set(edge.from, nextDistance)
      approachKind.set(edge.from, edge.kind)
      queue.push(edge.from)
    }
  }
  const targetDomains = new Set(targets.flatMap(nodeId => nodeMap.get(nodeId)?.domains || []))
  const ranked = [...distance.entries()]
    .sort((left, right) => {
      const leftNode = nodeMap.get(left[0])!, rightNode = nodeMap.get(right[0])!
      const leftStatus = projection.statuses[left[0]] || 'unmarked'
      const rightStatus = projection.statuses[right[0]] || 'unmarked'
      const score = (node: LearningPathNode, nodeId: string, nodeDistance: number, status: LearnerPathStatus) => {
        const targetBonus = targets.includes(nodeId) ? 100 : 0
        const domainBonus = node.domains.filter(domain => targetDomains.has(domain)).length * 7
        const distanceBonus = Math.max(0, 28 - nodeDistance * 4.5)
        const hardBonus = approachKind.get(nodeId) === 'hard_prerequisite' ? 6 : 0
        const foundationBonus = node.stage === 'foundation' ? 4 : node.stage === 'core' ? 2 : 0
        const selfReportAdjustment = status === 'self_reported_mastered' ? -3 : 0
        return targetBonus + domainBonus + distanceBonus + hardBonus + foundationBonus + selfReportAdjustment
      }
      const scoreDifference = score(rightNode, right[0], right[1], rightStatus) - score(leftNode, left[0], left[1], leftStatus)
      return scoreDifference || left[1] - right[1] || leftNode.order - rightNode.order || leftNode.id.localeCompare(rightNode.id)
    })
    .map(([nodeId]) => nodeId)
  const hardRequired = new Set(targets)
  const hardQueue = targets.map(nodeId => ({ nodeId, depth: 0 }))
  while (hardQueue.length) {
    const { nodeId, depth } = hardQueue.shift()!
    if (depth >= 6) continue
    for (const edge of reverse.get(nodeId) || []) {
      if (edge.kind !== 'hard_prerequisite' || hardRequired.has(edge.from)) continue
      hardRequired.add(edge.from)
      hardQueue.push({ nodeId: edge.from, depth: depth + 1 })
    }
  }
  const directSoft = new Set(targets.flatMap(nodeId => (reverse.get(nodeId) || [])
    .filter(edge => edge.kind === 'soft_prerequisite').map(edge => edge.from)))
  const bounded = [
    ...ranked.filter(nodeId => hardRequired.has(nodeId)),
    ...ranked.filter(nodeId => directSoft.has(nodeId) && !hardRequired.has(nodeId)),
    ...ranked.filter(nodeId => !hardRequired.has(nodeId) && !directSoft.has(nodeId)),
  ].slice(0, Math.max(24, hardRequired.size + directSoft.size))
  const routeNodeIds = topologicallyOrderLearningPathRoute(
    [...new Set([...bounded, ...targets])],
    projection.nodes,
    projection.edges,
  )
  const milestones: string[] = []
  for (const nodeId of routeNodeIds) {
    const node = nodeMap.get(nodeId)
    if (!node) continue
    const previousMilestoneId = milestones.length ? milestones[milestones.length - 1] : undefined
    const previous = previousMilestoneId ? nodeMap.get(previousMilestoneId) : undefined
    if (!previous || previous.stage !== node.stage) milestones.push(nodeId)
  }
  targets.forEach(nodeId => { if (!milestones.includes(nodeId)) milestones.push(nodeId) })
  const targetTitles = targets.map(nodeId => nodeMap.get(nodeId)?.title || nodeId)
  const routeTitles = routeNodeIds.map(nodeId => nodeMap.get(nodeId)?.title || nodeId)
  const objective = message.replace(/\s+/g, ' ').trim().slice(0, 500)
  const snapshotSignature = `${packet.snapshotId}:${objective}:${routeNodeIds.join('|')}`
  return {
    id: `path-plan-${stableHash(snapshotSignature)}`,
    policyId: 'vnext-learning-path-planner-v2',
    generatedFromSnapshotId: packet.snapshotId,
    title: `通向${targetTitles.join('与')}的长期路径`.slice(0, 100),
    objective,
    horizon: planningHorizon(message),
    targetNodeIds: targets,
    routeNodeIds,
    milestoneNodeIds: milestones.slice(0, 10),
    rationale: `根据学习者明确目标，把官方/个人课程图中的前置关系压缩为 ${routeNodeIds.length} 个路线节点。自报学过只影响验证顺序，不会被当作已经掌握。建议路线：${routeTitles.join(' → ')}。`.slice(0, 1500),
    evidenceQuote: objective.slice(0, 500),
  }
}

export function commitLearningPathPlan(state: LearnerPathState, proposal: LearningPathPlanProposal) {
  const projection = projectLearnerPath(state)
  const nodeIds = new Set(projection.nodes.map(node => node.id))
  if (!proposal.targetNodeIds.length || proposal.targetNodeIds.some(nodeId => !nodeIds.has(nodeId))) return state
  const previous = projection.plans.find(plan => plan.id === proposal.id)
  const plan: LearningPathPlan = {
    id: proposal.id,
    title: proposal.title,
    objective: proposal.objective,
    horizon: proposal.horizon,
    targetNodeIds: proposal.targetNodeIds.filter(nodeId => nodeIds.has(nodeId)),
    routeNodeIds: proposal.routeNodeIds.filter(nodeId => nodeIds.has(nodeId)),
    milestoneNodeIds: proposal.milestoneNodeIds.filter(nodeId => nodeIds.has(nodeId)),
    rationale: proposal.rationale,
    evidenceQuote: proposal.evidenceQuote,
    sourcePlanId: proposal.sourcePlanId,
    status: 'active',
    revision: (previous?.revision || 0) + 1,
  }
  return appendLearningPathEvent(state, {
    type: previous ? 'vnext_learning_path_plan_revised' : 'vnext_learning_path_plan_committed',
    plan,
    detail: `学习者确认长期学习路径“${plan.title}”；路线用于导航，不代表节点掌握`,
  })
}

export function archiveLearningPathPlan(state: LearnerPathState, planId: string) {
  const plan = projectLearnerPath(state).plans.find(item => item.id === planId && item.status === 'active')
  if (!plan) return state
  return appendLearningPathEvent(state, {
    type: 'vnext_learning_path_plan_archived',
    planId,
    detail: `学习者归档长期学习路径“${plan.title}”；历史确认继续保留`,
  })
}

export function learningPathPacketToTutorContext(packet: LearningPathReadPacket) {
  const nodeLines = packet.nodes.map(node => {
    const prerequisites = node.prerequisites.map(item => `${item.title}(${PATH_EDGE_LABELS[item.kind]})`).join('、') || '无已载入前置'
    const successors = node.successors.map(item => `${item.title}(${PATH_EDGE_LABELS[item.kind]})`).join('、') || '无已载入后继'
    return `- ${node.title} [${node.origin === 'official' ? '官方' : '个人'}；${PATH_STATUS_LABELS[node.status]}]；前置：${prerequisites}；后继：${successors}`
  }).join('\n')
  return [
    '学习路径图读取结果（结构核参考投影，不是强制培养方案）：',
    `检索：${packet.retrievalMode} / ${packet.resolution}；匹配类型：${packet.matchKind}；查询主题：${packet.query || '概览'}。`,
    packet.candidates.length
      ? `候选：${packet.candidates.slice(0, 5).map(candidate => `${candidate.title}(${Math.round(candidate.confidence * 100)}%，${candidate.reasons.join('+') || '弱相关'})`).join('、')}${packet.omittedCandidateCount ? `；另省略 ${packet.omittedCandidateCount} 项` : ''}。`
      : '',
    nodeLines,
    packet.resolution === 'ambiguous'
      ? '当前结果存在歧义。应把候选与匹配理由交给学习者选择，不能直接生成长期路线或个人节点。'
      : packet.needsFuzzySearch
        ? '精确读取未命中；下一步应调用模糊图谱检索，不要直接联网或创建个人节点。'
      : packet.needsExternalResearch
      ? `图谱不能可靠承载“${packet.topicCandidate}”。应联网确认它与已有节点的关系，再把结果作为可确认的个人节点提案；不得直接改图。`
      : '可以把匹配节点作为路线锚点，但应尊重学习者目标、已有资源和实际约束，不得强制按图学习。',
    '状态证据边界：“学过/掌握”均为学习者自报，只能用于路径导航；不能替代题目、项目或迁移证据，不能据此写 Knowledge mastery。',
    `Manifest：${packet.snapshotId}；官方 ${packet.manifest.officialNodeCount} 节点，个人 ${packet.manifest.personalNodeCount} 节点。`,
  ].filter(Boolean).join('\n\n')
}

const PERSONAL_NODE_TERM_EXPANSIONS: Array<[RegExp, string[]]> = [
  [/量子/, ['quantum']],
  [/机器学习/, ['machine']],
  [/深度学习/, ['deep', 'neural']],
  [/强化学习/, ['reinforcement']],
  [/具身智能/, ['embodied', 'robotics']],
  [/智能体/, ['agent']],
  [/大语言模型/, ['language', 'model', 'llm']],
  [/计算机视觉/, ['computer', 'vision']],
  [/自然语言处理/, ['natural', 'language', 'nlp']],
  [/网络安全/, ['cybersecurity', 'security']],
  [/操作系统/, ['operating', 'system']],
  [/数据库/, ['database']],
  [/编译器/, ['compiler']],
]

const GENERIC_EVIDENCE_TERMS = new Set([
  'learn', 'learning', 'course', 'class', 'introduction', 'overview', 'guide', 'tutorial',
  '研究', '学习', '课程', '入门', '指南', '概述', '方向',
])

function evidenceTermGroups(topic: string) {
  const normalized = topic.normalize('NFKC').toLocaleLowerCase()
  const latin = (normalized.match(/[a-z0-9+#]{2,}/g) || []).filter(term => !GENERIC_EVIDENCE_TERMS.has(term))
  const chineseWords = normalized.match(/[\u4e00-\u9fff]{2,}/g) || []
  const chinese = chineseWords.flatMap(word => word.length <= 4
    ? [word]
    : Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2)))
    .filter(term => !GENERIC_EVIDENCE_TERMS.has(term))
  const expanded = PERSONAL_NODE_TERM_EXPANSIONS.flatMap(([pattern, terms]) => pattern.test(normalized) ? terms : [])
    .filter(term => !GENERIC_EVIDENCE_TERMS.has(term))
  return [unique(latin), unique(chinese), unique(expanded)].filter(group => group.length)
}

function isPublicEvidenceUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

export function assessPersonalPathNodeEvidence(
  topic: string,
  evidence: PersonalPathNodeEvidence[] = [],
): PersonalPathNodeEvidenceReport {
  const groups = evidenceTermGroups(topic)
  const accepted: PersonalPathNodeEvidenceAssessment[] = []
  const rejected: PersonalPathNodeEvidenceReport['rejected'] = []
  const seenUrls = new Set<string>()
  evidence.slice(0, 12).forEach(item => {
    const rawUrl = String(item.url || '').trim()
    if (!isPublicEvidenceUrl(rawUrl)) {
      rejected.push({ url: rawUrl, reason: 'invalid_url' })
      return
    }
    const url = new URL(rawUrl)
    url.hash = ''
    const canonical = url.toString().replace(/\/$/, '')
    if (seenUrls.has(canonical)) return
    seenUrls.add(canonical)
    const title = String(item.title || '').replace(/\s+/g, ' ').trim().slice(0, 180)
    const snippet = String(item.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 1200)
    const source = String(item.source || url.hostname).replace(/\s+/g, ' ').trim().slice(0, 120)
    if (!title || title.length < 3 || `${title}${snippet}`.length < 24) {
      rejected.push({ url: canonical, reason: 'insufficient_metadata' })
      return
    }
    const haystack = `${title} ${snippet} ${source}`.normalize('NFKC').toLocaleLowerCase()
    let bestMatches: string[] = []
    let relevance = 0
    groups.forEach(group => {
      const matches = group.filter(term => haystack.includes(term.toLocaleLowerCase()))
      const coverage = matches.length / Math.max(1, group.length)
      if (coverage > relevance) {
        relevance = coverage
        bestMatches = matches
      }
    })
    const quality = item.quality || 'community'
    const minimum = quality === 'official' || quality === 'academic' ? 0.5 : 0.72
    if (!bestMatches.length || relevance < minimum) {
      rejected.push({ url: canonical, reason: bestMatches.length ? 'weak_source' : 'off_topic' })
      return
    }
    accepted.push({
      url: canonical,
      title,
      source,
      quality,
      relevance: Math.round(relevance * 100) / 100,
      matchedTerms: bestMatches.slice(0, 8),
    })
  })
  const authoritative = accepted.some(item => item.quality === 'official' || item.quality === 'academic')
  const independentHosts = new Set(accepted.map(item => new URL(item.url).hostname)).size
  return {
    valid: authoritative || independentHosts >= 2,
    accepted: accepted.slice(0, 6),
    rejected,
    policyId: 'vnext-personal-path-evidence-v1',
  }
}

export function buildPersonalNodeProposal(
  packet: LearningPathReadPacket,
  sourceEvidence: PersonalPathNodeEvidence[] = [],
  state?: LearnerPathState,
): PersonalPathNodeProposal | undefined {
  const evidenceReport = assessPersonalPathNodeEvidence(packet.topicCandidate, sourceEvidence)
  if (!packet.needsExternalResearch || packet.retrievalMode !== 'fuzzy' || packet.resolution !== 'not_found'
    || !packet.topicCandidate || !evidenceReport.valid) return undefined
  const projection = state ? projectLearnerPath(state) : {
    nodes: OFFICIAL_PATH_NODES,
    edges: OFFICIAL_PATH_EDGES,
    statuses: {}, personalNodeIds: [], plans: [], eventCount: 0,
  } satisfies LearnerPathProjection
  const duplicateCheck = searchFuzzyLearningPath(projection.nodes, packet.topicCandidate, 3)
  if (duplicateCheck.resolution === 'resolved' || (duplicateCheck.candidates[0]?.confidence || 0) >= 0.67) return undefined
  const projectionNodeMap = new Map(projection.nodes.map(node => [node.id, node]))
  const anchors = packet.suggestedAnchorIds.flatMap(nodeId => {
    const node = projectionNodeMap.get(nodeId)
    return node ? [node] : []
  })
  const order = Math.max(4, ...anchors.map(node => node.order + 1))
  const title = packet.topicCandidate.slice(0, 64)
  const normalizedTitle = normalizeLearningPathText(title)
  const connections = anchors.map(anchor => {
    const normalizedAnchor = normalizeLearningPathText(anchor.title)
    const compoundExtension = normalizedAnchor.length >= 3 && normalizedTitle.includes(normalizedAnchor)
      && normalizedTitle.length >= normalizedAnchor.length + 2
    return {
      nodeId: anchor.id,
      kind: compoundExtension ? 'soft_prerequisite' as const : 'co_learning' as const,
      rationale: compoundExtension
        ? `“${title}”在名称上扩展了“${anchor.title}”，暂列为待确认软前置；来源只证明主题存在，不证明掌握或硬依赖。`
        : `图谱检索显示它与“${anchor.title}”主题邻近，暂列为待确认共学关系；不据此臆造前置要求。`,
    }
  })
  const validatedUrls = evidenceReport.accepted.map(item => item.url)
  return {
    id: `path-proposal-${stableHash(`${packet.snapshotId}:${title}:${validatedUrls.join('|')}`)}`,
    policyId: 'vnext-personal-path-node-proposer-v3',
    generatedFromSnapshotId: packet.snapshotId,
    title,
    summary: `围绕“${title}”形成的个人学习节点候选；来源证明该主题值得独立定位，连接关系仍需学习者检查。`,
    aliases: [title],
    domains: unique(anchors.flatMap(node => node.domains)).slice(0, 4),
    stage: order >= 6 ? 'advanced' : 'domain',
    order,
    sourceUrls: validatedUrls,
    sourceEvidence: evidenceReport.accepted,
    connections,
    requiresLearnerConfirmation: true,
    masteryUnchanged: true,
  }
}

export function validateOfficialLearningPathGraph() {
  const errors: string[] = []
  const nodeMap = new Map(OFFICIAL_PATH_NODES.map(node => [node.id, node]))
  if (nodeMap.size !== OFFICIAL_PATH_NODES.length) errors.push('官方节点 ID 不唯一')
  const sourceIds = new Set(LEARNING_PATH_SOURCES.map(source => source.id))
  OFFICIAL_PATH_NODES.forEach(node => {
    if (!node.sourceRefs.length || node.sourceRefs.some(source => !sourceIds.has(source))) errors.push(`${node.id} 来源无效`)
  })
  const indegree = new Map(OFFICIAL_PATH_NODES.map(node => [node.id, 0]))
  const outgoing = new Map(OFFICIAL_PATH_NODES.map(node => [node.id, [] as string[]]))
  OFFICIAL_PATH_EDGES.forEach(edge => {
    const from = nodeMap.get(edge.from), to = nodeMap.get(edge.to)
    if (!from || !to) errors.push(`${edge.id} 端点不存在`)
    else {
      if (from.order > to.order) errors.push(`${edge.id} 未保持 DAG 顺序`)
      indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1)
      outgoing.get(edge.from)?.push(edge.to)
    }
  })
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id)
  let visited = 0
  while (queue.length) {
    const current = queue.shift()!
    visited += 1
    outgoing.get(current)?.forEach(target => {
      const next = (indegree.get(target) || 0) - 1
      indegree.set(target, next)
      if (next === 0) queue.push(target)
    })
  }
  if (visited !== OFFICIAL_PATH_NODES.length) errors.push('官方课程图存在环')
  return { valid: errors.length === 0, errors, nodeCount: OFFICIAL_PATH_NODES.length, edgeCount: OFFICIAL_PATH_EDGES.length }
}

export function sanitizeLearnerPathState(value: unknown): LearnerPathState {
  if (!value || typeof value !== 'object' || !Array.isArray((value as Record<string, unknown>).events)) return createInitialLearnerPathState()
  const rawEvents = (value as { events: unknown[] }).events.slice(-500)
  const events: LearningPathEvent[] = []
  rawEvents.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return
    const item = raw as Partial<LearningPathEvent>
    if (![
      'vnext_learning_path_node_status_set', 'vnext_personal_path_node_added', 'vnext_personal_path_node_removed',
      'vnext_learning_path_plan_committed', 'vnext_learning_path_plan_revised', 'vnext_learning_path_plan_archived',
    ].includes(String(item.type))) return
    const base = {
      id: typeof item.id === 'string' ? item.id.slice(0, 120) : `restored-${index}`,
      sequence: Number.isFinite(item.sequence) ? Number(item.sequence) : index + 1,
      at: Number.isFinite(item.at) ? Number(item.at) : index + 1,
      type: item.type as LearningPathEvent['type'],
      detail: typeof item.detail === 'string' ? item.detail.slice(0, 300) : '',
    }
    if (item.type === 'vnext_learning_path_node_status_set' && typeof item.nodeId === 'string' && item.status && item.status in PATH_STATUS_LABELS) {
      events.push({ ...base, nodeId: item.nodeId.slice(0, 120), status: item.status })
    }
    if (item.type === 'vnext_personal_path_node_removed' && typeof item.nodeId === 'string') {
      events.push({ ...base, nodeId: item.nodeId.slice(0, 120) })
    }
    if (item.type === 'vnext_learning_path_plan_archived' && typeof item.planId === 'string') {
      events.push({ ...base, planId: item.planId.slice(0, 160) })
    }
    if ((item.type === 'vnext_learning_path_plan_committed' || item.type === 'vnext_learning_path_plan_revised') && item.plan) {
      const plan = item.plan
      const targetNodeIds = Array.isArray(plan.targetNodeIds) ? plan.targetNodeIds.slice(0, 8).map(value => String(value).slice(0, 160)) : []
      const routeNodeIds = Array.isArray(plan.routeNodeIds) ? plan.routeNodeIds.slice(0, 40).map(value => String(value).slice(0, 160)) : []
      if (typeof plan.id === 'string' && targetNodeIds.length && targetNodeIds.every(nodeId => routeNodeIds.includes(nodeId))) {
        events.push({ ...base, plan: {
          id: plan.id.slice(0, 160),
          title: String(plan.title || '').slice(0, 200),
          objective: String(plan.objective || '').slice(0, 1000),
          horizon: String(plan.horizon || '长期').slice(0, 120),
          targetNodeIds,
          routeNodeIds,
          milestoneNodeIds: Array.isArray(plan.milestoneNodeIds) ? plan.milestoneNodeIds.slice(0, 16).map(value => String(value).slice(0, 160)) : [],
          rationale: String(plan.rationale || '').slice(0, 1600),
          evidenceQuote: String(plan.evidenceQuote || '').slice(0, 500),
          sourcePlanId: typeof plan.sourcePlanId === 'string' ? plan.sourcePlanId.slice(0, 160) : undefined,
          status: 'active',
          revision: Math.max(1, Number(plan.revision) || 1),
        } })
      }
    }
    if (item.type === 'vnext_personal_path_node_added' && item.node?.origin === 'personal' && typeof item.node.id === 'string') {
      const node: LearningPathNode = {
        ...item.node,
        id: item.node.id.slice(0, 120), title: String(item.node.title || '').slice(0, 80), summary: String(item.node.summary || '').slice(0, 260),
        aliases: Array.isArray(item.node.aliases) ? item.node.aliases.slice(0, 8).map(value => String(value).slice(0, 60)) : [],
        domains: Array.isArray(item.node.domains) ? item.node.domains.slice(0, 6).map(value => String(value).slice(0, 30)) : [],
        audiences: ['self_directed'], origin: 'personal',
        stage: item.node.stage && item.node.stage in PATH_STAGE_LABELS ? item.node.stage : 'advanced',
        order: Math.max(1, Math.min(20, Number(item.node.order) || 6)),
        sourceRefs: Array.isArray(item.node.sourceRefs) ? item.node.sourceRefs.slice(0, 6).map(value => String(value).slice(0, 500)) : [],
      }
      const edges = Array.isArray(item.edges) ? item.edges.slice(0, 8).filter(edge => edge?.origin === 'personal' && typeof edge.from === 'string' && typeof edge.to === 'string').map((edge, edgeIndex) => ({
        id: typeof edge.id === 'string' ? edge.id.slice(0, 160) : `restored-edge-${index}-${edgeIndex}`,
        from: edge.from.slice(0, 120), to: edge.to.slice(0, 120),
        kind: edge.kind && edge.kind in PATH_EDGE_LABELS ? edge.kind : 'soft_prerequisite' as PathEdgeKind,
        rationale: String(edge.rationale || '').slice(0, 180), origin: 'personal' as const,
      })) : []
      events.push({ ...base, node, edges })
    }
  })
  return { version: 1, events: events.length ? events : createInitialLearnerPathState().events }
}
