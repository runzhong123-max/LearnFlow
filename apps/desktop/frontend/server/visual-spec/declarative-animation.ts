import type { LearningVisualKind, VisualRepair, VisualStateSnapshot } from './types.ts'

type JsonRecord = Record<string, unknown>

const ID = /^[a-z][a-z0-9_]{0,63}$/
const TIMELINE_FIELDS = ['state', 'initialState', 'frames', 'invariants', 'finalState'] as const

function record(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`visual_declarative_record_required:${path}`)
  return value as JsonRecord
}

function array(value: unknown, path: string, minimum: number, maximum: number) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`visual_declarative_array_invalid:${path}`)
  }
  return value
}

function id(value: unknown, path: string) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`visual_declarative_id_invalid:${path}`)
  return value
}

function text(value: unknown, path: string, maximum = 80) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`visual_declarative_text_invalid:${path}`)
  return value.trim()
}

function assertUnique(items: Array<{ id: string }>, path: string) {
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error(`visual_declarative_duplicate_id:${path}`)
}

function emptyState(): VisualStateSnapshot {
  return {
    activeIds: [], values: {}, pointers: {}, positions: {}, tensorShapes: {},
    expressions: {}, series: {}, stack: [], emittedMessageIds: [],
  }
}

function assertTimelineAbsent(payload: JsonRecord) {
  const supplied = TIMELINE_FIELDS.filter(field => payload[field] !== undefined)
  if (supplied.length) throw new Error(`visual_declarative_timeline_forbidden:${supplied.join(',')}`)
}

function compileProtocol(payload: JsonRecord): JsonRecord | undefined {
  if (payload.abstraction !== 'protocol_sequence' || payload.frames !== undefined) return undefined
  assertTimelineAbsent(payload)
  const semantic = record(payload.semantic, 'semantic')
  if (semantic.type !== 'protocol_sequence') throw new Error('visual_declarative_semantic_mismatch:protocol_sequence')
  const messages = array(semantic.messages, 'semantic.messages', 1, 16).map((value, index) => {
    const message = record(value, `semantic.messages[${index}]`)
    const order = Number(message.order)
    if (!Number.isInteger(order) || order < 1 || order > 99) throw new Error(`visual_declarative_order_invalid:semantic.messages[${index}]`)
    return { id: id(message.id, `semantic.messages[${index}].id`), label: text(message.label, `semantic.messages[${index}].label`, 42), order }
  }).sort((left, right) => left.order - right.order)
  assertUnique(messages, 'semantic.messages')
  if (new Set(messages.map(item => item.order)).size !== messages.length) throw new Error('visual_declarative_duplicate_order:semantic.messages')
  const initialState = emptyState()
  const finalState = emptyState()
  finalState.activeIds = [messages[messages.length - 1].id]
  finalState.emittedMessageIds = messages.map(item => item.id)
  return {
    ...payload,
    initialState,
    frames: messages.map((message, index) => ({
      id: `protocol_step_${index + 1}`,
      title: `第 ${index + 1} 步：${message.label}`,
      narration: `${message.label}。时间线由消息顺序确定性生成。`,
      durationMs: 1200,
      patches: [{ type: 'send_message', messageId: message.id }],
    })),
    invariants: [{ type: 'final_state_active', targetId: messages[messages.length - 1].id }],
    finalState,
  }
}

function compileProcessStoryboard(payload: JsonRecord): JsonRecord | undefined {
  if (payload.abstraction !== 'process_storyboard') return undefined
  assertTimelineAbsent(payload)
  const semantic = record(payload.semantic, 'semantic')
  if (semantic.type !== 'process_storyboard') throw new Error('visual_declarative_semantic_mismatch:process_storyboard')
  const stages = array(semantic.stages, 'semantic.stages', 3, 12).map((value, index) => {
    const stage = record(value, `semantic.stages[${index}]`)
    return {
      id: id(stage.id, `semantic.stages[${index}].id`),
      label: text(stage.label, `semantic.stages[${index}].label`, 32),
      initial: stage.initial === true || undefined,
      terminal: stage.terminal === true || undefined,
    }
  })
  assertUnique(stages, 'semantic.stages')
  const initialStages = stages.filter(stage => stage.initial)
  if (initialStages.length !== 1) throw new Error('visual_declarative_exactly_one_initial_stage_required')
  const stageIds = new Set(stages.map(stage => stage.id))
  const transitions = array(semantic.transitions, 'semantic.transitions', 2, 20).map((value, index) => {
    const transition = record(value, `semantic.transitions[${index}]`)
    const output = {
      id: id(transition.id, `semantic.transitions[${index}].id`),
      from: id(transition.from, `semantic.transitions[${index}].from`),
      to: id(transition.to, `semantic.transitions[${index}].to`),
      event: text(transition.event, `semantic.transitions[${index}].event`, 42),
      ...(typeof transition.guard === 'string' && transition.guard.trim() ? { guard: text(transition.guard, `semantic.transitions[${index}].guard`, 48) } : {}),
    }
    if (!stageIds.has(output.from) || !stageIds.has(output.to)) throw new Error(`visual_declarative_transition_reference_invalid:${output.id}`)
    if (output.from === output.to) throw new Error(`visual_declarative_transition_no_change:${output.id}`)
    return output
  })
  assertUnique(transitions, 'semantic.transitions')
  const transitionById = new Map(transitions.map(transition => [transition.id, transition]))
  const path = array(semantic.path, 'semantic.path', 2, 12).map((value, index) => id(value, `semantic.path[${index}]`))
  let currentStateId = initialStages[0].id
  const resolvedPath = path.map((transitionId, index) => {
    const transition = transitionById.get(transitionId)
    if (!transition) throw new Error(`visual_declarative_path_reference_invalid:${transitionId}`)
    if (transition.from !== currentStateId) {
      throw new Error(`visual_declarative_path_discontinuous:${transitionId}:expected_${currentStateId}:received_${transition.from}`)
    }
    currentStateId = transition.to
    return transition
  })
  const initialState = { ...emptyState(), activeIds: [initialStages[0].id], currentStateId: initialStages[0].id }
  const finalTransition = resolvedPath[resolvedPath.length - 1]
  const finalState = { ...emptyState(), activeIds: [finalTransition.id, currentStateId], currentStateId }
  return {
    ...payload,
    abstraction: 'state_machine',
    semantic: { type: 'state_machine', states: stages, transitions },
    initialState,
    frames: resolvedPath.map((transition, index) => ({
      id: `process_step_${index + 1}`,
      title: `第 ${index + 1} 步：${transition.event}`,
      narration: `${transition.event}：${transition.from} → ${transition.to}。`,
      durationMs: 1300,
      patches: [{
        type: 'transition_state', transitionId: transition.id,
        fromStateId: transition.from, toStateId: transition.to,
      }],
    })),
    invariants: [{ type: 'final_state_active', targetId: currentStateId }],
    finalState,
  }
}

export function compileDeclarativeAnimationPlan(
  payload: JsonRecord,
  requestedKind: LearningVisualKind,
): { payload: JsonRecord; repairs: VisualRepair[]; expectedAbstraction?: 'state_machine' } {
  if (requestedKind !== 'animation') return { payload, repairs: [] }
  const process = compileProcessStoryboard(payload)
  if (process) return {
    payload: process,
    repairs: [{
      code: 'declarative_process_timeline_compiled', path: 'frames',
      detail: '模型只声明阶段、转移与连续路径；帧、补丁、初态和终态由代码确定性生成。',
    }],
    expectedAbstraction: 'state_machine',
  }
  const protocol = compileProtocol(payload)
  if (protocol) return {
    payload: protocol,
    repairs: [{
      code: 'declarative_protocol_timeline_compiled', path: 'frames',
      detail: '模型只声明参与者与有序消息；发送帧、初态和终态由代码确定性生成。',
    }],
  }
  return { payload, repairs: [] }
}
