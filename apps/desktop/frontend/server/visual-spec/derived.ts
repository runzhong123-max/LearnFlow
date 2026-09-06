import type {
  ComputerVisualSemantic,
  ConvolutionTraceSemantic,
  EventLoopSemantic,
  GraphAlgorithmSemantic,
  MathematicsVisualSemantic,
  MatrixOperationSemantic,
  NaturalFrequencySemantic,
  OptimizationSemantic,
} from './types.ts'

export type MatrixDerivation = {
  result: number[][]
  focus?: { row: number; column: number; terms: Array<{ left: number; right: number; product: number }>; value: number }
}

export function deriveMatrixOperation(semantic: MatrixOperationSemantic): MatrixDerivation {
  const leftRows = semantic.left.values.length
  const leftColumns = semantic.left.values[0]?.length || 0
  const rightRows = semantic.right.values.length
  const rightColumns = semantic.right.values[0]?.length || 0
  if (!leftRows || !leftColumns || !rightRows || !rightColumns) throw new Error('matrix_empty')
  if (semantic.left.values.some(row => row.length !== leftColumns) || semantic.right.values.some(row => row.length !== rightColumns)) throw new Error('matrix_not_rectangular')
  if ([...semantic.left.values, ...semantic.right.values].some(row => row.some(value => !Number.isFinite(value)))) throw new Error('matrix_non_finite_input')
  if (leftColumns !== rightRows) throw new Error('matrix_inner_dimension_mismatch')
  const result = Array.from({ length: leftRows }, (_, row) => Array.from({ length: rightColumns }, (_, column) => (
    semantic.left.values[row].reduce((sum, value, index) => {
      const product = value * semantic.right.values[index][column]
      const next = sum + product
      if (!Number.isFinite(product) || !Number.isFinite(next)) throw new Error('matrix_result_non_finite')
      return next
    }, 0)
  )))
  if (!semantic.focus) return { result }
  const { row, column } = semantic.focus
  if (row < 0 || row >= leftRows || column < 0 || column >= rightColumns) throw new Error('matrix_focus_out_of_bounds')
  const terms = semantic.left.values[row].map((left, index) => ({ left, right: semantic.right.values[index][column], product: left * semantic.right.values[index][column] }))
  return { result, focus: { row, column, terms, value: result[row][column] } }
}

export type DijkstraUpdate = {
  nodeId: string
  edgeId: string
  before: number | null
  after: number
  parentId: string
}

export type DijkstraSnapshot = {
  step: number
  currentId?: string
  settledIds: string[]
  distances: Record<string, number | null>
  parents: Record<string, string | null>
  updates: DijkstraUpdate[]
}

export type DijkstraDerivation = {
  snapshots: DijkstraSnapshot[]
  distances: Record<string, number | null>
  parents: Record<string, string | null>
  settledOrder: string[]
  pathNodeIds: string[]
  pathEdgeIds: string[]
  cost: number | null
}

export function deriveDijkstra(semantic: GraphAlgorithmSemantic): DijkstraDerivation {
  if (semantic.edges.some(edge => !Number.isFinite(edge.weight) || edge.weight < 0)) throw new Error('dijkstra_weight_invalid')
  const nodeOrder = new Map(semantic.nodes.map((node, index) => [node.id, index]))
  const distances: Record<string, number | null> = Object.fromEntries(semantic.nodes.map(node => [node.id, node.id === semantic.sourceId ? 0 : null]))
  const parents: Record<string, string | null> = Object.fromEntries(semantic.nodes.map(node => [node.id, null]))
  const settled = new Set<string>()
  const snapshots: DijkstraSnapshot[] = [{ step: 0, settledIds: [], distances: { ...distances }, parents: { ...parents }, updates: [] }]

  while (settled.size < semantic.nodes.length) {
    const candidates = semantic.nodes
      .filter(node => !settled.has(node.id) && distances[node.id] !== null)
      .sort((left, right) => (distances[left.id]! - distances[right.id]!) || (nodeOrder.get(left.id)! - nodeOrder.get(right.id)!))
    const current = candidates[0]
    if (!current) break
    settled.add(current.id)
    const updates: DijkstraUpdate[] = []
    const outgoing = semantic.edges.flatMap(edge => {
      if (edge.from === current.id) return [{ edge, neighborId: edge.to }]
      if (!semantic.directed && edge.to === current.id) return [{ edge, neighborId: edge.from }]
      return []
    })
    for (const { edge, neighborId } of outgoing) {
      if (settled.has(neighborId)) continue
      const candidate = distances[current.id]! + edge.weight
      const before = distances[neighborId]
      if (before === null || candidate < before) {
        distances[neighborId] = candidate
        parents[neighborId] = current.id
        updates.push({ nodeId: neighborId, edgeId: edge.id, before, after: candidate, parentId: current.id })
      }
    }
    snapshots.push({ step: snapshots.length, currentId: current.id, settledIds: [...settled], distances: { ...distances }, parents: { ...parents }, updates })
    if (current.id === semantic.targetId) break
  }

  const pathNodeIds: string[] = []
  if (distances[semantic.targetId] !== null) {
    let cursor: string | null = semantic.targetId
    const guard = new Set<string>()
    while (cursor) {
      if (guard.has(cursor)) throw new Error('dijkstra_parent_cycle')
      guard.add(cursor)
      pathNodeIds.unshift(cursor)
      if (cursor === semantic.sourceId) break
      cursor = parents[cursor]
    }
    if (pathNodeIds[0] !== semantic.sourceId) pathNodeIds.length = 0
  }
  const pathEdgeIds: string[] = []
  for (let index = 1; index < pathNodeIds.length; index += 1) {
    const from = pathNodeIds[index - 1]
    const to = pathNodeIds[index]
    const edge = semantic.edges.find(item => item.from === from && item.to === to)
      || (!semantic.directed ? semantic.edges.find(item => item.from === to && item.to === from) : undefined)
    if (!edge) throw new Error('dijkstra_path_edge_missing')
    pathEdgeIds.push(edge.id)
  }
  return {
    snapshots,
    distances: { ...distances },
    parents: { ...parents },
    settledOrder: snapshots.slice(1).map(snapshot => snapshot.currentId!),
    pathNodeIds,
    pathEdgeIds,
    cost: distances[semantic.targetId],
  }
}

export type NaturalFrequencyDerivation = {
  condition: number
  noCondition: number
  truePositive: number
  falseNegative: number
  falsePositive: number
  trueNegative: number
  positives: number
  posterior: number
}

export function deriveNaturalFrequency(semantic: NaturalFrequencySemantic): NaturalFrequencyDerivation {
  const condition = Math.round(semantic.population * semantic.prevalence)
  const noCondition = semantic.population - condition
  const truePositive = Math.round(condition * semantic.sensitivity)
  const falseNegative = condition - truePositive
  const trueNegative = Math.round(noCondition * semantic.specificity)
  const falsePositive = noCondition - trueNegative
  const positives = truePositive + falsePositive
  if (positives <= 0) throw new Error('natural_frequency_no_positive_cases')
  return { condition, noCondition, truePositive, falseNegative, falsePositive, trueNegative, positives, posterior: truePositive / positives }
}

export type EventLoopSnapshot = {
  step: number
  activeLineId?: string
  callStack: string[]
  webApi: string[]
  microtasks: string[]
  tasks: string[]
  output: string[]
  activeOperationId?: string
  phase: 'initial' | 'script' | 'drain_microtasks' | 'next_task' | 'complete'
}

export type EventLoopDerivation = { snapshots: EventLoopSnapshot[]; output: string[] }

export function deriveEventLoop(semantic: EventLoopSemantic): EventLoopDerivation {
  const snapshots: EventLoopSnapshot[] = [{ step: 0, callStack: ['main'], webApi: [], microtasks: [], tasks: [], output: [], phase: 'initial' }]
  const microtasks: string[] = []
  const webApi: string[] = []
  const output: string[] = []
  for (const operation of [...semantic.operations].sort((left, right) => left.order - right.order)) {
    if (operation.kind === 'sync') output.push(operation.output)
    else if (operation.kind === 'microtask') microtasks.push(operation.id)
    else webApi.push(operation.id)
    snapshots.push({
      step: snapshots.length,
      activeLineId: operation.lineId,
      callStack: ['main'],
      webApi: [...webApi],
      microtasks: [...microtasks],
      tasks: [],
      output: [...output],
      activeOperationId: operation.id,
      phase: 'script',
    })
  }
  const tasks = [...webApi]
  webApi.length = 0
  snapshots.push({ step: snapshots.length, callStack: [], webApi: [], microtasks: [...microtasks], tasks: [...tasks], output: [...output], phase: 'script' })
  while (microtasks.length) {
    const operationId = microtasks.shift()!
    const operation = semantic.operations.find(item => item.id === operationId)!
    output.push(operation.output)
    snapshots.push({ step: snapshots.length, activeLineId: operation.lineId, callStack: [operationId], webApi: [], microtasks: [...microtasks], tasks: [...tasks], output: [...output], activeOperationId: operationId, phase: 'drain_microtasks' })
  }
  while (tasks.length) {
    const operationId = tasks.shift()!
    const operation = semantic.operations.find(item => item.id === operationId)!
    output.push(operation.output)
    snapshots.push({ step: snapshots.length, activeLineId: operation.lineId, callStack: [operationId], webApi: [], microtasks: [], tasks: [...tasks], output: [...output], activeOperationId: operationId, phase: 'next_task' })
  }
  snapshots.push({ step: snapshots.length, callStack: [], webApi: [], microtasks: [], tasks: [], output: [...output], phase: 'complete' })
  return { snapshots, output }
}

export type OptimizationPoint = { step: number; x: number; y: number; gradient: number; delta: number | null }
export type OptimizationSnapshot = {
  step: number
  phase: 'initial' | 'gradient' | 'move' | 'summary'
  iteration: number
  point: OptimizationPoint
  nextX?: number
  history: OptimizationPoint[]
}
export type OptimizationDerivation = { points: OptimizationPoint[]; snapshots: OptimizationSnapshot[] }

export type ConvolutionSnapshot = {
  step: number
  phase: 'initial' | 'convolution' | 'relu' | 'pool'
  outputRow?: number
  outputColumn?: number
  inputRow?: number
  inputColumn?: number
  products?: number[]
  sum?: number
  convolution: Array<Array<number | null>>
  activated?: number[][]
  pooled?: number[][]
}

export type ConvolutionDerivation = {
  output: number[][]
  activated: number[][]
  pooled: number[][]
  snapshots: ConvolutionSnapshot[]
}

export function deriveConvolution(semantic: ConvolutionTraceSemantic): ConvolutionDerivation {
  const inputRows = semantic.input.values.length
  const inputColumns = semantic.input.values[0]?.length || 0
  const kernelRows = semantic.kernel.values.length
  const kernelColumns = semantic.kernel.values[0]?.length || 0
  if (!inputRows || !inputColumns || !kernelRows || !kernelColumns) throw new Error('convolution_empty')
  if (semantic.input.values.some(row => row.length !== inputColumns) || semantic.kernel.values.some(row => row.length !== kernelColumns)) throw new Error('convolution_not_rectangular')
  if (inputRows < kernelRows || inputColumns < kernelColumns) throw new Error('convolution_kernel_larger_than_input')
  const outputRows = Math.floor((inputRows - kernelRows) / semantic.stride) + 1
  const outputColumns = Math.floor((inputColumns - kernelColumns) / semantic.stride) + 1
  if (outputRows * outputColumns > 9) throw new Error('convolution_trace_too_large')
  const output = Array.from({ length: outputRows }, () => Array(outputColumns).fill(0) as number[])
  const partial = Array.from({ length: outputRows }, () => Array(outputColumns).fill(null) as Array<number | null>)
  const snapshots: ConvolutionSnapshot[] = [{ step: 0, phase: 'initial', convolution: partial.map(row => [...row]) }]
  for (let row = 0; row < outputRows; row += 1) {
    for (let column = 0; column < outputColumns; column += 1) {
      const products: number[] = []
      for (let kernelRow = 0; kernelRow < kernelRows; kernelRow += 1) {
        for (let kernelColumn = 0; kernelColumn < kernelColumns; kernelColumn += 1) {
          products.push(semantic.input.values[row * semantic.stride + kernelRow][column * semantic.stride + kernelColumn] * semantic.kernel.values[kernelRow][kernelColumn])
        }
      }
      const sum = products.reduce((total, value) => total + value, semantic.bias)
      if (!Number.isFinite(sum)) throw new Error('convolution_result_non_finite')
      output[row][column] = sum
      partial[row][column] = sum
      snapshots.push({
        step: snapshots.length, phase: 'convolution', outputRow: row, outputColumn: column,
        inputRow: row * semantic.stride, inputColumn: column * semantic.stride,
        products, sum, convolution: partial.map(item => [...item]),
      })
    }
  }
  const activated = output.map(row => row.map(value => Math.max(0, value)))
  snapshots.push({ step: snapshots.length, phase: 'relu', convolution: output.map(row => [...row]), activated })
  const pooledRows = Math.floor(activated.length / semantic.poolSize)
  const pooledColumns = Math.floor(activated[0].length / semantic.poolSize)
  const pooled = Array.from({ length: pooledRows }, (_, row) => Array.from({ length: pooledColumns }, (_, column) => {
    const values: number[] = []
    for (let poolRow = 0; poolRow < semantic.poolSize; poolRow += 1) {
      for (let poolColumn = 0; poolColumn < semantic.poolSize; poolColumn += 1) values.push(activated[row * semantic.poolSize + poolRow][column * semantic.poolSize + poolColumn])
    }
    return Math.max(...values)
  }))
  snapshots.push({ step: snapshots.length, phase: 'pool', convolution: output.map(row => [...row]), activated, pooled })
  return { output, activated, pooled, snapshots }
}

export function deriveOptimization(semantic: OptimizationSemantic): OptimizationDerivation {
  const points: OptimizationPoint[] = []
  let current = semantic.initialX
  for (let step = 0; step <= semantic.iterations; step += 1) {
    const gradient = 2 * (current - semantic.center)
    const next = step < semantic.iterations ? current - semantic.learningRate * gradient : undefined
    points.push({ step, x: current, y: (current - semantic.center) ** 2, gradient, delta: next === undefined ? null : next - current })
    if (next !== undefined) current = next
  }
  const snapshots: OptimizationSnapshot[] = [{ step: 0, phase: 'initial', iteration: 0, point: points[0], history: [points[0]] }]
  for (let index = 0; index < semantic.iterations; index += 1) {
    snapshots.push({ step: snapshots.length, phase: 'gradient', iteration: index, point: points[index], nextX: points[index + 1].x, history: points.slice(0, index + 1) })
    snapshots.push({ step: snapshots.length, phase: 'move', iteration: index + 1, point: points[index + 1], history: points.slice(0, index + 2) })
  }
  snapshots.push({ step: snapshots.length, phase: 'summary', iteration: semantic.iterations, point: points[points.length - 1], history: [...points] })
  return { points, snapshots }
}

export type DerivedSemantic = MatrixOperationSemantic | GraphAlgorithmSemantic | NaturalFrequencySemantic | EventLoopSemantic | OptimizationSemantic | ConvolutionTraceSemantic

function shortestPathCostOracle(semantic: GraphAlgorithmSemantic): number | null {
  if (semantic.nodes.length > 8 || semantic.edges.length > 24) throw new Error('graph_oracle_input_too_large')
  const nodeIds = new Set(semantic.nodes.map(node => node.id))
  if (nodeIds.size !== semantic.nodes.length || !nodeIds.has(semantic.sourceId) || !nodeIds.has(semantic.targetId)) throw new Error('graph_oracle_node_invalid')
  if (semantic.edges.some(edge => !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || !Number.isFinite(edge.weight) || edge.weight < 0)) throw new Error('graph_oracle_edge_invalid')
  const edges = semantic.edges.flatMap(edge => semantic.directed
    ? [{ from: edge.from, to: edge.to, weight: edge.weight }]
    : [{ from: edge.from, to: edge.to, weight: edge.weight }, { from: edge.to, to: edge.from, weight: edge.weight }])
  const distances = new Map<string, number | null>(semantic.nodes.map(node => [node.id, node.id === semantic.sourceId ? 0 : null]))
  for (let pass = 1; pass < semantic.nodes.length; pass += 1) {
    let changed = false
    for (const edge of edges) {
      const fromDistance = distances.get(edge.from)
      if (fromDistance === null || fromDistance === undefined) continue
      const candidate = fromDistance + edge.weight
      if (!Number.isFinite(candidate)) throw new Error('graph_oracle_cost_non_finite')
      const before = distances.get(edge.to)
      if (before === null || before === undefined || candidate < before) {
        distances.set(edge.to, candidate)
        changed = true
      }
    }
    if (!changed) break
  }
  return distances.get(semantic.targetId) ?? null
}

export function isDerivedSemantic(semantic: ComputerVisualSemantic | MathematicsVisualSemantic): semantic is DerivedSemantic {
  return semantic.type === 'matrix_operation'
    || semantic.type === 'graph_algorithm'
    || semantic.type === 'natural_frequency'
    || semantic.type === 'event_loop'
    || semantic.type === 'optimization'
    || semantic.type === 'convolution_trace'
}

export function derivedTraceLength(semantic: DerivedSemantic) {
  if (semantic.type === 'graph_algorithm') return deriveDijkstra(semantic).snapshots.length
  if (semantic.type === 'event_loop') return deriveEventLoop(semantic).snapshots.length
  if (semantic.type === 'optimization') return deriveOptimization(semantic).snapshots.length
  if (semantic.type === 'convolution_trace') return deriveConvolution(semantic).snapshots.length
  return 1
}

export function verifyDerivedSemantic(semantic: ComputerVisualSemantic | MathematicsVisualSemantic) {
  if (!isDerivedSemantic(semantic)) return { checked: 0, passed: 0, failures: [] as string[] }
  try {
    if (semantic.type === 'matrix_operation') deriveMatrixOperation(semantic)
    if (semantic.type === 'graph_algorithm') {
      const result = deriveDijkstra(semantic)
      if (result.cost === null || !result.pathNodeIds.length) throw new Error('dijkstra_target_unreachable')
      const oracleCost = shortestPathCostOracle(semantic)
      if (oracleCost === null || result.cost !== oracleCost) throw new Error('dijkstra_oracle_cost_mismatch')
      const pathWeight = result.pathEdgeIds.reduce((sum, edgeId) => sum + (semantic.edges.find(edge => edge.id === edgeId)?.weight ?? Number.NaN), 0)
      if (!Number.isFinite(pathWeight) || pathWeight !== result.cost) throw new Error('dijkstra_path_cost_mismatch')
    }
    if (semantic.type === 'natural_frequency') deriveNaturalFrequency(semantic)
    if (semantic.type === 'event_loop') deriveEventLoop(semantic)
    if (semantic.type === 'optimization') {
      const result = deriveOptimization(semantic)
      if (!(semantic.learningRate > 0 && semantic.learningRate < 1)) throw new Error('optimization_learning_rate_not_convergent')
      if (result.points.some(point => point.x < semantic.axes.xDomain[0] || point.x > semantic.axes.xDomain[1] || point.y < semantic.axes.yDomain[0] || point.y > semantic.axes.yDomain[1])) throw new Error('optimization_trace_outside_domain')
    }
    if (semantic.type === 'convolution_trace') {
      const result = deriveConvolution(semantic)
      if (result.snapshots.length < 4 || result.snapshots.length > 12) throw new Error('convolution_trace_length_invalid')
      if (result.output.some(row => row.some(value => !Number.isFinite(value)))) throw new Error('convolution_output_non_finite')
    }
    return { checked: 1, passed: 1, failures: [] as string[] }
  } catch (error) {
    return { checked: 1, passed: 0, failures: [error instanceof Error ? error.message : 'derived_semantic_failed'] }
  }
}
