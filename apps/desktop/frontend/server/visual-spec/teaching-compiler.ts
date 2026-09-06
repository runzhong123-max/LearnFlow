export const TEACHING_COMPILER_ID = 'learnflow.teaching-request-compiler'
export const TEACHING_COMPILER_VERSION = '1.1.0'

export type TeachingVisualKind = 'diagram' | 'animation'

type VerifiedDerivation<T extends string, I, D> = {
  compilerId: typeof TEACHING_COMPILER_ID
  version: typeof TEACHING_COMPILER_VERSION
  verification: 'derived_verified'
  type: T
  kind: TeachingVisualKind
  input: I
  derived: D
}

export type TeachingDerivationFailure = VerifiedDerivation<
  'derivation_failure',
  { request: string; category: 'matrix_multiplication' | 'dijkstra' | 'natural_frequency' },
  { accepted: false; code: string; message: string; details?: Record<string, unknown> }
>

export type MatrixMultiplicationDerivation = VerifiedDerivation<
  'matrix_multiplication',
  {
    request: string
    matrices: { A: number[][]; B: number[][] }
    focus?: { row: number; column: number }
  },
  {
    result: number[][]
    focus?: {
      row: number
      column: number
      value: number
      terms: Array<{ left: number; right: number; product: number }>
      expression: string
    }
  }
>

export type WeightedEdge = { id: string; from: string; to: string; weight: number }

export type DijkstraDerivation = VerifiedDerivation<
  'dijkstra',
  {
    request: string
    directed: boolean
    nodes: string[]
    edges: WeightedEdge[]
    source: string
    target?: string
  },
  {
    distances: Record<string, number | null>
    parents: Record<string, string | null>
    settledOrder: string[]
    path: string[]
    pathCost: number | null
    relaxations: Array<{
      step: number
      from: string
      to: string
      weight: number
      previousDistance: number | null
      candidateDistance: number
      nextDistance: number | null
      updated: boolean
      parent: string | null
    }>
  }
>

export type NaturalFrequencyDerivation = VerifiedDerivation<
  'natural_frequency_bayes',
  {
    request: string
    population: number
    prevalence: number
    sensitivity: number
    specificity: number
  },
  {
    diseased: number
    healthy: number
    truePositive: number
    falseNegative: number
    falsePositive: number
    trueNegative: number
    positive: number
    posterior: number
  }
>

type EventQueue = 'sync' | 'microtask' | 'task'

export type EventLoopDerivation = VerifiedDerivation<
  'js_event_loop',
  {
    request: string
    codeLines: Array<{ number: number; text: string }>
    events: Array<{ id: string; sourceLineNumber: number; queue: EventQueue; output: string }>
  },
  {
    sync: string[]
    microtasks: string[]
    tasks: string[]
    outputOrder: string[]
  }
>

export type GradientDescentDerivation = VerifiedDerivation<
  'quadratic_gradient_descent',
  {
    request: string
    center: number
    x0: number
    alpha: number
    updates: number
  },
  {
    optimum: { x: number; y: 0 }
    iterations: Array<{
      step: number
      x: number
      y: number
      gradient: number
      delta: number
      nextX: number
      nextY: number
    }>
    points: Array<{ step: number; x: number; y: number }>
  }
>

export type ConvolutionDerivation = VerifiedDerivation<
  'convolution_trace',
  {
    request: string
    input: number[][]
    kernel: number[][]
    stride: 1 | 2
    padding: 0
    bias: number
  },
  {
    output: number[][]
    activated: number[][]
    pooled: number[][]
  }
>

export type TeachingDerivation =
  | MatrixMultiplicationDerivation
  | DijkstraDerivation
  | NaturalFrequencyDerivation
  | EventLoopDerivation
  | GradientDescentDerivation
  | ConvolutionDerivation
  | TeachingDerivationFailure

function envelope<T extends TeachingDerivation>(value: Omit<T, 'compilerId' | 'version' | 'verification'>): T {
  return {
    compilerId: TEACHING_COMPILER_ID,
    version: TEACHING_COMPILER_VERSION,
    verification: 'derived_verified',
    ...value,
  } as T
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function stableNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value
}

function failure(
  kind: TeachingVisualKind,
  request: string,
  category: 'matrix_multiplication' | 'dijkstra' | 'natural_frequency',
  code: string,
  message: string,
  details?: Record<string, unknown>,
): TeachingDerivationFailure {
  return envelope<TeachingDerivationFailure>({
    type: 'derivation_failure',
    kind,
    input: { request, category },
    derived: { accepted: false, code, message, ...(details ? { details } : {}) },
  })
}

function extractBalanced(text: string, start: number, open: string, close: string): string | undefined {
  if (text[start] !== open) return undefined
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
      continue
    }
    if (character === open) depth += 1
    if (character === close) {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

function extractAssignedMatrix(text: string, name: string): unknown {
  const matcher = new RegExp(`(?:^|[^A-Za-z0-9_])${name}\\s*=\\s*(?=\\[)`, 'i')
  const match = matcher.exec(text)
  if (!match) return undefined
  const start = match.index + match[0].length
  const source = extractBalanced(text, start, '[', ']')
  if (!source) return null
  try {
    return JSON.parse(source.split('，').join(','))
  } catch {
    return null
  }
}

function deriveConvolutionRequest(kind: TeachingVisualKind, request: string): TeachingDerivation | undefined {
  if (!/(?:cnn|卷积|池化|手写数字|mnist|感受野)/i.test(request)) return undefined
  const rawInput = extractAssignedMatrix(request, 'CONV_INPUT')
    ?? extractAssignedMatrix(request, 'INPUT')
  const rawKernel = extractAssignedMatrix(request, 'CONV_KERNEL')
    ?? extractAssignedMatrix(request, 'KERNEL')
  if (rawInput === undefined && rawKernel === undefined) return undefined
  const input = normalizeMatrix(rawInput)
  const kernel = normalizeMatrix(rawKernel)
  if (!input || !kernel) return undefined
  const strideValue = matchedNumber(/stride\s*(?:=|:|：)\s*(\d+)/i.exec(request)) ?? 1
  const padding = matchedNumber(/padding\s*(?:=|:|：)\s*(\d+)/i.exec(request)) ?? 0
  const bias = matchedNumber(/bias\s*(?:=|:|：)\s*([+\-−]?(?:\d+(?:\.\d+)?|\.\d+))/i.exec(request)) ?? 0
  if ((strideValue !== 1 && strideValue !== 2) || padding !== 0 || !Number.isFinite(bias)) return undefined
  if (input.length > 7 || input[0].length > 7 || kernel.length > 4 || kernel[0].length > 4) return undefined
  if (input.length < kernel.length || input[0].length < kernel[0].length) return undefined
  const outputRows = Math.floor((input.length - kernel.length) / strideValue) + 1
  const outputColumns = Math.floor((input[0].length - kernel[0].length) / strideValue) + 1
  if (outputRows < 1 || outputColumns < 1 || outputRows * outputColumns > 9) return undefined
  const output = Array.from({ length: outputRows }, (_, row) => Array.from({ length: outputColumns }, (_, column) => {
    let sum = bias
    for (let kernelRow = 0; kernelRow < kernel.length; kernelRow += 1) {
      for (let kernelColumn = 0; kernelColumn < kernel[0].length; kernelColumn += 1) {
        sum += input[row * strideValue + kernelRow][column * strideValue + kernelColumn] * kernel[kernelRow][kernelColumn]
      }
    }
    return stableNumber(sum)
  }))
  const activated = output.map(row => row.map(value => Math.max(0, value)))
  const pooledRows = Math.floor(activated.length / 2)
  const pooledColumns = Math.floor(activated[0].length / 2)
  const pooled = Array.from({ length: pooledRows }, (_, row) => Array.from({ length: pooledColumns }, (_, column) => Math.max(
    activated[row * 2][column * 2],
    activated[row * 2][column * 2 + 1],
    activated[row * 2 + 1][column * 2],
    activated[row * 2 + 1][column * 2 + 1],
  )))
  return envelope<ConvolutionDerivation>({
    type: 'convolution_trace', kind,
    input: { request, input, kernel, stride: strideValue as 1 | 2, padding: 0, bias },
    derived: { output, activated, pooled },
  })
}

function normalizeMatrix(value: unknown): number[][] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return undefined
  if (!value.every((row) => Array.isArray(row))) return undefined
  const rows = value as unknown[][]
  const width = rows[0].length
  if (width === 0 || width > 8 || rows.some((row) => row.length !== width)) return undefined
  if (!rows.every((row) => row.every((cell) => finiteNumber(cell) && Math.abs(cell) <= 1_000_000))) return undefined
  return rows.map((row) => row.map((cell) => stableNumber(cell as number)))
}

function matrixValueOutOfRange(value: unknown) {
  return Array.isArray(value) && value.some((row) => (
    Array.isArray(row) && row.some((cell) => typeof cell === 'number' && (!Number.isFinite(cell) || Math.abs(cell) > 1_000_000))
  ))
}

function parseFocus(text: string): { row: number; column: number } | undefined {
  const bracket = /\bC\s*\[\s*(\d+)\s*[,，]\s*(\d+)\s*\]/i.exec(text)
  const subscript = /\bC\s*_\s*\{?\s*(\d+)\s*[,，\s]?\s*(\d+)\s*\}?/i.exec(text)
  const compact = /\bC\s*(\d)(\d)\b/i.exec(text)
  const match = bracket ?? subscript ?? compact
  if (!match) return undefined
  return { row: Number(match[1]), column: Number(match[2]) }
}

function deriveMatrix(kind: TeachingVisualKind, request: string): TeachingDerivation | undefined {
  const hasSignal = /矩阵|matrix|matmul|乘|相乘|×/i.test(request)
  const rawA = extractAssignedMatrix(request, 'A')
  const rawB = extractAssignedMatrix(request, 'B')
  if (!hasSignal && rawA === undefined && rawB === undefined) return undefined
  if (rawA === undefined || rawB === undefined || rawA === null || rawB === null) {
    if (rawA === undefined && rawB === undefined) return undefined
    return failure(kind, request, 'matrix_multiplication', 'matrix_parse_error', 'A and B must be finite rectangular numeric arrays.')
  }
  const A = normalizeMatrix(rawA)
  const B = normalizeMatrix(rawB)
  if (!A || !B) {
    if (matrixValueOutOfRange(rawA) || matrixValueOutOfRange(rawB)) {
      return failure(kind, request, 'matrix_multiplication', 'matrix_value_out_of_range', 'Every matrix value must be finite with absolute value no greater than 1,000,000.')
    }
    return failure(kind, request, 'matrix_multiplication', 'matrix_invalid_shape', 'A and B must be non-empty rectangular matrices no larger than 8×8.')
  }
  if (A[0].length !== B.length) {
    return failure(
      kind,
      request,
      'matrix_multiplication',
      'matrix_dimension_mismatch',
      `Cannot multiply ${A.length}×${A[0].length} by ${B.length}×${B[0].length}; inner dimensions ${A[0].length} and ${B.length} differ.`,
      { leftShape: [A.length, A[0].length], rightShape: [B.length, B[0].length] },
    )
  }
  let arithmeticFailed = false
  const result = A.map((row) => B[0].map((_, column) => {
    let sum = 0
    for (let inner = 0; inner < row.length; inner += 1) {
      const product = row[inner] * B[inner][column]
      if (!Number.isFinite(product)) arithmeticFailed = true
      sum += product
      if (!Number.isFinite(sum)) arithmeticFailed = true
    }
    return stableNumber(sum)
  }))
  if (arithmeticFailed || result.some((row) => row.some((cell) => !Number.isFinite(cell)))) {
    return failure(kind, request, 'matrix_multiplication', 'matrix_non_finite_result', 'Matrix multiplication produced a non-finite intermediate or result.')
  }
  const focus = parseFocus(request)
  if (focus && (focus.row < 1 || focus.row > result.length || focus.column < 1 || focus.column > result[0].length)) {
    return failure(kind, request, 'matrix_multiplication', 'matrix_focus_out_of_range', 'The requested result cell is outside matrix C.', {
      focus,
      resultShape: [result.length, result[0].length],
    })
  }
  const focusResult = focus ? (() => {
    const row = focus.row - 1
    const column = focus.column - 1
    const terms = A[row].map((left, inner) => ({
      left,
      right: B[inner][column],
      product: stableNumber(left * B[inner][column]),
    }))
    return {
      ...focus,
      value: result[row][column],
      terms,
      expression: `${terms.map((term) => `${term.left}×${term.right}`).join(' + ')} = ${result[row][column]}`,
    }
  })() : undefined
  return envelope<MatrixMultiplicationDerivation>({
    type: 'matrix_multiplication',
    kind,
    input: { request, matrices: { A, B }, ...(focus ? { focus } : {}) },
    derived: { result, ...(focusResult ? { focus: focusResult } : {}) },
  })
}

const NODE = '[A-Za-z][A-Za-z0-9_]*'

function namedNode(text: string, labels: string[]): string | undefined {
  const label = labels.join('|')
  const match = new RegExp(`(?:${label})\\s*(?:node\\s*)?(?:=|:|：|为|是)?\\s*(${NODE})`, 'i').exec(text)
  return match?.[1]
}

function deriveDijkstra(kind: TeachingVisualKind, request: string): TeachingDerivation | undefined {
  if (!/dijkstra|迪杰斯特拉|最短(?:路|路径)/i.test(request)) return undefined
  const edgePattern = new RegExp(`(${NODE})\\s*(→|->|—|-|到|至)\\s*(${NODE})\\s*(?:(?:权重|weight)\\s*(?:=|:|：|为)?|(?:=|:|：))\\s*([+\-−]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))`, 'gi')
  const parsed: Array<{ from: string; to: string; weight: number; notation: string }> = []
  for (const match of request.matchAll(edgePattern)) {
    parsed.push({ from: match[1], to: match[3], weight: Number(match[4].replace('−', '-')), notation: match[2] })
  }
  if (parsed.length === 0) return undefined
  if (parsed.some((edge) => !Number.isFinite(edge.weight) || edge.weight < 0)) {
    return failure(kind, request, 'dijkstra', 'dijkstra_negative_weight', 'Dijkstra requires every edge weight to be finite and non-negative.')
  }
  const explicitDirected = /有向|\bdirected\b/i.test(request) && !/无向|\bundirected\b/i.test(request)
  const explicitUndirected = /无向|\bundirected\b/i.test(request)
  const hasArrow = parsed.some((edge) => ['→', '->', '到', '至'].includes(edge.notation))
  const hasLine = parsed.some((edge) => edge.notation === '-' || edge.notation === '—')
  if (!explicitDirected && !explicitUndirected && hasArrow && hasLine) {
    return failure(kind, request, 'dijkstra', 'dijkstra_mixed_edge_notation', 'Mixed directed and undirected edge notation needs an explicit graph direction.')
  }
  const directed = explicitUndirected ? false : explicitDirected || hasArrow
  const edgeKeys = new Set<string>()
  for (const edge of parsed) {
    const endpoints = directed ? [edge.from, edge.to] : [edge.from, edge.to].sort((left, right) => left.localeCompare(right, 'en'))
    const key = `${endpoints[0]}\u0000${endpoints[1]}`
    if (edgeKeys.has(key)) {
      return failure(kind, request, 'dijkstra', 'dijkstra_parallel_edge', 'Parallel edges are not supported by the deterministic Dijkstra teaching compiler.', {
        from: endpoints[0],
        to: endpoints[1],
        directed,
      })
    }
    edgeKeys.add(key)
  }
  const nodes = [...new Set(parsed.flatMap((edge) => [edge.from, edge.to]))]
  if (nodes.length > 8) {
    return failure(kind, request, 'dijkstra', 'dijkstra_too_many_nodes', 'The deterministic teaching compiler supports at most 8 graph nodes.', { nodeCount: nodes.length })
  }
  const fromTo = /(?:从\s*|\bfrom\s+)\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:到|至|\bto\b)\s*([A-Za-z][A-Za-z0-9_]*)/i.exec(request)
  const source = namedNode(request, ['源点', '起点', 'source', 'start']) ?? fromTo?.[1] ?? (nodes.includes('S') ? 'S' : undefined)
  const target = namedNode(request, ['终点', '目标', 'target', 'end']) ?? fromTo?.[2] ?? (nodes.includes('T') ? 'T' : undefined)
  if (!source || !nodes.includes(source) || (target && !nodes.includes(target))) return undefined
  const edges: WeightedEdge[] = parsed.map((edge, index) => ({ id: `e${index + 1}`, from: edge.from, to: edge.to, weight: stableNumber(edge.weight) }))
  const adjacency = new Map<string, Array<{ to: string; weight: number; order: number }>>(nodes.map((node) => [node, []]))
  edges.forEach((edge, order) => {
    adjacency.get(edge.from)?.push({ to: edge.to, weight: edge.weight, order })
    if (!directed) adjacency.get(edge.to)?.push({ to: edge.from, weight: edge.weight, order })
  })
  adjacency.forEach((list) => list.sort((left, right) => left.order - right.order || left.to.localeCompare(right.to, 'en')))

  const distance = new Map(nodes.map((node) => [node, Number.POSITIVE_INFINITY]))
  const parent = new Map<string, string | null>(nodes.map((node) => [node, null]))
  distance.set(source, 0)
  const settled = new Set<string>()
  const settledOrder: string[] = []
  const relaxations: DijkstraDerivation['derived']['relaxations'] = []
  while (settled.size < nodes.length) {
    const current = nodes
      .filter((node) => !settled.has(node) && Number.isFinite(distance.get(node)))
      .sort((left, right) => (distance.get(left) ?? Infinity) - (distance.get(right) ?? Infinity) || left.localeCompare(right, 'en'))[0]
    if (!current) break
    settled.add(current)
    settledOrder.push(current)
    if (target && current === target) break
    for (const edge of adjacency.get(current) ?? []) {
      if (settled.has(edge.to)) continue
      const previous = distance.get(edge.to) ?? Infinity
      const candidate = stableNumber((distance.get(current) ?? Infinity) + edge.weight)
      const updated = candidate < previous
      if (updated) {
        distance.set(edge.to, candidate)
        parent.set(edge.to, current)
      }
      relaxations.push({
        step: settledOrder.length,
        from: current,
        to: edge.to,
        weight: edge.weight,
        previousDistance: Number.isFinite(previous) ? previous : null,
        candidateDistance: candidate,
        nextDistance: Number.isFinite(distance.get(edge.to)) ? (distance.get(edge.to) as number) : null,
        updated,
        parent: parent.get(edge.to) ?? null,
      })
    }
  }
  const distances = Object.fromEntries(nodes.map((node) => [node, Number.isFinite(distance.get(node)) ? distance.get(node) as number : null]))
  const parents = Object.fromEntries(nodes.map((node) => [node, parent.get(node) ?? null]))
  const path: string[] = []
  if (target && Number.isFinite(distance.get(target))) {
    let cursor: string | null = target
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      path.unshift(cursor)
      if (cursor === source) break
      cursor = parent.get(cursor) ?? null
    }
    if (path[0] !== source) path.splice(0)
  }
  return envelope<DijkstraDerivation>({
    type: 'dijkstra',
    kind,
    input: { request, directed, nodes, edges, source, ...(target ? { target } : {}) },
    derived: {
      distances,
      parents,
      settledOrder,
      path,
      pathCost: target && Number.isFinite(distance.get(target)) ? distance.get(target) as number : null,
      relaxations,
    },
  })
}

function parseRatio(text: string, labels: string[]): number | undefined {
  const match = new RegExp(`(?:${labels.join('|')})\\s*(?:=|:|：|为|是|of)?\\s*(\\d+(?:\\.\\d+)?|\\.\\d+)\\s*(%|％)?`, 'i').exec(text)
  if (!match) return undefined
  const numeric = Number(match[1])
  const ratio = match[2] || numeric > 1 ? numeric / 100 : numeric
  return Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? stableNumber(ratio) : undefined
}

function reliableCount(value: number): number | undefined {
  const rounded = Math.round(value)
  return Number.isSafeInteger(rounded) && Math.abs(value - rounded) <= 1e-7 ? rounded : undefined
}

function deriveNaturalFrequency(kind: TeachingVisualKind, request: string): TeachingDerivation | undefined {
  if (!/贝叶斯|bayes|自然频数|敏感度|灵敏度|sensitivity|特异度|specificity/i.test(request)) return undefined
  const populationMatch = /(?:population|sample\s*size|cohort|总人数|总人口|样本量|总样本|人群|N)\s*(?:=|:|：|为|是|of)?\s*([\d,，]+)/i.exec(request)
  const people = [...request.matchAll(/([\d,，]+)\s*(?:人|名|例|samples?)/gi)].map((match) => Number(match[1].replace(/[，,]/g, '')))
  const population = populationMatch ? Number(populationMatch[1].replace(/[，,]/g, '')) : (people.length ? Math.max(...people) : undefined)
  const prevalence = parseRatio(request, ['prevalence', '患病率', '发病率', '先验概率'])
  const sensitivity = parseRatio(request, ['sensitivity', '敏感度', '灵敏度', '召回率', '真阳性率'])
  const specificity = parseRatio(request, ['specificity', '特异度', '真阴性率'])
  const hasNumericInputs = population !== undefined || prevalence !== undefined || sensitivity !== undefined
  if (specificity === undefined) {
    if (hasNumericInputs) {
      return failure(
        kind,
        request,
        'natural_frequency',
        'natural_frequency_specificity_missing',
        'A recognized Bayes natural-frequency request must provide a valid specificity.',
      )
    }
    return undefined
  }
  if (!population || !Number.isSafeInteger(population) || population <= 0 || prevalence === undefined || sensitivity === undefined) return undefined
  const diseased = reliableCount(population * prevalence)
  if (diseased === undefined) return undefined
  const healthy = population - diseased
  const truePositive = reliableCount(diseased * sensitivity)
  const falsePositive = reliableCount(healthy * (1 - specificity))
  if (truePositive === undefined || falsePositive === undefined) return undefined
  const falseNegative = diseased - truePositive
  const trueNegative = healthy - falsePositive
  const positive = truePositive + falsePositive
  const posterior = positive > 0 ? stableNumber(truePositive / positive) : 0
  return envelope<NaturalFrequencyDerivation>({
    type: 'natural_frequency_bayes',
    kind,
    input: { request, population, prevalence, sensitivity, specificity },
    derived: { diseased, healthy, truePositive, falseNegative, falsePositive, trueNegative, positive, posterior },
  })
}

type EventToken = {
  kind: 'identifier' | 'number' | 'string' | 'punctuator'
  value: string
  start: number
  end: number
  decoded?: string
}

type ParsedEventStatement = {
  start: number
  end: number
  queue: EventQueue
  output: string
  logStart: number
}

function sourceLineNumber(source: string, offset: number) {
  let line = 1
  for (let index = 0; index < Math.min(offset, source.length); index += 1) if (source[index] === '\n') line += 1
  return line
}

function sourceLines(source: string) {
  const lines: Array<{ number: number; text: string; start: number; end: number }> = []
  let start = 0
  let number = 1
  while (start <= source.length) {
    const newline = source.indexOf('\n', start)
    const rawEnd = newline < 0 ? source.length : newline
    const contentEnd = rawEnd > start && source[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd
    lines.push({ number, text: source.slice(start, contentEnd).trim(), start, end: newline < 0 ? source.length : newline + 1 })
    if (newline < 0) break
    start = newline + 1
    number += 1
  }
  return lines
}

function relevantCodeLines(source: string, spans: Array<{ start: number; end: number }>) {
  return sourceLines(source)
    .filter((line) => line.text && spans.some((span) => span.start < line.end && span.end > line.start))
    .map(({ number, text }) => ({ number, text }))
}

function decodeStringLiteral(value: string): string | undefined {
  const quote = value[0]
  if (!quote || !['"', "'", '`'].includes(quote) || value[value.length - 1] !== quote) return undefined
  const body = value.slice(1, -1)
  if (quote === '`' && body.includes('${')) return undefined
  let output = ''
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]
    if (character !== '\\') {
      if (character === quote) return undefined
      output += character
      continue
    }
    index += 1
    const escaped = body[index]
    if (escaped === undefined) return undefined
    const replacements: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', "'": "'", '"': '"', '`': '`' }
    if (!(escaped in replacements)) return undefined
    output += replacements[escaped]
  }
  return output
}

function tokenizeEventSource(source: string): EventToken[] | undefined {
  const tokens: EventToken[] = []
  let index = 0
  while (index < source.length) {
    const character = source[index]
    if (/\s/u.test(character)) {
      index += 1
      continue
    }
    if (character === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2)
      index = newline < 0 ? source.length : newline + 1
      continue
    }
    if (character === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2)
      if (close < 0) return undefined
      index = close + 2
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      const start = index
      const quote = character
      index += 1
      let escaped = false
      while (index < source.length) {
        const current = source[index]
        index += 1
        if (escaped) {
          escaped = false
          continue
        }
        if (current === '\\') {
          escaped = true
          continue
        }
        if (current === quote) break
        if (current === '\n' || current === '\r') return undefined
      }
      if (source[index - 1] !== quote) return undefined
      const value = source.slice(start, index)
      const decoded = decodeStringLiteral(value)
      if (decoded === undefined) return undefined
      tokens.push({ kind: 'string', value, decoded, start, end: index })
      continue
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index
      index += 1
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1
      tokens.push({ kind: 'identifier', value: source.slice(start, index), start, end: index })
      continue
    }
    if (/\d/.test(character)) {
      const start = index
      index += 1
      while (index < source.length && /\d/.test(source[index])) index += 1
      if (source[index] === '.') {
        index += 1
        while (index < source.length && /\d/.test(source[index])) index += 1
      }
      tokens.push({ kind: 'number', value: source.slice(start, index), start, end: index })
      continue
    }
    if (source.slice(index, index + 2) === '=>') {
      tokens.push({ kind: 'punctuator', value: '=>', start: index, end: index + 2 })
      index += 2
      continue
    }
    tokens.push({ kind: 'punctuator', value: character, start: index, end: index + 1 })
    index += 1
  }
  return tokens
}

function parseEventStatements(source: string): ParsedEventStatement[] | undefined {
  const tokens = tokenizeEventSource(source)
  if (!tokens) return undefined
  const entry = tokens.findIndex(token => token.kind === 'identifier' && ['console', 'Promise', 'setTimeout'].includes(token.value))
  if (entry < 0) return undefined

  const declarationWords = new Set(['function', 'class', 'const', 'let', 'var', 'import', 'export'])
  const forbiddenPreamblePunctuation = new Set(['(', ')', '{', '}', '[', ']', '=', '=>', ';', '.'])
  if (tokens.slice(0, entry).some(token => (
    token.kind === 'string'
    || token.kind === 'number'
    || declarationWords.has(token.value)
    || forbiddenPreamblePunctuation.has(token.value)
  ))) return undefined

  let cursor = entry
  const current = () => tokens[cursor]
  const take = (value: string) => {
    if (current()?.value !== value) return undefined
    const token = current()
    cursor += 1
    return token
  }
  const parseLogCall = () => {
    const start = take('console')
    if (!start || !take('.') || !take('log') || !take('(')) return undefined
    const literal = current()
    if (!literal || literal.kind !== 'string' || literal.decoded === undefined) return undefined
    cursor += 1
    if (!take(')')) return undefined
    return { output: literal.decoded, logStart: start.start }
  }
  const parseCallback = () => {
    if (!take('(') || !take(')') || !take('=>')) return undefined
    const braced = Boolean(take('{'))
    const log = parseLogCall()
    if (!log) return undefined
    if (braced) {
      take(';')
      if (!take('}')) return undefined
    }
    return log
  }

  const statements: ParsedEventStatement[] = []
  while (cursor < tokens.length) {
    const start = current().start
    let queue: EventQueue
    let log: { output: string; logStart: number } | undefined
    if (current().value === 'console') {
      queue = 'sync'
      log = parseLogCall()
    } else if (current().value === 'setTimeout') {
      queue = 'task'
      cursor += 1
      if (!take('(')) return undefined
      log = parseCallback()
      if (!log || !take(',')) return undefined
      const delay = current()
      if (!delay || delay.kind !== 'number' || !/^0(?:\.0+)?$/.test(delay.value)) return undefined
      cursor += 1
      if (!take(')')) return undefined
    } else if (current().value === 'Promise') {
      queue = 'microtask'
      cursor += 1
      if (!take('.') || !take('resolve') || !take('(') || !take(')') || !take('.') || !take('then') || !take('(')) return undefined
      log = parseCallback()
      if (!log || !take(')')) return undefined
    } else {
      return undefined
    }
    if (!log) return undefined
    let end = tokens[cursor - 1].end
    if (take(';')) end = tokens[cursor - 1].end
    else if (cursor < tokens.length && !source.slice(end, current().start).includes('\n')) return undefined
    statements.push({ start, end, queue, output: log.output, logStart: log.logStart })
  }
  return statements
}

function deriveEventLoop(kind: TeachingVisualKind, request: string): TeachingDerivation | undefined {
  const statements = parseEventStatements(request)
  if (!statements || statements.length < 2 || !statements.some(statement => statement.queue !== 'sync')) return undefined
  const events: EventLoopDerivation['input']['events'] = []
  statements.forEach((statement, index) => events.push({
    id: `event_${index + 1}`,
    sourceLineNumber: sourceLineNumber(request, statement.logStart),
    queue: statement.queue,
    output: statement.output,
  }))
  const codeLines = relevantCodeLines(request, statements)
  const lineNumbers = new Set(codeLines.map((line) => line.number))
  if (events.some((event) => !lineNumbers.has(event.sourceLineNumber))) return undefined
  const sync = events.filter((event) => event.queue === 'sync').map((event) => event.output)
  const microtasks = events.filter((event) => event.queue === 'microtask').map((event) => event.output)
  const tasks = events.filter((event) => event.queue === 'task').map((event) => event.output)
  return envelope<EventLoopDerivation>({
    type: 'js_event_loop',
    kind,
    input: { request, codeLines, events },
    derived: { sync, microtasks, tasks, outputOrder: [...sync, ...microtasks, ...tasks] },
  })
}

function matchedNumber(match: RegExpExecArray | null): number | undefined {
  if (!match) return undefined
  const value = match.slice(1).find((part) => part !== undefined)
  if (value === undefined) return undefined
  const parsed = Number(value.replace('−', '-'))
  return Number.isFinite(parsed) ? parsed : undefined
}

function deriveGradientDescent(kind: TeachingVisualKind, request: string): TeachingDerivation | undefined {
  if (!/gradient\s*descent|梯度下降/i.test(request)) return undefined
  const objective = /\(\s*x\s*([+\-−])\s*(\d+(?:\.\d+)?|\.\d+)\s*\)\s*(?:\^|\*\*)\s*2/i.exec(request)
  if (!objective) return undefined
  const center = stableNumber((objective[1] === '+' ? -1 : 1) * Number(objective[2]))
  const x0 = matchedNumber(/(?:x\s*(?:_?\s*0|₀)|初始(?:值|点)?(?:\s*x)?|initial\s*x)\s*(?:=|:|：|为|是)?\s*([+\-−]?(?:\d+(?:\.\d+)?|\.\d+))/i.exec(request))
  const alpha = matchedNumber(/(?:α|alpha|learning\s*rate|学习率|步长)\s*(?:=|:|：|为|是)?\s*([+\-−]?(?:\d+(?:\.\d+)?|\.\d+))/i.exec(request))
  const updates = matchedNumber(/(?:迭代|更新|运行|做|进行)\s*(\d+)\s*(?:步|次)|(?:步数|iterations?)\s*(?:=|:|：|为|是)?\s*(\d+)|(\d+)\s*(?:steps?|次迭代)/i.exec(request))
  if (x0 === undefined || alpha === undefined || updates === undefined || alpha <= 0 || !Number.isInteger(updates) || updates < 1 || updates > 24) return undefined
  let x = stableNumber(x0)
  const points: GradientDescentDerivation['derived']['points'] = [{ step: 0, x, y: stableNumber((x - center) ** 2) }]
  const iterations: GradientDescentDerivation['derived']['iterations'] = []
  for (let step = 1; step <= updates; step += 1) {
    const y = stableNumber((x - center) ** 2)
    const gradient = stableNumber(2 * (x - center))
    const delta = stableNumber(-alpha * gradient)
    const nextX = stableNumber(x + delta)
    const nextY = stableNumber((nextX - center) ** 2)
    if (![y, gradient, delta, nextX, nextY].every(Number.isFinite) || Math.abs(nextX) > 1e12) return undefined
    iterations.push({ step, x, y, gradient, delta, nextX, nextY })
    points.push({ step, x: nextX, y: nextY })
    x = nextX
  }
  return envelope<GradientDescentDerivation>({
    type: 'quadratic_gradient_descent',
    kind,
    input: { request, center, x0: stableNumber(x0), alpha: stableNumber(alpha), updates },
    derived: { optimum: { x: center, y: 0 }, iterations, points },
  })
}

/**
 * Converts only requests whose numerical or execution semantics can be
 * deterministically recovered. It never calls a model and intentionally
 * returns undefined for ambiguous or unsupported inputs.
 */
export function deriveTeachingRequest(kind: TeachingVisualKind, request: string): TeachingDerivation | undefined {
  const source = request.trim()
  if (!source) return undefined
  return deriveConvolutionRequest(kind, source)
    ?? deriveMatrix(kind, source)
    ?? deriveDijkstra(kind, source)
    ?? deriveNaturalFrequency(kind, source)
    ?? deriveEventLoop(kind, source)
    ?? deriveGradientDescent(kind, source)
}
