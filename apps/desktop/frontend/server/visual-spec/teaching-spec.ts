import {
  PROMPT_VERSION,
  RENDERER_VERSION,
  VISUAL_VERSION,
  type EventLoopSemantic,
  type ConvolutionTraceSemantic,
  type GraphAlgorithmSemantic,
  type LearningVisualFrame,
  type LearningVisualSpec,
  type MatrixOperationSemantic,
  type NaturalFrequencySemantic,
  type OptimizationSemantic,
  type VisualPredictionGate,
} from './types.ts'
import { deriveConvolution, deriveDijkstra, deriveEventLoop, deriveOptimization, derivedTraceLength } from './derived.ts'
import { emptyState, generationReport, provenance } from './validation.ts'
import type { TeachingDerivation } from './teaching-compiler.ts'
import { TEACHING_COMPILER_ID, TEACHING_COMPILER_VERSION } from './teaching-compiler.ts'

function base(request: string) {
  return {
    version: VISUAL_VERSION,
    provenance: provenance(request),
    generation: { ...generationReport('deterministic_compiler', true, []), compiler: { id: TEACHING_COMPILER_ID, version: TEACHING_COMPILER_VERSION } },
  } as const
}

function stableId(value: string, fallback: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 28)
  return normalized || fallback
}

function stableIdMap(values: string[], fallback: string) {
  const used = new Set<string>()
  const output = new Map<string, string>()
  values.forEach((value, index) => {
    const base = stableId(value, fallback)
    let candidate = base
    let attempt = index + 1
    while (used.has(candidate)) {
      const suffix = `_${attempt}`
      candidate = `${base.slice(0, 35 - suffix.length)}${suffix}`
      attempt += 1
    }
    used.add(candidate)
    output.set(value, candidate)
  })
  return output
}

function animationTimeline(semantic: GraphAlgorithmSemantic | EventLoopSemantic | OptimizationSemantic | ConvolutionTraceSemantic, frames: LearningVisualFrame[]) {
  const lastStep = derivedTraceLength(semantic) - 1
  const initialState = emptyState()
  initialState.values[semantic.id] = 0
  const finalState = emptyState()
  finalState.values[semantic.id] = lastStep
  finalState.activeIds = [semantic.id]
  return {
    kind: 'animation' as const,
    initialState,
    frames,
    invariants: [{ type: 'final_state_value' as const, targetId: semantic.id, equals: lastStep }],
    finalState,
  }
}

function convolutionSpec(derivation: Extract<TeachingDerivation, { type: 'convolution_trace' }>): LearningVisualSpec | undefined {
  const semantic: ConvolutionTraceSemantic = {
    type: 'convolution_trace', id: 'convolution_trace',
    input: { id: 'input_image', label: '输入图像', values: derivation.input.input },
    kernel: { id: 'edge_kernel', label: '竖直边缘卷积核', values: derivation.input.kernel },
    outputId: 'feature_map', stride: derivation.input.stride, padding: 0,
    bias: derivation.input.bias, activation: 'relu', poolSize: 2,
  }
  const trace = deriveConvolution(semantic)
  const common = {
    ...base(derivation.input.request), domain: 'computer' as const, abstraction: 'convolution_trace' as const, semantic,
    title: 'CNN：卷积核如何形成特征图',
    subtitle: derivation.kind === 'animation' ? '滑动窗口 → 乘加 → ReLU → 最大池化' : '卷积、激活与池化的确定性结果',
    explanation: '每个特征图单元都由对应输入窗口与卷积核逐项相乘后求和得到；ReLU 和最大池化结果由代码确定性计算。',
    accessibility: {
      summary: `输入为 ${semantic.input.values.length}×${semantic.input.values[0].length}，卷积核为 ${semantic.kernel.values.length}×${semantic.kernel.values[0].length}，得到 ${trace.output.length}×${trace.output[0].length} 特征图，再经过 ReLU 与 2×2 最大池化。`,
      readingOrder: [semantic.id, semantic.input.id, semantic.kernel.id, semantic.outputId],
      nonColorStateCue: '当前输入窗口和输出单元格同时使用粗边框、坐标与乘加算式标注。',
    },
  }
  if (derivation.kind === 'diagram') {
    const state = emptyState()
    state.values[semantic.id] = trace.snapshots.length - 1
    state.activeIds = [semantic.id]
    return { ...common, kind: 'diagram', state }
  }
  const frames: LearningVisualFrame[] = trace.snapshots.slice(1).map(snapshot => ({
    id: `convolution_step_${snapshot.step}`,
    title: snapshot.phase === 'convolution'
      ? `计算特征图 [${snapshot.outputRow}, ${snapshot.outputColumn}]`
      : snapshot.phase === 'relu' ? '应用 ReLU' : '执行 2×2 最大池化',
    narration: snapshot.phase === 'convolution'
      ? `${snapshot.products?.join(' + ')} + bias ${semantic.bias} = ${snapshot.sum}。`
      : snapshot.phase === 'relu' ? '负响应归零，正响应保持不变。' : '每个 2×2 区域保留最大响应。',
    durationMs: 1250,
    patches: [{ type: 'set_trace_step', semanticId: semantic.id, step: snapshot.step }],
  }))
  return { ...common, ...animationTimeline(semantic, frames) }
}

function prediction(id: string, prompt: string, choices: Array<{ id: string; label: string }>, correctChoiceId: string, explanation: string): VisualPredictionGate {
  return { id, prompt, choices, correctChoiceId, explanation }
}

function matrixSpec(derivation: Extract<TeachingDerivation, { type: 'matrix_multiplication' }>): LearningVisualSpec | undefined {
  if (derivation.kind !== 'diagram') return undefined
  const { A, B } = derivation.input.matrices
  const semantic: MatrixOperationSemantic = {
    type: 'matrix_operation', id: 'matrix_product', operation: 'multiply',
    left: { id: 'matrix_a', label: 'A', values: A },
    right: { id: 'matrix_b', label: 'B', values: B },
    resultId: 'matrix_c',
    focus: derivation.input.focus ? { row: derivation.input.focus.row - 1, column: derivation.input.focus.column - 1 } : undefined,
    transferPrompt: `如果 A 改为 ${A.length + 3}×${A[0].length}，而 B 不变，输出形状是什么？`,
  }
  const state = emptyState()
  return {
    ...base(derivation.input.request), kind: 'diagram', domain: 'mathematics', abstraction: 'matrix_operation', semantic, state,
    title: '矩阵乘法：形状与单元格来源', subtitle: '内维必须相等，外维决定输出形状',
    explanation: '结果与点积展开均由输入矩阵确定性计算，不由模型填写。',
    accessibility: {
      summary: `A 是 ${A.length}×${A[0].length}，B 是 ${B.length}×${B[0].length}；内维相等，结果是 ${A.length}×${B[0].length}。`,
      readingOrder: [semantic.id, semantic.left.id, semantic.right.id, semantic.resultId],
      nonColorStateCue: '焦点行、列和结果格同时使用文字标签、边框线型与点积公式，不只依赖颜色。',
    },
  }
}

function graphFrames(semantic: GraphAlgorithmSemantic): LearningVisualFrame[] {
  const trace = deriveDijkstra(semantic)
  const labels = new Map(semantic.nodes.map(node => [node.id, node.label]))
  const label = (nodeId: string | null | undefined) => nodeId ? labels.get(nodeId) || nodeId : '—'
  const frames: LearningVisualFrame[] = []
  trace.snapshots.slice(1).forEach((snapshot, index) => {
    frames.push({
      id: `graph_step_${snapshot.step}`,
      title: `确定 ${label(snapshot.currentId)}`,
      narration: snapshot.updates.length
        ? snapshot.updates.map(update => `${label(update.nodeId)}: ${update.before ?? '∞'} → ${update.after}，前驱改为 ${label(update.parentId)}`).join('；')
        : `${label(snapshot.currentId)} 的最短距离已确定。`,
      durationMs: 1500,
      patches: [{ type: 'set_trace_step', semanticId: semantic.id, step: snapshot.step }],
    })
    if (index === 0 && trace.snapshots[2]?.currentId) {
      const finite = Object.entries(snapshot.distances).filter(([nodeId, distance]) => !snapshot.settledIds.includes(nodeId) && distance !== null)
        .sort((left, right) => (left[1]! - right[1]!)).slice(0, 3)
      const correct = trace.snapshots[2].currentId!
      const choices = finite.map(([nodeId, distance], choiceIndex) => ({ id: `choice_${choiceIndex + 1}`, label: `${label(nodeId)}（距离 ${distance}）`, nodeId }))
      const correctChoice = choices.find(choice => choice.nodeId === correct)
      if (choices.length >= 2 && correctChoice) frames.push({
        id: 'graph_prediction_next', title: '先预测下一结点', narration: '在揭晓前比较所有未确定结点的 tentative distance。', durationMs: 1200, patches: [],
        prediction: prediction('gate_graph_next', '下一步应确定哪个结点？', choices.map(({ id, label: choiceLabel }) => ({ id, label: choiceLabel })), correctChoice.id, `Dijkstra 每次选择尚未确定且 tentative distance 最小的结点，因此选择 ${label(correct)}。`),
      })
    }
  })
  return frames
}

function graphSpec(derivation: Extract<TeachingDerivation, { type: 'dijkstra' }>): LearningVisualSpec | undefined {
  if (!derivation.input.target) return undefined
  const nodeIds = stableIdMap(derivation.input.nodes, 'node')
  const idFor = (node: string) => nodeIds.get(node)!
  const semantic: GraphAlgorithmSemantic = {
    type: 'graph_algorithm', id: 'dijkstra_trace', algorithm: 'dijkstra', directed: derivation.input.directed,
    nodes: derivation.input.nodes.map(nodeId => ({ id: idFor(nodeId), label: nodeId })),
    edges: derivation.input.edges.map(edge => ({ ...edge, from: idFor(edge.from), to: idFor(edge.to) })),
    sourceId: idFor(derivation.input.source), targetId: idFor(derivation.input.target),
    transferPrompt: derivation.input.edges[0] ? `如果边 ${derivation.input.edges[0].from}→${derivation.input.edges[0].to} 的权重改变，哪些 tentative distance 需要重新比较？` : undefined,
  }
  const trace = deriveDijkstra(semantic)
  const labels = new Map(semantic.nodes.map(node => [node.id, node.label]))
  const pathLabel = trace.pathNodeIds.map(nodeId => labels.get(nodeId) || nodeId).join('→')
  const common = {
    ...base(derivation.input.request), domain: 'computer' as const, abstraction: 'graph_algorithm' as const, semantic,
    title: 'Dijkstra：距离、前驱与最短路径',
    subtitle: derivation.kind === 'diagram' ? `${labels.get(semantic.sourceId)} → ${labels.get(semantic.targetId)}，总代价 ${trace.cost}` : '逐步比较 tentative distance 与 parent',
    explanation: '距离、前驱、确定顺序和最终路径均由输入带权图运行参考算法得到。',
    accessibility: {
      summary: `确定顺序为 ${trace.settledOrder.map(nodeId => labels.get(nodeId) || nodeId).join('、')}；最短路径为 ${pathLabel}，总代价 ${trace.cost}。`,
      readingOrder: [semantic.id, ...semantic.nodes.map(node => node.id), ...semantic.edges.map(edge => edge.id)],
      nonColorStateCue: '当前、frontier、settled 和最短路径同时使用文字、勾号、线型与粗细表示。',
    },
  }
  if (derivation.kind === 'diagram') {
    const state = emptyState()
    state.values[semantic.id] = derivedTraceLength(semantic) - 1
    return { ...common, kind: 'diagram', state }
  }
  const frames = graphFrames(semantic)
  if (frames.length > 12) return undefined
  return { ...common, ...animationTimeline(semantic, frames) }
}

function naturalFrequencySpec(derivation: Extract<TeachingDerivation, { type: 'natural_frequency_bayes' }>): LearningVisualSpec | undefined {
  if (derivation.kind !== 'diagram') return undefined
  const semantic: NaturalFrequencySemantic = {
    type: 'natural_frequency', id: 'natural_frequency', population: derivation.input.population,
    prevalence: derivation.input.prevalence, sensitivity: derivation.input.sensitivity, specificity: derivation.input.specificity,
    conditionLabel: '患病', positiveLabel: '检测阳性',
    predictionPrompt: '阳性后的患病概率更接近灵敏度，还是由所有阳性的组成决定？',
  }
  return {
    ...base(derivation.input.request), kind: 'diagram', domain: 'mathematics', abstraction: 'natural_frequency', semantic, state: emptyState(),
    title: '阳性不等于患病：自然频数', subtitle: '先数所有阳性，再确定其中真正患病的人数',
    explanation: '四格计数、阳性总数与后验比例均由总体和三项率确定性推导。',
    accessibility: {
      summary: `在 ${derivation.input.population} 人中，真阳性 ${derivation.derived.truePositive}，假阳性 ${derivation.derived.falsePositive}，所有阳性 ${derivation.derived.positive}，阳性后患病概率约 ${(derivation.derived.posterior * 100).toFixed(1)}%。`,
      readingOrder: [semantic.id],
      nonColorStateCue: '真阳性、假阳性、假阴性和真阴性均有完整文字标签；阳性组成还按真实宽度比例编码。',
    },
  }
}

function eventLoopSpec(derivation: Extract<TeachingDerivation, { type: 'js_event_loop' }>): LearningVisualSpec | undefined {
  const lines = derivation.input.codeLines.map((line, index) => ({ id: `line_${index + 1}`, number: line.number, text: line.text }))
  const lineIds = new Map(derivation.input.codeLines.map((line, index) => [line.number, lines[index].id]))
  if (derivation.input.events.some(event => !lineIds.has(event.sourceLineNumber))) return undefined
  const semantic: EventLoopSemantic = {
    type: 'event_loop', id: 'event_loop_trace', language: 'javascript', lines,
    operations: derivation.input.events.map((event, index) => ({
      id: event.queue === 'microtask' ? `microtask_${index + 1}` : event.queue === 'task' ? `task_${index + 1}` : `sync_${index + 1}`,
      lineId: lineIds.get(event.sourceLineNumber)!, kind: event.queue, output: event.output, order: index + 1,
      label: event.queue === 'microtask' ? `Promise callback → ${event.output}` : event.queue === 'task' ? `Timer callback → ${event.output}` : `同步输出 ${event.output}`,
    })),
  }
  const common = {
    ...base(derivation.input.request), domain: 'computer' as const, abstraction: 'event_loop' as const, semantic,
    title: 'JavaScript 事件循环', subtitle: derivation.kind === 'diagram' ? '同步脚本、微任务与任务队列的最终关系' : '同步脚本 → 微任务 → 下一轮任务',
    explanation: '同步代码、微任务与任务按参考调度器派生；callback 在不同区域保持同一稳定 ID。',
    accessibility: {
      summary: `同步输出先发生；主任务结束后清空微任务，再进入下一轮任务。最终输出 ${derivation.derived.outputOrder.join('、')}。`,
      readingOrder: [semantic.id, ...semantic.lines.map(line => line.id), ...semantic.operations.map(operation => operation.id)],
      nonColorStateCue: '每个 callback token 保持稳定文字 ID，所在区域、队列名和当前状态均显式显示。',
    },
  }
  if (derivation.kind === 'diagram') {
    const state = emptyState()
    state.values[semantic.id] = derivedTraceLength(semantic) - 1
    state.activeIds = [semantic.id]
    return { ...common, kind: 'diagram', state }
  }
  const trace = deriveEventLoop(semantic)
  const frames: LearningVisualFrame[] = []
  const revealIndex = trace.snapshots.findIndex(snapshot => snapshot.phase === 'drain_microtasks')
  trace.snapshots.slice(1).forEach(snapshot => {
    if (snapshot.step === revealIndex) {
      const micro = semantic.operations.find(operation => operation.kind === 'microtask')
      const task = semantic.operations.find(operation => operation.kind === 'task')
      if (micro && task) frames.push({
        id: 'event_prediction_next', title: '先预测下一输出', narration: '主脚本已经结束，两个队列都存在待执行回调。', durationMs: 1200, patches: [],
        prediction: prediction('gate_event_next', `下一个输出是 ${task.output} 还是 ${micro.output}？`, [{ id: 'choice_task', label: task.output }, { id: 'choice_microtask', label: micro.output }], 'choice_microtask', `当前任务结束后先清空微任务队列，所以 ${micro.output} 先于 ${task.output}。`),
      })
    }
    frames.push({
      id: `event_step_${snapshot.step}`, title: snapshot.phase === 'complete' ? '完成' : snapshot.phase === 'drain_microtasks' ? '清空微任务' : snapshot.phase === 'next_task' ? '进入下一轮任务' : '执行主脚本',
      narration: `输出为 ${snapshot.output.length ? snapshot.output.join('、') : '空'}；微任务 ${snapshot.microtasks.length} 个，任务 ${snapshot.tasks.length} 个。`,
      durationMs: 1300, patches: [{ type: 'set_trace_step', semanticId: semantic.id, step: snapshot.step }],
    })
  })
  if (frames.length > 12) return undefined
  return {
    ...common, ...animationTimeline(semantic, frames),
  }
}

function optimizationSpec(derivation: Extract<TeachingDerivation, { type: 'quadratic_gradient_descent' }>): LearningVisualSpec | undefined {
  if (derivation.input.updates > 5) return undefined
  const traceXValues = [derivation.input.center, ...derivation.derived.points.map(point => point.x)]
  const traceMinimumX = Math.min(...traceXValues)
  const traceMaximumX = Math.max(...traceXValues)
  const traceSpan = traceMaximumX - traceMinimumX
  const xPadding = Math.max(1, traceSpan * 0.1)
  const xDomain: [number, number] = [
    traceMinimumX - xPadding,
    traceMaximumX + xPadding,
  ]
  const yMaximum = Math.max(
    ...derivation.derived.points.map(point => point.y),
    (xDomain[0] - derivation.input.center) ** 2,
    (xDomain[1] - derivation.input.center) ** 2,
    1,
  ) * 1.08
  const semantic: OptimizationSemantic = {
    type: 'optimization', id: 'optimization_trace', objective: 'squared_distance', center: derivation.input.center,
    initialX: derivation.input.x0, learningRate: derivation.input.alpha, iterations: derivation.input.updates,
    axes: {
      xLabel: 'x', yLabel: 'f(x)',
      xDomain,
      yDomain: [0, yMaximum],
    },
  }
  const trace = deriveOptimization(semantic)
  const common = {
    ...base(derivation.input.request), domain: 'mathematics' as const, abstraction: 'optimization' as const, semantic,
    title: '梯度下降：方向与步长', subtitle: `f(x)=(x−${semantic.center})²，α=${semantic.learningRate}`,
    explanation: '曲线、坐标轴和相机固定；每个点、梯度与更新量均由同一递推式计算。',
    accessibility: {
      summary: `从 x=${semantic.initialX} 出发，${semantic.iterations} 次更新后到 x=${trace.points[trace.points.length - 1]?.x}；点逐步接近最小值 x=${semantic.center}。`,
      readingOrder: [semantic.id],
      nonColorStateCue: '当前点、历史点、切线和更新箭头使用稳定 ID、文字数值与不同线型共同表达。',
    },
  }
  if (derivation.kind === 'diagram') {
    const state = emptyState()
    state.values[semantic.id] = derivedTraceLength(semantic) - 1
    state.activeIds = [semantic.id]
    return { ...common, kind: 'diagram', state }
  }
  const frames: LearningVisualFrame[] = []
  trace.snapshots.slice(1).forEach(snapshot => {
    if (snapshot.phase === 'gradient' && snapshot.iteration === 0 && Math.abs(trace.points[0].gradient) > 1e-12) {
      const correct = trace.points[1].x
      const distractor = semantic.initialX + semantic.learningRate * trace.points[0].gradient
      frames.push({
        id: 'optimization_prediction_first', title: '先预测第一步', narration: '先使用 x₁=x₀−αg₀ 判断移动方向与位置。', durationMs: 1200, patches: [],
        prediction: prediction('gate_optimization_first', '第一步更新后的 x₁ 是多少？', [{ id: 'choice_correct', label: String(correct) }, { id: 'choice_sign_error', label: String(distractor) }], 'choice_correct', `g₀=${trace.points[0].gradient}，所以 Δx=−${semantic.learningRate}×(${trace.points[0].gradient})=${trace.points[0].delta}，x₁=${correct}。`),
      })
    }
    frames.push({
      id: `optimization_step_${snapshot.step}`,
      title: snapshot.phase === 'gradient' ? `第 ${snapshot.iteration + 1} 步：读梯度` : snapshot.phase === 'move' ? `移动到 x=${snapshot.point.x}` : '收敛规律',
      narration: snapshot.phase === 'gradient' ? `当前梯度 ${snapshot.point.gradient}，更新量 ${snapshot.point.delta}。` : `当前 x=${snapshot.point.x}，f(x)=${snapshot.point.y}。`,
      durationMs: 1300, patches: [{ type: 'set_trace_step', semanticId: semantic.id, step: snapshot.step }],
    })
  })
  return {
    ...common, ...animationTimeline(semantic, frames),
  }
}

export function teachingDerivationToSpec(derivation: TeachingDerivation): LearningVisualSpec | undefined {
  if (derivation.type === 'derivation_failure') throw new Error(`visual_deterministic_derivation_failed:${derivation.derived.code}`)
  const spec = derivation.type === 'matrix_multiplication' ? matrixSpec(derivation)
    : derivation.type === 'dijkstra' ? graphSpec(derivation)
      : derivation.type === 'natural_frequency_bayes' ? naturalFrequencySpec(derivation)
        : derivation.type === 'js_event_loop' ? eventLoopSpec(derivation)
          : derivation.type === 'quadratic_gradient_descent' ? optimizationSpec(derivation)
            : derivation.type === 'convolution_trace' ? convolutionSpec(derivation)
            : undefined
  if (!spec || !derivation.input.request.includes('【教学示例参数】')) return spec
  return {
    ...spec,
    title: `教学示例：${spec.title}`,
    subtitle: `以下数值和对象是为解释机制选取的示例；${spec.subtitle}`,
    explanation: `原请求没有提供完整可计算输入，因此使用明确标注的教学示例，不代表学习者自己的数据。${spec.explanation}`,
    accessibility: {
      ...spec.accessibility,
      summary: `这是教学示例，不代表学习者自己的数据。${spec.accessibility.summary}`,
    },
  }
}

export const TEACHING_RUNTIME_VERSIONS = { schema: VISUAL_VERSION, prompt: PROMPT_VERSION, renderer: RENDERER_VERSION }
