import type { LearningTaskTutorContext } from './learning.ts'

export type FiveKernelName = 'structure' | 'knowledge' | 'human' | 'value' | 'practice'
export type ProfileClaimUsePolicy = 'direct' | 'adapt_silently' | 'ask_before_surface'

export type SimulatedProfileClaim = {
  id: string
  text: string
  confidence: number
  provenance: 'user_self_report' | 'design_boundary'
  sensitivity: 'ordinary' | 'sensitive'
  usePolicy: ProfileClaimUsePolicy
  tags: string[]
}

export type SimulatedProfileModule = {
  id: string
  kernel: FiveKernelName
  title: string
  summary: string
  version: number
  subjectKey: string
  tags: string[]
  relatedModuleIds: string[]
  claims: SimulatedProfileClaim[]
}

export type SimulatedFiveKernelProfile = {
  id: string
  version: number
  authority: 'simulated_read_only_profile'
  description: string
  modules: SimulatedProfileModule[]
}

export const FIVE_KERNEL_LABELS: Record<FiveKernelName, string> = {
  structure: '结构核', knowledge: '知识核', human: '人因核', value: '价值核', practice: '实践核',
}

const claim = (
  id: string,
  text: string,
  tags: string[],
  options: Partial<Pick<SimulatedProfileClaim, 'confidence' | 'provenance' | 'sensitivity' | 'usePolicy'>> = {},
): SimulatedProfileClaim => ({
  id, text, tags,
  confidence: options.confidence ?? 0.95,
  provenance: options.provenance ?? 'user_self_report',
  sensitivity: options.sensitivity ?? 'ordinary',
  usePolicy: options.usePolicy ?? 'direct',
})

export const SIMULATED_FIVE_KERNEL_PROFILE: SimulatedFiveKernelProfile = {
  id: 'learner-simulation-primary',
  version: 1,
  authority: 'simulated_read_only_profile',
  description: '根据学习者本轮明确自述建立的可检查模拟画像；不是正式五核状态，也不是掌握证据。',
  modules: [
    {
      id: 'structure-current-position', kernel: 'structure', title: '当前位置与先修关系', version: 1,
      subjectKey: 'learner-path', tags: ['路径', '规划', '先修', '课程', '机器学习', '强化学习', '智能体'],
      summary: '准大二计算机专业阶段；已有数学、编程与 AI 入门课程接触，可从先修关系组织后续路径。',
      relatedModuleIds: ['knowledge-declared-foundation', 'knowledge-ai-frontier', 'value-current-directions'],
      claims: [
        claim('structure-stage', '学习者自述为计算机专业准大二学生。', ['年级', '大学', '计算机专业']),
        claim('structure-ml-bridge', '后续机器学习深造可把概率论、线性代数、微积分与已有基础算法作为返回锚点。', ['机器学习', '数学', '先修'], { provenance: 'design_boundary', confidence: 0.8 }),
        claim('structure-agent-bridge', '智能体工程的基础路径可从 Python、软件工程、API 与工具编排独立起步，不必等待强化学习；只有 RL-based 或学习型智能体分支才需要联接 RL。', ['智能体', 'agent', '工程', 'Python', '先修'], { provenance: 'design_boundary', confidence: 0.85 }),
        claim('structure-rl-bridge', '强化学习路径需要联合概率、线性代数、机器学习基础与序贯决策概念。', ['强化学习', 'RL', '数学', '先修'], { provenance: 'design_boundary', confidence: 0.8 }),
      ],
    },
    {
      id: 'knowledge-declared-foundation', kernel: 'knowledge', title: '自述课程与技术接触', version: 1,
      subjectKey: 'computer-science-foundation', tags: ['基础', '数学', '编程', '算法', '课程', 'Python', 'C'],
      summary: '记录已学过的课程与技术接触范围，不把“学过”提升成独立掌握。',
      relatedModuleIds: ['structure-current-position', 'practice-evidence-boundary'],
      claims: [
        claim('knowledge-math-exposure', '自述学过微积分、概率论、线性代数与离散数学。', ['数学', '微积分', '概率论', '线性代数', '离散数学']),
        claim('knowledge-cs-exposure', '自述学过数据结构、C 语言与 Python。', ['编程', '数据结构', 'C', 'Python']),
        claim('knowledge-no-mastery-inference', '课程接触只表示可用于讲解的候选锚点；具体熟练度仍需任务内验证。', ['边界', '验证', '熟练度'], { provenance: 'design_boundary', confidence: 1 }),
      ],
    },
    {
      id: 'knowledge-ai-frontier', kernel: 'knowledge', title: 'AI 已有接触与开放边界', version: 1,
      subjectKey: 'artificial-intelligence', tags: ['AI', '机器学习', '深度学习', '强化学习', '智能体', 'agent', '核方法', '神经网络'],
      summary: '已有机器学习基础算法和深度学习基础接触；深入程度与迁移能力尚未验证。',
      relatedModuleIds: ['structure-current-position', 'value-current-directions', 'practice-project-competence'],
      claims: [
        claim('knowledge-ml-exposure', '自述学过机器学习的基础算法。', ['机器学习', '算法', 'ML']),
        claim('knowledge-dl-exposure', '自述学过深度学习基础。', ['深度学习', '神经网络', 'DL']),
        claim('knowledge-open-frontier', '深入机器学习、智能体工程与强化学习仍是开放学习区域，不能从自述推断掌握。', ['机器学习', '智能体', '强化学习', '边界'], { provenance: 'design_boundary', confidence: 1 }),
      ],
    },
    {
      id: 'human-explanation-preferences', kernel: 'human', title: '讲解与表征偏好', version: 1,
      subjectKey: 'instruction-presentation', tags: ['讲解', '解释', '可视化', '例子', '代码', '定义', '学习任务'],
      summary: '优先用定义建立边界，随后给直接例子或代码；适合时加入真正有解释力的可视化。',
      relatedModuleIds: ['knowledge-declared-foundation'],
      claims: [
        claim('human-visual-preference', '学习者明确偏好有解释作用的可视化内容。', ['可视化', '图解', '动画'], { sensitivity: 'sensitive', usePolicy: 'adapt_silently' }),
        claim('human-definition-example', '学习者喜欢先读定义，再立即看到直接例子或代码。', ['定义', '例子', '代码', '讲解'], { sensitivity: 'sensitive', usePolicy: 'adapt_silently' }),
        claim('human-no-style-label', '不得把表达偏好固化成“视觉型学习者”等固定学习风格，也不能牺牲任务所需的其他表征。', ['学习风格', '边界'], { provenance: 'design_boundary', confidence: 1, sensitivity: 'sensitive', usePolicy: 'adapt_silently' }),
      ],
    },
    {
      id: 'human-sensitive-boundary', kernel: 'human', title: '敏感理解边界', version: 1,
      subjectKey: 'human-support-boundary', tags: ['负荷', '挫败', '节奏', '情绪', '支持', '隐私'],
      summary: '人因判断优先服务当前理解，但必须短时、低推断、可纠正，不形成性格或能力标签。',
      relatedModuleIds: [],
      claims: [
        claim('human-affect-boundary', '单次“不会”、答错或停顿不能推断稳定情绪、人格、能力或医学状态。', ['不会', '答错', '情绪', '边界'], { provenance: 'design_boundary', confidence: 1, sensitivity: 'sensitive', usePolicy: 'adapt_silently' }),
        claim('human-support-policy', '出现明确负荷或挫败表达时，只在当前任务缩小步幅、增加支架，并允许学习者纠正该判断。', ['负荷', '挫败', '支架', '节奏'], { provenance: 'design_boundary', confidence: 1, sensitivity: 'sensitive', usePolicy: 'adapt_silently' }),
      ],
    },
    {
      id: 'value-current-directions', kernel: 'value', title: '当前方向与未来分支', version: 1,
      subjectKey: 'learning-direction', tags: ['目标', '方向', '规划', '机器学习', '智能体', '强化学习', '科研', '职业'],
      summary: '价值核只保留当前方向与未来可能性；三条方向尚无固定优先级，不维护庞大的动机类型标签。',
      relatedModuleIds: ['structure-current-position', 'knowledge-ai-frontier'],
      claims: [
        claim('value-current-goals', '当前希望深入机器学习、智能体相关工程知识与强化学习。', ['目标', '机器学习', '智能体', '强化学习']),
        claim('value-future-branches', '未来可能从事智能体相关工作，也可能走向广义机器学习科研。', ['职业', '科研', '智能体', '机器学习']),
        claim('value-no-priority-inference', '尚未明确三条方向的固定优先级、时间约束或排他选择，规划时应允许并行探索与再确认。', ['优先级', '时间', '边界'], { provenance: 'design_boundary', confidence: 1 }),
      ],
    },
    {
      id: 'practice-project-competence', kernel: 'practice', title: '项目实践能力的待证区域', version: 1,
      subjectKey: 'project-competence', tags: ['项目', '工程', '实践', '代码', '调试', '测试', '仓库', '智能体'],
      summary: '实践核目前没有足够的真实项目证据；课程经历与生成内容不能替代工程能力评估。',
      relatedModuleIds: ['knowledge-declared-foundation', 'knowledge-ai-frontier', 'practice-evidence-boundary'],
      claims: [
        claim('practice-no-project-proof', '当前自述没有提供可验证的真实项目产物、过程记录或个人贡献证据。', ['项目', '证据', '边界'], { provenance: 'design_boundary', confidence: 1 }),
        claim('practice-target-capabilities', '后续项目应分别观察实现、调试诊断、测试验证、设计取舍、工具使用、研究复现与迁移能力。', ['实现', '调试', '测试', '设计', '工具', '复现', '迁移'], { provenance: 'design_boundary', confidence: 0.9 }),
      ],
    },
    {
      id: 'practice-evidence-boundary', kernel: 'practice', title: '实践证据组合规则', version: 1,
      subjectKey: 'practice-evidence', tags: ['项目', '实践', '评估', '证据', '仓库', '提交', '作品集'],
      summary: '项目能力需要过程与产物、多来源与多时点证据共同支持；学习事件只是索引入口。',
      relatedModuleIds: ['practice-project-competence'],
      claims: [
        claim('practice-triangulation', '评估应联合产物质量、决策理由、调试与测试轨迹、代码审查、反思说明和必要的独立复现。', ['项目', '产物', '决策', '调试', '测试', '审查', '反思'], { provenance: 'design_boundary', confidence: 1 }),
        claim('practice-event-limit', '学习事件只能说明发生过什么，不能完整表达产物质量、隐性贡献或复杂工程判断；需要保留 artifact 与 rubric 引用。', ['学习事件', '产物', 'rubric', '边界'], { provenance: 'design_boundary', confidence: 1 }),
        claim('practice-count-limit', '提交次数、代码行数或任务完成数只能作线索，不能单独决定实践能力。', ['提交', '代码行', '指标', '边界'], { provenance: 'design_boundary', confidence: 1 }),
      ],
    },
  ],
}

export type ProfileReaderInput = {
  message: string
  mode?: 'free' | 'simple_explain' | 'guided_learning' | 'learning_plan'
  learningTaskContext?: LearningTaskTutorContext
  maxModules?: number
  maxClaims?: number
}

export type ProfileContextModule = {
  id: string
  kernel: FiveKernelName
  title: string
  summary: string
  claims: Array<Pick<SimulatedProfileClaim, 'id' | 'text' | 'confidence' | 'provenance'>>
}

export type FiveKernelContextPacket = {
  snapshotId: string
  policyId: 'vnext-five-kernel-profile-reader-v1'
  authority: 'simulated_read_only_profile'
  selectedModules: ProfileContextModule[]
  adaptationDirectives: string[]
  missingFacets: string[]
  manifest: {
    kernels: FiveKernelName[]
    moduleCount: number
    claimCount: number
    omittedModuleCount: number
    estimatedTokens: number
    noMasteryInference: true
  }
}

const INTENT_RULES: Array<{ test: RegExp; kernels: FiveKernelName[]; tags: string[] }> = [
  { test: /(?:路径|规划|怎么学|先学|课程|路线|下一步)/i, kernels: ['structure', 'knowledge', 'value', 'human'], tags: ['路径', '规划', '先修'] },
  { test: /(?:项目|实现|工程|仓库|代码|调试|测试|复现|作品)/i, kernels: ['practice', 'knowledge', 'structure', 'human'], tags: ['项目', '工程', '实践'] },
  { test: /(?:职业|工作|科研|方向|目标|选择)/i, kernels: ['value', 'structure', 'knowledge'], tags: ['方向', '目标', '职业', '科研'] },
  { test: /(?:不懂|不会|困难|太难|跟不上|挫败|累|提示|慢一点)/i, kernels: ['human', 'knowledge', 'structure'], tags: ['支持', '负荷', '支架'] },
  { test: /(?:什么是|讲讲|解释|理解|为什么|区别|原理)/i, kernels: ['knowledge', 'human', 'structure'], tags: ['讲解', '解释', '定义', '例子'] },
]

const TOPIC_ALIASES: Array<{ test: RegExp; tags: string[] }> = [
  { test: /(?:机器学习|核方法|分类|回归|贝叶斯|聚类|ML\b)/i, tags: ['机器学习', '算法', '数学'] },
  { test: /(?:深度学习|神经网络|反向传播|Transformer|DL\b)/i, tags: ['深度学习', '神经网络', '数学'] },
  { test: /(?:强化学习|策略梯度|价值函数|Q-learning|RL\b)/i, tags: ['强化学习', 'RL', '概率论'] },
  { test: /(?:智能体|agent|LangGraph|LangChain|tool calling|RAG)/i, tags: ['智能体', 'agent', '工程', 'Python'] },
  { test: /(?:Python|C语言|数据结构|算法|编程)/i, tags: ['Python', 'C', '数据结构', '编程'] },
  { test: /(?:概率|线性代数|微积分|离散数学|数学)/i, tags: ['概率论', '线性代数', '微积分', '离散数学', '数学'] },
]

function stableHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function unique<T>(values: T[]) {
  return [...new Set(values)]
}

export function readFiveKernelProfile(input: ProfileReaderInput): FiveKernelContextPacket {
  const query = `${input.message} ${input.learningTaskContext?.objective || ''} ${input.learningTaskContext?.skillName || ''}`.trim()
  const intents = INTENT_RULES.filter(rule => rule.test.test(query))
  const requestedKernels = unique((intents.length ? intents : [{ kernels: ['knowledge', 'human'] as FiveKernelName[], tags: [] }])
    .flatMap(rule => rule.kernels))
  if (input.mode === 'guided_learning') requestedKernels.push(...(['practice', 'human'] as FiveKernelName[]))
  if (input.mode === 'learning_plan') requestedKernels.push(...(['structure', 'value', 'practice', 'knowledge'] as FiveKernelName[]))
  const kernelPriority = unique(requestedKernels)
  const queryTags = unique([
    ...intents.flatMap(rule => rule.tags),
    ...TOPIC_ALIASES.filter(rule => rule.test.test(query)).flatMap(rule => rule.tags),
  ])

  const scored = SIMULATED_FIVE_KERNEL_PROFILE.modules.map(module => {
    const kernelScore = kernelPriority.includes(module.kernel) ? 16 - kernelPriority.indexOf(module.kernel) * 2 : 0
    const tagScore = unique([...module.tags, ...module.claims.flatMap(item => item.tags)])
      .filter(tag => queryTags.includes(tag) || (tag.length > 1 && query.toLowerCase().includes(tag.toLowerCase()))).length * 5
    const taskScore = input.learningTaskContext && module.tags.some(tag => input.learningTaskContext!.objective.includes(tag)) ? 4 : 0
    return { module, score: kernelScore + tagScore + taskScore }
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.module.id.localeCompare(b.module.id))

  const maxModules = Math.max(1, Math.min(input.maxModules ?? 5, 6))
  const maxClaims = Math.max(1, Math.min(input.maxClaims ?? 9, 12))
  const selected: SimulatedProfileModule[] = []
  for (const kernel of kernelPriority) {
    const candidate = scored.find(item => item.module.kernel === kernel && !selected.includes(item.module))?.module
    if (candidate && selected.length < maxModules) selected.push(candidate)
  }
  for (const item of scored) {
    if (selected.length >= maxModules) break
    if (!selected.includes(item.module)) selected.push(item.module)
  }

  const adaptationDirectives: string[] = []
  const visibleModules: ProfileContextModule[] = []
  let claimBudget = maxClaims
  for (const module of selected) {
    const visibleClaims = module.claims.filter(item => item.usePolicy === 'direct').slice(0, claimBudget)
    claimBudget -= visibleClaims.length
    const silentClaims = module.claims.filter(item => item.usePolicy === 'adapt_silently')
    if (silentClaims.some(item => item.id === 'human-visual-preference')) {
      adaptationDirectives.push('概念关系或过程确实受益时，优先提供简洁图解；不要称学习者为视觉型学习者。')
    }
    if (silentClaims.some(item => item.id === 'human-definition-example')) {
      adaptationDirectives.push('讲解先给准确而短的定义，紧接一个直接例子或代码；不要复述这是画像偏好。')
    }
    if (silentClaims.some(item => item.id === 'human-affect-boundary' || item.id === 'human-support-policy')) {
      adaptationDirectives.push('只对本轮明确负荷信号缩小步幅或增加支架，不推断稳定情绪、人格、能力或医学状态。')
    }
    visibleModules.push({
      id: module.id, kernel: module.kernel, title: module.title, summary: module.summary,
      claims: visibleClaims.map(item => ({ id: item.id, text: item.text, confidence: item.confidence, provenance: item.provenance })),
    })
  }

  const missingFacets: string[] = []
  if (/(?:项目|工程|实践|仓库)/i.test(query)) missingFacets.push('尚无可验证的真实项目产物与过程证据')
  if (/(?:掌握|熟练|水平|会不会)/i.test(query)) missingFacets.push('自述课程经历不足以判断掌握或熟练度')
  const kernels = unique(visibleModules.map(module => module.kernel))
  const claimCount = visibleModules.reduce((total, module) => total + module.claims.length, 0)
  const estimateText = visibleModules.map(module => `${module.summary}${module.claims.map(item => item.text).join('')}`).join('') + adaptationDirectives.join('')
  const signature = `${SIMULATED_FIVE_KERNEL_PROFILE.version}|${query}|${visibleModules.map(module => `${module.id}:${module.claims.map(item => item.id).join(',')}`).join('|')}`
  return {
    snapshotId: `profile-${stableHash(signature)}`,
    policyId: 'vnext-five-kernel-profile-reader-v1',
    authority: 'simulated_read_only_profile',
    selectedModules: visibleModules,
    adaptationDirectives: unique(adaptationDirectives),
    missingFacets,
    manifest: {
      kernels, moduleCount: visibleModules.length, claimCount,
      omittedModuleCount: SIMULATED_FIVE_KERNEL_PROFILE.modules.length - visibleModules.length,
      estimatedTokens: Math.ceil(estimateText.length / 2.4), noMasteryInference: true,
    },
  }
}

export function profilePacketToTutorContext(packet: FiveKernelContextPacket) {
  const moduleText = packet.selectedModules.map(module => [
    `[${FIVE_KERNEL_LABELS[module.kernel]}] ${module.title}：${module.summary}`,
    ...module.claims.map(item => `- ${item.text}（${item.provenance === 'user_self_report' ? '学习者自述' : '设计边界'}，置信 ${item.confidence.toFixed(2)}）`),
  ].join('\n')).join('\n\n')
  const directives = packet.adaptationDirectives.map(item => `- ${item}`).join('\n')
  const missing = packet.missingFacets.map(item => `- ${item}`).join('\n')
  return [
    '五核画像读取结果（模拟、只读、有界；只能帮助选取锚点和表达方式，不能用来宣布掌握、评分或写回画像）：',
    '强制证据边界：Tutor 生成过的讲解、路线、题目以及学习者仅仅读到这些内容，都不是学习者理解或实践能力证据。课程自述只表示接触，不表示熟练。缺少项目证据时只能说“目前证据不足，无法判断独立完成能力”，不能把缺证据反推成“大概率不能”、能力弱或有具体缺陷。可以区分“具备开始尝试的先修锚点”和“已经证明能独立交付”。规划若尚未确认方向优先级或时间约束，只能提供暂定顺序与并行分支，并明确需要学习者再选择；不得擅自编造学期、月份或固定时间线。',
    moduleText,
    directives ? `静默适配指令：\n${directives}` : '',
    missing ? `当前证据缺口：\n${missing}` : '',
    `Manifest：${packet.snapshotId}；${packet.manifest.moduleCount} modules / ${packet.manifest.claimCount} claims；省略 ${packet.manifest.omittedModuleCount} modules。`,
  ].filter(Boolean).join('\n\n')
}
