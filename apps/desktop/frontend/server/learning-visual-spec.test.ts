import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  classifyLearningVisual,
  generateLearningVisual,
  inspectLearningVisualSpec,
  readLearningVisualSpec,
  replayAnimation,
  visualSpecToArtifact,
} from './learning-visual-spec.ts'
import { GOLD_VISUAL_FIXTURES } from './visual-spec/gold-fixtures.ts'
import { parseV2Spec } from './visual-spec/validation.ts'
import { executeLearningVisual, resolveVisualRequest } from './visual-tool-execution.ts'
import './visual-spec/gold-teaching.test.ts'
import './visual-spec/teaching-compiler.test.ts'
import './visual-playback.test.ts'

function commonState(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  }
}

async function generatePlan(kind: 'diagram' | 'animation', request: string, payload: Record<string, unknown>) {
  return generateLearningVisual(kind, request, async () => JSON.stringify(payload))
}

function persistedV2From(value: unknown) {
  const payload = JSON.parse(JSON.stringify(value)) as {
    version: string
    provenance: {
      schemaVersion: string
      promptVersion: string
      rendererVersion: string
      requestHash: string
      requestText: string
    }
  }
  payload.version = 'learnflow.visual.v2'
  payload.provenance.schemaVersion = 'learnflow.visual.v2'
  payload.provenance.promptVersion = 'learnflow.visual-planner.v2'
  payload.provenance.rendererVersion = 'learnflow.deterministic-svg.v2'
  return payload
}

test('computer and mathematics classifiers cover every required abstraction family', () => {
  assert.deepEqual(classifyLearningVisual('演示 TCP 三次握手协议'), { domain: 'computer', abstraction: 'protocol_sequence' })
  assert.deepEqual(classifyLearningVisual('展示连接的状态机'), { domain: 'computer', abstraction: 'state_machine' })
  assert.deepEqual(classifyLearningVisual('逐步展示链表数据结构'), { domain: 'computer', abstraction: 'data_structure' })
  assert.deepEqual(classifyLearningVisual('逐行代码执行和调用栈'), { domain: 'computer', abstraction: 'code_trace' })
  assert.deepEqual(classifyLearningVisual('用动画演示迪杰斯特拉算法'), { domain: 'computer', abstraction: 'graph_algorithm' })
  assert.deepEqual(classifyLearningVisual('演示自注意力 QKV 的张量 shape 流动'), { domain: 'computer', abstraction: 'tensor_shape_flow' })
  assert.deepEqual(classifyLearningVisual('用动画演示 CNN 手写数字卷积和池化'), { domain: 'computer', abstraction: 'convolution_trace' })
  assert.deepEqual(classifyLearningVisual('画出函数导数变化'), { domain: 'mathematics', abstraction: 'function' })
  assert.deepEqual(classifyLearningVisual('贝叶斯概率分布'), { domain: 'mathematics', abstraction: 'natural_frequency' })
  assert.deepEqual(classifyLearningVisual('prevalence 1%, sensitivity 90%'), { domain: 'mathematics', abstraction: 'natural_frequency' })
  assert.deepEqual(classifyLearningVisual('患病率 1%，但还没给特异度'), { domain: 'mathematics', abstraction: 'natural_frequency' })
  assert.deepEqual(classifyLearningVisual('矩阵线性变换'), { domain: 'mathematics', abstraction: 'transformation' })
  assert.deepEqual(classifyLearningVisual('公式等式推导'), { domain: 'mathematics', abstraction: 'derivation' })
})

test('CNN convolution animation compiles, computes and renders without a model', async () => {
  let modelCalls = 0
  const generated = await generateLearningVisual('animation', '用动画演示 CNN 手写数字识别中的卷积、ReLU 和池化', async () => {
    modelCalls += 1
    throw new Error('CNN deterministic compiler must not call the model')
  })
  assert.equal(modelCalls, 0)
  assert.equal(generated.spec.abstraction, 'convolution_trace')
  assert.equal(generated.spec.kind, 'animation')
  assert.equal(generated.generation.source, 'deterministic_compiler')
  assert.equal(generated.generation.compileStatus, 'illustrative_example')
  assert.equal(generated.quality.verification.level, 'derived_verified')
  assert.equal(generated.quality.status, 'passed')
  assert.equal(generated.artifact.steps.length, 12)
  assert.match(generated.artifact.steps[1].svg, /输入图像/)
  assert.match(generated.artifact.steps[1].svg, /竖直边缘卷积核/)
  assert.match(generated.artifact.steps.at(-1)?.text || '', /最大响应/)
  const replayed = readLearningVisualSpec(JSON.parse(JSON.stringify(generated.spec)), 'animation', generated.spec.provenance.requestText)
  assert.equal(replayed.abstraction, 'convolution_trace')
  assert.deepEqual(replayAnimation(replayed).finalState, generated.spec.finalState)
})

test('deictic visual requests preserve the current turn and recover the prior user topic', () => {
  const resolved = resolveVisualRequest('我希望你用动画演示出来', [
    { role: 'user', content: '跟我解释一下迪杰斯特拉算法' },
    { role: 'assistant', content: 'Dijkstra 会反复选择当前距离最小的未确定节点。' },
    { role: 'user', content: '我希望你用动画演示出来' },
  ])
  assert.equal(resolved.originalRequest, '我希望你用动画演示出来')
  assert.equal(resolved.contextEnriched, true)
  assert.deepEqual(resolved.topicAnchor, { topic: '跟我解释一下迪杰斯特拉算法', source: 'prior_user' })
  assert.match(resolved.effectiveRequest, /【结构化主题锚点】\{"topic":"跟我解释一下迪杰斯特拉算法","source":"prior_user"\}/)
})

test('natural visual follow-ups recover a short prior topic without a domain keyword list', () => {
  const resolved = resolveVisualRequest('给我一个动画示例', [
    { role: 'user', content: '讲一下快速排序' },
    { role: 'assistant', content: '快速排序通过分区递归处理子数组。' },
    { role: 'user', content: '给我一个动画示例' },
  ])
  assert.equal(resolved.contextEnriched, true)
  assert.deepEqual(resolved.topicAnchor, { topic: '讲一下快速排序', source: 'prior_user' })
})

test('visual-to-visual follow-ups inherit the validated artifact rather than prose guesses', () => {
  const resolved = resolveVisualRequest('做成动画', [{
    role: 'assistant', content: '这里是上一轮说明。', toolRuns: [{
      id: 'visual-1', kind: 'image', status: 'completed', title: '生成知识图解', detail: '完成', durationMs: 1,
      artifact: {
        kind: 'image', title: '令牌刷新图解', subtitle: '观察过期与换发', steps: [],
        readable: {
          summary: '客户端用刷新令牌换取新的访问令牌。', readingOrder: [], frameDescriptions: [],
          nonColorStateCue: '状态使用文字标记。',
        },
      },
    }],
  }])
  assert.equal(resolved.contextEnriched, true)
  assert.equal(resolved.topicAnchor?.source, 'prior_artifact')
  assert.match(resolved.topicAnchor?.topic || '', /令牌刷新图解.*刷新令牌/)
})

test('a topicless visual request fails before spending a planner call', async () => {
  let calls = 0
  await assert.rejects(
    () => executeLearningVisual('animation', '给我一个动画示例', [], async () => {
      calls += 1
      return '{}'
    }),
    /visual_topic_context_required/,
  )
  assert.equal(calls, 0)
})

test('concept-only computable requests use disclosed deterministic teaching examples', async () => {
  const cases = [
    ['diagram', '画一下两个矩阵相乘'],
    ['animation', '用动画演示迪杰斯特拉算法'],
    ['diagram', '画贝叶斯定理自然频数'],
    ['animation', '用动画解释 JS 事件循环'],
    ['animation', '做一个梯度下降动画'],
  ] as const
  for (const [kind, request] of cases) {
    const generated = await generateLearningVisual(kind, request, async () => {
      throw new Error('illustrative compiler must not call the model')
    })
    assert.equal(generated.generation.compileStatus, 'illustrative_example')
    assert.equal(generated.generation.plannerAttempts, 0)
    assert.match(generated.artifact.title, /^教学示例：/)
    assert.match(generated.explanation, /教学示例.*学习者自己的数据/)
    assert.equal(generated.quality.verification.level, 'derived_verified')
  }
})

test('Chinese weighted-edge phrasing compiles as an exact Dijkstra animation', async () => {
  const generated = await generateLearningVisual(
    'animation',
    '用动画演示迪杰斯特拉：有向图，从 S 到 T，S 到 A 权重 4，S 到 B 权重 1，B 到 A 权重 2，A 到 T 权重 3',
    async () => { throw new Error('exact compiler must not call the model') },
  )
  assert.equal(generated.generation.compileStatus, 'exact')
  assert.equal(generated.generation.plannerAttempts, 0)
  assert.equal(generated.artifact.kind, 'animation')
  assert.equal(generated.quality.verification.level, 'derived_verified')
})

test('numeric fields and graph direction keep strict JSON primitive types', () => {
  const functionPayload = (sampleY: unknown) => ({
    version: 'learnflow.visual.v3', kind: 'diagram', title: '严格数值', domain: 'mathematics', abstraction: 'function',
    semantic: {
      type: 'function',
      axes: { xLabel: 'x', yLabel: 'y', xDomain: [-1, 1], yDomain: [-1, 2] },
      series: [{ id: 'curve', label: 'curve', points: [[-1, 1], [0, sampleY], [1, 1]] }],
      parameters: [],
    },
    state: {},
  }) as Record<string, unknown>
  for (const invalid of [null, false, [], '', '1']) {
    assert.throws(
      () => parseV2Spec(functionPayload(invalid), 'diagram', '画出函数的严格有限数值'),
      /visual_spec_number_invalid:semantic\.series\[0\]\.points\[1\]\[1\]/,
    )
  }
  assert.doesNotThrow(() => parseV2Spec(functionPayload(0), 'diagram', '画出函数的严格有限数值'))

  const graphPayload = (directed: unknown) => ({
    version: 'learnflow.visual.v3', kind: 'diagram', title: '严格方向', domain: 'computer', abstraction: 'graph_algorithm',
    semantic: {
      type: 'graph_algorithm', id: 'graph_trace', algorithm: 'dijkstra', directed,
      nodes: [{ id: 's', label: 'S' }, { id: 't', label: 'T' }],
      edges: [{ id: 's_t', from: 's', to: 't', weight: 1 }], sourceId: 's', targetId: 't',
    },
    state: {},
  }) as Record<string, unknown>
  for (const invalid of [null, 0, 1, 'true', []]) {
    assert.throws(
      () => parseV2Spec(graphPayload(invalid), 'diagram', 'Dijkstra 严格方向'),
      /visual_spec_boolean_required:semantic\.directed/,
    )
  }
  assert.equal(parseV2Spec(graphPayload(false), 'diagram', 'Dijkstra 严格方向').semantic.type, 'graph_algorithm')
  assert.equal(parseV2Spec(graphPayload(true), 'diagram', 'Dijkstra 严格方向').semantic.type, 'graph_algorithm')
})

test('reader rejects every explicit unknown schema version before shape sniffing', () => {
  assert.throws(
    () => readLearningVisualSpec({ version: 'learnflow.visual.v999', nodes: [{ id: 'a', label: 'A' }] }, 'diagram', '未知版本'),
    /visual_spec_version_unsupported:learnflow\.visual\.v999/,
  )
  assert.throws(
    () => readLearningVisualSpec({ version: 'learnflow.visual.v999', semantic: {} }, 'diagram', '未知版本'),
    /visual_spec_version_unsupported:learnflow\.visual\.v999/,
  )
  assert.throws(
    () => readLearningVisualSpec({ semantic: {} }, 'diagram', '无版本语义'),
    /visual_spec_version_required/,
  )
})

test('a function diagram uses finite samples, stable state, replayable provenance and safe SVG', async () => {
  const generated = await generatePlan('diagram', '画出函数 y=x² 的有限采样图', {
    version: 'learnflow.visual.v3', kind: 'diagram', title: '二次函数', subtitle: '有限采样，不执行表达式',
    domain: 'mathematics', abstraction: 'function',
    semantic: {
      type: 'function',
      axes: { xLabel: 'x', yLabel: 'y', xDomain: [-2, 2], yDomain: [0, 4] },
      series: [{ id: 'curve', label: 'y=x²', points: [[-2, 4], [-1, 1], [0, 0], [1, 1], [2, 4]] }],
      parameters: [],
    },
    state: {},
    accessibility: { summary: '横轴是 x，纵轴是 y，五个有限采样点形成抛物线。', readingOrder: ['curve'], nonColorStateCue: '曲线同时使用编号与文字标签。' },
    explanation: '观察对称性。',
  })
  assert.equal(generated.plannerSucceeded, true)
  assert.equal(generated.degraded, false)
  assert.equal(generated.spec.kind, 'diagram')
  assert.equal(generated.artifact.kind, 'image')
  assert.equal(generated.artifact.specVersion, 'learnflow.visual.v3')
  assert.equal(generated.artifact.provenance.requestHash, generated.spec.provenance.requestHash)
  assert.equal(generated.artifact.replay.spec, generated.spec)
  assert.equal(generated.quality.replayable, true)
  assert.equal(generated.quality.verification.level, 'structural')
  assert.equal(generated.quality.score, 84)
  assert.equal(generated.quality.layout.collisions, 0)
  assert.equal(generated.quality.layout.outOfBounds, 0)
  assert.match(generated.artifact.steps[0].svg, /^<svg/)
  assert.doesNotMatch(generated.artifact.steps[0].svg, /<script|foreignObject|javascript:|onload=/i)
})

test('diagram rejects timeline fields instead of displaying a content-free fallback', async () => {
  await assert.rejects(() => generatePlan('diagram', '解释模块关系', {
    version: 'learnflow.visual.v3', kind: 'diagram', title: '模块关系', domain: 'computer', abstraction: 'system_structure',
    semantic: { type: 'system_structure', entities: [{ id: 'a', label: 'A' }], relations: [] },
    state: {}, frames: [],
  }), /visual_generation_unavailable:.*diagram_timeline_forbidden/)
})

test('protocol animation replays typed send_message patches and verifies final state', async () => {
  const generated = await generatePlan('animation', '演示一次客户端请求', {
    version: 'learnflow.visual.v3', kind: 'animation', title: '请求时序', domain: 'computer', abstraction: 'protocol_sequence',
    semantic: {
      type: 'protocol_sequence',
      participants: [{ id: 'client', label: '客户端' }, { id: 'server', label: '服务端' }],
      messages: [{ id: 'request', from: 'client', to: 'server', label: '请求', order: 1 }],
    },
    initialState: {},
    frames: [{ id: 'f1', title: '发送请求', narration: '客户端向服务端发送请求。', durationMs: 900, patches: [{ type: 'send_message', messageId: 'request' }] }],
    invariants: [{ type: 'references_resolve' }, { type: 'final_state_active', targetId: 'request' }],
    finalState: { activeIds: ['request'], emittedMessageIds: ['request'] },
    accessibility: { summary: '客户端向服务端发送一条请求。', readingOrder: ['client', 'server', 'request'], nonColorStateCue: '消息按序号、方向和状态文字呈现。' },
  })
  assert.equal(generated.plannerSucceeded, true)
  assert.equal(generated.spec.kind, 'animation')
  assert.equal(generated.quality.semanticChanges, 1)
  assert.equal(generated.quality.invariants.failures.length, 0)
  assert.equal(generated.artifact.steps.length, 2)
  assert.match(generated.artifact.steps[1].text, /发送消息 request/)
})

test('state machine animation requires a real transition patch', async () => {
  const generated = await generatePlan('animation', '演示开关状态机', {
    kind: 'animation', title: '开关状态机', domain: 'computer', abstraction: 'state_machine',
    semantic: {
      type: 'state_machine', states: [{ id: 'off', label: '关闭', initial: true }, { id: 'on', label: '开启' }],
      transitions: [{ id: 'turn_on', from: 'off', to: 'on', event: '按下开关' }],
    },
    initialState: { currentStateId: 'off' },
    frames: [{ id: 'f1', title: '打开', narration: '状态从关闭转为开启。', patches: [{ type: 'transition_state', transitionId: 'turn_on', fromStateId: 'off', toStateId: 'on' }] }],
    invariants: [{ type: 'final_state_active', targetId: 'on' }],
    finalState: { activeIds: ['turn_on', 'on'], currentStateId: 'on' },
  })
  assert.equal(generated.plannerSucceeded, true)
  assert.equal(generated.quality.semanticChanges, 1)
  assert.match(generated.artifact.steps[1].svg, /当前/)
})

test('data structure animation updates a pointer without inventing links', async () => {
  const generated = await generatePlan('animation', '移动链表头指针', {
    kind: 'animation', title: '头指针移动', domain: 'computer', abstraction: 'data_structure',
    semantic: {
      type: 'data_structure', structure: 'linked_list',
      items: [{ id: 'n1', label: '节点1' }, { id: 'n2', label: '节点2' }],
      links: [{ id: 'next', from: 'n1', to: 'n2', kind: 'next' }],
      pointers: [{ id: 'head', label: 'head', targetId: 'n1' }],
    },
    initialState: { pointers: { head: 'n1' } },
    frames: [{ id: 'f1', title: '移动 head', narration: 'head 改为指向第二个节点。', patches: [{ type: 'set_pointer', pointerId: 'head', targetId: 'n2' }] }],
    invariants: [{ type: 'references_resolve' }],
    finalState: { activeIds: ['head', 'n2'], pointers: { head: 'n2' } },
  })
  assert.equal(generated.plannerSucceeded, true)
  assert.equal(generated.spec.semantic.type, 'data_structure')
  if (generated.spec.semantic.type === 'data_structure') assert.equal(generated.spec.semantic.links.length, 1)
  assert.match(generated.artifact.steps[1].text, /指针 head 指向 n2/)
})

test('code trace is inert display data with active line, variable and stack patches', async () => {
  const generated = await generatePlan('animation', '逐行展示变量更新', {
    kind: 'animation', title: '代码追踪', domain: 'computer', abstraction: 'code_trace',
    semantic: {
      type: 'code_trace', language: 'pseudocode',
      lines: [{ id: 'line1', number: 1, text: 'x ← 0' }, { id: 'line2', number: 2, text: 'x ← x + 1' }],
      variables: [{ id: 'x', name: 'x', initialValue: 0 }],
      stackFrames: [{ id: 'main_frame', functionName: 'main', lineId: 'line1' }],
    },
    initialState: { activeLineId: 'line1', values: { x: 0 }, stack: [] },
    frames: [{ id: 'f1', title: '执行第二行', narration: '进入第二行并更新 x。', patches: [{ type: 'set_active_line', lineId: 'line2' }, { type: 'set_variable', variableId: 'x', value: 1 }, { type: 'push_stack', frameId: 'main_frame' }] }],
    invariants: [{ type: 'final_state_value', targetId: 'x', equals: 1 }],
    finalState: { activeIds: ['line2', 'x', 'main_frame'], activeLineId: 'line2', values: { x: 1 }, stack: ['main_frame'] },
  })
  assert.equal(generated.plannerSucceeded, true)
  assert.match(generated.artifact.steps[1].svg, /x = 1/)
  assert.doesNotMatch(generated.artifact.steps[1].svg, /<script/)
})

test('tensor flow validates finite integer shapes and replays shape changes', async () => {
  const generated = await generatePlan('animation', '张量形状从 2×4 变到 2×8', {
    kind: 'animation', title: '张量形状流', domain: 'computer', abstraction: 'tensor_shape_flow',
    semantic: {
      type: 'tensor_shape_flow',
      tensors: [{ id: 'x', label: 'X', shape: [2, 4], dtype: 'float32' }, { id: 'y', label: 'Y', shape: [2, 4], dtype: 'float32' }],
      operations: [{ id: 'linear', label: '线性映射', inputIds: ['x'], outputIds: ['y'] }],
    },
    initialState: { tensorShapes: { y: [2, 4] } },
    frames: [{ id: 'f1', title: '映射输出', narration: '输出最后一维变为 8。', patches: [{ type: 'set_tensor_shape', tensorId: 'y', shape: [2, 8] }] }],
    invariants: [{ type: 'tensor_shape', tensorId: 'y', shape: [2, 8] }],
    finalState: { activeIds: ['y'], tensorShapes: { y: [2, 8] } },
  })
  assert.equal(generated.plannerSucceeded, true)
  assert.match(generated.artifact.steps[1].svg, /2 × 8/)
})

test('probability diagram enforces normalized PMF finite data', async () => {
  const generated = await generatePlan('diagram', '画一个伯努利分布', {
    kind: 'diagram', title: '伯努利分布', domain: 'mathematics', abstraction: 'probability',
    semantic: { type: 'probability', mode: 'pmf', xLabel: 'x', yLabel: 'P(X=x)', samples: [{ id: 'p0', x: 0, y: 0.4 }, { id: 'p1', x: 1, y: 0.6 }] },
    state: {},
  })
  assert.equal(generated.plannerSucceeded, true)
  assert.equal(generated.quality.issues.length, 0)
  assert.match(generated.artifact.steps[0].svg, /PMF/)
  const stems = [...generated.artifact.steps[0].svg.matchAll(/id="lf_pmf_(?!axes)[^"]+"><line[^>]+y1="365"[^>]+y2="([0-9.]+)"/g)]
  assert.equal(stems.length, 2)
  assert.ok(stems.every(match => Number(match[1]) < 365), 'every positive PMF mass must rise above the zero baseline')
})

test('probability animation updates finite samples with a domain-specific patch', async () => {
  const generated = await generatePlan('animation', '展示伯努利分布参数变化', {
    kind: 'animation', title: '伯努利分布变化', domain: 'mathematics', abstraction: 'probability',
    semantic: { type: 'probability', mode: 'pmf', xLabel: 'x', yLabel: 'P(X=x)', samples: [{ id: 'p0', x: 0, y: 0.4 }, { id: 'p1', x: 1, y: 0.6 }] },
    initialState: {},
    frames: [{ id: 'f1', title: '调整概率', narration: '两个有限样本保持归一化。', patches: [{ type: 'set_probability_sample', sampleId: 'p0', y: 0.3 }, { type: 'set_probability_sample', sampleId: 'p1', y: 0.7 }] }],
    invariants: [{ type: 'probability_bounds' }],
    finalState: { activeIds: ['p0', 'p1'], values: { p0: 0.3, p1: 0.7 } },
  })
  assert.equal(generated.plannerSucceeded, true)
  assert.equal(generated.quality.semanticChanges, 1)
  assert.equal(generated.quality.invariants.failures.length, 0)
  assert.match(generated.artifact.steps[1].text, /概率样本 p0 更新为 0.3/)
})

test('typed patches cannot borrow targets or operations from another abstraction', async () => {
  await assert.rejects(() => generatePlan('animation', '演示一次客户端请求', {
    kind: 'animation', title: '错误 patch', domain: 'computer', abstraction: 'protocol_sequence',
    semantic: { type: 'protocol_sequence', participants: [{ id: 'client', label: '客户端' }, { id: 'server', label: '服务端' }], messages: [{ id: 'request', from: 'client', to: 'server', label: '请求', order: 1 }] },
    initialState: {},
    frames: [{ id: 'f1', title: '伪变化', narration: '把参与者误当变量。', patches: [{ type: 'set_variable', variableId: 'client', value: 1 }] }],
    invariants: [{ type: 'references_resolve' }],
    finalState: { activeIds: ['client'], values: { client: 1 } },
  }), /visual_generation_unavailable:.*patch_not_allowed:protocol_sequence.set_variable/)
})

test('mathematical transformation animation uses finite coordinates and parameter patches', async () => {
  const generated = await generatePlan('animation', '展示向量平移', {
    kind: 'animation', title: '向量平移', domain: 'mathematics', abstraction: 'transformation',
    semantic: {
      type: 'transformation', space: 'cartesian',
      objects: [{ id: 'before', label: '变换前', points: [[0, 0], [1, 0]] }, { id: 'after', label: '变换后', points: [[0, 0], [1, 0]] }],
      transforms: [{ id: 'shift', label: '向右上平移', beforeId: 'before', afterId: 'after', kind: 'translate' }],
      parameters: [{ id: 'distance', label: '位移', value: 0 }],
    },
    initialState: { values: { distance: 0 }, series: { after: [[0, 0], [1, 0]] } },
    frames: [{ id: 'f1', title: '执行平移', narration: '两个端点同时平移。', patches: [{ type: 'set_parameter', parameterId: 'distance', value: 1 }, { type: 'transform_object', objectId: 'after', points: [[1, 1], [2, 1]] }] }],
    invariants: [{ type: 'final_state_value', targetId: 'distance', equals: 1 }],
    finalState: { activeIds: ['distance', 'after'], values: { distance: 1 }, series: { after: [[1, 1], [2, 1]] } },
  })
  assert.equal(generated.plannerSucceeded, true)
  assert.equal(generated.spec.semantic.type, 'transformation')
  assert.equal(replayAnimation(generated.spec as typeof generated.spec & { kind: 'animation' }).semanticChanges, 1)
})

test('derivation animation replaces an expression as inert text', async () => {
  const generated = await generatePlan('animation', '展示公式交换律推导', {
    kind: 'animation', title: '交换律', domain: 'mathematics', abstraction: 'derivation',
    semantic: { type: 'derivation', steps: [{ id: 's1', expression: 'a + b', relation: 'definition', reason: '起点', changedTerms: [] }, { id: 's2', expression: 'a + b', relation: 'equals', reason: '交换律', changedTerms: ['a', 'b'] }] },
    initialState: { expressions: { s2: 'a + b' } },
    frames: [{ id: 'f1', title: '交换项', narration: '交换加数位置。', patches: [{ type: 'replace_expression', stepId: 's2', expression: 'b + a' }] }],
    invariants: [{ type: 'final_state_active', targetId: 's2' }],
    finalState: { activeIds: ['s2'], expressions: { s2: 'b + a' } },
  })
  assert.equal(generated.plannerSucceeded, true)
  assert.match(generated.artifact.steps[1].svg, /b \+ a/)
})

test('a frame whose patch changes only focus is rejected as a fake animation', async () => {
  await assert.rejects(() => generatePlan('animation', '逐行代码变量保持不变', {
    kind: 'animation', title: '无变化', domain: 'computer', abstraction: 'code_trace',
    semantic: { type: 'code_trace', language: 'pseudocode', lines: [{ id: 'line1', number: 1, text: 'x ← 1' }], variables: [{ id: 'x', name: 'x', initialValue: 1 }], stackFrames: [] },
    initialState: { values: { x: 1 } },
    frames: [{ id: 'f1', title: '仍为 1', narration: '数值没有变化。', patches: [{ type: 'set_variable', variableId: 'x', value: 1 }] }],
    invariants: [{ type: 'references_resolve' }],
    finalState: { activeIds: ['x'], values: { x: 1 } },
  }), /visual_generation_unavailable:.*(?:frame_without_semantic_change|visual_patch_no_change)/)
})

test('a prediction gate cannot reveal its answer by applying a patch in the same frame', async () => {
  await assert.rejects(generatePlan('animation', '展示一个状态机并先预测', {
    kind: 'animation', title: '预测状态变化', domain: 'computer', abstraction: 'state_machine',
    semantic: {
      type: 'state_machine',
      states: [{ id: 'idle', label: '空闲', initial: true }, { id: 'busy', label: '运行' }],
      transitions: [{ id: 'start', from: 'idle', to: 'busy', event: 'start' }],
    },
    initialState: { currentStateId: 'idle' },
    frames: [{
      id: 'predict_and_reveal', title: '先预测', narration: '预测下一状态。',
      prediction: {
        id: 'gate_state', prompt: '下一状态是什么？',
        choices: [{ id: 'choice_idle', label: '空闲' }, { id: 'choice_busy', label: '运行' }],
        correctChoiceId: 'choice_busy', explanation: 'start 触发 idle 到 busy。',
      },
      patches: [{ type: 'transition_state', transitionId: 'start', from: 'idle', to: 'busy' }],
    }],
    invariants: [{ type: 'final_state_active', targetId: 'busy' }],
    finalState: { activeIds: ['start', 'busy'], currentStateId: 'busy' },
  }), /visual_spec_prediction_frame_must_not_patch/)
})

test('a prediction gate must be followed by a real reveal frame', async () => {
  await assert.rejects(generatePlan('animation', '展示一个状态机并先预测', {
    kind: 'animation', title: '未揭晓的预测', domain: 'computer', abstraction: 'state_machine',
    semantic: {
      type: 'state_machine',
      states: [{ id: 'idle', label: '空闲', initial: true }, { id: 'busy', label: '运行' }],
      transitions: [{ id: 'start', from: 'idle', to: 'busy', event: 'start' }],
    },
    initialState: { currentStateId: 'idle' },
    frames: [{
      id: 'prediction_only', title: '先预测', narration: '预测下一状态。', patches: [],
      prediction: {
        id: 'gate_state', prompt: '下一状态是什么？',
        choices: [{ id: 'choice_idle', label: '空闲' }, { id: 'choice_busy', label: '运行' }],
        correctChoiceId: 'choice_busy', explanation: 'start 会进入 busy。',
      },
    }],
    invariants: [{ type: 'references_resolve' }],
    finalState: { currentStateId: 'idle' },
  }), /visual_spec_prediction_without_reveal/)
})

test('a structural model plan cannot claim a verified non-leaking prediction gate', async () => {
  await assert.rejects(generatePlan('animation', '展示一个状态机并先预测', {
    kind: 'animation', title: '模型预测状态变化', domain: 'computer', abstraction: 'state_machine',
    semantic: {
      type: 'state_machine',
      states: [{ id: 'idle', label: '空闲', initial: true }, { id: 'busy', label: '运行' }],
      transitions: [{ id: 'start', from: 'idle', to: 'busy', event: 'start' }],
    },
    initialState: { currentStateId: 'idle' },
    frames: [
      {
        id: 'predict', title: '先预测', narration: '先预测下一状态。', patches: [],
        prediction: {
          id: 'gate_state', prompt: '下一状态是什么？',
          choices: [{ id: 'choice_idle', label: '空闲' }, { id: 'choice_busy', label: '运行' }],
          correctChoiceId: 'choice_busy', explanation: 'start 会触发 idle 到 busy。',
        },
      },
      {
        id: 'reveal', title: '揭晓', narration: '进入运行状态。',
        patches: [{ type: 'transition_state', transitionId: 'start', fromStateId: 'idle', toStateId: 'busy' }],
      },
    ],
    invariants: [{ type: 'final_state_active', targetId: 'busy' }],
    finalState: { activeIds: ['start', 'busy'], currentStateId: 'busy' },
  }), /visual_spec_prediction_requires_verified_compiler/)
})

test('setting a tensor to its declared shape is a no-op even when initialState omits the duplicate value', async () => {
  await assert.rejects(() => generatePlan('animation', '保持张量形状不变', {
    kind: 'animation', title: '无变化张量', domain: 'computer', abstraction: 'tensor_shape_flow',
    semantic: { type: 'tensor_shape_flow', tensors: [{ id: 'x', label: 'X', shape: [2, 4] }, { id: 'y', label: 'Y', shape: [2, 4] }], operations: [{ id: 'copy', label: '复制', inputIds: ['x'], outputIds: ['y'] }] },
    initialState: {},
    frames: [{ id: 'f1', title: '仍为 2×4', narration: '形状没有改变。', patches: [{ type: 'set_tensor_shape', tensorId: 'y', shape: [2, 4] }] }],
    invariants: [{ type: 'tensor_shape', tensorId: 'y', shape: [2, 4] }],
    finalState: { activeIds: ['y'], tensorShapes: { y: [2, 4] } },
  }), /visual_generation_unavailable:.*visual_patch_no_change:set_tensor_shape.y/)
})

test('legacy highlight-only animation deterministically degrades to a diagram', async () => {
  const generated = await generatePlan('animation', '旧版流程', {
    version: 'learnflow.visual.v1', kind: 'animation', title: '旧版流程', domain: 'computer', abstraction: 'sequence',
    nodes: [{ id: 'a', label: 'A', role: 'input', shape: 'card', column: 0, lane: 0 }, { id: 'b', label: 'B', role: 'output', shape: 'card', column: 1, lane: 0 }],
    relations: [{ id: 'r1', from: 'a', to: 'b', kind: 'flow' }],
    frames: [{ id: 'f1', title: '高亮', narration: '只高亮', activeNodeIds: ['a', 'b'], activeRelationIds: ['r1'] }],
  })
  assert.equal(generated.plannerSucceeded, false)
  assert.equal(generated.spec.kind, 'diagram')
  assert.equal(generated.artifact.kind, 'image')
  assert.equal(generated.artifact.degraded, true)
  assert.equal(generated.artifact.degradedTo, 'diagram')
  assert.match(generated.artifact.modelError || '', /typed_semantic_patches/)
})

test('legacy image, static and animation specs remain readable without semantic invention', () => {
  const base = {
    version: 'learnflow.visual.v1', title: '旧图', domain: 'general', abstraction: 'concept_map',
    nodes: [{ id: 'a', label: 'A', role: 'concept', shape: 'card', column: 0, lane: 0 }], relations: [], frames: [],
  }
  for (const kind of ['image', 'static']) {
    const spec = readLearningVisualSpec({ ...base, kind }, 'diagram', '旧图')
    assert.equal(spec.version, 'learnflow.visual.v1')
    assert.equal(spec.kind, 'diagram')
    const { artifact } = visualSpecToArtifact(spec)
    assert.equal(artifact.kind, 'image')
    assert.equal(artifact.replay.spec.version, 'learnflow.visual.v1')
  }
  const animation = readLearningVisualSpec({ ...base, kind: 'animation', frames: [{ id: 'f1', title: '帧1', narration: '旧高亮', activeNodeIds: ['a'], activeRelationIds: [] }] }, 'animation', '旧动画')
  const { artifact } = visualSpecToArtifact(animation)
  assert.equal(artifact.kind, 'image')
  assert.equal(artifact.degradedTo, 'storyboard')
  assert.equal(artifact.steps.length, 1)
})

test('dangling references are rejected instead of filtered or auto-connected', async () => {
  assert.throws(() => readLearningVisualSpec({
    version: 'learnflow.visual.v1', kind: 'diagram', title: '坏图', nodes: [{ id: 'a', label: 'A' }],
    relations: [{ id: 'r1', from: 'a', to: 'missing', kind: 'flow' }], frames: [],
  }, 'diagram', '坏图'), /dangling_reference/)

  await assert.rejects(() => generatePlan('diagram', '坏关系', {
    kind: 'diagram', title: '坏关系', domain: 'computer', abstraction: 'system_structure',
    semantic: { type: 'system_structure', entities: [{ id: 'a', label: 'A' }], relations: [{ id: 'r1', from: 'a', to: 'missing', kind: 'flow' }] }, state: {},
  }), /visual_generation_unavailable:.*dangling_reference/)
})

test('missing relations stay missing and are never silently repaired', async () => {
  const generated = await generatePlan('diagram', '三个独立组件', {
    kind: 'diagram', title: '独立组件', domain: 'computer', abstraction: 'system_structure',
    semantic: { type: 'system_structure', entities: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], relations: [] },
    state: {},
  })
  assert.equal(generated.plannerSucceeded, true)
  assert.equal(generated.spec.semantic.type, 'system_structure')
  if (generated.spec.semantic.type === 'system_structure') assert.equal(generated.spec.semantic.relations.length, 0)
  assert.equal(generated.quality.repairs.some(repair => /relation/i.test(repair.code)), false)
  assert.ok(generated.quality.warnings.includes('relations_missing_not_repaired'))
})

test('provider failure uses only a verified deterministic template and otherwise returns no artifact', async () => {
  const tcp = await generateLearningVisual('animation', '逐步演示 TCP 三次握手', async () => { throw new Error('provider timeout') })
  assert.equal(tcp.plannerSucceeded, false)
  assert.equal(tcp.degraded, true)
  assert.equal(tcp.degradedTo, 'deterministic_animation')
  assert.equal(tcp.spec.kind, 'animation')
  assert.match(tcp.modelError || '', /provider timeout/)
  assert.equal(tcp.quality.semanticChanges, 3)

  const federatedDiagram = await generateLearningVisual('diagram', '画一张联邦学习的一轮训练流程图', async () => { throw new Error('provider timeout') })
  assert.equal(federatedDiagram.degradedTo, 'diagram')
  assert.equal(federatedDiagram.spec.semantic.type, 'system_structure')
  if (federatedDiagram.spec.semantic.type === 'system_structure') {
    assert.equal(federatedDiagram.spec.semantic.entities.length, 5)
    assert.equal(federatedDiagram.spec.semantic.relations.length, 5)
  }
  assert.match(federatedDiagram.artifact.steps[0]?.svg || '', /本地数据/)
  assert.match(federatedDiagram.artifact.steps[0]?.svg || '', /聚合服务/)

  const federatedAnimation = await generateLearningVisual('animation', '逐步演示联邦学习的一轮训练', async () => { throw new Error('provider timeout') })
  assert.equal(federatedAnimation.degradedTo, 'deterministic_animation')
  assert.equal(federatedAnimation.spec.kind, 'animation')
  assert.equal(federatedAnimation.quality.semanticChanges, 5)

  await assert.rejects(
    () => generateLearningVisual('animation', '演示一个没有足够事实的主题', async () => { throw new Error('empty model output') }),
    /visual_generation_unavailable:empty model output/,
  )

  await assert.rejects(
    () => generateLearningVisual('animation', '逐步演示 TCP 四次挥手', async () => { throw new Error('provider timeout') }),
    /visual_generation_unavailable:provider timeout/,
  )
  await assert.rejects(
    () => generateLearningVisual('diagram', '画一张联邦学习投毒攻击的防御流程图', async () => { throw new Error('provider timeout') }),
    /visual_generation_unavailable:provider timeout/,
  )
})

test('request intent blocks a valid but unrelated model abstraction before display', async () => {
  let modelCalls = 0
  const generated = await generateLearningVisual('animation', '逐步演示 TCP 三次握手', async () => {
    modelCalls += 1
    return JSON.stringify({
      version: 'learnflow.visual.v3', kind: 'animation', title: '无关概率动画', domain: 'mathematics', abstraction: 'probability',
      semantic: {
        type: 'probability', mode: 'pmf', xLabel: 'x', yLabel: 'P(X=x)',
        samples: [{ id: 'p0', x: 0, y: 0.4 }, { id: 'p1', x: 1, y: 0.6 }],
      },
      initialState: {},
      frames: [{
        id: 'change_probability', title: '调整概率', narration: '调整两个有限样本。',
        patches: [
          { type: 'set_probability_sample', sampleId: 'p0', y: 0.3 },
          { type: 'set_probability_sample', sampleId: 'p1', y: 0.7 },
        ],
      }],
      invariants: [{ type: 'probability_bounds' }],
      finalState: { activeIds: ['p0', 'p1'], values: { p0: 0.3, p1: 0.7 } },
    })
  })

  assert.equal(modelCalls, 2)
  assert.equal(generated.spec.abstraction, 'protocol_sequence')
  assert.equal(generated.spec.semantic.type, 'protocol_sequence')
  assert.match(generated.modelError || '', /visual_spec_domain_abstraction_mismatch/)
})

test('a failed visual plan receives one bounded repair attempt', async () => {
  const timeouts: number[] = []
  const stages: string[] = []
  let calls = 0
  const generated = await generateLearningVisual('diagram', '画一个编译器前端结构图', async (_instructions, _input, timeoutMs) => {
    calls += 1
    timeouts.push(timeoutMs || 0)
    if (calls === 1) return '{}'
    return JSON.stringify({
      version: 'learnflow.visual.v3', kind: 'diagram', title: '编译器前端', subtitle: '从源码到中间表示',
      domain: 'computer', abstraction: 'system_structure',
      semantic: {
        type: 'system_structure',
        entities: [{ id: 'source', label: '源代码' }, { id: 'parser', label: '解析器' }, { id: 'ir', label: '中间表示' }],
        relations: [
          { id: 'source_to_parser', from: 'source', to: 'parser', kind: 'flow' },
          { id: 'parser_to_ir', from: 'parser', to: 'ir', kind: 'flow' },
        ],
      },
      state: { activeIds: ['source', 'parser', 'ir'] },
      accessibility: { summary: '源代码经过解析器形成中间表示。', readingOrder: ['source', 'parser', 'ir'], nonColorStateCue: '箭头和标签共同表达方向。' },
      explanation: '按箭头阅读编译器前端的三个阶段。',
    })
  }, { onStage: stage => stages.push(stage) })
  assert.equal(calls, 2)
  assert.deepEqual(timeouts, [150_000, 120_000])
  assert.equal(generated.generation.plannerAttempts, 2)
  assert.equal(generated.generation.repairAttempted, true)
  assert.equal(generated.generation.attempts.length, 2)
  assert.deepEqual(generated.generation.attempts.map(item => item.status), ['rejected', 'accepted'])
  assert.deepEqual(generated.generation.attempts.map(item => item.timeoutMs), [150_000, 120_000])
  assert.ok(stages.includes('planner_started'))
  assert.ok(stages.includes('repair_started'))
  assert.ok(stages.includes('validation_started'))
  assert.equal(stages.at(-1), 'rendered')
  assert.equal(generated.artifact.kind, 'image')
})

test('planner punctuation repair salvages JSON without a second model call or semantic invention', async () => {
  let calls = 0
  let generationOptions: unknown
  const valid = JSON.stringify({
    version: 'learnflow.visual.v3', kind: 'diagram', title: '编译器前端', subtitle: '稳定结构',
    domain: 'computer', abstraction: 'system_structure',
    semantic: {
      type: 'system_structure',
      entities: [{ id: 'source', label: '源代码 }{ 与 ,] 保持原文' }, { id: 'parser', label: '解析器' }, { id: 'ir', label: '中间表示' }],
      relations: [{ id: 'source_parser', from: 'source', to: 'parser', kind: 'flow' }, { id: 'parser_ir', from: 'parser', to: 'ir', kind: 'flow' }],
    },
    state: { activeIds: ['source'] },
    accessibility: { summary: '源代码经过解析器形成中间表示。', readingOrder: ['source', 'parser', 'ir'], nonColorStateCue: '当前对象有文字标记。' },
    explanation: '沿箭头阅读。',
  })
  const missingComma = valid.replace('},{"id":"parser"', '}{"id":"parser"')
  const generated = await generateLearningVisual('diagram', '画一个编译器前端结构图', async (_instructions, _input, _timeout, _tokens, options) => {
    calls += 1
    generationOptions = options
    return missingComma
  })
  assert.equal(calls, 1)
  assert.deepEqual(generationOptions, { responseFormat: 'json_object' })
  assert.ok(generated.spec.generation.repairs.some(repair => repair.code === 'planner_json_punctuation_repaired'))
  assert.equal(generated.generation.syntaxRepairApplied, true)
  assert.equal(generated.generation.attempts.length, 1)
  assert.equal(generated.generation.attempts[0].status, 'accepted')
  assert.equal(generated.spec.semantic.type, 'system_structure')
  if (generated.spec.semantic.type === 'system_structure') {
    assert.equal(generated.spec.semantic.entities[0].label, '源代码 }{ 与 ,] 保持原文')
  }
  assert.equal(generated.quality.status, 'passed')
})

test('an unseen process compiles from declarative stages into a validated animation without authored frames', async () => {
  let calls = 0
  const generated = await generateLearningVisual('animation', '用动画演示编译器从源代码到中间表示的处理过程', async instructions => {
    calls += 1
    assert.match(instructions, /声明式过程动画/)
    return JSON.stringify({
      version: 'learnflow.visual.v3', kind: 'animation', title: '编译器前端流水线', subtitle: '按阶段观察表示变化',
      domain: 'computer', abstraction: 'process_storyboard',
      semantic: {
        type: 'process_storyboard',
        stages: [
          { id: 'source', label: '源代码', initial: true },
          { id: 'tokens', label: '词法单元' },
          { id: 'ast', label: '语法树' },
          { id: 'ir', label: '中间表示', terminal: true },
        ],
        transitions: [
          { id: 'lex', from: 'source', to: 'tokens', event: '词法分析' },
          { id: 'parse', from: 'tokens', to: 'ast', event: '语法分析' },
          { id: 'lower', from: 'ast', to: 'ir', event: '降低表示' },
        ],
        path: ['lex', 'parse', 'lower'],
      },
      accessibility: { summary: '源代码依次经过词法分析、语法分析和降低表示形成中间表示。', readingOrder: ['source', 'tokens', 'ast', 'ir', 'lex', 'parse', 'lower'], nonColorStateCue: '当前阶段使用文字和粗边框标记。' },
      explanation: '逐步观察编译器前端如何改变程序表示。',
    })
  })
  assert.equal(calls, 1)
  assert.equal(generated.spec.abstraction, 'state_machine')
  assert.equal(generated.spec.semantic.type, 'state_machine')
  assert.equal(generated.spec.kind, 'animation')
  if (generated.spec.kind === 'animation') {
    assert.equal(generated.spec.frames.length, 3)
    assert.deepEqual(generated.spec.frames.map(frame => frame.patches[0]?.type), ['transition_state', 'transition_state', 'transition_state'])
    assert.equal(generated.spec.finalState.currentStateId, 'ir')
  }
  assert.ok(generated.spec.generation.repairs.some(repair => repair.code === 'declarative_process_timeline_compiled'))
  assert.equal(generated.quality.replayable, true)
  assert.equal(generated.quality.verification.level, 'structural')
  assert.equal(JSON.stringify(generated.spec).includes('positions'), true)
  assert.doesNotMatch(JSON.stringify(generated.spec.frames), /"to":\s*\[/)
})

test('a generic placeholder process is rejected even when its structure is valid', async () => {
  const placeholder = JSON.stringify({
    version: 'learnflow.visual.v3', kind: 'animation', title: '过程动画示例', domain: 'computer', abstraction: 'process_storyboard',
    semantic: {
      type: 'process_storyboard',
      stages: [
        { id: 'input', label: '输入', initial: true },
        { id: 'process', label: '处理' },
        { id: 'output', label: '输出', terminal: true },
      ],
      transitions: [
        { id: 'start', from: 'input', to: 'process', event: '处理' },
        { id: 'finish', from: 'process', to: 'output', event: '完成' },
      ],
      path: ['start', 'finish'],
    },
    accessibility: { summary: '输入经过处理得到输出。', readingOrder: ['input', 'process', 'output', 'start', 'finish'], nonColorStateCue: '当前状态有文字标记。' },
    explanation: '观察通用过程。',
  })
  await assert.rejects(
    () => generateLearningVisual('animation', '用动画演示快速排序的分区过程', async () => placeholder),
    /visual_topic_coverage_missing/,
  )
})

test('an unseen three-stage topic passes the same generic topic and substance gates', async () => {
  const generated = await generateLearningVisual('animation', '用动画演示 OAuth token refresh 生命周期', async () => JSON.stringify({
    version: 'learnflow.visual.v3', kind: 'animation', title: 'OAuth token refresh', domain: 'computer', abstraction: 'process_storyboard',
    semantic: {
      type: 'process_storyboard',
      stages: [
        { id: 'expired', label: '访问令牌过期', initial: true },
        { id: 'refreshing', label: '提交 refresh token' },
        { id: 'renewed', label: '获得新 token', terminal: true },
      ],
      transitions: [
        { id: 'submit_refresh', from: 'expired', to: 'refreshing', event: '客户端提交 refresh token' },
        { id: 'issue_token', from: 'refreshing', to: 'renewed', event: '授权服务签发新 token' },
      ],
      path: ['submit_refresh', 'issue_token'],
    },
    accessibility: { summary: 'OAuth 客户端在访问令牌过期后提交 refresh token，并获得新 token。', readingOrder: ['expired', 'refreshing', 'renewed', 'submit_refresh', 'issue_token'], nonColorStateCue: '当前阶段由文字和粗边框共同标记。' },
    explanation: '逐步观察 token refresh 生命周期。',
  }))
  assert.equal(generated.spec.kind, 'animation')
  assert.equal(generated.artifact.steps.length, 3)
  assert.equal(generated.quality.semanticChanges, 2)
})

test('a semantic-only protocol plan receives a deterministic message timeline', async () => {
  const generated = await generateLearningVisual('animation', '用动画演示一个新的请求、确认、完成协议', async instructions => {
    assert.match(instructions, /声明式协议动画/)
    return JSON.stringify({
      version: 'learnflow.visual.v3', kind: 'animation', title: '三步协议', domain: 'computer', abstraction: 'protocol_sequence',
      semantic: {
        type: 'protocol_sequence',
        participants: [{ id: 'client', label: '客户端' }, { id: 'server', label: '服务端' }],
        messages: [
          { id: 'request', from: 'client', to: 'server', label: '请求', order: 1 },
          { id: 'ack', from: 'server', to: 'client', label: '确认', order: 2 },
          { id: 'done', from: 'server', to: 'client', label: '完成', order: 3 },
        ],
      },
      accessibility: { summary: '客户端请求，服务端确认并完成。', readingOrder: ['client', 'server', 'request', 'ack', 'done'], nonColorStateCue: '已发送消息带有顺序编号。' },
      explanation: '按消息编号阅读。',
    })
  })
  assert.equal(generated.spec.semantic.type, 'protocol_sequence')
  assert.equal(generated.spec.kind, 'animation')
  if (generated.spec.kind === 'animation') {
    assert.equal(generated.spec.frames.length, 3)
    assert.deepEqual(generated.spec.finalState.emittedMessageIds, ['request', 'ack', 'done'])
  }
  assert.ok(generated.spec.generation.repairs.some(repair => repair.code === 'declarative_protocol_timeline_compiled'))
})

test('declarative process continuity is validated before the one bounded repair', async () => {
  let calls = 0
  const base = {
    version: 'learnflow.visual.v3', kind: 'animation', title: '发布过程', domain: 'computer', abstraction: 'process_storyboard',
    semantic: {
      type: 'process_storyboard',
      stages: [{ id: 'draft', label: '草稿', initial: true }, { id: 'review', label: '审核' }, { id: 'live', label: '上线', terminal: true }],
      transitions: [{ id: 'submit', from: 'draft', to: 'review', event: '提交' }, { id: 'publish', from: 'review', to: 'live', event: '发布' }],
      path: ['publish', 'submit'],
    },
    accessibility: { summary: '草稿经过审核后上线。', readingOrder: ['draft', 'review', 'live', 'submit', 'publish'], nonColorStateCue: '当前状态有文字标记。' },
    explanation: '观察发布状态变化。',
  }
  const generated = await generateLearningVisual('animation', '用动画演示内容发布流程', async () => {
    calls += 1
    if (calls === 1) return JSON.stringify(base)
    return JSON.stringify({ ...base, semantic: { ...base.semantic, path: ['submit', 'publish'] } })
  })
  assert.equal(calls, 2)
  assert.match(generated.modelError || '', /visual_declarative_path_discontinuous/)
  assert.deepEqual(generated.generation.attempts.map(attempt => attempt.status), ['rejected', 'accepted'])
})

test('an incomplete natural-frequency request never falls through to the model', async () => {
  let modelCalls = 0
  await assert.rejects(
    () => generateLearningVisual(
      'diagram',
      '用自然频数解释贝叶斯：总人数 10000，患病率 1%，敏感度 90%，还没有给出另一项指标',
      async () => {
        modelCalls += 1
        return '{}'
      },
    ),
    /natural_frequency_specificity_missing/,
  )
  assert.equal(modelCalls, 0)
})

test('a legal persisted v2 spec migrates to v3 and then round-trips as v3', async () => {
  const generated = await generatePlan('diagram', '版本迁移系统图', {
    version: 'learnflow.visual.v3', kind: 'diagram', title: '版本迁移系统图', domain: 'computer', abstraction: 'system_structure',
    semantic: {
      type: 'system_structure',
      entities: [{ id: 'input', label: '输入' }, { id: 'output', label: '输出' }],
      relations: [{ id: 'flow', from: 'input', to: 'output', kind: 'flow' }],
    },
    state: {},
  })
  const persistedV2 = persistedV2From(generated.spec)
  const migrated = readLearningVisualSpec(persistedV2, 'diagram', '不得覆盖旧 requestText')

  assert.equal(migrated.version, 'learnflow.visual.v3')
  assert.deepEqual(
    [migrated.provenance.schemaVersion, migrated.provenance.promptVersion, migrated.provenance.rendererVersion],
    ['learnflow.visual.v3', 'learnflow.visual-planner.v3', 'learnflow.deterministic-svg.v3'],
  )
  assert.equal(migrated.provenance.requestHash, persistedV2.provenance.requestHash)
  assert.equal(migrated.provenance.requestText, persistedV2.provenance.requestText)
  assert.ok(migrated.generation.repairs.some(repair => repair.code === 'schema_migrated_v2_to_v3'))

  const rendered = visualSpecToArtifact(migrated)
  assert.equal(rendered.artifact.specVersion, 'learnflow.visual.v3')
  assert.equal(rendered.artifact.renderer, 'learnflow.deterministic-svg.v3')
  const reread = readLearningVisualSpec(JSON.parse(JSON.stringify(migrated)), 'diagram', '仍不得覆盖旧 requestText')
  assert.deepEqual(reread, migrated)
})

test('v2 migration rejects every non-canonical provenance tuple and a forged request hash', async () => {
  const generated = await generatePlan('diagram', '严格校验旧 provenance', {
    version: 'learnflow.visual.v3', kind: 'diagram', title: '严格 provenance', domain: 'computer', abstraction: 'system_structure',
    semantic: {
      type: 'system_structure',
      entities: [{ id: 'left', label: '左' }, { id: 'right', label: '右' }],
      relations: [{ id: 'mapping', from: 'left', to: 'right', kind: 'mapping' }],
    },
    state: {},
  })
  const mutations: Array<(payload: ReturnType<typeof persistedV2From>) => void> = [
    payload => { payload.provenance.schemaVersion = 'learnflow.visual.v1' },
    payload => { payload.provenance.promptVersion = 'learnflow.visual-planner.v3' },
    payload => { payload.provenance.rendererVersion = 'learnflow.deterministic-svg.v999' },
  ]
  for (const mutate of mutations) {
    const invalid = persistedV2From(generated.spec)
    mutate(invalid)
    assert.throws(() => readLearningVisualSpec(invalid, 'diagram', '严格校验旧 provenance'), /visual_spec_provenance_version_invalid/)
  }

  const forged = persistedV2From(generated.spec)
  forged.provenance.requestText = `${forged.provenance.requestText} forged`
  assert.throws(() => readLearningVisualSpec(forged, 'diagram', '严格校验旧 provenance'), /visual_spec_provenance_hash_mismatch/)
})

test('a valid v2 payload without provenance records an explicit repair and stays structural', async () => {
  const generated = await generatePlan('diagram', '缺失 provenance 的旧系统图', {
    version: 'learnflow.visual.v3', kind: 'diagram', title: '旧系统图', domain: 'computer', abstraction: 'system_structure',
    semantic: {
      type: 'system_structure',
      entities: [{ id: 'source', label: '来源' }, { id: 'sink', label: '去向' }],
      relations: [{ id: 'flow', from: 'source', to: 'sink', kind: 'flow' }],
    },
    state: {},
  })
  const persistedV2 = persistedV2From(generated.spec) as ReturnType<typeof persistedV2From> & { provenance?: unknown }
  delete persistedV2.provenance

  const migrated = readLearningVisualSpec(persistedV2, 'diagram', '迁移时重建 provenance')
  const migration = migrated.generation.repairs.find(repair => repair.code === 'schema_migrated_v2_to_v3')
  assert.equal(migrated.provenance.requestText, '迁移时重建 provenance')
  assert.equal(migration?.detail, 'legacy_v2_schema_validated_and_missing_provenance_regenerated')
  assert.equal(visualSpecToArtifact(migrated).quality.verification.level, 'structural')
})

test('v3-only computable semantics cannot masquerade as a legacy v2 closed schema', async () => {
  const generated = await generateLearningVisual(
    'diagram',
    '矩阵乘法 A=[[1,2],[3,4]]，B=[[5],[6]]，重点解释 C_11',
    async () => { throw new Error('deterministic compiler should not call model') },
  )
  const disguised = persistedV2From(generated.spec)
  assert.throws(
    () => readLearningVisualSpec(disguised, 'diagram', disguised.provenance.requestText),
    /visual_spec_v2_abstraction_unsupported:mathematics.matrix_operation/,
  )
})

test('persisted v3 deterministic compiler claims require the exact registered compiler tuple', async () => {
  const generated = await generateLearningVisual(
    'diagram',
    '矩阵乘法 A=[[1,2],[3,4]]，B=[[5],[6]]，重点解释 C_11',
    async () => { throw new Error('deterministic compiler should not call model') },
  )
  const valid = readLearningVisualSpec(
    JSON.parse(JSON.stringify(generated.spec)),
    'diagram',
    generated.spec.provenance.requestText,
  )
  assert.equal(visualSpecToArtifact(valid).quality.verification.level, 'derived_verified')

  const forgedId = JSON.parse(JSON.stringify(generated.spec)) as {
    generation: { compiler: { id: string; version: string } }
  }
  forgedId.generation.compiler.id = 'learnflow.forged-compiler'
  assert.throws(
    () => readLearningVisualSpec(forgedId, 'diagram', generated.spec.provenance.requestText),
    /visual_spec_generation_compiler_version_invalid/,
  )

  const forgedVersion = JSON.parse(JSON.stringify(generated.spec)) as {
    generation: { compiler: { id: string; version: string } }
  }
  forgedVersion.generation.compiler.version = '999.0.0'
  assert.throws(
    () => readLearningVisualSpec(forgedVersion, 'diagram', generated.spec.provenance.requestText),
    /visual_spec_generation_compiler_version_invalid/,
  )
})

test('persisted deterministic compiler claims are recompiled from provenance before trust', async () => {
  const matrix = await generateLearningVisual(
    'diagram',
    '矩阵乘法 A=[[1,2],[3,4]]，B=[[5],[6]]，重点解释 C_11',
    async () => { throw new Error('deterministic compiler should not call model') },
  )
  type MutableMatrixSpec = {
    title: string
    explanation: string
    semantic: { left: { values: number[][] } }
    state: { activeIds: string[] }
    accessibility: { summary: string }
  }
  const matrixMutations: Array<(payload: MutableMatrixSpec) => void> = [
    payload => { payload.semantic.left.values[0][0] = 9 },
    payload => { payload.state.activeIds = ['matrix_a'] },
    payload => { payload.title = '伪造标题' },
    payload => { payload.explanation = '伪造说明' },
    payload => { payload.accessibility.summary = '伪造无障碍摘要' },
  ]
  for (const mutate of matrixMutations) {
    const forged = JSON.parse(JSON.stringify(matrix.spec)) as MutableMatrixSpec
    mutate(forged)
    assert.throws(
      () => readLearningVisualSpec(forged, 'diagram', matrix.spec.provenance.requestText),
      /visual_spec_deterministic_compiler_claim_mismatch/,
    )
  }

  const optimization = await generateLearningVisual(
    'animation',
    '演示 f(x)=(x-2)^2 的梯度下降，x0=-2，学习率 α=.25，迭代 4 步',
    async () => { throw new Error('deterministic compiler should not call model') },
  )
  type MutableCompiledAnimation = { frames: Array<{ prediction?: unknown; narration: string; patches: Array<{ type: string; step?: number }> }> }
  const forgedTimeline = JSON.parse(JSON.stringify(optimization.spec)) as MutableCompiledAnimation
  forgedTimeline.frames.find(frame => !frame.prediction)!.narration = '伪造帧说明'
  assert.throws(
    () => readLearningVisualSpec(forgedTimeline, 'animation', optimization.spec.provenance.requestText),
    /visual_spec_deterministic_compiler_claim_mismatch/,
  )
})

test('deterministic derived traces cannot jump, repeat or move backward', async () => {
  const generated = await generateLearningVisual(
    'animation',
    '演示 f(x)=(x-2)^2 的梯度下降，x0=-2，学习率 α=.25，迭代 4 步',
    async () => { throw new Error('deterministic compiler should not call model') },
  )
  type MutableTraceSpec = {
    frames: Array<{ prediction?: unknown; id: string; patches: Array<{ type: string; step?: number }> }>
  }
  const forgedTrace = (ordinaryIndex: number, step: number) => {
    const payload = JSON.parse(JSON.stringify(generated.spec)) as MutableTraceSpec
    const ordinary = payload.frames.filter(frame => !frame.prediction)
    ordinary[ordinaryIndex].patches[0].step = step
    return payload
  }

  assert.throws(
    () => readLearningVisualSpec(forgedTrace(0, 2), 'animation', generated.spec.provenance.requestText),
    /visual_spec_trace_sequence_invalid:.*expected_1:received_2/,
  )
  assert.throws(
    () => readLearningVisualSpec(forgedTrace(1, 1), 'animation', generated.spec.provenance.requestText),
    /visual_spec_trace_sequence_invalid:.*expected_2:received_1/,
  )
  assert.throws(
    () => readLearningVisualSpec(forgedTrace(2, 1), 'animation', generated.spec.provenance.requestText),
    /visual_spec_trace_sequence_invalid:.*expected_3:received_1/,
  )
})

test('degraded generation metadata and provenance survive persisted-spec replay', async () => {
  const generated = await generateLearningVisual('animation', '逐步演示 TCP 三次握手', async () => { throw new Error('planner unavailable') })
  const persistedSpec = JSON.parse(JSON.stringify(generated.artifact.replay.spec))
  const replayed = readLearningVisualSpec(persistedSpec, 'animation', 'this argument must not replace stored provenance')
  const rerendered = visualSpecToArtifact(replayed)

  assert.equal(replayed.generation.plannerSucceeded, false)
  assert.equal(replayed.generation.degraded, true)
  assert.equal(replayed.generation.degradedTo, 'deterministic_animation')
  assert.match(replayed.generation.modelError || '', /planner unavailable/)
  assert.deepEqual(rerendered.artifact.provenance, generated.artifact.provenance)
  assert.equal(rerendered.artifact.plannerSucceeded, false)
  assert.equal(rerendered.artifact.status, 'degraded')
})

test('executable model content and non-finite numeric plans are rejected without a fake fallback', async () => {
  await assert.rejects(() => generateLearningVisual('diagram', '展示函数', async () => JSON.stringify({
    kind: 'diagram', title: '危险', domain: 'mathematics', abstraction: 'derivation',
    semantic: { type: 'derivation', steps: [{ id: 's1', expression: 'eval(x)', relation: 'definition', reason: '', changedTerms: [] }] }, state: {},
  })), /visual_generation_unavailable:.*executable_content_rejected/)

  await assert.rejects(() => generatePlan('diagram', '画函数', {
    kind: 'diagram', title: '超界', domain: 'mathematics', abstraction: 'function',
    semantic: { type: 'function', axes: { xLabel: 'x', yLabel: 'y', xDomain: [-2, 2], yDomain: [0, 4] }, series: [{ id: 'curve', label: 'curve', points: [[0, 0], [1, 1e50]] }], parameters: [] }, state: {},
  }), /visual_generation_unavailable:.*number_invalid/)
})

test('deterministic layout keeps an eight-node gold fixture in bounds without collision', async () => {
  const entities = Array.from({ length: 8 }, (_, index) => ({ id: `n${index}`, label: `节点${index}` }))
  const generated = await generatePlan('diagram', '八个独立节点', {
    kind: 'diagram', title: '八节点布局', domain: 'computer', abstraction: 'system_structure',
    semantic: { type: 'system_structure', entities, relations: [] }, state: {},
  })
  assert.equal(generated.plannerSucceeded, true)
  assert.deepEqual(generated.quality.layout, { collisions: 0, outOfBounds: 0 })
  assert.match(generated.artifact.steps[0].svg, /viewBox="0 0 800 450"/)
})

test('every gold fixture validates, renders and replays without a model or network', () => {
  for (const [name, payload] of Object.entries(GOLD_VISUAL_FIXTURES)) {
    const expectedKind = payload.kind === 'animation' ? 'animation' : 'diagram'
    const spec = readLearningVisualSpec(payload, expectedKind, `gold:${name}`)
    const quality = inspectLearningVisualSpec(spec)
    const rendered = visualSpecToArtifact(spec)

    assert.notEqual(quality.status, 'rejected', name)
    assert.equal(rendered.quality.layout.collisions, 0, name)
    assert.equal(rendered.quality.layout.outOfBounds, 0, name)
    assert.match(rendered.artifact.steps[0].svg, /^<svg/, name)
    if (spec.version === 'learnflow.visual.v3' && spec.kind === 'animation') {
      assert.ok(quality.semanticChanges >= 1, name)
      assert.deepEqual(replayAnimation(spec).finalState, spec.finalState, name)
    }
  }
})

test('a semantic plan that fails the deterministic layout gate is not displayed', async () => {
  const entities = Array.from({ length: 24 }, (_, index) => ({ id: `n${index}`, label: `节点${index}` }))
  await assert.rejects(() => generatePlan('diagram', '画出二十四个系统节点', {
    kind: 'diagram', title: '过密布局', domain: 'computer', abstraction: 'system_structure',
    semantic: { type: 'system_structure', entities, relations: [] }, state: {},
  }), /visual_generation_unavailable:.*visual_spec_quality_gate:layout_collisions/)
})

test('artifact replay survives JSON round-trip with provenance and quality report intact', async () => {
  const generated = await generatePlan('diagram', '静态系统图', {
    kind: 'diagram', title: '系统图', domain: 'computer', abstraction: 'system_structure',
    semantic: { type: 'system_structure', entities: [{ id: 'input', label: '输入' }, { id: 'core', label: '核心' }], relations: [{ id: 'flow', from: 'input', to: 'core', kind: 'flow' }] }, state: {},
  })
  const persisted = JSON.parse(JSON.stringify(generated.artifact)) as typeof generated.artifact
  const replayed = readLearningVisualSpec(persisted.replay.spec, 'diagram', persisted.provenance.requestText)
  const rerendered = visualSpecToArtifact(replayed)
  assert.equal(rerendered.artifact.provenance.requestHash, persisted.provenance.requestHash)
  assert.equal(rerendered.artifact.renderer, persisted.renderer)
  assert.deepEqual(rerendered.quality.layout, persisted.quality.layout)
  assert.equal(rerendered.artifact.readable.summary, persisted.readable.summary)
})

test('a one-node topic anchor is rejected as non-instructional', async () => {
  await assert.rejects(() => generatePlan('diagram', '未知系统主题', {
    kind: 'diagram', title: '未知系统主题', domain: 'computer', abstraction: 'system_structure',
    semantic: { type: 'system_structure', entities: [{ id: 'topic', label: '未知系统主题' }], relations: [] }, state: {},
  }), /visual_generation_unavailable:.*insufficient_semantic_structure/)
})

test('VisualArtifact source exposes keyboard, pause, live frame text and reduced-motion contracts', async () => {
  const source = await readFile(new URL('../src/VisualArtifact.tsx', import.meta.url), 'utf8')
  const gateStyles = await readFile(new URL('../src/visual-artifact-gate.css', import.meta.url), 'utf8')
  assert.match(source, /prefers-reduced-motion: reduce/)
  assert.match(source, /onKeyDown=\{handleKeyboard\}/)
  assert.match(source, /aria-live="polite"/)
  assert.match(source, /aria-pressed=\{playing\}/)
  assert.match(source, /currentAccessibleSummary = isAnimation \? frameDescription : summary/)
  assert.match(source, /!isAnimation && artifact\.subtitle/)
  assert.match(source, /aria-label="重新开始"/)
  assert.match(source, /暂停/)
  assert.match(source, /nonColorStateCue/)
  assert.match(gateStyles, /overflow-x:\s*auto/)
  assert.match(gateStyles, /min-width:\s*900px/)
  assert.match(gateStyles, /max-height:\s*none/)
})
