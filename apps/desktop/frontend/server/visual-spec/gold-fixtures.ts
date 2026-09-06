/**
 * Deterministic, JSON-serializable contract fixtures. They intentionally use
 * finite data only and can be replayed without a model or network.
 */
export const GOLD_VISUAL_FIXTURES: Record<string, Record<string, unknown>> = {
  protocol_sequence: {
    version: 'learnflow.visual.v2', kind: 'animation', title: '请求时序', domain: 'computer', abstraction: 'protocol_sequence',
    semantic: { type: 'protocol_sequence', participants: [{ id: 'client', label: '客户端' }, { id: 'server', label: '服务端' }], messages: [{ id: 'request', from: 'client', to: 'server', label: '请求', order: 1 }] },
    initialState: {},
    frames: [{ id: 'f1', title: '发送请求', narration: '客户端发送请求。', patches: [{ type: 'send_message', messageId: 'request' }] }],
    invariants: [{ type: 'final_state_active', targetId: 'request' }],
    finalState: { activeIds: ['request'], emittedMessageIds: ['request'] },
  },
  state_machine: {
    version: 'learnflow.visual.v2', kind: 'animation', title: '开关状态', domain: 'computer', abstraction: 'state_machine',
    semantic: { type: 'state_machine', states: [{ id: 'off', label: '关闭', initial: true }, { id: 'on', label: '开启' }], transitions: [{ id: 'turn_on', from: 'off', to: 'on', event: '按下开关' }] },
    initialState: { currentStateId: 'off' },
    frames: [{ id: 'f1', title: '打开', narration: '转为开启。', patches: [{ type: 'transition_state', transitionId: 'turn_on', fromStateId: 'off', toStateId: 'on' }] }],
    invariants: [{ type: 'final_state_active', targetId: 'on' }],
    finalState: { activeIds: ['turn_on', 'on'], currentStateId: 'on' },
  },
  data_structure: {
    version: 'learnflow.visual.v2', kind: 'animation', title: '链表头指针', domain: 'computer', abstraction: 'data_structure',
    semantic: { type: 'data_structure', structure: 'linked_list', items: [{ id: 'n1', label: '节点1' }, { id: 'n2', label: '节点2' }], links: [{ id: 'next', from: 'n1', to: 'n2', kind: 'next' }], pointers: [{ id: 'head', label: 'head', targetId: 'n1' }] },
    initialState: { pointers: { head: 'n1' } },
    frames: [{ id: 'f1', title: '移动 head', narration: 'head 指向节点2。', patches: [{ type: 'set_pointer', pointerId: 'head', targetId: 'n2' }] }],
    invariants: [{ type: 'references_resolve' }],
    finalState: { activeIds: ['head', 'n2'], pointers: { head: 'n2' } },
  },
  code_trace: {
    version: 'learnflow.visual.v2', kind: 'animation', title: '代码追踪', domain: 'computer', abstraction: 'code_trace',
    semantic: { type: 'code_trace', language: 'pseudocode', lines: [{ id: 'line1', number: 1, text: 'x ← 0' }, { id: 'line2', number: 2, text: 'x ← 1' }], variables: [{ id: 'x', name: 'x', initialValue: 0 }], stackFrames: [] },
    initialState: { activeLineId: 'line1', values: { x: 0 } },
    frames: [{ id: 'f1', title: '执行第二行', narration: 'x 更新为 1。', patches: [{ type: 'set_active_line', lineId: 'line2' }, { type: 'set_variable', variableId: 'x', value: 1 }] }],
    invariants: [{ type: 'final_state_value', targetId: 'x', equals: 1 }],
    finalState: { activeIds: ['line2', 'x'], activeLineId: 'line2', values: { x: 1 } },
  },
  tensor_shape_flow: {
    version: 'learnflow.visual.v2', kind: 'animation', title: '张量形状', domain: 'computer', abstraction: 'tensor_shape_flow',
    semantic: { type: 'tensor_shape_flow', tensors: [{ id: 'x', label: 'X', shape: [2, 4] }, { id: 'y', label: 'Y', shape: [2, 4] }], operations: [{ id: 'linear', label: '线性映射', inputIds: ['x'], outputIds: ['y'] }] },
    initialState: { tensorShapes: { y: [2, 4] } },
    frames: [{ id: 'f1', title: '输出', narration: '最后一维变为 8。', patches: [{ type: 'set_tensor_shape', tensorId: 'y', shape: [2, 8] }] }],
    invariants: [{ type: 'tensor_shape', tensorId: 'y', shape: [2, 8] }],
    finalState: { activeIds: ['y'], tensorShapes: { y: [2, 8] } },
  },
  function: {
    version: 'learnflow.visual.v2', kind: 'diagram', title: '二次函数', domain: 'mathematics', abstraction: 'function',
    semantic: { type: 'function', axes: { xLabel: 'x', yLabel: 'y', xDomain: [-2, 2], yDomain: [0, 4] }, series: [{ id: 'curve', label: 'y=x²', points: [[-2, 4], [0, 0], [2, 4]] }], parameters: [] },
    state: {},
  },
  probability: {
    version: 'learnflow.visual.v2', kind: 'diagram', title: '伯努利分布', domain: 'mathematics', abstraction: 'probability',
    semantic: { type: 'probability', mode: 'pmf', xLabel: 'x', yLabel: 'P(X=x)', samples: [{ id: 'p0', x: 0, y: 0.4 }, { id: 'p1', x: 1, y: 0.6 }] },
    state: {},
  },
  transformation: {
    version: 'learnflow.visual.v2', kind: 'animation', title: '向量平移', domain: 'mathematics', abstraction: 'transformation',
    semantic: { type: 'transformation', space: 'cartesian', objects: [{ id: 'before', label: '变换前', points: [[0, 0], [1, 0]] }, { id: 'after', label: '变换后', points: [[0, 0], [1, 0]] }], transforms: [{ id: 'shift', label: '平移', beforeId: 'before', afterId: 'after', kind: 'translate' }], parameters: [] },
    initialState: { series: { after: [[0, 0], [1, 0]] } },
    frames: [{ id: 'f1', title: '平移', narration: '端点同时平移。', patches: [{ type: 'transform_object', objectId: 'after', points: [[1, 1], [2, 1]] }] }],
    invariants: [{ type: 'final_state_active', targetId: 'after' }],
    finalState: { activeIds: ['after'], series: { after: [[1, 1], [2, 1]] } },
  },
  derivation: {
    version: 'learnflow.visual.v2', kind: 'animation', title: '交换律', domain: 'mathematics', abstraction: 'derivation',
    semantic: { type: 'derivation', steps: [{ id: 's1', expression: 'a + b', relation: 'definition', reason: '起点', changedTerms: [] }, { id: 's2', expression: 'a + b', relation: 'equals', reason: '交换律', changedTerms: ['a', 'b'] }] },
    initialState: { expressions: { s2: 'a + b' } },
    frames: [{ id: 'f1', title: '交换项', narration: '交换加数位置。', patches: [{ type: 'replace_expression', stepId: 's2', expression: 'b + a' }] }],
    invariants: [{ type: 'final_state_active', targetId: 's2' }],
    finalState: { activeIds: ['s2'], expressions: { s2: 'b + a' } },
  },
}
