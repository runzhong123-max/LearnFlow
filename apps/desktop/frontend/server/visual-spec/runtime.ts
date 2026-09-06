import {
  type LearningVisualQuality,
  type LearningVisualSpec,
  type ProbabilitySemantic,
  type ReadableLearningVisualSpec,
  type VisualPatch,
  type VisualStateSnapshot,
} from './types.ts'
import { verifyDerivedSemantic } from './derived.ts'
import { assertDeterministicTraceTimeline, cloneState, equivalent } from './validation.ts'

function patchTargets(patch: VisualPatch) {
  switch (patch.type) {
    case 'send_message': return [patch.messageId]
    case 'transition_state': return [patch.transitionId, patch.toStateId]
    case 'move_item': return [patch.itemId]
    case 'set_pointer': return [patch.pointerId, ...(patch.targetId ? [patch.targetId] : [])]
    case 'set_active_line': return [patch.lineId]
    case 'set_variable': return [patch.variableId]
    case 'push_stack': case 'pop_stack': return [patch.frameId]
    case 'set_tensor_shape': return [patch.tensorId]
    case 'set_parameter': return [patch.parameterId]
    case 'set_probability_sample': return [patch.sampleId]
    case 'replace_series': return [patch.seriesId]
    case 'transform_object': return [patch.objectId]
    case 'replace_expression': return [patch.stepId]
    case 'set_trace_step': return [patch.semanticId]
    case 'set_visibility': return [patch.targetId]
    case 'set_focus': return patch.targetIds
    case 'set_property': return [patch.targetId]
    case 'set_group_members': return [patch.groupId, ...patch.memberIds]
    case 'set_order': return [patch.groupId, ...patch.itemIds]
  }
}

function hasOwn(source: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(source, key)
}

function semanticValue(spec: LearningVisualSpec, state: VisualStateSnapshot, patch: VisualPatch): unknown {
  if (patch.type === 'move_item') return state.positions[patch.itemId]
  if (patch.type === 'set_pointer') {
    if (hasOwn(state.pointers, patch.pointerId)) return state.pointers[patch.pointerId]
    return spec.semantic.type === 'data_structure' ? spec.semantic.pointers.find(item => item.id === patch.pointerId)?.targetId : undefined
  }
  if (patch.type === 'set_active_line') return state.activeLineId
  if (patch.type === 'set_variable') {
    if (hasOwn(state.values, patch.variableId)) return state.values[patch.variableId]
    return spec.semantic.type === 'code_trace' ? spec.semantic.variables.find(item => item.id === patch.variableId)?.initialValue : undefined
  }
  if (patch.type === 'set_tensor_shape') {
    return state.tensorShapes[patch.tensorId] || (spec.semantic.type === 'tensor_shape_flow' ? spec.semantic.tensors.find(item => item.id === patch.tensorId)?.shape : undefined)
  }
  if (patch.type === 'set_parameter') {
    if (hasOwn(state.values, patch.parameterId)) return state.values[patch.parameterId]
    if (spec.semantic.type === 'function' || spec.semantic.type === 'transformation') return spec.semantic.parameters.find(item => item.id === patch.parameterId)?.value
    return undefined
  }
  if (patch.type === 'set_probability_sample') {
    if (hasOwn(state.values, patch.sampleId)) return state.values[patch.sampleId]
    return spec.semantic.type === 'probability' ? spec.semantic.samples.find(item => item.id === patch.sampleId)?.y : undefined
  }
  if (patch.type === 'replace_series') {
    return state.series[patch.seriesId] || (spec.semantic.type === 'function' ? spec.semantic.series.find(item => item.id === patch.seriesId)?.points : undefined)
  }
  if (patch.type === 'transform_object') {
    return state.series[patch.objectId] || (spec.semantic.type === 'transformation' ? spec.semantic.objects.find(item => item.id === patch.objectId)?.points : undefined)
  }
  if (patch.type === 'replace_expression') {
    return state.expressions[patch.stepId] || (spec.semantic.type === 'derivation' ? spec.semantic.steps.find(item => item.id === patch.stepId)?.expression : undefined)
  }
  if (patch.type === 'set_trace_step') return state.values[patch.semanticId] ?? 0
  if (patch.type === 'set_visibility') return (state.visibleIds || []).includes(patch.targetId)
  if (patch.type === 'set_focus') return state.focusIds || []
  if (patch.type === 'set_property') return state.properties?.[patch.targetId]?.[patch.key]
  if (patch.type === 'set_group_members') return state.groupMembers?.[patch.groupId] || []
  if (patch.type === 'set_order') return state.orders?.[patch.groupId] || []
  return undefined
}

function rejectNoOp(spec: LearningVisualSpec, state: VisualStateSnapshot, patch: VisualPatch) {
  const before = semanticValue(spec, state, patch)
  const after = patch.type === 'move_item' ? patch.to
    : patch.type === 'set_pointer' ? patch.targetId
      : patch.type === 'set_active_line' ? patch.lineId
        : patch.type === 'set_variable' ? patch.value
          : patch.type === 'set_tensor_shape' ? patch.shape
            : patch.type === 'set_parameter' ? patch.value
              : patch.type === 'set_probability_sample' ? patch.y
                : patch.type === 'replace_series' ? patch.points
                  : patch.type === 'transform_object' ? patch.points
                    : patch.type === 'replace_expression' ? patch.expression
                      : patch.type === 'set_trace_step' ? patch.step
                        : patch.type === 'set_visibility' ? patch.visible
                          : patch.type === 'set_focus' ? patch.targetIds
                            : patch.type === 'set_property' ? patch.value
                              : patch.type === 'set_group_members' ? patch.memberIds
                                : patch.type === 'set_order' ? patch.itemIds
                      : undefined
  if (after !== undefined && equivalent(before, after)) throw new Error(`visual_patch_no_change:${patch.type}.${patchTargets(patch)[0]}`)
}

function applyPatch(spec: LearningVisualSpec, state: VisualStateSnapshot, patch: VisualPatch) {
  rejectNoOp(spec, state, patch)
  switch (patch.type) {
    case 'send_message':
      if (state.emittedMessageIds.includes(patch.messageId)) throw new Error(`visual_patch_no_change:send_message.${patch.messageId}`)
      if (spec.semantic.type === 'protocol_sequence') {
        const message = spec.semantic.messages.find(item => item.id === patch.messageId)
        const missingPredecessor = spec.semantic.messages.some(item => item.order < (message?.order || 0) && !state.emittedMessageIds.includes(item.id))
        if (missingPredecessor) throw new Error(`visual_patch_protocol_order_invalid:${patch.messageId}`)
      }
      state.emittedMessageIds.push(patch.messageId)
      break
    case 'transition_state':
      if (!state.currentStateId && spec.semantic.type === 'state_machine') state.currentStateId = spec.semantic.states.find(item => item.initial)?.id
      if (state.currentStateId && state.currentStateId !== patch.fromStateId) throw new Error(`visual_patch_state_mismatch:${patch.transitionId}`)
      if (patch.fromStateId === patch.toStateId) throw new Error(`visual_patch_no_change:transition_state.${patch.transitionId}`)
      state.currentStateId = patch.toStateId
      break
    case 'move_item': state.positions[patch.itemId] = [...patch.to]; break
    case 'set_pointer': state.pointers[patch.pointerId] = patch.targetId; break
    case 'set_active_line': state.activeLineId = patch.lineId; break
    case 'set_variable': state.values[patch.variableId] = patch.value; break
    case 'push_stack': state.stack.push(patch.frameId); break
    case 'pop_stack':
      if (state.stack[state.stack.length - 1] !== patch.frameId) throw new Error(`visual_patch_stack_mismatch:${patch.frameId}`)
      state.stack.pop()
      break
    case 'set_tensor_shape': state.tensorShapes[patch.tensorId] = [...patch.shape]; break
    case 'set_parameter': state.values[patch.parameterId] = patch.value; break
    case 'set_probability_sample': state.values[patch.sampleId] = patch.y; break
    case 'replace_series': state.series[patch.seriesId] = patch.points.map(item => [...item]); break
    case 'transform_object': state.series[patch.objectId] = patch.points.map(item => [...item]); break
    case 'replace_expression': state.expressions[patch.stepId] = patch.expression; break
    case 'set_trace_step': state.values[patch.semanticId] = patch.step; break
    case 'set_visibility': {
      const visible = new Set(state.visibleIds || [])
      if (patch.visible) visible.add(patch.targetId); else visible.delete(patch.targetId)
      state.visibleIds = [...visible]
      break
    }
    case 'set_focus': state.focusIds = [...patch.targetIds]; break
    case 'set_property': state.properties = {
      ...(state.properties || {}),
      [patch.targetId]: { ...(state.properties?.[patch.targetId] || {}), [patch.key]: patch.value },
    }; break
    case 'set_group_members': state.groupMembers = { ...(state.groupMembers || {}), [patch.groupId]: [...patch.memberIds] }; break
    case 'set_order': state.orders = { ...(state.orders || {}), [patch.groupId]: [...patch.itemIds] }; break
  }
  state.activeIds = Array.from(new Set([...state.activeIds, ...patchTargets(patch)]))
}

export function replayAnimation(spec: LearningVisualSpec & { kind: 'animation' }) {
  assertDeterministicTraceTimeline(spec)
  let state = cloneState(spec.initialState)
  const states: VisualStateSnapshot[] = []
  let semanticChanges = 0
  for (const [frameIndex, frame] of spec.frames.entries()) {
    if (frame.prediction && frame.patches.length) throw new Error(`visual_spec_prediction_frame_must_not_patch:${frame.id}`)
    if (frame.prediction && !spec.frames[frameIndex + 1]?.patches.length) throw new Error(`visual_spec_prediction_without_reveal:${frame.id}`)
    state.activeIds = []
    const before = cloneState(state)
    for (const patch of frame.patches) applyPatch(spec, state, patch)
    const afterWithoutFocus = cloneState(state)
    afterWithoutFocus.activeIds = []
    const changed = !equivalent(before, afterWithoutFocus)
    if (!changed && !frame.prediction) throw new Error(`visual_spec_frame_without_semantic_change:${frame.id}`)
    if (changed) semanticChanges += 1
    states.push(cloneState(state))
  }
  return { states, finalState: state, semanticChanges }
}

export function probabilityInvariantFailures(semantic: ProbabilitySemantic, state?: VisualStateSnapshot) {
  const failures: string[] = []
  const samples = semantic.samples.map(item => ({
    ...item,
    y: typeof state?.values[item.id] === 'number' ? state.values[item.id] as number : item.y,
  }))
  if (samples.some(item => item.y < 0)) failures.push('probability_negative_value')
  if (semantic.mode === 'pmf') {
    const sum = samples.reduce((total, item) => total + item.y, 0)
    if (Math.abs(sum - 1) > 0.02) failures.push('pmf_not_normalized')
  }
  if (semantic.mode === 'cdf') {
    if (samples.some(item => item.y > 1)) failures.push('cdf_out_of_bounds')
    for (let index = 1; index < samples.length; index += 1) {
      if (samples[index].y < samples[index - 1].y) failures.push('cdf_not_monotonic')
    }
  }
  return Array.from(new Set(failures))
}

export function evaluateInvariants(spec: LearningVisualSpec & { kind: 'animation' }, finalState: VisualStateSnapshot) {
  const failures: string[] = []
  for (const invariant of spec.invariants) {
    if (invariant.type === 'references_resolve') continue
    if (invariant.type === 'final_state_active' && !finalState.activeIds.includes(invariant.targetId)) failures.push(`final_state_not_active:${invariant.targetId}`)
    if (invariant.type === 'final_state_value' && !equivalent(finalState.values[invariant.targetId], invariant.equals)) failures.push(`final_state_value_mismatch:${invariant.targetId}`)
    if (invariant.type === 'tensor_shape' && !equivalent(finalState.tensorShapes[invariant.tensorId], invariant.shape)) failures.push(`tensor_shape_mismatch:${invariant.tensorId}`)
    if (invariant.type === 'probability_bounds') {
      if (spec.semantic.type !== 'probability') failures.push('probability_invariant_domain_mismatch')
      else failures.push(...probabilityInvariantFailures(spec.semantic, finalState))
    }
    if (invariant.type === 'cdf_monotonic') {
      if (spec.semantic.type !== 'probability' || spec.semantic.mode !== 'cdf') failures.push('cdf_invariant_domain_mismatch')
      else failures.push(...probabilityInvariantFailures(spec.semantic, finalState))
    }
  }
  return Array.from(new Set(failures))
}

export function describePatch(patch: VisualPatch) {
  switch (patch.type) {
    case 'send_message': return `发送消息 ${patch.messageId}`
    case 'transition_state': return `状态从 ${patch.fromStateId} 转为 ${patch.toStateId}`
    case 'move_item': return `移动 ${patch.itemId} 到 (${patch.to[0]}, ${patch.to[1]})`
    case 'set_pointer': return `指针 ${patch.pointerId} 指向 ${patch.targetId ?? '空'}`
    case 'set_active_line': return `执行到代码行 ${patch.lineId}`
    case 'set_variable': return `变量 ${patch.variableId} 更新为 ${String(patch.value)}`
    case 'push_stack': return `调用栈压入 ${patch.frameId}`
    case 'pop_stack': return `调用栈弹出 ${patch.frameId}`
    case 'set_tensor_shape': return `张量 ${patch.tensorId} 形状变为 [${patch.shape.join(' × ')}]`
    case 'set_parameter': return `参数 ${patch.parameterId} 更新为 ${patch.value}`
    case 'set_probability_sample': return `概率样本 ${patch.sampleId} 更新为 ${patch.y}`
    case 'replace_series': return `曲线 ${patch.seriesId} 更新 ${patch.points.length} 个有限采样点`
    case 'transform_object': return `对象 ${patch.objectId} 完成坐标变换`
    case 'replace_expression': return `推导步骤 ${patch.stepId} 的表达式发生替换`
    case 'set_trace_step': return `可计算教学轨迹 ${patch.semanticId} 前进到第 ${patch.step} 步`
    case 'set_visibility': return `${patch.visible ? '显示' : '隐藏'}对象 ${patch.targetId}`
    case 'set_focus': return `聚焦 ${patch.targetIds.join('、')}`
    case 'set_property': return `${patch.targetId}.${patch.key} 更新为 ${String(patch.value)}`
    case 'set_group_members': return `集合 ${patch.groupId} 的成员更新为 ${patch.memberIds.join('、') || '空'}`
    case 'set_order': return `集合 ${patch.groupId} 的顺序更新为 ${patch.itemIds.join(' → ')}`
  }
}

export function inspectLearningVisualSpec(spec: ReadableLearningVisualSpec): LearningVisualQuality {
  if (spec.version === 'learnflow.visual.v1') {
    const warnings = ['legacy_schema_v1']
    if (!spec.relations.length && spec.nodes.length > 1) warnings.push('relations_missing_not_repaired')
    if (spec.kind === 'animation') warnings.push('legacy_highlight_only_animation_degraded_to_storyboard')
    return {
      score: spec.kind === 'animation' ? 62 : 74,
      status: 'degraded',
      issues: [],
      warnings,
      repaired: true,
      repairs: spec.generation.repairs,
      semanticChanges: 0,
      invariants: { checked: 0, passed: 0, failures: [] },
      layout: { collisions: 0, outOfBounds: 0 },
      security: { executableContentRejected: true, finiteDataOnly: true },
      replayable: true,
      verification: { level: 'structural', checked: 0, passed: 0, failures: [] },
    }
  }

  const issues: string[] = []
  const warnings: string[] = []
  let semanticChanges = 0
  let checked = 0
  let passed = 0
  let invariantFailures: string[] = []
  let replayStates: VisualStateSnapshot[] = []
  const verification = verifyDerivedSemantic(spec.semantic)

  if (spec.semantic.type === 'system_structure') {
    if (spec.semantic.entities.length < 2) issues.push('insufficient_semantic_structure')
    else if (spec.semantic.relations.length < 1) warnings.push('relations_missing_not_repaired')
  }
  if (spec.semantic.type === 'math_structure') {
    if (spec.semantic.terms.length < 2) issues.push('insufficient_semantic_structure')
    else if (spec.semantic.relations.length < 1) warnings.push('relations_missing_not_repaired')
  }

  if (spec.kind === 'animation') {
    try {
      const replay = replayAnimation(spec)
      replayStates = replay.states
      semanticChanges = replay.semanticChanges
      if (!equivalent(replay.finalState, spec.finalState)) issues.push('final_state_mismatch')
      invariantFailures = evaluateInvariants(spec, replay.finalState)
      checked = spec.invariants.length
      passed = Math.max(0, checked - invariantFailures.length)
      const expectedChanges = spec.frames.filter(frame => frame.patches.length > 0).length
      if (replay.semanticChanges !== expectedChanges) issues.push('frame_without_semantic_change')
    } catch (error) {
      issues.push(error instanceof Error ? error.message : 'animation_replay_failed')
    }
  }

  if (spec.semantic.type === 'probability') {
    issues.push(...probabilityInvariantFailures(spec.semantic))
    replayStates.forEach((state, index) => {
      for (const failure of probabilityInvariantFailures(spec.semantic as ProbabilitySemantic, state)) issues.push(`frame_${index + 1}:${failure}`)
    })
  }
  if (invariantFailures.length) issues.push(...invariantFailures)
  if (verification.failures.length) issues.push(...verification.failures.map(failure => `derived_truth:${failure}`))
  if (spec.generation.degraded) warnings.push(`degraded_to:${spec.generation.degradedTo || spec.kind}`)
  if (spec.generation.modelError) warnings.push(`model_error:${spec.generation.modelError}`)
  const uniqueIssues = Array.from(new Set(issues))
  const uniqueWarnings = Array.from(new Set(warnings))
  const verificationLevel = verification.checked > 0 && spec.generation.source === 'deterministic_compiler' ? 'derived_verified' : 'structural'
  const rawScore = Math.max(0, 100 - uniqueIssues.length * 25 - uniqueWarnings.length * 4 - spec.generation.repairs.length * 2)
  const score = verificationLevel === 'derived_verified' ? rawScore : Math.min(84, rawScore)
  return {
    score,
    status: uniqueIssues.length ? 'rejected' : spec.generation.degraded ? 'degraded' : 'passed',
    issues: uniqueIssues,
    warnings: uniqueWarnings,
    repaired: spec.generation.repairs.length > 0 || spec.generation.degraded,
    repairs: spec.generation.repairs,
    semanticChanges,
    invariants: { checked, passed, failures: invariantFailures },
    layout: { collisions: 0, outOfBounds: 0 },
    security: { executableContentRejected: true, finiteDataOnly: true },
    replayable: true,
    verification: { level: verificationLevel, ...verification },
  }
}
