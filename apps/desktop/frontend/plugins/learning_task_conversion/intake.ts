export const LEARNING_TASK_INTAKE_SCHEMA_VERSION = 'learning-task-conversion-intake.v1' as const

export type LearningTaskInputKind =
  | 'role'
  | 'role_or_direction'
  | 'work_task'
  | 'learning_topic'
  | 'ambiguous'

export type LearningTaskIntakeStatus =
  | 'needs_task_selection'
  | 'needs_input'
  | 'ready_for_confirmation'

export type LearningTaskIntakeCandidate = {
  id: string
  title: string
  description: string
  source: 'role_package' | 'project_source' | 'model_proposed'
  sourceRef: string
}

export type PrepareLearningTaskIntakeInput = {
  rawInput: string
  roleName?: string
  taskDescription?: string
  candidateTasks?: Array<Partial<LearningTaskIntakeCandidate> & { title?: string }>
  selectedTaskTitle?: string
  selectedTaskDescription?: string
  modelAssessment?: {
    schemaVersion: string
    model: string
    assessedKind: LearningTaskInputKind
    confidence: number
    rationale: string
    nextQuestion: string
  }
}

export type LearningTaskConversionIntake = {
  schemaVersion: typeof LEARNING_TASK_INTAKE_SCHEMA_VERSION
  intakeId: string
  originalInput: string
  inputKind: LearningTaskInputKind
  status: LearningTaskIntakeStatus
  lockedTerms: string[]
  roleName: string
  taskContract: {
    title: string
    description: string
    action: string
    workObject: string
    source: 'user_explicit' | LearningTaskIntakeCandidate['source']
    sourceRef: string
  }
  missingFields: string[]
  candidateTasks: LearningTaskIntakeCandidate[]
  nextQuestion: string
  confirmed: false
  warnings: Array<{ code: string; message: string }>
  preflight: {
    method: 'semantic_model' | 'deterministic_guard'
    schemaVersion: string
    model: string
    assessedKind: LearningTaskInputKind
    confidence: number | null
    rationale: string
  }
}

export type LearningTaskDraftConfirmation = {
  originalInput: string
  intakeId: string
  intakeRootHash: string
  intakeConfirmed: true
  taskTitle: string
  taskDescription: string
  taskSource: LearningTaskConversionIntake['taskContract']['source']
  taskSourceRef: string
}

const ROLE_SUFFIX = /(?:工程师|技师|技术员|操作员|运维员|管理员|设计师|分析师|开发人员|测试人员|岗位|职业)$/i
const ROLE_INTENT = /(?:我想|想要?|准备|打算|希望)?\s*(?:当|成为|从事|做一名|应聘)\s*/i
const LEARNING_INTENT = /(?:我想|想要?|准备|打算|希望)?\s*(?:学习|学会|了解|掌握|研究|系统学习)\s*/i
const CONCRETE_ACTIONS = [
  '安装', '拆装', '装配', '检修', '维修', '维护', '调试', '检测', '校准', '配置', '部署',
  '制作', '加工', '焊接', '更换', '诊断', '排查', '修复', '验收', '重装', '测试', '巡检',
  '接线', '调优', '迁移', '备份', '恢复', '集成', '实现', '开发', '构建', '发布', '装机',
  '添加', '放置', '摆放', '跟随', '编写', '挂载', '对准', '限制', '调整', '优化',
] as const
const CONCRETE_SCOPE = /(?:模块|功能|接口|API|页面|组件|脚本|服务|环境|驱动|摄像机|角色|场景|电池|电机|设备|系统安装|系统重装|网络配置|故障|产线|工位|数据库|流水线|模型训练|验收)/i
const BROAD_DEVELOPMENT = /^(?:linux|windows|android|ios|unity|游戏客户端|前端|后端|嵌入式|机器人|人工智能|ai|大数据|软件|系统|应用)?\s*(?:系统|客户端|应用)?\s*开发$/i
const WRAPPERS = /^(?:请你?|麻烦你?|帮我|给我|我想要?|我想|我准备|我打算|我希望|想要?|想)\s*/i
const GENERIC_ONLY = new Set(['计算机', '网络', '系统', '软件', '开发', '学习', '方向', '职业', '岗位'])

function clean(value: unknown, limit = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

export function learningTaskDraftConfirmationPrompt(
  intake: Pick<LearningTaskConversionIntake, 'originalInput' | 'intakeId' | 'taskContract'> & { intakeRootHash: string },
) {
  const contract = intake.taskContract
  return `我确认按“${contract.title}”生成学习型任务。请调用 learning_task_conversion__draft_learning_task：originalInput 原样使用“${intake.originalInput}”，intakeId 使用 ${intake.intakeId}，intakeRootHash 使用 ${intake.intakeRootHash}，intakeConfirmed 设为 true，taskTitle 原样使用“${contract.title}”，taskDescription 原样使用“${contract.description}”，taskSource 使用 ${contract.source}，taskSourceRef 原样使用“${contract.sourceRef}”。`
}

export function parseLearningTaskDraftConfirmation(message: string): LearningTaskDraftConfirmation | undefined {
  if (!/^我确认按“[^”]{2,300}”生成学习型任务。请调用 learning_task_conversion__draft_learning_task：/.test(message)) return undefined
  const originalInput = message.match(/originalInput 原样使用“([^”]{2,500})”/)?.[1] || ''
  const intakeIdValue = message.match(/intakeId 使用 ([a-z0-9_-]{8,80})/i)?.[1] || ''
  const intakeRootHash = message.match(/intakeRootHash 使用 ([a-f0-9]{64})/i)?.[1] || ''
  const taskTitle = message.match(/taskTitle 原样使用“([^”]{2,300})”/)?.[1] || ''
  const taskDescription = message.match(/taskDescription 原样使用“([\s\S]{0,2000}?)”，taskSource 使用/)?.[1] || ''
  const taskSource = message.match(/taskSource 使用 (user_explicit|role_package|project_source|model_proposed)/)?.[1] as LearningTaskDraftConfirmation['taskSource'] | undefined
  const taskSourceRef = message.match(/taskSourceRef 原样使用“([^”]{0,300})”/)?.[1] || ''
  if (!originalInput || !intakeIdValue || !intakeRootHash || !taskTitle || !taskSource) return undefined
  return {
    originalInput,
    intakeId: intakeIdValue,
    intakeRootHash,
    intakeConfirmed: true,
    taskTitle,
    taskDescription,
    taskSource,
    taskSourceRef,
  }
}

export function normalizeLearningTaskIntakeText(value: string) {
  return clean(value, 500).normalize('NFKC').toLocaleLowerCase()
    .replace(/[學習網絡軟體應用開發]/g, character => ({
      學: '学', 習: '习', 網: '网', 絡: '络', 軟: '软', 體: '体', 應: '应', 用: '用', 開: '开', 發: '发',
    }[character] || character))
    .replace(/软体/g, '软件')
    .replace(/[^a-z0-9+#\u4e00-\u9fff]+/g, '')
}

function stripIntent(value: string) {
  return clean(value, 300)
    .replace(WRAPPERS, '')
    .replace(ROLE_INTENT, '')
    .replace(LEARNING_INTENT, '')
    .replace(/(?:怎么学|如何学|该怎么做|可以吗|好吗)[？?。！!]*$/i, '')
    .trim()
}

function actionIn(value: string) {
  return CONCRETE_ACTIONS.find(action => value.includes(action)) || ''
}

/**
 * Provider-side step count is only a planning hint. Derive it from the locked
 * task contract instead of silently forcing every task into the same template.
 */
export function suggestLearningTaskStepCount(taskTitle: string, taskDescription = '') {
  const text = clean(`${taskTitle} ${taskDescription}`, 2_300)
  const actionCount = new Set(CONCRETE_ACTIONS.filter(action => text.includes(action))).size
  const connectorCount = (text.match(/[、，,；;]|(?:与|和|及|以及|并完成|并进行)/g) || []).length
  const explicitGateCount = new Set([
    /验收|交付/.test(text) ? 'acceptance' : '',
    /测试|验证|检查|核对/.test(text) ? 'verification' : '',
    /安全|防护|断电|备份|回滚/.test(text) ? 'safety' : '',
    /记录|报告|截图|清单/.test(text) ? 'evidence' : '',
  ].filter(Boolean)).size
  const descriptionDetail = taskDescription.trim().length >= 80 ? 1 : 0
  return Math.max(4, Math.min(9,
    4
    + Math.max(0, Math.min(3, actionCount) - 1)
    + Math.min(2, connectorCount)
    + Math.min(2, explicitGateCount)
    + descriptionDetail,
  ))
}

function looksLikeBroadDevelopment(topic: string) {
  const normalized = topic.replace(/[与和及、]/g, '').trim()
  if (BROAD_DEVELOPMENT.test(normalized)) return true
  return normalized.endsWith('开发') && !CONCRETE_SCOPE.test(normalized) && normalized.length <= 18
}

export function classifyLearningTaskInput(rawInput: string): LearningTaskInputKind {
  const raw = clean(rawInput, 500)
  const topic = stripIntent(raw)
  if (!topic || GENERIC_ONLY.has(normalizeLearningTaskIntakeText(topic))) return 'ambiguous'
  if (ROLE_SUFFIX.test(topic) || ROLE_INTENT.test(raw) && ROLE_SUFFIX.test(topic)) return 'role'
  if (LEARNING_INTENT.test(raw)) return 'learning_topic'
  const action = actionIn(topic)
  if (action) {
    if (action === '开发' && looksLikeBroadDevelopment(topic)) return 'role_or_direction'
    const object = topic.replace(action, '').replace(/[的与和及、]/g, '').trim()
    if (object.length >= 2) return 'work_task'
  }
  if (/(?:开发|运维|运营|设计|管理|分析|工程)$/.test(topic)) return 'role_or_direction'
  return 'ambiguous'
}

function lockedTerms(rawInput: string) {
  const topic = stripIntent(rawInput)
  const latin = topic.match(/[0-9]+[A-Za-z][A-Za-z0-9+#.-]*|[A-Za-z][A-Za-z0-9+#.-]*/g) || []
  const chinese = topic
    .replace(ROLE_SUFFIX, '')
    .split(/[，,。；;：:、与和及的\s（）()]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2 && !CONCRETE_ACTIONS.includes(item as typeof CONCRETE_ACTIONS[number]))
  return [...new Set([...latin, ...chinese])].slice(0, 8)
}

function preservesLockedTerms(title: string, terms: string[]) {
  const normalized = normalizeLearningTaskIntakeText(title)
  return terms.every(term => {
    const locked = normalizeLearningTaskIntakeText(term)
    if (normalized.includes(locked)) return true
    if (/[a-z0-9+#]/i.test(locked) || locked.length < 4) return false
    const grams = Array.from({ length: locked.length - 1 }, (_, index) => locked.slice(index, index + 2))
    const overlap = grams.filter(gram => normalized.includes(gram)).length / Math.max(1, grams.length)
    return overlap >= 0.5
  })
}

function stableId(value: string, index: number) {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return `task_${(hash >>> 0).toString(16).padStart(8, '0')}_${index + 1}`
}

function intakeId(rawInput: string) {
  return `lti_${stableId(normalizeLearningTaskIntakeText(rawInput), 0).slice(5, 13)}`
}

function sanitizeCandidates(
  values: PrepareLearningTaskIntakeInput['candidateTasks'],
): LearningTaskIntakeCandidate[] {
  const seen = new Set<string>()
  return (values || []).flatMap((value, index) => {
    const title = clean(value.title, 160)
    const normalized = normalizeLearningTaskIntakeText(title)
    if (!title || title.length < 4 || seen.has(normalized)) return []
    seen.add(normalized)
    const source = ['role_package', 'project_source', 'model_proposed'].includes(String(value.source))
      ? value.source as LearningTaskIntakeCandidate['source'] : 'model_proposed'
    return [{
      id: clean(value.id, 100) || stableId(title, index),
      title,
      description: clean(value.description, 500),
      source,
      sourceRef: clean(value.sourceRef, 300),
    }]
  }).slice(0, 5)
}

function taskContract(
  title: string,
  description: string,
  source: LearningTaskConversionIntake['taskContract']['source'] = 'user_explicit',
  sourceRef = '',
) {
  const action = actionIn(title)
  const actionIndex = action ? title.indexOf(action) : -1
  const workObject = actionIndex >= 0
    ? clean(`${title.slice(0, actionIndex)}${title.slice(actionIndex + action.length)}`.replace(/[的与和及、]/g, ' '), 180)
    : ''
  return { title, description, action, workObject, source, sourceRef }
}

export function prepareLearningTaskIntake(
  input: PrepareLearningTaskIntakeInput,
): LearningTaskConversionIntake {
  const originalInput = clean(input.rawInput, 500)
  const deterministicKind = classifyLearningTaskInput(originalInput)
  const assessedKind = input.modelAssessment?.assessedKind
  // A model can over-read an action word inside a role or broad direction
  // (for example “运维工程师” or “Unity 客户端开发”). The local classifier
  // remains authoritative for those two structural cases. For an otherwise
  // ambiguous phrase, a semantic work-task judgment may still fill the gap.
  const correctedModelTaskKind = assessedKind === 'work_task'
    && (deterministicKind === 'role' || deterministicKind === 'role_or_direction')
  // If the text itself already contains a recognizable action and object,
  // semantic uncertainty must not force the learner to invent an enterprise
  // backstory. WF03 exists to expand that compact task into checkable steps.
  const correctedModelAmbiguity = deterministicKind === 'work_task'
    && (assessedKind === 'ambiguous' || assessedKind === 'learning_topic')
  const inputKind = correctedModelTaskKind || correctedModelAmbiguity
    ? deterministicKind
    : assessedKind || deterministicKind
  const terms = lockedTerms(originalInput)
  const candidates = sanitizeCandidates(input.candidateTasks)
  const selectedTaskTitle = clean(input.selectedTaskTitle, 300)
  const warnings: LearningTaskConversionIntake['warnings'] = []
  if (correctedModelTaskKind) {
    warnings.push({
      code: 'model_task_kind_corrected',
      message: '语义模型把岗位或宽泛方向误判为单个任务，已由本地规则恢复为任务选择流程。',
    })
  }
  if (correctedModelAmbiguity) {
    warnings.push({
      code: 'model_ambiguity_corrected',
      message: '输入已包含可识别的动作与工作对象，已直接形成待确认任务，不再要求补充企业背景。',
    })
  }
  const assessment = input.modelAssessment
  const preflight: LearningTaskConversionIntake['preflight'] = assessment ? {
    method: 'semantic_model',
    schemaVersion: clean(assessment.schemaVersion, 80),
    model: clean(assessment.model, 120),
    assessedKind: assessment.assessedKind,
    confidence: Math.max(0, Math.min(1, Number(assessment.confidence) || 0)),
    rationale: clean(assessment.rationale, 500),
  } : {
    method: 'deterministic_guard', schemaVersion: '', model: '', assessedKind: inputKind,
    confidence: null, rationale: '仅执行本地结构与语义锚点检查。',
  }

  if (selectedTaskTitle) {
    const selected = candidates.find(candidate => candidate.title === selectedTaskTitle)
    if (!selected && !preservesLockedTerms(selectedTaskTitle, terms)) {
      warnings.push({
        code: 'semantic_anchor_changed',
        message: '所选任务没有保留用户原始方向的核心词，不能提交讯飞。',
      })
    } else {
      const selectedDescription = clean(input.selectedTaskDescription || selected?.description, 2_000)
      const contract = taskContract(
        selectedTaskTitle,
        selectedDescription,
        selected?.source || 'model_proposed',
        selected?.sourceRef || '',
      )
      // Exact membership in the displayed candidate list is itself the
      // selection anchor: the learner is choosing a previously presented
      // semantic candidate, not asking the host to invent a replacement now.
      const anchorPreserved = Boolean(selected || preservesLockedTerms(selectedTaskTitle, terms))
      if (anchorPreserved && (!contract.action || !contract.workObject)) {
        // A learner-selected semantic candidate may express a complete work
        // package through domain verbs outside the small deterministic list
        // (for example 摄像机“添加、摆放与跟随”). The local extractor supplies
        // display metadata; it must not veto the semantic proposal plus the
        // learner's explicit selection.
        contract.action = '实施'
        contract.workObject = selectedTaskTitle
        warnings.push({
          code: 'semantic_selected_contract_used',
          message: '所选任务已通过语义候选与原文锚点校验；本地动作词仅作为展示信息，不再阻止确认。',
        })
      }
      if (contract.action && contract.workObject && anchorPreserved) {
        return {
          schemaVersion: LEARNING_TASK_INTAKE_SCHEMA_VERSION,
          intakeId: intakeId(originalInput), originalInput, inputKind, status: 'ready_for_confirmation',
          lockedTerms: terms, roleName: clean(input.roleName || (inputKind === 'role' ? stripIntent(originalInput) : ''), 160),
          taskContract: contract, missingFields: [], candidateTasks: candidates,
          nextQuestion: '请确认是否按这个企业真实工作任务生成学习型任务。',
          confirmed: false, warnings, preflight,
        }
      }
      warnings.push({
        code: 'selected_task_not_executable',
        message: '所选内容仍不是“动作 + 工作对象”构成的单个可执行任务。',
      })
    }
  }

  if (inputKind === 'work_task') {
    const title = stripIntent(originalInput)
    const contract = taskContract(title, clean(input.taskDescription, 2_000))
    if (!contract.action || !contract.workObject) {
      // The semantic model has already judged this as a concrete task. Local
      // keyword extraction is only presentation metadata, not a second hard
      // gate. Keep the learner's wording intact and let explicit confirmation
      // decide whether the slow provider may run.
      contract.action = '执行'
      contract.workObject = title
      warnings.push({
        code: 'semantic_contract_used',
        message: '本地关键词未完整拆出动作和对象，已采用语义模型的任务判断，仍需你确认后才会调用讯飞。',
      })
    }
    return {
      schemaVersion: LEARNING_TASK_INTAKE_SCHEMA_VERSION,
      intakeId: intakeId(originalInput), originalInput, inputKind, status: 'ready_for_confirmation',
      lockedTerms: terms, roleName: clean(input.roleName, 160),
      taskContract: contract,
      missingFields: [], candidateTasks: candidates,
      nextQuestion: '请确认是否按这个企业真实工作任务生成学习型任务。',
      confirmed: false, warnings, preflight,
    }
  }

  const roleName = clean(input.roleName || (inputKind === 'role' ? stripIntent(originalInput) : ''), 160)
  const needsSelection = inputKind !== 'ambiguous' || candidates.length > 0
  const nextQuestion = candidates.length
    ? '请选择一个要转化的企业真实工作任务；选择后仍会先展示任务契约，不会立即调用讯飞。'
    : clean(input.modelAssessment?.nextQuestion, 500)
      || (inputKind === 'role' || inputKind === 'role_or_direction'
      ? `请从“${roleName || stripIntent(originalInput)}”中选一个具体、可执行的企业工作任务。`
      : inputKind === 'learning_topic'
        ? `你希望围绕“${stripIntent(originalInput)}”完成哪个实际工作任务？`
        : '请补充要完成的动作和对象，例如“为 Unity 2D 场景配置摄像机跟随”。')
  return {
    schemaVersion: LEARNING_TASK_INTAKE_SCHEMA_VERSION,
    intakeId: intakeId(originalInput), originalInput, inputKind,
    status: needsSelection ? 'needs_task_selection' : 'needs_input',
    lockedTerms: terms, roleName,
    taskContract: taskContract('', ''),
    missingFields: ['要完成的动作和对象'], candidateTasks: candidates, nextQuestion,
    confirmed: false, warnings, preflight,
  }
}
