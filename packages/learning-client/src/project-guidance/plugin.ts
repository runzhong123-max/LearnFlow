import { PROJECT_GUIDANCE_RENDERER, PROJECT_GUIDANCE_VERSION } from './contract.ts'
import { prepareProjectGuidance, confirmProjectGuidance, listProjectPracticeCases } from './runtime.ts'

const string = (maxLength: number) => ({ type: 'string', maxLength })
const strings = { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1000 } }
const modes = ['free', 'simple_explain', 'guided_learning', 'learning_plan']
/** Injected into each host's existing plugin; no host transport or credentials are discovered here. */
export const projectGuidanceContributions = {
  objects: [{ type: 'project_guidance', title: '工作任务转项目方案', schemaVersion: PROJECT_GUIDANCE_VERSION,
    description: '三类型选择、实验或带教任务书，以及宿主确认后的正式项目引用。',
    schema: { type: 'object', additionalProperties: false, required: ['schema_version', 'status', 'mastery_inference'],
      properties: Object.fromEntries([
        ['schema_version', 'string'], ['status', 'string'], ['name', 'string'], ['raw_input', 'string'], ['project_mode', 'string'],
        ['objective', 'string'], ['expected_outcome', 'string'], ['execution_surface', 'string'], ['candidate_id', 'string'],
        ['root_hash', 'string'], ['case_id', 'string'], ['case_version', 'string'], ['case_root_hash', 'string'],
        ['mastery_inference', 'boolean'], ['requires_confirmation', 'boolean'], ['created', 'boolean'],
        ['choices', 'array'], ['case_catalog', 'array'], ['missing_fields', 'array'], ['source_refs', 'array'], ['project_brief', 'object'],
        ['candidate', 'object'], ['navigation', 'object'], ['workspace', 'object'], ['workflow', 'object'],
        ['project_id', 'integer'], ['session_id', 'integer'],
      ].map(([name, type]) => [name, { type }])) },
    validate: (value: any) => value.mastery_inference === false && [
      'needs_mode_selection', 'needs_input', 'needs_case_selection', 'case_catalog', 'ready_for_confirmation', 'confirmed',
    ].includes(value.status) ? [] : ['project guidance must not infer mastery'],
  }],
  tools: [
    { id: 'list_project_practice_cases', title: '查找带教实践案例', toolClass: 'perception', risk: 'read_only',
      description: '读取当前学习者可用的版本化案例目录，不读取未来阶段材料或执行项目。',
      whenToUse: '用户已选择带教实践，需要匹配真实工作情境与可执行案例时。',
      whenNotToUse: '不能因为目录只有一个案例就自动替用户采用；没有匹配案例时不要伪造案例ID。',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      availableInModes: modes, outputObjectTypes: ['project_guidance'], renderer: PROJECT_GUIDANCE_RENDERER },
    { id: 'prepare_project_guidance', title: '准备工作任务转项目方案', toolClass: 'execution', risk: 'artifact',
      description: '先选择知识学习、实验或带教实践；收齐实验或带教的任务书后交 LearnFlow 准备未确认项目候选，不调用讯飞。',
      whenToUse: '新的工作任务尚未明确三种项目类型，或用户选择实验/带教后需要整理目标、交付、约束和验收时。',
      whenNotToUse: '已明确知识学习类型时使用原知识学习准备单；不能代替用户选择类型、确认或宣布掌握。',
      inputSchema: { type: 'object', additionalProperties: false, required: ['rawInput'], properties: {
        rawInput: { ...string(2000), minLength: 2 }, projectMode: { type: 'string', enum: ['experiment', 'practice'] },
        name: string(120), objective: string(2000), expectedOutcome: string(2000),
        deliverables: strings, constraints: strings, successCriteria: strings,
        caseId: string(100), caseVersion: string(100), caseRootHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      } }, availableInModes: modes, outputObjectTypes: ['project_guidance'], renderer: PROJECT_GUIDANCE_RENDERER },
    { id: 'confirm_project_guidance', title: '核对桌面项目确认', toolClass: 'execution', risk: 'artifact',
      description: '核对用户确认的 candidateId 与 rootHash 并呈现同一桌面确认卡；只有native宿主确认API成功后才能显示正式项目入口。',
      whenToUse: '用户已查看方案并在后续一轮明确确认当前不可变候选时；实验和带教的实际执行只在桌面。',
      whenNotToUse: '用户仅审阅、缺少明确确认、候选或hash不匹配时禁止；网页不能直接执行本地实验或案例。',
      inputSchema: { type: 'object', additionalProperties: false, required: ['candidateId', 'expectedRootHash', 'confirmed'],
        properties: { candidateId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' },
          expectedRootHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, confirmed: { type: 'boolean', enum: [true] } } },
      availableInModes: modes, outputObjectTypes: ['project_guidance'], renderer: PROJECT_GUIDANCE_RENDERER },
  ],
  skills: [{ id: 'project_guidance', title: '工作任务转换为三种学习项目',
    description: '由同一插件对话引导知识学习、实验与带教，复用 Tutor、项目、纸张、文件及正式验收。',
    whenToUse: '学习者启用本插件并提供工作任务，或正在整理实验与带教方案时。',
    whenNotToUse: '普通概念问答、已有项目的日常回答或正在验收时不要重新创建项目。',
    tools: ['prepare_project_guidance', 'confirm_project_guidance', 'list_project_practice_cases'], objectTypes: ['project_guidance'],
    instructions: [
      '先明确用户要知识学习、实验项目还是带教实践。没有明确选择时调用 prepare_project_guidance 且不传 projectMode，返回三选卡，本轮停止。不能凭工作内容替用户选择。',
      '知识学习使用原 prepare_learning_task_intake -> 用户确认 -> draft_learning_task 讯飞链；实验与带教绝不调用讯飞或 draft_learning_task。',
      '实验和带教只在桌面执行，网页可以讨论任务书、查看方案和结果；不得声称网页能够操作本地文件或bash。',
      '实验项目围绕可检查成果；带教围绕澄清、判断、阶段交付与交接。每轮先问一个最关键的缺口，确认目标、交付物、约束与验收标准后再 prepare_project_guidance。允许提出任务书候选，不得把生成候选说成用户已确认。',
      '带教先调用 list_project_practice_cases 读取可用案例目录，只有用户选择了确切匹配案例，才原样传 caseId/caseVersion/caseRootHash。不能把任意工作任务自动套到固定案例；没有匹配案例时明确案例设计尚未支持，继续澄清方案。不要向学习者泄露未来阶段材料或答案。',
      '将完整任务书作为插件对象展开到现有纸张，用同一对象引用继续对话，不创建第二套项目或文档权威。',
      'prepare 后本轮停止并等待用户确认。confirm_project_guidance 只核对并呈现相同的桌面确认卡；必须由学习者点击任务书卡片的“确认创建桌面项目”，native宿主返回成功后才有项目入口。不得编造创建结果或链接。',
      '项目 Tutor 统一承接项目任务书、阶段材料、文件、提示和交付；工程子Agent只通过已有 local_agent_broker 在隔离副本工作，不能替用户提交作答或写五核。运行/测试通过不是独立学习证据。',
    ].join('\n'),
  }],
  renderers: [{ id: PROJECT_GUIDANCE_RENDERER, title: '项目类型与任务书', description: '显示三种选择、项目任务书、桌面入口及真实确认结果。' }],
  handlers: { prepare_project_guidance: prepareProjectGuidance, confirm_project_guidance: confirmProjectGuidance, list_project_practice_cases: listProjectPracticeCases },
}
