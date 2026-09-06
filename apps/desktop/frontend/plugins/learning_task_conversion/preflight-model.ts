import type { PrepareLearningTaskIntakeInput } from './intake.ts'

export const LEARNING_TASK_PREFLIGHT_SCHEMA_VERSION = 'learning-task-intake-model.v1' as const

export type LearningTaskPreflightModelResult = {
  schema_version: typeof LEARNING_TASK_PREFLIGHT_SCHEMA_VERSION
  original_input: string
  input_kind: 'role' | 'role_or_direction' | 'work_task' | 'learning_topic' | 'ambiguous'
  role_name: string
  selected_task: { title: string; description: string } | null
  candidate_tasks: Array<{ title: string; description: string }>
  confidence: number
  rationale: string
  next_question: string
}

function compact(value: unknown, limit: number) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function jsonObject(text: string) {
  const source = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  try {
    return JSON.parse(source) as unknown
  } catch {
    const start = source.indexOf('{')
    const end = source.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('learning_task_preflight_invalid_json:语义预检没有返回 JSON 对象')
    return JSON.parse(source.slice(start, end + 1)) as unknown
  }
}

export function learningTaskPreflightInstructions() {
  return [
    '你是职业教育“学习型任务转化”的前置语义分析器，只负责理解输入，不生成教学内容和任务步骤。',
    '必须输出一个 JSON 对象，禁止 Markdown、解释文字和代码围栏。',
    `schema_version 必须是 ${LEARNING_TASK_PREFLIGHT_SCHEMA_VERSION}。`,
    'original_input 必须与输入 JSON 的 raw_input 完全一致，不得翻译、改写或替换技术方向。',
    'input_kind 只能是 role、role_or_direction、work_task、learning_topic、ambiguous。',
    'work_task 表示包含可识别动作和工作对象、可以继续拆解为步骤的实际任务；检查结果可以由后续 WF03 规划补全，不要求用户在首句中写全。岗位、职业或宽泛开发方向不能冒充 work_task。',
    '硬规则：以“工程师、技师、技术员、操作员、运维员、管理员、设计师、分析师、开发人员、测试人员、岗位、职业”表示人员职责范围的输入必须判为 role；即使名称中含“开发、运维、测试”等动作词，也绝不能判为 work_task。',
    '判断规则：任务名称能识别出“做什么动作”和“操作什么对象”即可判为 work_task，例如“交换机 VLAN 配置”“Unity 摄像机放置与 2D 视角跟随”。允许一个围绕同一交付目标的紧凑任务包含配置、实现、验证等连续动作，不要强制拆成一个动词。',
    '若是 work_task：selected_task.title 必须保持原任务名称和技术锚点，description 用一两句话说明实际作业对象、结果和验收边界；candidate_tasks 返回空数组。',
    '若是岗位、方向或学习主题：selected_task 必须为 null；candidate_tasks 必须给出 3 个同领域、互不重复、可执行且可验收的典型工作任务，每项必须是动作加工作对象，不得推荐相似岗位或热门替代方向。',
    '不要要求用户证明任务来自企业、补写企业背景或虚构真实项目。只有确实无法识别动作或工作对象时，才把 selected_task 设为 null，并在 next_question 中只追问一个最高价值缺口。',
    '不得输出学习路径、课程章节、学习目标、固定步数、个性化建议或知识讲解。',
    'JSON 字段必须完整：schema_version、original_input、input_kind、role_name、selected_task、candidate_tasks、confidence、rationale、next_question。',
  ].join('\n')
}

export function learningTaskPreflightInput(rawInput: string, taskDescription = '') {
  return JSON.stringify({
    raw_input: compact(rawInput, 500),
    user_request: compact(taskDescription, 2_000),
    goal: '判断输入层级并形成调用慢速讯飞工作流之前的任务契约',
  }, null, 2)
}

export function parseLearningTaskPreflightResult(
  text: string,
  expectedOriginalInput: string,
): LearningTaskPreflightModelResult {
  const value = jsonObject(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('learning_task_preflight_invalid:语义预检结果必须是对象')
  }
  const raw = value as Record<string, unknown>
  const schemaVersion = compact(raw.schema_version, 80)
  const echoedOriginalInput = compact(raw.original_input, 500)
  const expected = compact(expectedOriginalInput, 500)
  if (schemaVersion !== LEARNING_TASK_PREFLIGHT_SCHEMA_VERSION) {
    throw new Error('learning_task_preflight_schema_mismatch:语义预检合同版本不匹配')
  }
  // The host already owns the immutable user input. A model echo is never an
  // authoritative identifier, so punctuation or wrapper drift must not make
  // a valid preflight unusable. Any semantic replacement still has to pass
  // the deterministic locked-term checks in prepareLearningTaskIntake.
  const originalInput = expected
  const allowedKinds = new Set(['role', 'role_or_direction', 'work_task', 'learning_topic', 'ambiguous'])
  const inputKind = compact(raw.input_kind, 40)
  if (!allowedKinds.has(inputKind)) {
    throw new Error('learning_task_preflight_kind_invalid:语义预检没有给出有效输入层级')
  }
  const selectedValue = raw.selected_task
  const selectedTask = selectedValue && typeof selectedValue === 'object' && !Array.isArray(selectedValue)
    ? {
        title: compact((selectedValue as Record<string, unknown>).title, 300),
        description: compact((selectedValue as Record<string, unknown>).description, 2_000),
      }
    : null
  const candidates = Array.isArray(raw.candidate_tasks)
    ? raw.candidate_tasks.flatMap(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const title = compact((item as Record<string, unknown>).title, 300)
        if (title.length < 4) return []
        return [{ title, description: compact((item as Record<string, unknown>).description, 2_000) }]
      }).slice(0, 5)
    : []
  if (inputKind === 'work_task' && (!selectedTask || selectedTask.title.length < 2)) {
    throw new Error('learning_task_preflight_task_missing:语义预检判定为工作任务但没有返回任务契约')
  }
  if (inputKind !== 'work_task' && selectedTask) {
    throw new Error('learning_task_preflight_selection_invalid:岗位或方向不能由模型替用户直接选择任务')
  }
  const confidenceValue = Number(raw.confidence)
  return {
    schema_version: LEARNING_TASK_PREFLIGHT_SCHEMA_VERSION,
    original_input: originalInput,
    input_kind: inputKind as LearningTaskPreflightModelResult['input_kind'],
    role_name: compact(raw.role_name, 160),
    selected_task: selectedTask,
    candidate_tasks: candidates,
    confidence: Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : 0,
    rationale: compact(
      `${raw.rationale || ''}${echoedOriginalInput && echoedOriginalInput !== expected ? ' 模型回显与用户原文不一致，已由宿主恢复原文主键。' : ''}`,
      500,
    ),
    next_question: compact(raw.next_question, 500),
  }
}

export function preflightResultToIntakeInput(
  result: LearningTaskPreflightModelResult,
  taskDescription: string,
  model: string,
): PrepareLearningTaskIntakeInput {
  const candidateTasks = result.candidate_tasks.map(item => ({
    ...item,
    source: 'model_proposed' as const,
    sourceRef: `model-preflight:${model}`,
  }))
  const selected = result.selected_task
  const selectedPreservesOriginalTitle = selected?.title === result.original_input
  return {
    rawInput: result.original_input,
    roleName: result.role_name,
    taskDescription: selectedPreservesOriginalTitle ? selected?.description || taskDescription : taskDescription,
    candidateTasks,
    modelAssessment: {
      schemaVersion: result.schema_version,
      model,
      assessedKind: result.input_kind,
      confidence: result.confidence,
      rationale: result.rationale,
      nextQuestion: result.next_question,
    },
  }
}
