import {
  PROMPT_VERSION,
  RENDERER_VERSION,
  VISUAL_VERSION,
  type CodeTraceSemantic,
  type ComputerVisualAbstraction,
  type ComputerVisualSemantic,
  type ConvolutionTraceSemantic,
  type DataStructureSemantic,
  type DerivationSemantic,
  type EventLoopSemantic,
  type FunctionSemantic,
  type GraphAlgorithmSemantic,
  type LearningVisualAbstraction,
  type LearningVisualDomain,
  type LearningVisualFrame,
  type LearningVisualKind,
  type LearningVisualSpec,
  type LegacyLearningVisualFrame,
  type LegacyLearningVisualNode,
  type LegacyLearningVisualRelation,
  type LegacyLearningVisualSpec,
  type MathematicsVisualAbstraction,
  type MathematicsVisualSemantic,
  type MathStructureSemantic,
  type MatrixOperationSemantic,
  type NaturalFrequencySemantic,
  type OptimizationSemantic,
  type ProbabilitySemantic,
  type ProtocolSequenceSemantic,
  type SemanticSceneSemantic,
  type ReadableLearningVisualSpec,
  type StateMachineSemantic,
  type SystemStructureSemantic,
  type TensorShapeFlowSemantic,
  type TransformationSemantic,
  type VisualAccessibility,
  type VisualGenerationReport,
  type VisualInvariant,
  type VisualPatch,
  type VisualPoint,
  type VisualPredictionGate,
  type VisualProvenance,
  type VisualRepair,
  type VisualScalar,
  type VisualStateSnapshot,
} from './types.ts'
import { derivedTraceLength, isDerivedSemantic } from './derived.ts'
import { deriveTeachingRequest, TEACHING_COMPILER_ID, TEACHING_COMPILER_VERSION } from './teaching-compiler.ts'
import { teachingDerivationToSpec } from './teaching-spec.ts'

type ParseContext = { repairs: VisualRepair[] }

const LEGACY_V1_VERSION = 'learnflow.visual.v1' as const
const LEGACY_V2_VERSION = 'learnflow.visual.v2' as const
const LEGACY_V2_PROMPT_VERSION = 'learnflow.visual-planner.v2' as const
const LEGACY_V2_RENDERER_VERSION = 'learnflow.deterministic-svg.v2' as const
const LEGACY_V2_ABSTRACTIONS = {
  computer: new Set(['protocol_sequence', 'state_machine', 'data_structure', 'code_trace', 'tensor_shape_flow', 'semantic_scene', 'system_structure']),
  mathematics: new Set(['function', 'probability', 'transformation', 'derivation', 'math_structure']),
} as const
const LEGACY_V2_PATCH_TYPES = new Set([
  'send_message',
  'transition_state',
  'move_item',
  'set_pointer',
  'set_active_line',
  'set_variable',
  'push_stack',
  'pop_stack',
  'set_tensor_shape',
  'set_parameter',
  'set_probability_sample',
  'replace_series',
  'transform_object',
  'replace_expression',
])

const MAX_ENTITIES = 24
const MAX_RELATIONS = 32
const MAX_FRAMES = 12
const MAX_PATCHES_PER_FRAME = 8
const MAX_POINTS = 96
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,35}$/
export const FORBIDDEN_EXECUTABLE = /<\/?(?:script|iframe|object|embed|foreignObject)\b|javascript:|data:text\/html|\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(|\brequire\s*\(|\bimport\s*\(/i

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`visual_spec_object_required:${path}`)
  return value
}

export function compact(value: unknown, limit: number, context?: ParseContext, path = 'text') {
  const sanitized = String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  if (sanitized.length > limit && context) context.repairs.push({ code: 'text_truncated', path, detail: `kept_first_${limit}_characters` })
  return sanitized.slice(0, limit)
}

function text(value: unknown, path: string, limit: number, context: ParseContext, allowEmpty = false) {
  const output = compact(value, limit, context, path)
  if (!allowEmpty && !output) throw new Error(`visual_spec_text_required:${path}`)
  return output
}

function id(value: unknown, path: string) {
  const output = String(value ?? '').trim()
  if (!ID_PATTERN.test(output)) throw new Error(`visual_spec_id_invalid:${path}`)
  return output
}

function finiteNumber(value: unknown, path: string, min = -1_000_000, max = 1_000_000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`visual_spec_number_invalid:${path}`)
  }
  return value
}

function integer(value: unknown, path: string, min: number, max: number) {
  const output = finiteNumber(value, path, min, max)
  if (!Number.isInteger(output)) throw new Error(`visual_spec_integer_required:${path}`)
  return output
}

function scalar(value: unknown, path: string, context?: ParseContext): VisualScalar {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return finiteNumber(value, path)
  if (typeof value === 'string') return compact(value, 80, context, path)
  throw new Error(`visual_spec_scalar_invalid:${path}`)
}

function point(value: unknown, path: string): VisualPoint {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`visual_spec_point_invalid:${path}`)
  return [finiteNumber(value[0], `${path}[0]`), finiteNumber(value[1], `${path}[1]`)]
}

function boundedArray(value: unknown, path: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`visual_spec_array_required:${path}`)
  if (value.length < minimum) throw new Error(`visual_spec_array_too_short:${path}`)
  if (value.length > maximum) throw new Error(`visual_spec_array_too_long:${path}`)
  return value
}

function records(value: unknown, path: string, minimum: number, maximum: number) {
  return boundedArray(value, path, minimum, maximum).map((item, index) => record(item, `${path}[${index}]`))
}

function optionalRecords(value: unknown, path: string, maximum: number) {
  if (value === undefined || value === null) return []
  return records(value, path, 0, maximum)
}

function ids(value: unknown, path: string, maximum = MAX_ENTITIES) {
  return boundedArray(value, path, 0, maximum).map((item, index) => id(item, `${path}[${index}]`))
}

function points(value: unknown, path: string, minimum = 1, maximum = MAX_POINTS) {
  return boundedArray(value, path, minimum, maximum).map((item, index) => point(item, `${path}[${index}]`))
}

function numericMatrix(value: unknown, path: string) {
  const rows = boundedArray(value, path, 1, 8).map((row, rowIndex) => (
    boundedArray(row, `${path}[${rowIndex}]`, 1, 8).map((item, columnIndex) => finiteNumber(item, `${path}[${rowIndex}][${columnIndex}]`))
  ))
  const columns = rows[0].length
  if (rows.some(row => row.length !== columns)) throw new Error(`visual_spec_matrix_not_rectangular:${path}`)
  return rows
}

function shape(value: unknown, path: string) {
  return boundedArray(value, path, 1, 8).map((item, index) => integer(item, `${path}[${index}]`, 1, 1_000_000))
}

function uniqueIds(items: Array<{ id: string }>, path: string) {
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`visual_spec_duplicate_id:${path}.${item.id}`)
    seen.add(item.id)
  }
}

function assertReferences(items: string[], available: Set<string>, path: string) {
  for (const item of items) if (!available.has(item)) throw new Error(`visual_spec_dangling_reference:${path}.${item}`)
}

function hashText(value: string) {
  let hash = 0x811c9dc5
  for (const character of value) {
    hash ^= character.codePointAt(0) || 0
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function provenanceRequestText(value: unknown) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, 2200)
}

export function provenance(request: string): VisualProvenance {
  // Line boundaries are compiler input for code/event-loop requests. They are
  // therefore provenance, not presentational whitespace, and must survive a
  // persisted round trip for reproducible compilation.
  const requestText = provenanceRequestText(request)
  return {
    schemaVersion: VISUAL_VERSION,
    promptVersion: PROMPT_VERSION,
    rendererVersion: RENDERER_VERSION,
    requestHash: hashText(requestText),
    requestText,
  }
}

export function emptyState(): VisualStateSnapshot {
  return {
    activeIds: [],
    values: {},
    pointers: {},
    positions: {},
    tensorShapes: {},
    expressions: {},
    series: {},
    stack: [],
    emittedMessageIds: [],
  }
}

export function cloneState(state: VisualStateSnapshot): VisualStateSnapshot {
  return {
    ...state,
    activeIds: [...state.activeIds],
    values: { ...state.values },
    pointers: { ...state.pointers },
    positions: Object.fromEntries(Object.entries(state.positions).map(([key, value]) => [key, [...value] as VisualPoint])),
    tensorShapes: Object.fromEntries(Object.entries(state.tensorShapes).map(([key, value]) => [key, [...value]])),
    expressions: { ...state.expressions },
    series: Object.fromEntries(Object.entries(state.series).map(([key, value]) => [key, value.map(item => [...item] as VisualPoint)])),
    stack: [...state.stack],
    emittedMessageIds: [...state.emittedMessageIds],
    visibleIds: state.visibleIds === undefined ? undefined : [...state.visibleIds],
    focusIds: state.focusIds === undefined ? undefined : [...state.focusIds],
    groupMembers: state.groupMembers === undefined ? undefined : Object.fromEntries(Object.entries(state.groupMembers).map(([key, value]) => [key, [...value]])),
    orders: state.orders === undefined ? undefined : Object.fromEntries(Object.entries(state.orders).map(([key, value]) => [key, [...value]])),
    properties: state.properties === undefined ? undefined : Object.fromEntries(Object.entries(state.properties).map(([key, value]) => [key, { ...value }])),
  }
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedValue(value[key])]))
}

export function equivalent(left: unknown, right: unknown) {
  return JSON.stringify(sortedValue(left)) === JSON.stringify(sortedValue(right))
}

export function extractJson(raw: string) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const source = (fenced || raw).trim()
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('visual_spec_json_missing')
  const json = source.slice(start, end + 1)
  if (FORBIDDEN_EXECUTABLE.test(json)) throw new Error('visual_spec_executable_content_rejected')
  return record(JSON.parse(json), 'root')
}

function repairPlannerJsonPunctuation(original: string) {
  let repaired = ''
  let inString = false
  let escaped = false
  let changed = false
  for (let index = 0; index < original.length; index += 1) {
    const character = original[index]
    if (inString) {
      repaired += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      repaired += character
      continue
    }
    let next = index + 1
    while (/\s/.test(original[next] || '')) next += 1
    if (character === ',' && ['}', ']'].includes(original[next])) {
      changed = true
      continue
    }
    repaired += character
    if (['}', ']'].includes(character) && ['{', '['].includes(original[next])) {
      repaired += ','
      changed = true
    }
  }
  return changed ? repaired : original
}

/**
 * Repair only JSON punctuation that cannot change a scalar value or invent a
 * teaching fact. The repaired payload still passes the complete VisualSpec
 * parser, semantic verifier, replay gate, layout gate and SVG sanitizer.
 */
export function extractPlannerJson(raw: string): { payload: Record<string, unknown>; repairs: VisualRepair[] } {
  try {
    return { payload: extractJson(raw), repairs: [] }
  } catch (strictError) {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
    const source = (fenced || raw).trim()
    const start = source.indexOf('{')
    const end = source.lastIndexOf('}')
    if (start < 0 || end <= start) throw strictError
    const original = source.slice(start, end + 1)
    if (FORBIDDEN_EXECUTABLE.test(original)) throw strictError
    const repaired = repairPlannerJsonPunctuation(original)
    if (repaired === original) throw strictError
    try {
      return {
        payload: record(JSON.parse(repaired), 'root'),
        repairs: [{
          code: 'planner_json_punctuation_repaired',
          path: 'root',
          detail: '只修复尾随逗号或相邻数组/对象元素间缺失的逗号；未改写任何标量内容。',
        }],
      }
    } catch {
      throw strictError
    }
  }
}

function classificationForMath(value: string): MathematicsVisualAbstraction {
  if (/(?:自然频数|贝叶斯|患病率|灵敏度|敏感度|特异度|natural frequenc(?:y|ies)?|bayes(?:ian)?|prevalence|sensitivity|specificity)/i.test(value)) return 'natural_frequency'
  if (/(?:梯度下降|gradient descent|学习率)/i.test(value)) return 'optimization'
  if (/(?:矩阵乘法|矩阵相乘|matrix multiplication|matmul)/i.test(value)) return 'matrix_operation'
  if (/(?:概率|分布|贝叶斯|随机变量|pmf|pdf|cdf|probability)/i.test(value)) return 'probability'
  if (/(?:推导|证明|等式|化简|恒等|derivation|proof)/i.test(value)) return 'derivation'
  if (/(?:变换|矩阵|向量|旋转|平移|缩放|参数变化|线性映射|transform)/i.test(value)) return 'transformation'
  return 'function'
}

export function classifyLearningVisual(query: string):
  | { domain: 'computer'; abstraction: ComputerVisualAbstraction }
  | { domain: 'mathematics'; abstraction: MathematicsVisualAbstraction } {
  const normalized = query.toLowerCase()
  if (/(?:cnn|卷积(?:神经网络|核|层|计算)?|池化|手写数字|mnist|感受野)/i.test(normalized)) return { domain: 'computer', abstraction: 'convolution_trace' }
  if (/(?:事件循环|微任务|宏任务|event loop|microtask)/i.test(normalized)) return { domain: 'computer', abstraction: 'event_loop' }
  if (/(?:dijkstra|迪杰斯特拉|最短路径|带权图)/i.test(normalized)) return { domain: 'computer', abstraction: 'graph_algorithm' }
  if (/(?:张量|shape|qkv|神经网络|注意力|transformer|tensor)/i.test(normalized)) return { domain: 'computer', abstraction: 'tensor_shape_flow' }
  if (/(?:协议|握手|请求.*响应|客户端|服务端|tcp|http|sequence)/i.test(normalized)) return { domain: 'computer', abstraction: 'protocol_sequence' }
  if (/(?:状态机|状态转移|生命周期|state machine)/i.test(normalized)) return { domain: 'computer', abstraction: 'state_machine' }
  if (/(?:代码执行|逐行|变量变化|调用栈|递归栈|code trace)/i.test(normalized)) return { domain: 'computer', abstraction: 'code_trace' }
  if (/(?:树|链表|栈|队列|堆|数组|数据结构|二分|排序)/i.test(normalized)) return { domain: 'computer', abstraction: 'data_structure' }
  const math = /(?:公式|定理|证明|函数|导数|积分|矩阵|向量|概率|分布|几何|极限|梯度|方程|自然频数|贝叶斯|患病率|灵敏度|敏感度|特异度|math|theorem|probability|natural frequenc(?:y|ies)?|bayes(?:ian)?|prevalence|sensitivity|specificity)/i.test(normalized)
  if (math) return { domain: 'mathematics', abstraction: classificationForMath(normalized) }
  return { domain: 'computer', abstraction: 'system_structure' }
}

function parseProtocol(value: unknown, context: ParseContext): ProtocolSequenceSemantic {
  const source = record(value, 'semantic')
  const participants = records(source.participants, 'semantic.participants', 2, 8).map((item, index) => ({
    id: id(item.id, `semantic.participants[${index}].id`),
    label: text(item.label, `semantic.participants[${index}].label`, 32, context),
    role: compact(item.role, 24, context, `semantic.participants[${index}].role`) || undefined,
  }))
  uniqueIds(participants, 'semantic.participants')
  const participantIds = new Set(participants.map(item => item.id))
  const messages = records(source.messages, 'semantic.messages', 1, 16).map((item, index) => ({
    id: id(item.id, `semantic.messages[${index}].id`),
    from: id(item.from, `semantic.messages[${index}].from`),
    to: id(item.to, `semantic.messages[${index}].to`),
    label: text(item.label, `semantic.messages[${index}].label`, 42, context),
    order: integer(item.order, `semantic.messages[${index}].order`, 1, 99),
    phase: compact(item.phase, 28, context, `semantic.messages[${index}].phase`) || undefined,
  }))
  uniqueIds(messages, 'semantic.messages')
  for (const message of messages) assertReferences([message.from, message.to], participantIds, `semantic.messages.${message.id}`)
  if (new Set(messages.map(item => item.order)).size !== messages.length) throw new Error('visual_spec_duplicate_message_order')
  messages.sort((left, right) => left.order - right.order)
  return { type: 'protocol_sequence', participants, messages }
}

function parseStateMachine(value: unknown, context: ParseContext): StateMachineSemantic {
  const source = record(value, 'semantic')
  const states = records(source.states, 'semantic.states', 2, 12).map((item, index) => ({
    id: id(item.id, `semantic.states[${index}].id`),
    label: text(item.label, `semantic.states[${index}].label`, 32, context),
    initial: item.initial === true || undefined,
    terminal: item.terminal === true || undefined,
  }))
  uniqueIds(states, 'semantic.states')
  if (states.filter(item => item.initial).length > 1) throw new Error('visual_spec_multiple_initial_states')
  const stateIds = new Set(states.map(item => item.id))
  const transitions = records(source.transitions, 'semantic.transitions', 1, 20).map((item, index) => ({
    id: id(item.id, `semantic.transitions[${index}].id`),
    from: id(item.from, `semantic.transitions[${index}].from`),
    to: id(item.to, `semantic.transitions[${index}].to`),
    event: text(item.event, `semantic.transitions[${index}].event`, 42, context),
    guard: compact(item.guard, 48, context, `semantic.transitions[${index}].guard`) || undefined,
  }))
  uniqueIds(transitions, 'semantic.transitions')
  for (const transition of transitions) assertReferences([transition.from, transition.to], stateIds, `semantic.transitions.${transition.id}`)
  return { type: 'state_machine', states, transitions }
}

function parseDataStructure(value: unknown, context: ParseContext): DataStructureSemantic {
  const source = record(value, 'semantic')
  const structure = String(source.structure)
  if (!['array', 'linked_list', 'stack', 'queue', 'tree', 'heap', 'graph'].includes(structure)) throw new Error('visual_spec_data_structure_kind_invalid')
  const items = records(source.items, 'semantic.items', 1, 20).map((item, index) => ({
    id: id(item.id, `semantic.items[${index}].id`),
    label: text(item.label, `semantic.items[${index}].label`, 28, context),
    value: item.value === undefined ? undefined : scalar(item.value, `semantic.items[${index}].value`, context),
    index: item.index === undefined ? undefined : integer(item.index, `semantic.items[${index}].index`, -1, 999),
  }))
  uniqueIds(items, 'semantic.items')
  const itemIds = new Set(items.map(item => item.id))
  const links = optionalRecords(source.links, 'semantic.links', 28).map((item, index) => {
    const kind = String(item.kind)
    if (!['next', 'left', 'right', 'parent', 'contains', 'edge'].includes(kind)) throw new Error(`visual_spec_link_kind_invalid:semantic.links[${index}]`)
    const output = {
      id: id(item.id, `semantic.links[${index}].id`),
      from: id(item.from, `semantic.links[${index}].from`),
      to: id(item.to, `semantic.links[${index}].to`),
      kind: kind as DataStructureSemantic['links'][number]['kind'],
    }
    assertReferences([output.from, output.to], itemIds, `semantic.links[${index}]`)
    return output
  })
  uniqueIds(links, 'semantic.links')
  const pointers = optionalRecords(source.pointers, 'semantic.pointers', 12).map((item, index) => {
    const targetId = item.targetId === null || item.targetId === undefined ? null : id(item.targetId, `semantic.pointers[${index}].targetId`)
    if (targetId) assertReferences([targetId], itemIds, `semantic.pointers[${index}]`)
    return { id: id(item.id, `semantic.pointers[${index}].id`), label: text(item.label, `semantic.pointers[${index}].label`, 24, context), targetId }
  })
  uniqueIds(pointers, 'semantic.pointers')
  return { type: 'data_structure', structure: structure as DataStructureSemantic['structure'], items, links, pointers }
}

function parseCodeTrace(value: unknown, context: ParseContext): CodeTraceSemantic {
  const source = record(value, 'semantic')
  const language = String(source.language)
  if (!['pseudocode', 'python', 'typescript', 'javascript', 'java', 'cpp'].includes(language)) throw new Error('visual_spec_code_language_invalid')
  const lines = records(source.lines, 'semantic.lines', 1, 16).map((item, index) => ({
    id: id(item.id, `semantic.lines[${index}].id`),
    number: integer(item.number, `semantic.lines[${index}].number`, 1, 9999),
    text: text(item.text, `semantic.lines[${index}].text`, 100, context),
  }))
  uniqueIds(lines, 'semantic.lines')
  const lineIds = new Set(lines.map(item => item.id))
  const variables = optionalRecords(source.variables, 'semantic.variables', 7).map((item, index) => ({
    id: id(item.id, `semantic.variables[${index}].id`),
    name: text(item.name, `semantic.variables[${index}].name`, 24, context),
    initialValue: scalar(item.initialValue, `semantic.variables[${index}].initialValue`, context),
  }))
  uniqueIds(variables, 'semantic.variables')
  const stackFrames = optionalRecords(source.stackFrames, 'semantic.stackFrames', 12).map((item, index) => {
    const output = {
      id: id(item.id, `semantic.stackFrames[${index}].id`),
      functionName: text(item.functionName, `semantic.stackFrames[${index}].functionName`, 28, context),
      lineId: id(item.lineId, `semantic.stackFrames[${index}].lineId`),
    }
    assertReferences([output.lineId], lineIds, `semantic.stackFrames[${index}]`)
    return output
  })
  uniqueIds(stackFrames, 'semantic.stackFrames')
  return { type: 'code_trace', language: language as CodeTraceSemantic['language'], lines, variables, stackFrames }
}

function parseTensor(value: unknown, context: ParseContext): TensorShapeFlowSemantic {
  const source = record(value, 'semantic')
  const tensors = records(source.tensors, 'semantic.tensors', 2, 16).map((item, index) => {
    const dtype = item.dtype === undefined ? undefined : String(item.dtype)
    if (dtype && !['bool', 'int32', 'int64', 'float16', 'float32', 'float64'].includes(dtype)) throw new Error(`visual_spec_tensor_dtype_invalid:semantic.tensors[${index}]`)
    return {
      id: id(item.id, `semantic.tensors[${index}].id`),
      label: text(item.label, `semantic.tensors[${index}].label`, 28, context),
      shape: shape(item.shape, `semantic.tensors[${index}].shape`),
      dtype: dtype as TensorShapeFlowSemantic['tensors'][number]['dtype'],
    }
  })
  uniqueIds(tensors, 'semantic.tensors')
  const tensorIds = new Set(tensors.map(item => item.id))
  const operations = records(source.operations, 'semantic.operations', 1, 16).map((item, index) => {
    const inputIds = ids(item.inputIds, `semantic.operations[${index}].inputIds`, 8)
    const outputIds = ids(item.outputIds, `semantic.operations[${index}].outputIds`, 8)
    if (!inputIds.length || !outputIds.length) throw new Error(`visual_spec_tensor_operation_io_required:semantic.operations[${index}]`)
    assertReferences([...inputIds, ...outputIds], tensorIds, `semantic.operations[${index}]`)
    return { id: id(item.id, `semantic.operations[${index}].id`), label: text(item.label, `semantic.operations[${index}].label`, 32, context), inputIds, outputIds }
  })
  uniqueIds(operations, 'semantic.operations')
  return { type: 'tensor_shape_flow', tensors, operations }
}

function parseConvolution(value: unknown, context: ParseContext): ConvolutionTraceSemantic {
  const source = record(value, 'semantic')
  const input = record(source.input, 'semantic.input')
  const kernel = record(source.kernel, 'semantic.kernel')
  const stride = integer(source.stride, 'semantic.stride', 1, 2)
  if (stride !== 1 && stride !== 2) throw new Error('visual_spec_convolution_stride_invalid')
  if (source.padding !== 0) throw new Error('visual_spec_convolution_padding_invalid')
  if (source.activation !== 'relu') throw new Error('visual_spec_convolution_activation_invalid')
  if (source.poolSize !== 2) throw new Error('visual_spec_convolution_pool_invalid')
  return {
    type: 'convolution_trace',
    id: id(source.id, 'semantic.id'),
    input: {
      id: id(input.id, 'semantic.input.id'),
      label: text(input.label, 'semantic.input.label', 28, context),
      values: numericMatrix(input.values, 'semantic.input.values'),
    },
    kernel: {
      id: id(kernel.id, 'semantic.kernel.id'),
      label: text(kernel.label, 'semantic.kernel.label', 28, context),
      values: numericMatrix(kernel.values, 'semantic.kernel.values'),
    },
    outputId: id(source.outputId, 'semantic.outputId'),
    stride: stride as 1 | 2,
    padding: 0,
    bias: finiteNumber(source.bias, 'semantic.bias', -1_000, 1_000),
    activation: 'relu',
    poolSize: 2,
  }
}

function parseStructure(value: unknown, context: ParseContext): SystemStructureSemantic {
  const source = record(value, 'semantic')
  const entities = records(source.entities, 'semantic.entities', 1, MAX_ENTITIES).map((item, index) => {
    const role = item.role === undefined ? undefined : String(item.role)
    if (role && !['input', 'process', 'state', 'output', 'concept'].includes(role)) throw new Error(`visual_spec_entity_role_invalid:semantic.entities[${index}]`)
    return {
      id: id(item.id, `semantic.entities[${index}].id`),
      label: text(item.label, `semantic.entities[${index}].label`, 32, context),
      detail: compact(item.detail, 56, context, `semantic.entities[${index}].detail`) || undefined,
      role: role as SystemStructureSemantic['entities'][number]['role'],
    }
  })
  uniqueIds(entities, 'semantic.entities')
  const entityIds = new Set(entities.map(item => item.id))
  const relations = optionalRecords(source.relations, 'semantic.relations', MAX_RELATIONS).map((item, index) => {
    const kind = String(item.kind)
    if (!['flow', 'dependency', 'transition', 'comparison', 'mapping'].includes(kind)) throw new Error(`visual_spec_relation_kind_invalid:semantic.relations[${index}]`)
    const output = {
      id: id(item.id, `semantic.relations[${index}].id`),
      from: id(item.from, `semantic.relations[${index}].from`),
      to: id(item.to, `semantic.relations[${index}].to`),
      label: compact(item.label, 32, context, `semantic.relations[${index}].label`) || undefined,
      kind: kind as SystemStructureSemantic['relations'][number]['kind'],
    }
    assertReferences([output.from, output.to], entityIds, `semantic.relations[${index}]`)
    return output
  })
  uniqueIds(relations, 'semantic.relations')
  return { type: 'system_structure', entities, relations }
}

function parseSemanticScene(value: unknown, context: ParseContext): SemanticSceneSemantic {
  const source = record(value, 'semantic')
  const entities = records(source.entities, 'semantic.entities', 2, 32).map((item, index) => ({
    id: id(item.id, `semantic.entities[${index}].id`),
    label: text(item.label, `semantic.entities[${index}].label`, 34, context),
    kind: String(item.kind) as SemanticSceneSemantic['entities'][number]['kind'],
    detail: compact(item.detail, 56, context, `semantic.entities[${index}].detail`) || undefined,
  }))
  entities.forEach((item, index) => {
    if (!['item', 'actor', 'state', 'value', 'operator', 'result'].includes(item.kind)) throw new Error(`visual_spec_scene_entity_kind_invalid:${index}`)
  })
  uniqueIds(entities, 'semantic.entities')
  const entityIds = new Set(entities.map(item => item.id))
  const relations = optionalRecords(source.relations, 'semantic.relations', 48).map((item, index) => {
    const output = {
      id: id(item.id, `semantic.relations[${index}].id`), from: id(item.from, `semantic.relations[${index}].from`),
      to: id(item.to, `semantic.relations[${index}].to`), label: compact(item.label, 32, context, `semantic.relations[${index}].label`) || undefined,
      kind: String(item.kind) as SemanticSceneSemantic['relations'][number]['kind'],
    }
    if (!['flow', 'link', 'membership', 'comparison', 'message'].includes(output.kind)) throw new Error(`visual_spec_scene_relation_kind_invalid:${index}`)
    assertReferences([output.from, output.to], entityIds, `semantic.relations[${index}]`)
    return output
  })
  uniqueIds(relations, 'semantic.relations')
  const groups = optionalRecords(source.groups, 'semantic.groups', 12).map((item, index) => ({
    id: id(item.id, `semantic.groups[${index}].id`), label: text(item.label, `semantic.groups[${index}].label`, 28, context),
    layout: String(item.layout) as SemanticSceneSemantic['groups'][number]['layout'],
  }))
  groups.forEach((item, index) => {
    if (!['row', 'column', 'cluster'].includes(item.layout)) throw new Error(`visual_spec_scene_group_layout_invalid:${index}`)
  })
  uniqueIds(groups, 'semantic.groups')
  return { type: 'semantic_scene', entities, relations, groups }
}

function parseFunction(value: unknown, context: ParseContext): FunctionSemantic {
  const source = record(value, 'semantic')
  const axes = record(source.axes, 'semantic.axes')
  const xDomain = point(axes.xDomain, 'semantic.axes.xDomain')
  const yDomain = point(axes.yDomain, 'semantic.axes.yDomain')
  if (xDomain[0] >= xDomain[1] || yDomain[0] >= yDomain[1]) throw new Error('visual_spec_axis_domain_invalid')
  const series = records(source.series, 'semantic.series', 1, 5).map((item, index) => ({
    id: id(item.id, `semantic.series[${index}].id`),
    label: text(item.label, `semantic.series[${index}].label`, 28, context),
    points: points(item.points, `semantic.series[${index}].points`, 2, MAX_POINTS),
  }))
  uniqueIds(series, 'semantic.series')
  for (const item of series) {
    for (const [x, y] of item.points) {
      if (x < xDomain[0] || x > xDomain[1] || y < yDomain[0] || y > yDomain[1]) {
        throw new Error(`visual_spec_point_outside_domain:semantic.series.${item.id}`)
      }
    }
  }
  const parameters = optionalRecords(source.parameters, 'semantic.parameters', 12).map((item, index) => ({
    id: id(item.id, `semantic.parameters[${index}].id`),
    label: text(item.label, `semantic.parameters[${index}].label`, 24, context),
    value: finiteNumber(item.value, `semantic.parameters[${index}].value`),
  }))
  uniqueIds(parameters, 'semantic.parameters')
  return { type: 'function', axes: { xLabel: text(axes.xLabel, 'semantic.axes.xLabel', 20, context), yLabel: text(axes.yLabel, 'semantic.axes.yLabel', 20, context), xDomain, yDomain }, series, parameters }
}

function parseProbability(value: unknown, context: ParseContext): ProbabilitySemantic {
  const source = record(value, 'semantic')
  const mode = String(source.mode)
  if (!['pmf', 'pdf', 'cdf'].includes(mode)) throw new Error('visual_spec_probability_mode_invalid')
  const samples = records(source.samples, 'semantic.samples', 2, MAX_POINTS).map((item, index) => ({
    id: id(item.id, `semantic.samples[${index}].id`),
    x: finiteNumber(item.x, `semantic.samples[${index}].x`),
    y: finiteNumber(item.y, `semantic.samples[${index}].y`, 0, mode === 'cdf' ? 1 : 1_000_000),
    label: compact(item.label, 20, context, `semantic.samples[${index}].label`) || undefined,
  }))
  uniqueIds(samples, 'semantic.samples')
  samples.sort((left, right) => left.x - right.x)
  const highlightedRange = source.highlightedRange === undefined ? undefined : point(source.highlightedRange, 'semantic.highlightedRange')
  if (highlightedRange && highlightedRange[0] > highlightedRange[1]) throw new Error('visual_spec_probability_range_invalid')
  return { type: 'probability', mode: mode as ProbabilitySemantic['mode'], xLabel: text(source.xLabel, 'semantic.xLabel', 20, context), yLabel: text(source.yLabel, 'semantic.yLabel', 20, context), samples, highlightedRange }
}

function parseTransformation(value: unknown, context: ParseContext): TransformationSemantic {
  const source = record(value, 'semantic')
  const space = String(source.space)
  if (!['number_line', 'cartesian', 'vector'].includes(space)) throw new Error('visual_spec_transformation_space_invalid')
  const objects = records(source.objects, 'semantic.objects', 1, 12).map((item, index) => ({
    id: id(item.id, `semantic.objects[${index}].id`),
    label: text(item.label, `semantic.objects[${index}].label`, 28, context),
    points: points(item.points, `semantic.objects[${index}].points`, 1, 24),
  }))
  uniqueIds(objects, 'semantic.objects')
  const objectIds = new Set(objects.map(item => item.id))
  const transforms = optionalRecords(source.transforms, 'semantic.transforms', 12).map((item, index) => {
    const kind = String(item.kind)
    if (!['translate', 'rotate', 'scale', 'reflect', 'linear'].includes(kind)) throw new Error(`visual_spec_transform_kind_invalid:semantic.transforms[${index}]`)
    const beforeId = id(item.beforeId, `semantic.transforms[${index}].beforeId`)
    const afterId = id(item.afterId, `semantic.transforms[${index}].afterId`)
    assertReferences([beforeId, afterId], objectIds, `semantic.transforms[${index}]`)
    return { id: id(item.id, `semantic.transforms[${index}].id`), label: text(item.label, `semantic.transforms[${index}].label`, 32, context), beforeId, afterId, kind: kind as TransformationSemantic['transforms'][number]['kind'] }
  })
  uniqueIds(transforms, 'semantic.transforms')
  const parameters = optionalRecords(source.parameters, 'semantic.parameters', 12).map((item, index) => ({ id: id(item.id, `semantic.parameters[${index}].id`), label: text(item.label, `semantic.parameters[${index}].label`, 24, context), value: finiteNumber(item.value, `semantic.parameters[${index}].value`) }))
  uniqueIds(parameters, 'semantic.parameters')
  return { type: 'transformation', space: space as TransformationSemantic['space'], objects, transforms, parameters }
}

function parseDerivation(value: unknown, context: ParseContext): DerivationSemantic {
  const source = record(value, 'semantic')
  const steps = records(source.steps, 'semantic.steps', 1, 8).map((item, index) => {
    const relation = String(item.relation)
    if (!['equals', 'implies', 'approximately', 'definition'].includes(relation)) throw new Error(`visual_spec_derivation_relation_invalid:semantic.steps[${index}]`)
    const expression = text(item.expression, `semantic.steps[${index}].expression`, 120, context)
    if (FORBIDDEN_EXECUTABLE.test(expression)) throw new Error(`visual_spec_executable_content_rejected:semantic.steps[${index}].expression`)
    return {
      id: id(item.id, `semantic.steps[${index}].id`),
      expression,
      relation: relation as DerivationSemantic['steps'][number]['relation'],
      reason: text(item.reason, `semantic.steps[${index}].reason`, 80, context, true),
      changedTerms: item.changedTerms === undefined
        ? []
        : boundedArray(item.changedTerms, `semantic.steps[${index}].changedTerms`, 0, 8).map((term, termIndex) => text(term, `semantic.steps[${index}].changedTerms[${termIndex}]`, 32, context)),
    }
  })
  uniqueIds(steps, 'semantic.steps')
  return { type: 'derivation', steps }
}

function parseMathStructure(value: unknown, context: ParseContext): MathStructureSemantic {
  const source = record(value, 'semantic')
  const terms = records(source.terms, 'semantic.terms', 1, MAX_ENTITIES).map((item, index) => ({ id: id(item.id, `semantic.terms[${index}].id`), label: text(item.label, `semantic.terms[${index}].label`, 32, context), detail: compact(item.detail, 56, context, `semantic.terms[${index}].detail`) || undefined }))
  uniqueIds(terms, 'semantic.terms')
  const termIds = new Set(terms.map(item => item.id))
  const relations = optionalRecords(source.relations, 'semantic.relations', MAX_RELATIONS).map((item, index) => {
    const output = { id: id(item.id, `semantic.relations[${index}].id`), from: id(item.from, `semantic.relations[${index}].from`), to: id(item.to, `semantic.relations[${index}].to`), label: compact(item.label, 32, context, `semantic.relations[${index}].label`) || undefined }
    assertReferences([output.from, output.to], termIds, `semantic.relations[${index}]`)
    return output
  })
  uniqueIds(relations, 'semantic.relations')
  return { type: 'math_structure', terms, relations }
}

function parseMatrixOperation(value: unknown, context: ParseContext): MatrixOperationSemantic {
  const source = record(value, 'semantic')
  if (source.operation !== 'multiply') throw new Error('visual_spec_matrix_operation_invalid')
  const parseOperand = (valueToRead: unknown, path: string) => {
    const operand = record(valueToRead, path)
    return {
      id: id(operand.id, `${path}.id`),
      label: text(operand.label, `${path}.label`, 20, context),
      values: numericMatrix(operand.values, `${path}.values`),
    }
  }
  const semanticId = id(source.id, 'semantic.id')
  const left = parseOperand(source.left, 'semantic.left')
  const right = parseOperand(source.right, 'semantic.right')
  const resultId = id(source.resultId, 'semantic.resultId')
  uniqueIds([{ id: semanticId }, left, right, { id: resultId }], 'semantic.matrix_operation')
  const focusSource = source.focus === undefined ? undefined : record(source.focus, 'semantic.focus')
  const focus = focusSource ? {
    row: integer(focusSource.row, 'semantic.focus.row', 0, 7),
    column: integer(focusSource.column, 'semantic.focus.column', 0, 7),
  } : undefined
  return {
    type: 'matrix_operation', id: semanticId, operation: 'multiply', left, right, resultId, focus,
    transferPrompt: compact(source.transferPrompt, 120, context, 'semantic.transferPrompt') || undefined,
  }
}

function parseGraphAlgorithm(value: unknown, context: ParseContext): GraphAlgorithmSemantic {
  const source = record(value, 'semantic')
  if (source.algorithm !== 'dijkstra') throw new Error('visual_spec_graph_algorithm_invalid')
  if (typeof source.directed !== 'boolean') throw new Error('visual_spec_boolean_required:semantic.directed')
  const directed = source.directed
  const semanticId = id(source.id, 'semantic.id')
  const nodes = records(source.nodes, 'semantic.nodes', 2, 8).map((node, index) => ({
    id: id(node.id, `semantic.nodes[${index}].id`),
    label: text(node.label, `semantic.nodes[${index}].label`, 18, context),
  }))
  uniqueIds(nodes, 'semantic.nodes')
  const nodeIds = new Set(nodes.map(node => node.id))
  const edges = records(source.edges, 'semantic.edges', 1, 24).map((edge, index) => {
    const output = {
      id: id(edge.id, `semantic.edges[${index}].id`),
      from: id(edge.from, `semantic.edges[${index}].from`),
      to: id(edge.to, `semantic.edges[${index}].to`),
      weight: finiteNumber(edge.weight, `semantic.edges[${index}].weight`, 0, 1_000_000),
    }
    assertReferences([output.from, output.to], nodeIds, `semantic.edges[${index}]`)
    if (output.from === output.to) throw new Error(`visual_spec_graph_self_loop_unsupported:${output.id}`)
    return output
  })
  uniqueIds(edges, 'semantic.edges')
  const edgePairs = new Set<string>()
  for (const edge of edges) {
    const endpoints = directed ? [edge.from, edge.to] : [edge.from, edge.to].sort()
    const pair = `${endpoints[0]}\u0000${endpoints[1]}`
    if (edgePairs.has(pair)) throw new Error(`visual_spec_graph_parallel_edge_unsupported:${edge.from}.${edge.to}`)
    edgePairs.add(pair)
  }
  const sourceId = id(source.sourceId, 'semantic.sourceId')
  const targetId = id(source.targetId, 'semantic.targetId')
  assertReferences([sourceId, targetId], nodeIds, 'semantic.graph_endpoints')
  uniqueIds([{ id: semanticId }, ...nodes, ...edges], 'semantic.graph_algorithm')
  return {
    type: 'graph_algorithm', id: semanticId, algorithm: 'dijkstra', directed,
    nodes, edges, sourceId, targetId,
    transferPrompt: compact(source.transferPrompt, 120, context, 'semantic.transferPrompt') || undefined,
  }
}

function parseNaturalFrequency(value: unknown, context: ParseContext): NaturalFrequencySemantic {
  const source = record(value, 'semantic')
  return {
    type: 'natural_frequency',
    id: id(source.id, 'semantic.id'),
    population: integer(source.population, 'semantic.population', 1, 1_000_000),
    prevalence: finiteNumber(source.prevalence, 'semantic.prevalence', 0, 1),
    sensitivity: finiteNumber(source.sensitivity, 'semantic.sensitivity', 0, 1),
    specificity: finiteNumber(source.specificity, 'semantic.specificity', 0, 1),
    conditionLabel: text(source.conditionLabel, 'semantic.conditionLabel', 24, context),
    positiveLabel: text(source.positiveLabel, 'semantic.positiveLabel', 24, context),
    predictionPrompt: compact(source.predictionPrompt, 140, context, 'semantic.predictionPrompt') || undefined,
  }
}

function parseEventLoop(value: unknown, context: ParseContext): EventLoopSemantic {
  const source = record(value, 'semantic')
  if (source.language !== 'javascript') throw new Error('visual_spec_event_loop_language_invalid')
  const semanticId = id(source.id, 'semantic.id')
  const lines = records(source.lines, 'semantic.lines', 1, 16).map((line, index) => ({
    id: id(line.id, `semantic.lines[${index}].id`),
    number: integer(line.number, `semantic.lines[${index}].number`, 1, 9999),
    text: text(line.text, `semantic.lines[${index}].text`, 120, context),
  }))
  uniqueIds(lines, 'semantic.lines')
  const lineIds = new Set(lines.map(line => line.id))
  const operations = records(source.operations, 'semantic.operations', 1, 16).map((operation, index) => {
    const kind = String(operation.kind)
    if (!['sync', 'microtask', 'task'].includes(kind)) throw new Error(`visual_spec_event_operation_invalid:semantic.operations[${index}]`)
    const output = {
      id: id(operation.id, `semantic.operations[${index}].id`),
      lineId: id(operation.lineId, `semantic.operations[${index}].lineId`),
      kind: kind as EventLoopSemantic['operations'][number]['kind'],
      output: text(operation.output, `semantic.operations[${index}].output`, 32, context),
      order: integer(operation.order, `semantic.operations[${index}].order`, 1, 99),
      label: text(operation.label, `semantic.operations[${index}].label`, 42, context),
    }
    assertReferences([output.lineId], lineIds, `semantic.operations[${index}]`)
    return output
  })
  uniqueIds(operations, 'semantic.operations')
  if (new Set(operations.map(operation => operation.order)).size !== operations.length) throw new Error('visual_spec_duplicate_event_operation_order')
  uniqueIds([{ id: semanticId }, ...lines, ...operations], 'semantic.event_loop')
  return { type: 'event_loop', id: semanticId, language: 'javascript', lines, operations }
}

function parseOptimization(value: unknown, context: ParseContext): OptimizationSemantic {
  const source = record(value, 'semantic')
  if (source.objective !== 'squared_distance') throw new Error('visual_spec_optimization_objective_invalid')
  const axes = record(source.axes, 'semantic.axes')
  const xDomain = point(axes.xDomain, 'semantic.axes.xDomain')
  const yDomain = point(axes.yDomain, 'semantic.axes.yDomain')
  if (xDomain[0] >= xDomain[1] || yDomain[0] >= yDomain[1]) throw new Error('visual_spec_axis_domain_invalid')
  return {
    type: 'optimization', id: id(source.id, 'semantic.id'), objective: 'squared_distance',
    center: finiteNumber(source.center, 'semantic.center'),
    initialX: finiteNumber(source.initialX, 'semantic.initialX'),
    learningRate: finiteNumber(source.learningRate, 'semantic.learningRate', 0.000001, 0.999999),
    iterations: integer(source.iterations, 'semantic.iterations', 1, 5),
    axes: {
      xLabel: text(axes.xLabel, 'semantic.axes.xLabel', 20, context),
      yLabel: text(axes.yLabel, 'semantic.axes.yLabel', 20, context),
      xDomain,
      yDomain,
    },
  }
}

function parseSemantic(domain: LearningVisualDomain, abstraction: LearningVisualAbstraction, value: unknown, context: ParseContext): ComputerVisualSemantic | MathematicsVisualSemantic {
  if (domain === 'computer') {
    if (abstraction === 'protocol_sequence') return parseProtocol(value, context)
    if (abstraction === 'state_machine') return parseStateMachine(value, context)
    if (abstraction === 'data_structure') return parseDataStructure(value, context)
    if (abstraction === 'code_trace') return parseCodeTrace(value, context)
    if (abstraction === 'tensor_shape_flow') return parseTensor(value, context)
    if (abstraction === 'convolution_trace') return parseConvolution(value, context)
    if (abstraction === 'graph_algorithm') return parseGraphAlgorithm(value, context)
    if (abstraction === 'event_loop') return parseEventLoop(value, context)
    if (abstraction === 'semantic_scene') return parseSemanticScene(value, context)
    if (abstraction === 'system_structure') return parseStructure(value, context)
  } else {
    if (abstraction === 'function') return parseFunction(value, context)
    if (abstraction === 'probability') return parseProbability(value, context)
    if (abstraction === 'transformation') return parseTransformation(value, context)
    if (abstraction === 'derivation') return parseDerivation(value, context)
    if (abstraction === 'matrix_operation') return parseMatrixOperation(value, context)
    if (abstraction === 'natural_frequency') return parseNaturalFrequency(value, context)
    if (abstraction === 'optimization') return parseOptimization(value, context)
    if (abstraction === 'math_structure') return parseMathStructure(value, context)
  }
  throw new Error(`visual_spec_domain_abstraction_mismatch:${domain}.${abstraction}`)
}

export function entityIdsForSemantic(semantic: ComputerVisualSemantic | MathematicsVisualSemantic) {
  const output = new Set<string>()
  const add = (items: Array<{ id: string }> | undefined) => items?.forEach(item => output.add(item.id))
  switch (semantic.type) {
    case 'protocol_sequence': add(semantic.participants); add(semantic.messages); break
    case 'state_machine': add(semantic.states); add(semantic.transitions); break
    case 'data_structure': add(semantic.items); add(semantic.links); add(semantic.pointers); break
    case 'code_trace': add(semantic.lines); add(semantic.variables); add(semantic.stackFrames); break
    case 'tensor_shape_flow': add(semantic.tensors); add(semantic.operations); break
    case 'convolution_trace': add([{ id: semantic.id }, semantic.input, semantic.kernel, { id: semantic.outputId }]); break
    case 'graph_algorithm': add([{ id: semantic.id }]); add(semantic.nodes); add(semantic.edges); break
    case 'event_loop': add([{ id: semantic.id }]); add(semantic.lines); add(semantic.operations); break
    case 'semantic_scene': add(semantic.entities); add(semantic.relations); add(semantic.groups); break
    case 'system_structure': add(semantic.entities); add(semantic.relations); break
    case 'function': add(semantic.series); add(semantic.parameters); break
    case 'probability': add(semantic.samples); break
    case 'transformation': add(semantic.objects); add(semantic.transforms); add(semantic.parameters); break
    case 'derivation': add(semantic.steps); break
    case 'matrix_operation': add([{ id: semantic.id }, semantic.left, semantic.right, { id: semantic.resultId }]); break
    case 'natural_frequency': add([{ id: semantic.id }]); break
    case 'optimization': add([{ id: semantic.id }]); break
    case 'math_structure': add(semantic.terms); add(semantic.relations); break
  }
  return output
}

function parseMap<T>(value: unknown, path: string, references: Set<string>, parseValue: (value: unknown, path: string) => T): Record<string, T> {
  if (value === undefined) return {}
  const source = record(value, path)
  if (Object.keys(source).length > MAX_ENTITIES) throw new Error(`visual_spec_object_too_large:${path}`)
  return Object.fromEntries(Object.entries(source).map(([key, item]) => {
    const targetId = id(key, `${path}.${key}`)
    assertReferences([targetId], references, path)
    return [targetId, parseValue(item, `${path}.${key}`)]
  }))
}

function parseState(value: unknown, path: string, references: Set<string>, context: ParseContext): VisualStateSnapshot {
  const source = record(value, path)
  const activeIds = source.activeIds === undefined ? [] : ids(source.activeIds, `${path}.activeIds`)
  assertReferences(activeIds, references, `${path}.activeIds`)
  const currentStateId = source.currentStateId === undefined ? undefined : id(source.currentStateId, `${path}.currentStateId`)
  const activeLineId = source.activeLineId === undefined ? undefined : id(source.activeLineId, `${path}.activeLineId`)
  if (currentStateId) assertReferences([currentStateId], references, `${path}.currentStateId`)
  if (activeLineId) assertReferences([activeLineId], references, `${path}.activeLineId`)
  const pointers = parseMap(source.pointers, `${path}.pointers`, references, (item, itemPath) => {
    if (item === null) return null
    const targetId = id(item, itemPath)
    assertReferences([targetId], references, itemPath)
    return targetId
  })
  const stack = source.stack === undefined ? [] : ids(source.stack, `${path}.stack`, 12)
  const emittedMessageIds = source.emittedMessageIds === undefined ? [] : ids(source.emittedMessageIds, `${path}.emittedMessageIds`, 16)
  assertReferences(stack, references, `${path}.stack`)
  assertReferences(emittedMessageIds, references, `${path}.emittedMessageIds`)
  const visibleIds = source.visibleIds === undefined ? undefined : ids(source.visibleIds, `${path}.visibleIds`, 64)
  const focusIds = source.focusIds === undefined ? undefined : ids(source.focusIds, `${path}.focusIds`, 24)
  const groupMembers = source.groupMembers === undefined ? undefined : Object.fromEntries(Object.entries(record(source.groupMembers, `${path}.groupMembers`)).map(([key, value]) => [id(key, `${path}.groupMembers.${key}`), ids(value, `${path}.groupMembers.${key}`, 32)]))
  const orders = source.orders === undefined ? undefined : Object.fromEntries(Object.entries(record(source.orders, `${path}.orders`)).map(([key, value]) => [id(key, `${path}.orders.${key}`), ids(value, `${path}.orders.${key}`, 32)]))
  const properties = source.properties === undefined ? undefined : Object.fromEntries(Object.entries(record(source.properties, `${path}.properties`)).map(([key, value]) => [id(key, `${path}.properties.${key}`), Object.fromEntries(Object.entries(record(value, `${path}.properties.${key}`)).slice(0, 8).map(([propertyKey, propertyValue]) => [id(propertyKey, `${path}.properties.${key}.${propertyKey}`), scalar(propertyValue, `${path}.properties.${key}.${propertyKey}`, context)]))]))
  if (visibleIds) assertReferences(visibleIds, references, `${path}.visibleIds`)
  if (focusIds) assertReferences(focusIds, references, `${path}.focusIds`)
  Object.entries(groupMembers || {}).forEach(([groupId, members]) => {
    assertReferences([groupId], references, `${path}.groupMembers`)
    assertReferences(members, references, `${path}.groupMembers.${groupId}`)
  })
  Object.entries(orders || {}).forEach(([groupId, members]) => {
    assertReferences([groupId], references, `${path}.orders`)
    assertReferences(members, references, `${path}.orders.${groupId}`)
  })
  Object.keys(properties || {}).forEach(targetId => assertReferences([targetId], references, `${path}.properties`))
  return {
    activeIds,
    currentStateId,
    activeLineId,
    values: parseMap(source.values, `${path}.values`, references, (item, itemPath) => scalar(item, itemPath, context)),
    pointers,
    positions: parseMap(source.positions, `${path}.positions`, references, point),
    tensorShapes: parseMap(source.tensorShapes, `${path}.tensorShapes`, references, shape),
    expressions: parseMap(source.expressions, `${path}.expressions`, references, (item, itemPath) => {
      const expression = text(item, itemPath, 120, context)
      if (FORBIDDEN_EXECUTABLE.test(expression)) throw new Error(`visual_spec_executable_content_rejected:${itemPath}`)
      return expression
    }),
    series: parseMap(source.series, `${path}.series`, references, (item, itemPath) => points(item, itemPath, 1, MAX_POINTS)),
    stack,
    emittedMessageIds,
    visibleIds,
    focusIds,
    groupMembers,
    orders,
    properties,
  }
}

function assertPatchMatchesSemantic(
  patch: VisualPatch,
  semantic: ComputerVisualSemantic | MathematicsVisualSemantic,
  path: string,
) {
  const targetInvalid = (target: string) => { throw new Error(`visual_spec_patch_target_invalid:${path}.${target}`) }
  const notAllowed = () => { throw new Error(`visual_spec_patch_not_allowed:${semantic.type}.${patch.type}`) }
  const has = (items: Array<{ id: string }>, target: string) => items.some(item => item.id === target)

  if (semantic.type === 'protocol_sequence') {
    if (patch.type !== 'send_message') return notAllowed()
    if (!has(semantic.messages, patch.messageId)) targetInvalid(patch.messageId)
    return
  }
  if (semantic.type === 'state_machine') {
    if (patch.type !== 'transition_state') return notAllowed()
    const transition = semantic.transitions.find(item => item.id === patch.transitionId)
    if (!transition || transition.from !== patch.fromStateId || transition.to !== patch.toStateId) targetInvalid(patch.transitionId)
    return
  }
  if (semantic.type === 'data_structure') {
    if (patch.type === 'move_item') {
      if (!has(semantic.items, patch.itemId)) targetInvalid(patch.itemId)
      return
    }
    if (patch.type === 'set_pointer') {
      if (!has(semantic.pointers, patch.pointerId)) targetInvalid(patch.pointerId)
      if (patch.targetId && !has(semantic.items, patch.targetId)) targetInvalid(patch.targetId)
      return
    }
    return notAllowed()
  }
  if (semantic.type === 'code_trace') {
    if (patch.type === 'set_active_line' && has(semantic.lines, patch.lineId)) return
    if (patch.type === 'set_variable' && has(semantic.variables, patch.variableId)) return
    if ((patch.type === 'push_stack' || patch.type === 'pop_stack') && has(semantic.stackFrames, patch.frameId)) return
    if (patch.type === 'set_active_line' || patch.type === 'set_variable' || patch.type === 'push_stack' || patch.type === 'pop_stack') {
      return targetInvalid(patchTargetsForValidation(patch)[0])
    }
    return notAllowed()
  }
  if (semantic.type === 'tensor_shape_flow') {
    if (patch.type !== 'set_tensor_shape') return notAllowed()
    if (!has(semantic.tensors, patch.tensorId)) targetInvalid(patch.tensorId)
    return
  }
  if (isDerivedSemantic(semantic)) {
    if (patch.type !== 'set_trace_step') return notAllowed()
    if (patch.semanticId !== semantic.id) targetInvalid(patch.semanticId)
    if (patch.step < 0 || patch.step >= derivedTraceLength(semantic)) throw new Error(`visual_spec_trace_step_invalid:${path}.${patch.step}`)
    return
  }
  if (semantic.type === 'system_structure') {
    if (patch.type !== 'move_item') return notAllowed()
    if (!has(semantic.entities, patch.itemId)) targetInvalid(patch.itemId)
    return
  }
  if (semantic.type === 'semantic_scene') {
    const entityIds = new Set(semantic.entities.map(item => item.id))
    const relationIds = new Set(semantic.relations.map(item => item.id))
    const groupIds = new Set(semantic.groups.map(item => item.id))
    if (patch.type === 'set_visibility') {
      if (!entityIds.has(patch.targetId) && !relationIds.has(patch.targetId)) targetInvalid(patch.targetId)
      return
    }
    if (patch.type === 'set_focus') {
      patch.targetIds.forEach(target => {
        if (!entityIds.has(target) && !relationIds.has(target) && !groupIds.has(target)) targetInvalid(target)
      })
      return
    }
    if (patch.type === 'set_property') {
      if (!entityIds.has(patch.targetId) && !groupIds.has(patch.targetId)) targetInvalid(patch.targetId)
      return
    }
    if (patch.type === 'set_group_members' || patch.type === 'set_order') {
      if (!groupIds.has(patch.groupId)) targetInvalid(patch.groupId)
      const itemIds = patch.type === 'set_order' ? patch.itemIds : patch.memberIds
      itemIds.forEach(target => { if (!entityIds.has(target)) targetInvalid(target) })
      return
    }
    return notAllowed()
  }
  if (semantic.type === 'function') {
    if (patch.type === 'set_parameter') {
      if (!has(semantic.parameters, patch.parameterId)) targetInvalid(patch.parameterId)
      return
    }
    if (patch.type === 'replace_series') {
      if (!has(semantic.series, patch.seriesId)) targetInvalid(patch.seriesId)
      for (const [x, y] of patch.points) {
        if (x < semantic.axes.xDomain[0] || x > semantic.axes.xDomain[1] || y < semantic.axes.yDomain[0] || y > semantic.axes.yDomain[1]) {
          throw new Error(`visual_spec_point_outside_domain:${path}.points`)
        }
      }
      return
    }
    return notAllowed()
  }
  if (semantic.type === 'probability') {
    if (patch.type !== 'set_probability_sample') return notAllowed()
    if (!has(semantic.samples, patch.sampleId)) targetInvalid(patch.sampleId)
    if ((semantic.mode === 'pmf' || semantic.mode === 'cdf') && patch.y > 1) throw new Error(`visual_spec_probability_value_invalid:${path}.y`)
    return
  }
  if (semantic.type === 'transformation') {
    if (patch.type === 'set_parameter') {
      if (!has(semantic.parameters, patch.parameterId)) targetInvalid(patch.parameterId)
      return
    }
    if (patch.type === 'transform_object') {
      if (!has(semantic.objects, patch.objectId)) targetInvalid(patch.objectId)
      return
    }
    return notAllowed()
  }
  if (semantic.type === 'derivation') {
    if (patch.type !== 'replace_expression') return notAllowed()
    if (!has(semantic.steps, patch.stepId)) targetInvalid(patch.stepId)
    return
  }
  if (semantic.type === 'math_structure') {
    if (patch.type !== 'move_item') return notAllowed()
    if (!has(semantic.terms, patch.itemId)) targetInvalid(patch.itemId)
  }
}

function patchTargetsForValidation(patch: VisualPatch) {
  if (patch.type === 'set_active_line') return [patch.lineId]
  if (patch.type === 'set_variable') return [patch.variableId]
  if (patch.type === 'push_stack' || patch.type === 'pop_stack') return [patch.frameId]
  return []
}

function parsePatch(
  value: unknown,
  path: string,
  references: Set<string>,
  semantic: ComputerVisualSemantic | MathematicsVisualSemantic,
  context: ParseContext,
): VisualPatch {
  const source = record(value, path)
  const type = String(source.type)
  const ref = (valueToRead: unknown, field: string) => {
    const targetId = id(valueToRead, `${path}.${field}`)
    assertReferences([targetId], references, `${path}.${field}`)
    return targetId
  }
  let patch: VisualPatch | undefined
  if (type === 'send_message') patch = { type, messageId: ref(source.messageId, 'messageId') }
  else if (type === 'transition_state') patch = { type, transitionId: ref(source.transitionId, 'transitionId'), fromStateId: ref(source.fromStateId, 'fromStateId'), toStateId: ref(source.toStateId, 'toStateId') }
  else if (type === 'move_item') patch = { type, itemId: ref(source.itemId, 'itemId'), to: point(source.to, `${path}.to`) }
  else if (type === 'set_pointer') patch = { type, pointerId: ref(source.pointerId, 'pointerId'), targetId: source.targetId === null ? null : ref(source.targetId, 'targetId') }
  else if (type === 'set_active_line') patch = { type, lineId: ref(source.lineId, 'lineId') }
  else if (type === 'set_variable') patch = { type, variableId: ref(source.variableId, 'variableId'), value: scalar(source.value, `${path}.value`, context) }
  else if (type === 'push_stack' || type === 'pop_stack') patch = { type, frameId: ref(source.frameId, 'frameId') }
  else if (type === 'set_tensor_shape') patch = { type, tensorId: ref(source.tensorId, 'tensorId'), shape: shape(source.shape, `${path}.shape`) }
  else if (type === 'set_parameter') patch = { type, parameterId: ref(source.parameterId, 'parameterId'), value: finiteNumber(source.value, `${path}.value`) }
  else if (type === 'set_probability_sample') patch = { type, sampleId: ref(source.sampleId, 'sampleId'), y: finiteNumber(source.y, `${path}.y`, 0, 1_000_000) }
  else if (type === 'replace_series') patch = { type, seriesId: ref(source.seriesId, 'seriesId'), points: points(source.points, `${path}.points`, 2, MAX_POINTS) }
  else if (type === 'transform_object') patch = { type, objectId: ref(source.objectId, 'objectId'), points: points(source.points, `${path}.points`, 1, 24) }
  else if (type === 'set_trace_step') patch = { type, semanticId: ref(source.semanticId, 'semanticId'), step: integer(source.step, `${path}.step`, 0, 32) }
  else if (type === 'set_visibility') patch = { type, targetId: ref(source.targetId, 'targetId'), visible: source.visible === true }
  else if (type === 'set_focus') patch = { type, targetIds: ids(source.targetIds, `${path}.targetIds`, 16) }
  else if (type === 'set_property') patch = { type, targetId: ref(source.targetId, 'targetId'), key: id(source.key, `${path}.key`), value: scalar(source.value, `${path}.value`, context) }
  else if (type === 'set_group_members') patch = { type, groupId: ref(source.groupId, 'groupId'), memberIds: ids(source.memberIds, `${path}.memberIds`, 32) }
  else if (type === 'set_order') patch = { type, groupId: ref(source.groupId, 'groupId'), itemIds: ids(source.itemIds, `${path}.itemIds`, 32) }
  if (type === 'replace_expression') {
    const expression = text(source.expression, `${path}.expression`, 120, context)
    if (FORBIDDEN_EXECUTABLE.test(expression)) throw new Error(`visual_spec_executable_content_rejected:${path}.expression`)
    patch = { type, stepId: ref(source.stepId, 'stepId'), expression }
  }
  if (!patch) throw new Error(`visual_spec_patch_type_invalid:${path}.${type}`)
  assertPatchMatchesSemantic(patch, semantic, path)
  return patch
}

function parsePrediction(value: unknown, path: string, context: ParseContext): VisualPredictionGate | undefined {
  if (value === undefined) return undefined
  const source = record(value, path)
  const choices = records(source.choices, `${path}.choices`, 2, 4).map((choice, index) => ({
    id: id(choice.id, `${path}.choices[${index}].id`),
    label: text(choice.label, `${path}.choices[${index}].label`, 80, context),
  }))
  uniqueIds(choices, `${path}.choices`)
  if (new Set(choices.map(choice => choice.label)).size !== choices.length) throw new Error(`visual_spec_prediction_choices_not_distinct:${path}`)
  const correctChoiceId = id(source.correctChoiceId, `${path}.correctChoiceId`)
  if (!choices.some(choice => choice.id === correctChoiceId)) throw new Error(`visual_spec_prediction_answer_invalid:${path}`)
  return {
    id: id(source.id, `${path}.id`),
    prompt: text(source.prompt, `${path}.prompt`, 180, context),
    choices,
    correctChoiceId,
    explanation: text(source.explanation, `${path}.explanation`, 220, context),
  }
}

function parseFrames(value: unknown, references: Set<string>, semantic: ComputerVisualSemantic | MathematicsVisualSemantic, context: ParseContext): LearningVisualFrame[] {
  const output = records(value, 'frames', 1, MAX_FRAMES).map((item, index) => {
    const prediction = parsePrediction(item.prediction, `frames[${index}].prediction`, context)
    const rawPatches = records(item.patches, `frames[${index}].patches`, prediction ? 0 : 1, MAX_PATCHES_PER_FRAME)
    if (prediction && rawPatches.length) throw new Error(`visual_spec_prediction_frame_must_not_patch:frames[${index}]`)
    return {
      id: id(item.id, `frames[${index}].id`),
      title: text(item.title, `frames[${index}].title`, 64, context),
      narration: text(item.narration, `frames[${index}].narration`, 220, context),
      durationMs: integer(item.durationMs ?? 1500, `frames[${index}].durationMs`, 250, 10_000),
      patches: rawPatches.map((patch, patchIndex) => parsePatch(patch, `frames[${index}].patches[${patchIndex}]`, references, semantic, context)),
      prediction,
    }
  })
  uniqueIds(output, 'frames')
  const gateIds = output.flatMap(frame => frame.prediction ? [{ id: frame.prediction.id }] : [])
  uniqueIds(gateIds, 'frames.prediction')
  output.forEach((frame, index) => {
    if (frame.prediction && !output[index + 1]?.patches.length) {
      throw new Error(`visual_spec_prediction_without_reveal:frames[${index}]`)
    }
  })
  return output
}

function parseInvariants(value: unknown, references: Set<string>, context: ParseContext): VisualInvariant[] {
  return records(value, 'invariants', 1, 12).map((item, index) => {
    const type = String(item.type)
    const ref = (valueToRead: unknown, field: string) => {
      const targetId = id(valueToRead, `invariants[${index}].${field}`)
      assertReferences([targetId], references, `invariants[${index}].${field}`)
      return targetId
    }
    if (type === 'references_resolve' || type === 'cdf_monotonic') return { type }
    if (type === 'final_state_active') return { type, targetId: ref(item.targetId, 'targetId') }
    if (type === 'final_state_value') return { type, targetId: ref(item.targetId, 'targetId'), equals: scalar(item.equals, `invariants[${index}].equals`, context) }
    if (type === 'tensor_shape') return { type, tensorId: ref(item.tensorId, 'tensorId'), shape: shape(item.shape, `invariants[${index}].shape`) }
    if (type === 'probability_bounds') return { type, seriesId: item.seriesId === undefined ? undefined : ref(item.seriesId, 'seriesId') }
    throw new Error(`visual_spec_invariant_type_invalid:invariants[${index}].${type}`)
  })
}

function readingOrder(semantic: ComputerVisualSemantic | MathematicsVisualSemantic) {
  switch (semantic.type) {
    case 'protocol_sequence': return [...semantic.participants.map(item => item.id), ...semantic.messages.map(item => item.id)]
    case 'state_machine': return [...semantic.states.map(item => item.id), ...semantic.transitions.map(item => item.id)]
    case 'data_structure': return [...semantic.items.map(item => item.id), ...semantic.pointers.map(item => item.id)]
    case 'code_trace': return [...semantic.lines.map(item => item.id), ...semantic.variables.map(item => item.id), ...semantic.stackFrames.map(item => item.id)]
    case 'tensor_shape_flow': return [...semantic.tensors.map(item => item.id), ...semantic.operations.map(item => item.id)]
    case 'convolution_trace': return [semantic.id, semantic.input.id, semantic.kernel.id, semantic.outputId]
    case 'graph_algorithm': return [semantic.id, ...semantic.nodes.map(item => item.id), ...semantic.edges.map(item => item.id)]
    case 'event_loop': return [semantic.id, ...semantic.lines.map(item => item.id), ...semantic.operations.map(item => item.id)]
    case 'semantic_scene': return [...semantic.entities.map(item => item.id), ...semantic.relations.map(item => item.id), ...semantic.groups.map(item => item.id)]
    case 'system_structure': return semantic.entities.map(item => item.id)
    case 'function': return [...semantic.series.map(item => item.id), ...semantic.parameters.map(item => item.id)]
    case 'probability': return semantic.samples.map(item => item.id)
    case 'transformation': return [...semantic.objects.map(item => item.id), ...semantic.transforms.map(item => item.id)]
    case 'derivation': return semantic.steps.map(item => item.id)
    case 'matrix_operation': return [semantic.id, semantic.left.id, semantic.right.id, semantic.resultId]
    case 'natural_frequency': return [semantic.id]
    case 'optimization': return [semantic.id]
    case 'math_structure': return semantic.terms.map(item => item.id)
  }
}

function parseAccessibility(value: unknown, title: string, semantic: ComputerVisualSemantic | MathematicsVisualSemantic, context: ParseContext): VisualAccessibility {
  const source = value === undefined ? {} : record(value, 'accessibility')
  const references = entityIdsForSemantic(semantic)
  const requestedOrder = source.readingOrder === undefined
    ? readingOrder(semantic)
    : ids(source.readingOrder, 'accessibility.readingOrder', Math.max(MAX_ENTITIES, references.size))
  assertReferences(requestedOrder, references, 'accessibility.readingOrder')
  if (source.summary === undefined) context.repairs.push({ code: 'accessibility_summary_defaulted', path: 'accessibility.summary', detail: 'derived_from_title' })
  return {
    summary: compact(source.summary, 220, context, 'accessibility.summary') || `${title}：按文字顺序阅读视觉对象与状态变化。`,
    readingOrder: requestedOrder,
    nonColorStateCue: compact(source.nonColorStateCue, 160, context, 'accessibility.nonColorStateCue') || '当前状态同时使用“当前”文字、步骤标题和帧说明表示，不只依赖颜色。',
  }
}

export function generationReport(source: VisualGenerationReport['source'], plannerSucceeded: boolean, repairs: VisualRepair[], modelError?: string, degradedTo?: VisualGenerationReport['degradedTo']): VisualGenerationReport {
  return { source, plannerSucceeded, degraded: !plannerSucceeded || Boolean(degradedTo), degradedTo, modelError, repairs }
}

function parseStoredRepairs(value: unknown): VisualRepair[] {
  return optionalRecords(value, 'generation.repairs', 32).map((item, index) => ({
    code: text(item.code, `generation.repairs[${index}].code`, 64, { repairs: [] }),
    path: text(item.path, `generation.repairs[${index}].path`, 120, { repairs: [] }),
    detail: text(item.detail, `generation.repairs[${index}].detail`, 260, { repairs: [] }),
  }))
}

function parseStoredGeneration(value: unknown): VisualGenerationReport {
  const source = record(value, 'generation')
  const origin = String(source.source)
  if (!['model_plan', 'context_compiler', 'deterministic_compiler', 'deterministic_template', 'legacy_reader'].includes(origin)) throw new Error('visual_spec_generation_source_invalid')
  if (typeof source.plannerSucceeded !== 'boolean' || typeof source.degraded !== 'boolean') throw new Error('visual_spec_generation_status_invalid')
  const degradedTo = source.degradedTo === undefined ? undefined : String(source.degradedTo)
  if (degradedTo && !['diagram', 'storyboard', 'deterministic_animation'].includes(degradedTo)) throw new Error('visual_spec_generation_degraded_to_invalid')
  const modelError = source.modelError === undefined ? undefined : compact(source.modelError, 260)
  const compilerSource = source.compiler === undefined ? undefined : record(source.compiler, 'generation.compiler')
  const compiler = compilerSource ? {
    id: text(compilerSource.id, 'generation.compiler.id', 100, { repairs: [] }),
    version: text(compilerSource.version, 'generation.compiler.version', 40, { repairs: [] }),
  } : undefined
  if (source.plannerSucceeded && (source.degraded || degradedTo || modelError || !['model_plan', 'context_compiler', 'deterministic_compiler'].includes(origin))) throw new Error('visual_spec_generation_success_claim_invalid')
  if (origin === 'deterministic_compiler' && !compiler) throw new Error('visual_spec_generation_compiler_required')
  if (origin === 'deterministic_compiler' && compiler
    && (compiler.id !== TEACHING_COMPILER_ID || compiler.version !== TEACHING_COMPILER_VERSION)) {
    throw new Error('visual_spec_generation_compiler_version_invalid')
  }
  if (origin !== 'deterministic_compiler' && compiler) throw new Error('visual_spec_generation_compiler_mismatch')
  if (!source.plannerSucceeded && !source.degraded) throw new Error('visual_spec_generation_failure_claim_invalid')
  if (!source.degraded && degradedTo) throw new Error('visual_spec_generation_degradation_invalid')
  return {
    source: origin as VisualGenerationReport['source'],
    plannerSucceeded: source.plannerSucceeded,
    degraded: source.degraded,
    degradedTo: degradedTo as VisualGenerationReport['degradedTo'],
    modelError,
    compiler,
    repairs: parseStoredRepairs(source.repairs),
  }
}

function parseStoredProvenance(value: unknown, version: 'current' | 'legacy_v2' = 'current'): VisualProvenance {
  const source = record(value, 'provenance')
  const expected = version === 'legacy_v2'
    ? { schema: LEGACY_V2_VERSION, prompt: LEGACY_V2_PROMPT_VERSION, renderer: LEGACY_V2_RENDERER_VERSION }
    : { schema: VISUAL_VERSION, prompt: PROMPT_VERSION, renderer: RENDERER_VERSION }
  if (source.schemaVersion !== expected.schema || source.promptVersion !== expected.prompt || source.rendererVersion !== expected.renderer) {
    throw new Error('visual_spec_provenance_version_invalid')
  }
  const requestText = version === 'legacy_v2'
    ? compact(source.requestText, 2200)
    : provenanceRequestText(source.requestText)
  const requestHash = String(source.requestHash || '')
  if (requestHash !== hashText(requestText)) throw new Error('visual_spec_provenance_hash_mismatch')
  return { schemaVersion: VISUAL_VERSION, promptVersion: PROMPT_VERSION, rendererVersion: RENDERER_VERSION, requestHash, requestText }
}

/**
 * A deterministic teaching animation is a replay of one compiler-owned trace,
 * not a model-authored list of arbitrary trace indexes. Keep the accepted
 * timeline bijective with trace steps so no persisted plan can skip, repeat or
 * move backwards while still claiming derived verification.
 */
export function assertDeterministicTraceTimeline(spec: LearningVisualSpec) {
  if (spec.kind !== 'animation' || spec.generation.source !== 'deterministic_compiler' || !isDerivedSemantic(spec.semantic)) return

  const semanticId = spec.semantic.id
  const lastStep = derivedTraceLength(spec.semantic) - 1
  if (spec.initialState.values[semanticId] !== 0) {
    throw new Error(`visual_spec_trace_initial_step_invalid:${semanticId}`)
  }

  let expectedStep = 1
  for (const [frameIndex, frame] of spec.frames.entries()) {
    if (frame.prediction) {
      if (frame.patches.length) throw new Error(`visual_spec_prediction_frame_must_not_patch:${frame.id}`)
      const reveal = spec.frames[frameIndex + 1]
      const revealPatch = reveal?.patches[0]
      if (!reveal || reveal.prediction || reveal.patches.length !== 1 || revealPatch?.type !== 'set_trace_step' || revealPatch.semanticId !== semanticId) {
        throw new Error(`visual_spec_prediction_without_adjacent_trace_reveal:${frame.id}`)
      }
      if (revealPatch.step !== expectedStep) {
        throw new Error(`visual_spec_trace_sequence_invalid:${reveal.id}:expected_${expectedStep}:received_${revealPatch.step}`)
      }
      continue
    }

    const patch = frame.patches[0]
    if (frame.patches.length !== 1 || patch?.type !== 'set_trace_step' || patch.semanticId !== semanticId) {
      throw new Error(`visual_spec_trace_frame_invalid:${frame.id}`)
    }
    if (patch.step !== expectedStep) {
      throw new Error(`visual_spec_trace_sequence_invalid:${frame.id}:expected_${expectedStep}:received_${patch.step}`)
    }
    expectedStep += 1
  }

  if (expectedStep - 1 !== lastStep) {
    throw new Error(`visual_spec_trace_incomplete:${semanticId}:expected_${lastStep}:received_${expectedStep - 1}`)
  }
  if (spec.finalState.values[semanticId] !== lastStep) {
    throw new Error(`visual_spec_trace_final_step_invalid:${semanticId}`)
  }
}

function compilerOwnedProjection(spec: LearningVisualSpec) {
  const common = {
    version: spec.version,
    kind: spec.kind,
    domain: spec.domain,
    abstraction: spec.abstraction,
    title: spec.title,
    subtitle: spec.subtitle,
    explanation: spec.explanation,
    semantic: spec.semantic,
    accessibility: spec.accessibility,
  }
  return spec.kind === 'diagram'
    ? { ...common, state: spec.state }
    : {
        ...common,
        initialState: spec.initialState,
        frames: spec.frames,
        invariants: spec.invariants,
        finalState: spec.finalState,
      }
}

function assertDeterministicCompilerReproducible(spec: LearningVisualSpec) {
  if (spec.generation.source !== 'deterministic_compiler') return
  let canonical: LearningVisualSpec | undefined
  try {
    const derivation = deriveTeachingRequest(spec.kind, spec.provenance.requestText)
    canonical = derivation ? teachingDerivationToSpec(derivation) : undefined
  } catch {
    canonical = undefined
  }
  if (!canonical) throw new Error('visual_spec_deterministic_compiler_claim_unreproducible')
  if (!equivalent(compilerOwnedProjection(spec), compilerOwnedProjection(canonical))) {
    throw new Error('visual_spec_deterministic_compiler_claim_mismatch')
  }
}

type ParseSpecOptions = { preserveMetadata?: boolean; initialRepairs?: VisualRepair[] }

export function parseV2Spec(payload: Record<string, unknown>, requestedKind: LearningVisualKind, request: string, options: ParseSpecOptions = {}): LearningVisualSpec {
  if (payload.version !== undefined && payload.version !== VISUAL_VERSION) throw new Error(`visual_spec_version_unsupported:${String(payload.version)}`)
  if (payload.kind !== undefined && payload.kind !== requestedKind) throw new Error(`visual_spec_kind_mismatch:${String(payload.kind)}`)
  const context: ParseContext = { repairs: [...(options.initialRepairs || [])] }
  const storedGeneration = options.preserveMetadata && payload.generation !== undefined ? parseStoredGeneration(payload.generation) : undefined
  if (storedGeneration) context.repairs.push(...storedGeneration.repairs)
  if (options.preserveMetadata && payload.version === undefined) throw new Error('visual_spec_version_required')
  if (options.preserveMetadata && payload.kind === undefined) throw new Error('visual_spec_kind_required')
  if (!options.preserveMetadata && payload.version === undefined) context.repairs.push({ code: 'schema_version_defaulted', path: 'version', detail: VISUAL_VERSION })
  if (!options.preserveMetadata && payload.kind === undefined) context.repairs.push({ code: 'visual_kind_defaulted', path: 'kind', detail: requestedKind })
  if (payload.domain !== 'computer' && payload.domain !== 'mathematics') throw new Error('visual_spec_domain_required')
  if (typeof payload.abstraction !== 'string' || !payload.abstraction) throw new Error('visual_spec_abstraction_required')
  const domain = payload.domain
  const abstraction = payload.abstraction as LearningVisualAbstraction
  const semantic = parseSemantic(domain, abstraction, payload.semantic, context)
  if (semantic.type !== abstraction) throw new Error(`visual_spec_semantic_discriminator_mismatch:${abstraction}.${semantic.type}`)
  const title = compact(payload.title, 100, context, 'title') || compact(request, 72) || '学习视觉'
  const common = {
    version: VISUAL_VERSION,
    title,
    subtitle: compact(payload.subtitle, 180, context, 'subtitle'),
    explanation: compact(payload.explanation, 1800, context, 'explanation'),
    domain,
    abstraction,
    semantic,
    accessibility: parseAccessibility(payload.accessibility, title, semantic, context),
    provenance: options.preserveMetadata && payload.provenance !== undefined ? parseStoredProvenance(payload.provenance) : provenance(request),
    generation: storedGeneration ? { ...storedGeneration, repairs: context.repairs } : generationReport('model_plan', true, context.repairs),
  }
  const references = entityIdsForSemantic(semantic)
  if (requestedKind === 'diagram') {
    if (payload.frames !== undefined || payload.initialState !== undefined || payload.finalState !== undefined || payload.invariants !== undefined) {
      throw new Error('visual_spec_diagram_timeline_forbidden')
    }
    const spec = { ...common, kind: 'diagram', state: parseState(payload.state, 'state', references, context) } as LearningVisualSpec
    assertDeterministicTraceTimeline(spec)
    return spec
  }
  if (payload.state !== undefined) throw new Error('visual_spec_animation_stable_state_forbidden')
  const frames = parseFrames(payload.frames, references, semantic, context)
  const spec = {
    ...common,
    kind: 'animation',
    initialState: parseState(payload.initialState, 'initialState', references, context),
    frames,
    invariants: parseInvariants(payload.invariants, references, context),
    finalState: parseState(payload.finalState, 'finalState', references, context),
  } as LearningVisualSpec
  if (frames.some(frame => frame.prediction) && spec.generation.source !== 'deterministic_compiler') {
    throw new Error('visual_spec_prediction_requires_verified_compiler')
  }
  assertDeterministicTraceTimeline(spec)
  return spec
}

export function parseLegacySpec(payload: Record<string, unknown>, requestedKind: LearningVisualKind, request: string, options: ParseSpecOptions = {}): LegacyLearningVisualSpec {
  const storedGeneration = options.preserveMetadata && payload.generation !== undefined ? parseStoredGeneration(payload.generation) : undefined
  const context: ParseContext = { repairs: storedGeneration
    ? [...storedGeneration.repairs]
    : [{ code: 'legacy_visual_v1_read', path: 'version', detail: 'preserved_without_semantic_inference' }] }
  const nodes = records(payload.nodes, 'nodes', 1, MAX_ENTITIES).map((node, index) => {
    const role = String(node.role || 'concept')
    const shapeValue = String(node.shape || 'card')
    if (!['input', 'process', 'state', 'output', 'concept', 'formula'].includes(role)) throw new Error(`legacy_visual_role_invalid:nodes[${index}]`)
    if (!['card', 'circle', 'capsule'].includes(shapeValue)) throw new Error(`legacy_visual_shape_invalid:nodes[${index}]`)
    return {
      id: id(node.id, `nodes[${index}].id`),
      label: text(node.label, `nodes[${index}].label`, 32, context),
      detail: compact(node.detail, 56, context, `nodes[${index}].detail`) || undefined,
      role: role as LegacyLearningVisualNode['role'],
      shape: shapeValue as LegacyLearningVisualNode['shape'],
      column: integer(node.column ?? index, `nodes[${index}].column`, 0, 31),
      lane: integer(node.lane ?? 0, `nodes[${index}].lane`, 0, 15),
    }
  })
  uniqueIds(nodes, 'nodes')
  const nodeIds = new Set(nodes.map(item => item.id))
  const relations = optionalRecords(payload.relations, 'relations', MAX_RELATIONS).map((relation, index) => {
    const kind = String(relation.kind || 'flow')
    if (!['flow', 'dependency', 'transition', 'comparison', 'mapping'].includes(kind)) throw new Error(`legacy_visual_relation_kind_invalid:relations[${index}]`)
    const output = { id: id(relation.id, `relations[${index}].id`), from: id(relation.from, `relations[${index}].from`), to: id(relation.to, `relations[${index}].to`), label: compact(relation.label, 32, context, `relations[${index}].label`) || undefined, kind: kind as LegacyLearningVisualRelation['kind'] }
    assertReferences([output.from, output.to], nodeIds, `relations[${index}]`)
    return output
  })
  uniqueIds(relations, 'relations')
  const relationIds = new Set(relations.map(item => item.id))
  const frames = optionalRecords(payload.frames, 'frames', 16).map((frame, index) => {
    const activeNodeIds = frame.activeNodeIds === undefined ? [] : ids(frame.activeNodeIds, `frames[${index}].activeNodeIds`)
    const activeRelationIds = frame.activeRelationIds === undefined ? [] : ids(frame.activeRelationIds, `frames[${index}].activeRelationIds`)
    assertReferences(activeNodeIds, nodeIds, `frames[${index}].activeNodeIds`)
    assertReferences(activeRelationIds, relationIds, `frames[${index}].activeRelationIds`)
    return { id: id(frame.id, `frames[${index}].id`), title: text(frame.title, `frames[${index}].title`, 64, context), narration: text(frame.narration, `frames[${index}].narration`, 220, context, true), activeNodeIds, activeRelationIds } as LegacyLearningVisualFrame
  })
  const rawKind = String(payload.kind || requestedKind)
  const kind = rawKind === 'animation' ? 'animation' : 'diagram'
  const rawDomain = String(payload.domain || 'general')
  const domain = rawDomain === 'computer' || rawDomain === 'mathematics' ? rawDomain : 'general'
  return {
    version: 'learnflow.visual.v1',
    title: compact(payload.title, 100, context, 'title') || compact(request, 72) || '旧版学习视觉',
    subtitle: compact(payload.subtitle, 180, context, 'subtitle'),
    domain,
    abstraction: compact(payload.abstraction, 48) || 'legacy_graph',
    kind,
    nodes,
    relations,
    frames,
    explanation: compact(payload.explanation, 1800, context, 'explanation'),
    provenance: options.preserveMetadata && payload.provenance !== undefined
      ? parseStoredProvenance(
        payload.provenance,
        isRecord(payload.provenance) && payload.provenance.schemaVersion === LEGACY_V2_VERSION ? 'legacy_v2' : 'current',
      )
      : provenance(request),
    generation: storedGeneration
      ? { ...storedGeneration, repairs: context.repairs }
      : generationReport('legacy_reader', false, context.repairs, kind === 'animation' ? 'legacy_highlight_only_animation' : 'legacy_visual_v1', kind === 'animation' ? 'storyboard' : 'diagram'),
  }
}

function assertLegacyV2Payload(payload: Record<string, unknown>) {
  if (payload.version !== LEGACY_V2_VERSION) throw new Error(`visual_spec_version_unsupported:${String(payload.version)}`)
  if (payload.domain !== 'computer' && payload.domain !== 'mathematics') throw new Error('visual_spec_domain_required')
  const abstraction = String(payload.abstraction || '')
  if (!LEGACY_V2_ABSTRACTIONS[payload.domain].has(abstraction)) {
    throw new Error(`visual_spec_v2_abstraction_unsupported:${payload.domain}.${abstraction}`)
  }

  if (payload.generation !== undefined) {
    const generation = record(payload.generation, 'generation')
    if (generation.source === 'deterministic_compiler' || generation.compiler !== undefined) {
      throw new Error('visual_spec_v2_generation_source_invalid')
    }
  }

  for (const [frameIndex, frame] of optionalRecords(payload.frames, 'frames', MAX_FRAMES).entries()) {
    if (frame.prediction !== undefined) throw new Error(`visual_spec_v2_prediction_unsupported:frames[${frameIndex}]`)
    for (const [patchIndex, patch] of optionalRecords(frame.patches, `frames[${frameIndex}].patches`, MAX_PATCHES_PER_FRAME).entries()) {
      const patchType = String(patch.type || '')
      if (!LEGACY_V2_PATCH_TYPES.has(patchType)) {
        throw new Error(`visual_spec_v2_patch_unsupported:frames[${frameIndex}].patches[${patchIndex}].${patchType}`)
      }
    }
  }
}

function migrateLegacyV2Spec(
  payload: Record<string, unknown>,
  requestedKind: LearningVisualKind,
  request: string,
): LearningVisualSpec {
  assertLegacyV2Payload(payload)
  const storedProvenance = payload.provenance === undefined
    ? provenance(request)
    : parseStoredProvenance(payload.provenance, 'legacy_v2')
  const migrationRepair: VisualRepair = {
    code: 'schema_migrated_v2_to_v3',
    path: 'version',
    detail: payload.provenance === undefined
      ? 'legacy_v2_schema_validated_and_missing_provenance_regenerated'
      : 'legacy_v2_schema_and_provenance_tuple_validated',
  }
  return parseV2Spec(
    { ...payload, version: VISUAL_VERSION, provenance: storedProvenance },
    requestedKind,
    request,
    { preserveMetadata: true, initialRepairs: [migrationRepair] },
  )
}

export function readLearningVisualSpec(value: unknown, requestedKind: LearningVisualKind = 'diagram', request = ''): ReadableLearningVisualSpec {
  const payload = record(value, 'root')
  if (payload.version !== undefined
    && payload.version !== LEGACY_V1_VERSION
    && payload.version !== LEGACY_V2_VERSION
    && payload.version !== VISUAL_VERSION) {
    throw new Error(`visual_spec_version_unsupported:${String(payload.version)}`)
  }
  if (payload.version === LEGACY_V2_VERSION) return migrateLegacyV2Spec(payload, requestedKind, request)
  if (payload.version === VISUAL_VERSION) {
    const spec = parseV2Spec(payload, requestedKind, request, { preserveMetadata: true })
    assertDeterministicCompilerReproducible(spec)
    return spec
  }
  if ((payload.version === LEGACY_V1_VERSION || payload.version === undefined) && payload.nodes !== undefined) {
    return parseLegacySpec(payload, requestedKind, request, { preserveMetadata: true })
  }
  if (payload.semantic !== undefined) throw new Error('visual_spec_version_required')
  throw new Error('visual_spec_reader_unsupported')
}

export function legacyToSafeDiagram(legacy: LegacyLearningVisualSpec, request: string, modelError: string): LearningVisualSpec {
  const common = {
    version: VISUAL_VERSION,
    title: legacy.title,
    subtitle: legacy.subtitle,
    explanation: legacy.explanation,
    state: emptyState(),
    provenance: provenance(request),
    generation: generationReport('legacy_reader', false, [...legacy.generation.repairs, { code: 'legacy_animation_degraded', path: 'frames', detail: 'highlight_only_frames_cannot_claim_state_change' }], modelError, 'diagram'),
  }
  if (legacy.domain === 'mathematics') {
    const semantic: MathStructureSemantic = { type: 'math_structure', terms: legacy.nodes.map(node => ({ id: node.id, label: node.label, detail: node.detail })), relations: legacy.relations.map(relation => ({ id: relation.id, from: relation.from, to: relation.to, label: relation.label })) }
    return { ...common, kind: 'diagram', domain: 'mathematics', abstraction: 'math_structure', semantic, accessibility: { summary: `${legacy.title}：旧版视觉已按静态关系安全呈现。`, readingOrder: semantic.terms.map(item => item.id), nonColorStateCue: '旧版高亮不被视为状态变化，当前内容已降级为静态图解。' } }
  }
  const semantic: SystemStructureSemantic = { type: 'system_structure', entities: legacy.nodes.map(node => ({ id: node.id, label: node.label, detail: node.detail, role: node.role === 'formula' ? 'concept' : node.role })), relations: legacy.relations }
  return { ...common, kind: 'diagram', domain: 'computer', abstraction: 'system_structure', semantic, accessibility: { summary: `${legacy.title}：旧版视觉已按静态关系安全呈现。`, readingOrder: semantic.entities.map(item => item.id), nonColorStateCue: '旧版高亮不被视为状态变化，当前内容已降级为静态图解。' } }
}

function tcpAnimation(request: string, modelError: string): LearningVisualSpec {
  const semantic: ProtocolSequenceSemantic = {
    type: 'protocol_sequence',
    participants: [{ id: 'client', label: '客户端', role: '主动打开' }, { id: 'server', label: '服务端', role: '监听端' }],
    messages: [
      { id: 'syn', from: 'client', to: 'server', label: 'SYN', order: 1, phase: '发起同步' },
      { id: 'syn_ack', from: 'server', to: 'client', label: 'SYN + ACK', order: 2, phase: '确认并同步' },
      { id: 'ack', from: 'client', to: 'server', label: 'ACK', order: 3, phase: '最终确认' },
    ],
  }
  const initialState = emptyState()
  const frames: LearningVisualFrame[] = semantic.messages.map((message, index) => ({ id: `frame_${index + 1}`, title: `第 ${index + 1} 步：${message.label}`, narration: `${semantic.participants.find(item => item.id === message.from)?.label}发送 ${message.label}，${message.phase}。`, durationMs: 1500, patches: [{ type: 'send_message', messageId: message.id }] }))
  const finalState = cloneState(initialState)
  finalState.emittedMessageIds = semantic.messages.map(item => item.id)
  finalState.activeIds = ['ack']
  return {
    version: VISUAL_VERSION,
    kind: 'animation',
    title: 'TCP 三次握手',
    subtitle: '逐条消息确认双方的收发能力',
    domain: 'computer',
    abstraction: 'protocol_sequence',
    semantic,
    initialState,
    frames,
    invariants: [{ type: 'references_resolve' }, { type: 'final_state_active', targetId: 'ack' }],
    finalState,
    explanation: '先查看初始状态，再逐帧核对消息方向、顺序与文字状态。',
    accessibility: { summary: '客户端与服务端通过 SYN、SYN 加 ACK、ACK 三条有序消息建立连接。', readingOrder: ['client', 'server', 'syn', 'syn_ack', 'ack'], nonColorStateCue: '当前消息同时显示序号、方向、消息名和“当前步骤”文字。' },
    provenance: provenance(request),
    generation: generationReport('deterministic_template', false, [{ code: 'model_plan_rejected', path: 'root', detail: modelError }], modelError, 'deterministic_animation'),
  }
}

function federatedLearningDiagram(request: string, modelError: string): LearningVisualSpec {
  const semantic: SystemStructureSemantic = {
    type: 'system_structure',
    entities: [
      { id: 'local_data', label: '本地数据', detail: '原始数据保留在各参与方本地', role: 'input' },
      { id: 'local_training', label: '本地训练', detail: '各参与方使用本地数据更新模型', role: 'process' },
      { id: 'model_updates', label: '模型更新', detail: '仅上传模型参数更新或梯度', role: 'output' },
      { id: 'aggregation', label: '聚合服务', detail: '聚合多个参与方的模型更新', role: 'process' },
      { id: 'global_model', label: '全局模型', detail: '聚合后的模型进入下一轮训练', role: 'output' },
    ],
    relations: [
      { id: 'data_to_training', from: 'local_data', to: 'local_training', label: '留在本地使用', kind: 'flow' },
      { id: 'training_to_updates', from: 'local_training', to: 'model_updates', label: '产生更新', kind: 'flow' },
      { id: 'updates_to_aggregation', from: 'model_updates', to: 'aggregation', label: '上传更新', kind: 'flow' },
      { id: 'aggregation_to_global', from: 'aggregation', to: 'global_model', label: '合并', kind: 'flow' },
      { id: 'global_to_training', from: 'global_model', to: 'local_training', label: '下发下一轮', kind: 'flow' },
    ],
  }
  return {
    version: VISUAL_VERSION,
    kind: 'diagram',
    title: '联邦学习的一轮协作',
    subtitle: '数据留在本地，模型更新参与聚合',
    domain: 'computer',
    abstraction: 'system_structure',
    semantic,
    state: emptyState(),
    explanation: '沿箭头读取一轮训练；回环表示聚合后的全局模型会再次下发，而不是上传原始数据。',
    accessibility: {
      summary: '本地数据用于本地训练，参与方上传模型更新，聚合服务形成全局模型并下发下一轮；原始数据不离开本地。',
      readingOrder: ['local_data', 'local_training', 'model_updates', 'aggregation', 'global_model'],
      nonColorStateCue: '每条边同时标注动作文字，数据边界由“留在本地使用”明确说明。',
    },
    provenance: provenance(request),
    generation: generationReport('deterministic_template', false, [{ code: 'model_plan_rejected', path: 'root', detail: modelError }], modelError, 'diagram'),
  }
}

function federatedLearningAnimation(request: string, modelError: string): LearningVisualSpec {
  const semantic: ProtocolSequenceSemantic = {
    type: 'protocol_sequence',
    participants: [
      { id: 'coordinator', label: '聚合服务', role: '协调与聚合' },
      { id: 'client_a', label: '参与方 A', role: '本地训练' },
      { id: 'client_b', label: '参与方 B', role: '本地训练' },
    ],
    messages: [
      { id: 'dispatch_a', from: 'coordinator', to: 'client_a', label: '下发当前全局模型', order: 1, phase: '开始一轮' },
      { id: 'dispatch_b', from: 'coordinator', to: 'client_b', label: '下发当前全局模型', order: 2, phase: '开始一轮' },
      { id: 'update_a', from: 'client_a', to: 'coordinator', label: '上传模型更新', order: 3, phase: '本地训练完成' },
      { id: 'update_b', from: 'client_b', to: 'coordinator', label: '上传模型更新', order: 4, phase: '本地训练完成' },
      { id: 'next_round', from: 'coordinator', to: 'client_a', label: '聚合后进入下一轮', order: 5, phase: '形成新全局模型' },
    ],
  }
  const initialState = emptyState()
  const frames: LearningVisualFrame[] = semantic.messages.map((message, index) => ({
    id: `frame_${index + 1}`,
    title: `第 ${index + 1} 步：${message.phase}`,
    narration: `${semantic.participants.find(item => item.id === message.from)?.label}向${semantic.participants.find(item => item.id === message.to)?.label}${message.label}。原始数据始终不随消息发送。`,
    durationMs: 1500,
    patches: [{ type: 'send_message', messageId: message.id }],
  }))
  const finalState = cloneState(initialState)
  finalState.emittedMessageIds = semantic.messages.map(item => item.id)
  finalState.activeIds = ['next_round']
  return {
    version: VISUAL_VERSION,
    kind: 'animation',
    title: '联邦学习的一轮训练',
    subtitle: '逐步查看模型下发、本地训练更新与聚合',
    domain: 'computer',
    abstraction: 'protocol_sequence',
    semantic,
    initialState,
    frames,
    invariants: [{ type: 'references_resolve' }, { type: 'final_state_active', targetId: 'next_round' }],
    finalState,
    explanation: '这是简化的一轮协作时序：动画展示模型消息，不表示原始数据被上传。',
    accessibility: {
      summary: '聚合服务下发全局模型，参与方在本地训练并上传模型更新，聚合后开始下一轮；原始数据不离开参与方。',
      readingOrder: ['coordinator', 'client_a', 'client_b', 'dispatch_a', 'dispatch_b', 'update_a', 'update_b', 'next_round'],
      nonColorStateCue: '当前步骤同时显示序号、方向、消息名，并重复说明原始数据未发送。',
    },
    provenance: provenance(request),
    generation: generationReport('deterministic_template', false, [{ code: 'model_plan_rejected', path: 'root', detail: modelError }], modelError, 'deterministic_animation'),
  }
}

export function buildDeterministicFallback(kind: LearningVisualKind, request: string, modelError: string): LearningVisualSpec {
  const tcpHandshake = /(?:tcp[^。；\n]{0,32}三次握手|三次握手[^。；\n]{0,32}tcp|^\s*三次握手\s*$)/i.test(request)
    && !/(?:四次挥手|断开|终止|关闭|拥塞|重传|攻击|防御|teardown|termination|close|congestion)/i.test(request)
  if (kind === 'animation' && tcpHandshake) return tcpAnimation(request, modelError)
  const federatedRound = /(?:联邦学习|federated\s+learning)/i.test(request)
    && /(?:一轮|训练流程|训练过程|模型下发|模型更新|聚合|training\s+round)/i.test(request)
    && !/(?:投毒|攻击|防御|隐私攻击|拜占庭|后门|poison|attack|defen|byzantine|backdoor)/i.test(request)
  if (federatedRound) {
    return kind === 'animation'
      ? federatedLearningAnimation(request, modelError)
      : federatedLearningDiagram(request, modelError)
  }
  throw new Error(`visual_fallback_unavailable:${modelError}`)
}
