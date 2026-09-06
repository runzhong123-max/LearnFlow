import {
  defineLearnFlowPlugin,
  LEARNFLOW_PLUGIN_API_VERSION,
  type PluginJson,
  type PluginJsonSchema,
} from '../../src/plugin-api.ts'
import { learningTaskConversionRuntime } from './runtime.ts'
import { listLocalWorkCases, prepareLocalWorkCase, validateLocalWorkCaseCandidate, WORK_CASE_CANDIDATE_SCHEMA } from './work-case.ts'
import { LEARNING_TASK_INTAKE_SCHEMA_VERSION } from './intake.ts'
import {
  LEARNING_TASK_CONVERSION_PLUGIN,
  LEARNING_TASK_CONFIRMATION_SCHEMA_VERSION,
  LEARNING_TASK_OBJECT_SCHEMA_VERSION,
  LEARNING_TASK_OBJECT_TYPES,
  LEARNING_TASK_RENDERERS,
} from './shared.ts'

function objectSchema(properties: PluginJsonSchema['properties'], required: string[]): PluginJsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

const intakeSchema = objectSchema({
  schemaVersion: { type: 'string' }, intakeId: { type: 'string' }, intakeRootHash: { type: 'string' },
  originalInput: { type: 'string' }, inputKind: { type: 'string' }, status: { type: 'string' },
  lockedTerms: { type: 'array' }, roleName: { type: 'string' }, taskContract: { type: 'object' },
  missingFields: { type: 'array' }, candidateTasks: { type: 'array' }, nextQuestion: { type: 'string' },
  confirmed: { type: 'boolean' }, warnings: { type: 'array' }, preflight: { type: 'object' },
}, [
  'schemaVersion', 'intakeId', 'intakeRootHash', 'originalInput', 'inputKind', 'status',
  'lockedTerms', 'roleName', 'taskContract', 'missingFields', 'candidateTasks', 'nextQuestion',
  'confirmed', 'warnings', 'preflight',
])

const candidateSchema = objectSchema({
  schemaVersion: { type: 'string' }, candidateId: { type: 'string' }, requestId: { type: 'string' },
  packageId: { type: 'string' }, packageVersion: { type: 'string' }, snapshotId: { type: 'string' },
  rootHash: { type: 'string' }, lifecycle: { type: 'string' }, confirmationStatus: { type: 'string' },
  groundingStatus: { type: 'string' }, sourceSnapshot: { type: 'object' },
  sourceBindings: { type: 'array' }, citations: { type: 'array' }, task: { type: 'object' },
  mappings: { type: 'object' }, assessment: { type: 'object' }, coverage: { type: 'object' },
  warnings: { type: 'array' }, assumptions: { type: 'array' }, validation: { type: 'object' },
  provenance: { type: 'object' },
}, [
  'schemaVersion', 'candidateId', 'requestId', 'packageId', 'packageVersion', 'snapshotId',
  'rootHash', 'lifecycle', 'confirmationStatus', 'groundingStatus', 'sourceSnapshot',
  'sourceBindings', 'citations', 'task', 'mappings', 'assessment', 'coverage', 'warnings',
  'assumptions', 'validation', 'provenance',
])

const evidenceSchema = objectSchema({
  candidateId: { type: 'string' }, groundingStatus: { type: 'string' }, sourceSnapshot: { type: 'object' },
  sourceBindings: { type: 'array' }, citations: { type: 'array' }, coverage: { type: 'object' },
  warnings: { type: 'array' }, authority: { type: 'string' }, masteryInference: { type: 'boolean' },
}, ['candidateId', 'groundingStatus', 'sourceSnapshot', 'sourceBindings', 'citations', 'coverage', 'warnings', 'authority', 'masteryInference'])

const auditSchema = objectSchema({
  candidateId: { type: 'string' }, lifecycle: { type: 'string' }, validation: { type: 'object' },
  coverage: { type: 'object' }, warnings: { type: 'array' }, provenance: { type: 'object' },
  formalLearningTaskCreated: { type: 'boolean' }, kernelWrites: { type: 'integer' },
}, ['candidateId', 'lifecycle', 'validation', 'coverage', 'warnings', 'provenance', 'formalLearningTaskCreated', 'kernelWrites'])

const handoffSchema = objectSchema({
  schemaVersion: { type: 'string' }, candidateId: { type: 'string' }, status: { type: 'string' },
  consumer: { type: 'string' }, requiresUserConfirmation: { type: 'boolean' }, candidate: { type: 'object' },
  knowledgeId: { type: 'string' }, taskSteps: { type: 'array' }, skills: { type: 'array' },
  resources: { type: 'array' }, citations: { type: 'array' }, returnContract: { type: 'object' },
  validation: { type: 'object' }, instruction: { type: 'string' }, formalLearningTaskCreated: { type: 'boolean' },
  kernelWrites: { type: 'integer' },
}, [
  'schemaVersion', 'candidateId', 'status', 'consumer', 'requiresUserConfirmation', 'knowledgeId',
  'taskSteps', 'skills', 'resources', 'citations', 'returnContract', 'candidate', 'validation',
  'instruction', 'formalLearningTaskCreated', 'kernelWrites',
])

const confirmationSchema = objectSchema({
  schemaVersion: { type: 'string' }, candidateId: { type: 'string' }, created: { type: 'boolean' },
  formalLearningTaskCreated: { type: 'boolean' }, learningTask: { type: 'object' },
  navigation: { type: 'object' }, managementNavigation: { type: 'object' },
  masteryChanged: { type: 'boolean' }, kernelWrites: { type: 'integer' },
}, [
  'schemaVersion', 'candidateId', 'created', 'formalLearningTaskCreated', 'learningTask',
  'navigation', 'managementNavigation', 'masteryChanged', 'kernelWrites',
])

const candidateIdSchema: PluginJsonSchema = {
  type: 'object', properties: { candidateId: { type: 'string', minLength: 5, maxLength: 80 } },
  required: ['candidateId'], additionalProperties: false,
}

const plugin = defineLearnFlowPlugin({
  manifest: {
    apiVersion: LEARNFLOW_PLUGIN_API_VERSION,
    ...LEARNING_TASK_CONVERSION_PLUGIN,
    defaultEnabled: false,
    objects: [
      {
        type: 'work_case_candidate', title: '本地工作案例候选', description: '完整案例保存在宿主，候选只固定版本与内容哈希，确认后才物化项目路线。',
        schemaVersion: WORK_CASE_CANDIDATE_SCHEMA,
        schema: objectSchema({ case_id: { type: 'string' }, case_version: { type: 'string' }, case_root_hash: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, project_mode: { type: 'string' } }, ['case_id', 'case_version', 'case_root_hash', 'title', 'summary', 'project_mode']),
        validate: value => { try { validateLocalWorkCaseCandidate(value); return [] } catch { return ['invalid immutable local case selector'] } },
      },
      {
        type: 'learning_task_intake', title: '学习型任务转化准备单',
        description: '在调用讯飞前完成输入层级判断、原文锚定、任务选择和显式确认。',
        schemaVersion: LEARNING_TASK_INTAKE_SCHEMA_VERSION, schema: intakeSchema,
        validate: (value: PluginJson) => {
          const intake = value as Record<string, any>
          return intake.confirmed === false && ['needs_task_selection', 'needs_input', 'ready_for_confirmation'].includes(intake.status)
            ? [] : ['intake must remain unconfirmed and use a registered preflight status']
        },
      },
      {
        type: 'learning_task_candidate', title: '学习型任务候选',
        description: '讯飞工作流生成、LearnFlow 校验但尚未确认的候选 artifact。',
        schemaVersion: LEARNING_TASK_OBJECT_SCHEMA_VERSION, schema: candidateSchema,
        validate: (value: PluginJson) => {
          const candidate = value as Record<string, any>
          return candidate.lifecycle === 'candidate'
            && candidate.confirmationStatus === 'unconfirmed'
            && candidate.validation?.valid === true
            && candidate.provenance?.kernelTargets?.length === 0
            ? [] : ['candidate must remain valid, unconfirmed and kernel-free']
        },
      },
      {
        type: 'learning_task_evidence', title: '候选来源检查', description: '固定来源版本、引用、覆盖与事实边界。',
        schemaVersion: LEARNING_TASK_OBJECT_SCHEMA_VERSION, schema: evidenceSchema,
        validate: (value: PluginJson) => (value as Record<string, any>).masteryInference === false ? [] : ['evidence view cannot infer mastery'],
      },
      {
        type: 'learning_task_audit', title: '候选确定性审计', description: '结构、依赖、映射、引用与零内核写入检查。',
        schemaVersion: LEARNING_TASK_OBJECT_SCHEMA_VERSION, schema: auditSchema,
        validate: (value: PluginJson) => Number((value as Record<string, any>).kernelWrites) === 0 ? [] : ['audit must report zero kernel writes'],
      },
      {
        type: 'learning_task_handoff', title: 'Tutor 审阅候选包', description: '仅供 Tutor 解释和用户确认的候选交接包。',
        schemaVersion: LEARNING_TASK_OBJECT_SCHEMA_VERSION, schema: handoffSchema,
        validate: (value: PluginJson) => {
          const handoff = value as Record<string, any>
          return handoff.requiresUserConfirmation === true && handoff.formalLearningTaskCreated === false
            ? [] : ['handoff must require confirmation and must not create a formal task']
        },
      },
      {
        type: 'learning_task_confirmation', title: '正式学习任务确认结果',
        description: '用户明确确认、LearnFlow 重新校验并创建正式 LearningTask 后的结果。',
        schemaVersion: LEARNING_TASK_CONFIRMATION_SCHEMA_VERSION, schema: confirmationSchema,
        validate: (value: PluginJson) => {
          const confirmation = value as Record<string, any>
          return confirmation.formalLearningTaskCreated === true
            && confirmation.masteryChanged === false
            && Number(confirmation.kernelWrites) === 0
            ? [] : ['confirmation must create a formal task without claiming mastery or writing kernels']
        },
      },
    ],
    tools: [
      {
        id: 'list_local_work_cases', title: '查找本地工作案例', description: '读取宿主可用的版本化教学案例目录，不运行外部生成服务。',
        whenToUse: '学生希望体验本地工作案例或开始实践型项目时先查看可用案例。', whenNotToUse: '已经在具体案例阶段中工作时不重复查询目录。',
        toolClass: 'perception', risk: 'read_only', requiresProject: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }, outputObjectTypes: [],
        availableInModes: ['free', 'simple_explain', 'guided_learning', 'learning_plan'],
      },
      {
        id: 'prepare_local_work_case', title: '校验本地工作案例', description: '将目录原样返回的案例ID、版本、hash交给宿主校验，返回等待用户在项目工作台确认的候选。',
        whenToUse: '学生选择一个目录中的案例，准备建立实践项目时。', whenNotToUse: '没有目录返回的精确版本/hash时禁止猜测；不能代替学生确认或直接推进关卡。',
        toolClass: 'execution', risk: 'artifact', requiresProject: true, renderer: 'work_case_candidate',
        inputSchema: objectSchema({ caseId: { type: 'string' }, version: { type: 'string' }, rootHash: { type: 'string', minLength: 64, maxLength: 64 } }, ['caseId', 'version', 'rootHash']),
        outputObjectTypes: ['work_case_candidate'], availableInModes: ['free', 'simple_explain', 'guided_learning', 'learning_plan'],
      },
      {
        id: 'prepare_learning_task_intake', title: '准备学习型任务转化',
        description: '接收宿主独立语义模型的层级判断，并在本地校验原文锚点，返回待选择或待确认准备单；不调用讯飞。',
        whenToUse: '用户刚提出学习型任务转化意图时，由宿主先执行一次真实语义预检，再调用本工具固化任务契约。',
        whenNotToUse: '已有已确认的准备单 rootHash、正在读取既有候选或确认正式任务时不要重复调用。',
        toolClass: 'perception', risk: 'read_only',
        renderer: LEARNING_TASK_RENDERERS.intake,
        inputSchema: {
          type: 'object', additionalProperties: false, required: ['rawInput'],
          properties: {
            rawInput: { type: 'string', minLength: 2, maxLength: 500, description: '保持用户任务原文或引号中的原始任务，不得改写为相似方向。' },
            roleName: { type: 'string', maxLength: 160 },
            taskDescription: { type: 'string', maxLength: 2000 },
            candidateTasks: { type: 'array', maxItems: 5, items: { type: 'object' }, description: '可选候选任务；每项带 title、description、source 和 sourceRef。' },
            selectedTaskTitle: { type: 'string', maxLength: 300 },
            selectedTaskDescription: { type: 'string', maxLength: 2000 },
            modelAssessment: { type: 'object', description: '宿主服务端语义预检结果；仍按不可信模型输出执行本地校验。' },
          },
        },
        outputObjectTypes: ['learning_task_intake'],
        availableInModes: ['free', 'simple_explain', 'guided_learning', 'learning_plan'],
      },
      {
        id: 'draft_learning_task', title: '生成学习型任务候选',
        description: '把真实工作任务、固定项目来源与目标步骤数发送给服务端固定讯飞工作流，返回未提交候选。',
        whenToUse: '仅当 prepare_learning_task_intake 已返回 ready_for_confirmation，且用户随后明确确认同一个 intakeId 与 intakeRootHash 时调用。',
        whenNotToUse: '首次输入、岗位、方向、知识主题、待选择准备单或尚未明确确认时禁止调用；不要代替用户确认。',
        toolClass: 'execution', risk: 'artifact', requiresProject: true,
        renderer: LEARNING_TASK_RENDERERS.candidate,
        inputSchema: {
          type: 'object', additionalProperties: false,
          required: ['originalInput', 'intakeId', 'intakeRootHash', 'intakeConfirmed', 'taskTitle', 'taskSource'],
          properties: {
            originalInput: { type: 'string', minLength: 2, maxLength: 500 },
            intakeId: { type: 'string', minLength: 8, maxLength: 80 },
            intakeRootHash: { type: 'string', minLength: 64, maxLength: 64 },
            intakeConfirmed: { type: 'boolean', enum: [true] },
            taskTitle: { type: 'string', minLength: 2, maxLength: 300 },
            taskDescription: { type: 'string', maxLength: 2000 },
            taskSource: { type: 'string', enum: ['user_explicit', 'role_package', 'project_source', 'model_proposed'] },
            taskSourceRef: { type: 'string', maxLength: 300 },
            upstreamTask: { type: 'object', description: '可选的上游典型工作任务 JSON；按不可信输入处理。' },
            sourceVersionIds: { type: 'array', maxItems: 20, items: { type: 'integer', minimum: 1 } },
            targetStepCount: { type: 'integer', minimum: 3, maximum: 12 },
            maxSourceSegments: { type: 'integer', minimum: 1, maximum: 20 },
            requestId: { type: 'string', minLength: 8, maxLength: 160 },
          },
        },
        outputObjectTypes: ['learning_task_candidate'],
        availableInModes: ['free', 'simple_explain', 'guided_learning', 'learning_plan'], timeoutMs: 120_000,
      },
      {
        id: 'read_learning_task_candidate', title: '读取学习任务候选',
        description: '按 candidateId 读取当前用户、当前项目的未提交候选。',
        whenToUse: '对话中已有候选 ID，需要继续解释、比较步骤或恢复查看时。',
        whenNotToUse: '不要读取其他项目候选，不要把候选表述为正式 LearningTask。',
        toolClass: 'perception', risk: 'read_only', requiresProject: true,
        renderer: LEARNING_TASK_RENDERERS.candidate, inputSchema: candidateIdSchema,
        outputObjectTypes: ['learning_task_candidate'], availableInModes: ['free', 'simple_explain', 'guided_learning', 'learning_plan'],
      },
      {
        id: 'inspect_learning_task_evidence', title: '检查候选来源证据',
        description: '检查固定 SourceVersion、来源片段引用、覆盖、截断和 grounding 状态。',
        whenToUse: '用户追问候选依据、来源是否真正进入工作流、引用或覆盖缺口时。',
        whenNotToUse: '不要把候选来源当作学习者掌握证据，也不要补造 citation。',
        toolClass: 'perception', risk: 'read_only', requiresProject: true,
        renderer: LEARNING_TASK_RENDERERS.evidence, inputSchema: candidateIdSchema,
        outputObjectTypes: ['learning_task_evidence'], availableInModes: ['free', 'simple_explain', 'guided_learning', 'learning_plan'],
      },
      {
        id: 'audit_learning_task_candidate', title: '审计学习任务候选',
        description: '重新执行确定性结构、ID、引用、依赖 DAG、资源 URL 与零内核写入检查。',
        whenToUse: '用户要求复核候选是否可进入确认环节，或怀疑结构、映射、截断问题时。',
        whenNotToUse: '审计通过不等于用户确认、正式发布、评分或掌握。',
        toolClass: 'perception', risk: 'read_only', requiresProject: true,
        renderer: LEARNING_TASK_RENDERERS.audit, inputSchema: candidateIdSchema,
        outputObjectTypes: ['learning_task_audit'], availableInModes: ['free', 'simple_explain', 'guided_learning', 'learning_plan'],
      },
      {
        id: 'prepare_learning_handoff', title: '准备 Tutor 审阅候选',
        description: '把已校验候选整理为 Tutor 可解释、可追问、等待用户确认的只读交接包。',
        whenToUse: '用户希望继续由 Tutor 审阅、解释或确认候选步骤时。',
        whenNotToUse: '不要声称已进入个性化学习；本工具不创建正式 LearningTask。',
        toolClass: 'perception', risk: 'read_only', requiresProject: true,
        renderer: LEARNING_TASK_RENDERERS.handoff, inputSchema: candidateIdSchema,
        outputObjectTypes: ['learning_task_handoff'], availableInModes: ['free', 'simple_explain', 'guided_learning', 'learning_plan'],
      },
      {
        id: 'confirm_learning_task_candidate', title: '确认并创建正式学习任务',
        description: '使用候选 ID、不可变 rootHash 和用户明确确认，交由 LearnFlow 重新校验并幂等创建正式 LearningTask。',
        whenToUse: '用户已经看过当前候选，并明确表示确认、采用、创建正式任务或进入个性化学习时。',
        whenNotToUse: '不得在候选刚生成、用户只要求审阅或没有明确确认时调用；不得代替用户确认。',
        toolClass: 'execution', risk: 'artifact', requiresProject: true,
        renderer: LEARNING_TASK_RENDERERS.confirmation,
        inputSchema: {
          type: 'object', additionalProperties: false,
          required: ['candidateId', 'expectedRootHash', 'confirmed'],
          properties: {
            candidateId: { type: 'string', minLength: 5, maxLength: 80 },
            expectedRootHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            confirmed: { type: 'boolean', enum: [true] },
            confirmationId: { type: 'string', minLength: 8, maxLength: 160 },
          },
        },
        outputObjectTypes: ['learning_task_confirmation'],
        availableInModes: ['free', 'simple_explain', 'guided_learning', 'learning_plan'], timeoutMs: 30_000,
      },
    ],
    skills: [{
      id: 'draft_learning_task', title: '真实工作任务转学习任务候选',
      description: '选中插件后，先用准备单收敛并确认单个企业工作任务，再调用讯飞生成候选。',
      whenToUse: '用户要求把具体工作任务转成可执行学习步骤、任务工单或学习型工作任务。',
      whenNotToUse: '用户只是问概念、要求评分、修改掌握状态或尚未给出可执行任务时。',
      instructions: [
        '用户选择本地案例路线时，先list_local_work_cases，再用目录返回的精确caseId/version/rootHash调用prepare_local_work_case。完整材料由宿主按阶段读取，不压缩进讯飞500字符输入，不向模型释放未来事件。返回候选后指导用户在项目工作台确认开始。',
        '新的自由文本工作任务转化请求，第一步调用 learning_task_conversion__prepare_learning_task_intake。本工具只返回可检查准备单，不调用讯飞；返回后本轮必须停止工具链并让用户选择或确认，严禁同一轮继续 draft_learning_task。',
        '岗位或职业输入先给出其下的单个企业典型工作任务候选；优先使用已引用岗位包或项目来源，数据库没有时可给 model_proposed 候选，但必须保留用户原始领域词并标明待确认。学习方向和知识主题不得自动替换成相似岗位。',
        '只有准备单为 ready_for_confirmation 且用户在后续一轮明确确认时，才可把准备单的 originalInput、intakeId、intakeRootHash、taskContract 和 source 原样传给 draft_learning_task。不得猜测或重算 intakeRootHash。',
        'taskTitle 保留用户任务对象、动作和交付目标；可从当前项目读取到的来源由服务端固定 SourceVersion 后注入，插件不得自行伪造 sourceVersionIds 或 citations。步骤数量未被用户明确指定时不要虚构固定五步或六步。',
        '工具结果是 learning_task_candidate。必须明确它尚未成为正式 LearningTask，不得修改学习者五核、掌握状态、长期记忆、评分或学习路径。',
        '若 groundingStatus 为 ungrounded 或 source_supplied_unverified，必须就近说明来源边界；不要把模型生成内容表述为岗位来源事实。',
        '需要核对依据时调用 inspect_learning_task_evidence；需要结构复核时调用 audit_learning_task_candidate；用户希望继续审阅时调用 prepare_learning_handoff。',
        'handoff 只进入 Tutor 当前轮的候选消费上下文。用户明确确认之前，不得声称已进入个性化学习或正式发布。',
        '用户明确确认当前候选后，使用候选中原样返回的 candidateId 与 sourceSnapshot.rootHash 调用 confirm_learning_task_candidate，并把 confirmed 设为 true；不得猜测或改写 rootHash。',
        '确认工具只让 LearnFlow 创建正式 LearningTask。生成、确认和任务完成都不等于掌握；评分、证据升级、教学策略与五核变更仍由 LearnFlow 的确定性规则控制。',
      ].join('\n'),
      tools: ['list_local_work_cases', 'prepare_local_work_case', 'prepare_learning_task_intake', 'draft_learning_task', 'read_learning_task_candidate', 'inspect_learning_task_evidence', 'audit_learning_task_candidate', 'prepare_learning_handoff', 'confirm_learning_task_candidate'],
      objectTypes: [...LEARNING_TASK_OBJECT_TYPES],
    }],
    renderers: [
      { id: 'work_case_candidate', title: '本地案例候选', description: '显示固定版本与项目确认入口，保留教学模拟来源边界。' },
      { id: LEARNING_TASK_RENDERERS.intake, title: '任务转化准备单', description: '显示输入层级、原文锚点、任务候选和确认前 Plan 状态。' },
      { id: LEARNING_TASK_RENDERERS.candidate, title: '学习任务候选工作台', description: '按先后依赖显示任务步骤、产物、验收和步骤内知识技能。' },
      { id: LEARNING_TASK_RENDERERS.evidence, title: '候选来源证据', description: '显示固定来源、引用、覆盖与事实边界。' },
      { id: LEARNING_TASK_RENDERERS.audit, title: '候选确定性审计', description: '显示结构校验、警告与零内核写入边界。' },
      { id: LEARNING_TASK_RENDERERS.handoff, title: 'Tutor 审阅候选包', description: '显示等待用户确认的只读候选交接。' },
      { id: LEARNING_TASK_RENDERERS.confirmation, title: '正式学习任务入口', description: '显示 LearnFlow 正式任务与个性化学习入口。' },
    ],
  },
  handlers: {
    list_local_work_cases: (_input, context) => listLocalWorkCases(context),
    prepare_local_work_case: (input, context) => prepareLocalWorkCase(input, context),
    prepare_learning_task_intake: input => learningTaskConversionRuntime.prepare(input),
    draft_learning_task: (input, context) => learningTaskConversionRuntime.draft(input, context),
    read_learning_task_candidate: (input, context) => learningTaskConversionRuntime.read(input, context),
    inspect_learning_task_evidence: (input, context) => learningTaskConversionRuntime.evidence(input, context),
    audit_learning_task_candidate: (input, context) => learningTaskConversionRuntime.audit(input, context),
    prepare_learning_handoff: (input, context) => learningTaskConversionRuntime.handoff(input, context),
    confirm_learning_task_candidate: (input, context) => learningTaskConversionRuntime.confirm(input, context),
  },
})

export default plugin
