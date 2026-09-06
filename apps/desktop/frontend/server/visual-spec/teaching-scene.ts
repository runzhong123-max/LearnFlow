import {
  deriveDijkstra,
  deriveEventLoop,
  deriveMatrixOperation,
  deriveNaturalFrequency,
  deriveOptimization,
  type EventLoopSnapshot,
  type OptimizationSnapshot,
} from './derived.ts'
import type {
  EventLoopSemantic,
  GraphAlgorithmSemantic,
  LearningVisualSpec,
  MatrixOperationSemantic,
  NaturalFrequencySemantic,
  OptimizationSemantic,
  VisualScalar,
  VisualSceneManifest,
  VisualStateSnapshot,
} from './types.ts'

const VIEWPORT = [0, 0, 1000, 640] as const

const COLOR = {
  ink: '#19372d',
  muted: '#5f746a',
  line: '#9eb0a7',
  border: '#cedbd4',
  panel: '#ffffff',
  background: '#f3f8f5',
  green: '#237a57',
  greenSoft: '#e0f2e9',
  blue: '#176c96',
  blueSoft: '#e4f2f8',
  amber: '#8a5b00',
  amberSoft: '#fff0c7',
  plum: '#784b83',
  plumSoft: '#f2e8f5',
  red: '#a0473c',
  redSoft: '#f9e9e5',
} as const

type Bounds = readonly [number, number, number, number]

type SceneRegion = {
  id: string
  role: string
  bounds: Bounds
  background: string
  objects: SceneObject[]
}

type SceneObject = VisualSceneManifest['objects'][number] & {
  svg: string
  collisionSensitive: boolean
}

export type DerivedTeachingRenderResult = {
  svg: string
  collisions: number
  outOfBounds: number
  manifest: VisualSceneManifest
}

function cleanText(value: unknown, maximum = 240) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

function escapeXml(value: unknown) {
  return cleanText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function hashText(value: string) {
  let hash = 0x811c9dc5
  for (const character of value) {
    hash ^= character.codePointAt(0) || 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 6)
}

function stableId(prefix: string, raw: string) {
  const compact = cleanText(raw, 80).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[-.]+/, '') || 'item'
  return `lf_${prefix.replace(/[^A-Za-z0-9_-]+/g, '_')}_${compact}_${hashText(`${prefix}:${raw}`)}`
}

function numberLabel(value: number) {
  if (!Number.isFinite(value)) throw new Error('visual_scene_non_finite_number')
  if (value === 0) return '0'
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000 || absolute < 0.001) {
    const [coefficient, rawExponent] = value.toExponential(2).split('e')
    const exponent = Number(rawExponent)
    return `${Number(coefficient)}e${exponent >= 0 ? '+' : ''}${exponent}`
  }
  if (Number.isInteger(value)) return String(value)
  return Number(value.toFixed(3)).toString()
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

function subscript(value: number) {
  const digits = '₀₁₂₃₄₅₆₇₈₉'
  return String(value).split('').map(character => digits[Number(character)] || character).join('')
}

function boundsOf(x1: number, y1: number, x2: number, y2: number, padding = 0): Bounds {
  return [
    Math.min(x1, x2) - padding,
    Math.min(y1, y2) - padding,
    Math.abs(x2 - x1) + padding * 2,
    Math.abs(y2 - y1) + padding * 2,
  ]
}

function intersects(left: Bounds, right: Bounds) {
  return left[0] < right[0] + right[2]
    && left[0] + left[2] > right[0]
    && left[1] < right[1] + right[3]
    && left[1] + left[3] > right[1]
}

function contains(viewport: Bounds, bounds: Bounds) {
  return bounds[0] >= viewport[0]
    && bounds[1] >= viewport[1]
    && bounds[0] + bounds[2] <= viewport[0] + viewport[2]
    && bounds[1] + bounds[3] <= viewport[1] + viewport[3]
}

function textLines(value: unknown, x: number, y: number, options: {
  anchor?: 'start' | 'middle' | 'end'
  color?: string
  font?: 'sans' | 'mono'
  lineLength?: number
  maxLines?: number
  size?: number
  weight?: number
} = {}) {
  const lineLength = Math.max(4, options.lineLength ?? 24)
  const maxLines = Math.max(1, options.maxLines ?? 3)
  const capacity = lineLength * maxLines
  const source: string[] = []
  for (const character of String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()) {
    source.push(character)
    if (source.length > capacity) break
  }
  const truncated = source.length > capacity
  const visible = source.slice(0, capacity)
  if (truncated) visible[visible.length - 1] = '…'
  const lines: string[] = []
  for (let index = 0; index < visible.length; index += lineLength) {
    lines.push(visible.slice(index, index + lineLength).join(''))
  }
  if (!lines.length) lines.push('')
  const size = options.size ?? 13
  const lineHeight = size + 4
  const startY = y - ((lines.length - 1) * lineHeight) / 2
  return `<text x="${x}" y="${startY}" text-anchor="${options.anchor ?? 'middle'}" font-size="${size}" font-weight="${options.weight ?? 600}" fill="${options.color ?? COLOR.ink}" font-family="${options.font === 'mono' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'ui-sans-serif, system-ui, sans-serif'}">${lines.map((line, index) => `<tspan x="${x}" dy="${index ? lineHeight : 0}">${escapeXml(line)}</tspan>`).join('')}</text>`
}

function panel(bounds: Bounds, title: string, subtitle = '', tone: 'plain' | 'green' | 'blue' | 'amber' | 'plum' = 'plain') {
  const [x, y, width, height] = bounds
  const fill = tone === 'green' ? '#f5fbf8'
    : tone === 'blue' ? '#f4fafd'
      : tone === 'amber' ? '#fffaf0'
        : tone === 'plum' ? '#fbf7fc'
          : COLOR.panel
  const accent = tone === 'green' ? COLOR.green
    : tone === 'blue' ? COLOR.blue
      : tone === 'amber' ? COLOR.amber
        : tone === 'plum' ? COLOR.plum
          : COLOR.line
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="18" fill="${fill}" stroke="${COLOR.border}" stroke-width="1.5"></rect><rect x="${x}" y="${y}" width="6" height="${height}" rx="3" fill="${accent}"></rect>${textLines(title, x + 18, y + 27, { anchor: 'start', size: 14, weight: 760, lineLength: 28, maxLines: 1 })}${subtitle ? textLines(subtitle, x + width - 16, y + 27, { anchor: 'end', size: 10, weight: 560, color: COLOR.muted, lineLength: 36, maxLines: 1 }) : ''}`
}

class SceneBuilder {
  private readonly regions: SceneRegion[] = []
  private readonly ids = new Set<string>()

  addRegion(rawId: string, role: string, bounds: Bounds, background = '') {
    const id = stableId('region', rawId)
    if (this.ids.has(id)) throw new Error(`visual_scene_duplicate_id:${id}`)
    this.ids.add(id)
    this.regions.push({ id, role, bounds, background, objects: [] })
    return id
  }

  addObject(input: {
    regionId: string
    rawId: string
    prefix: string
    role: string
    bounds: Bounds
    svg: string
    value?: VisualScalar
    status?: string
    collisionSensitive?: boolean
  }) {
    const region = this.regions.find(item => item.id === input.regionId)
    if (!region) throw new Error(`visual_scene_region_missing:${input.regionId}`)
    const id = stableId(input.prefix, input.rawId)
    if (this.ids.has(id)) throw new Error(`visual_scene_duplicate_id:${id}`)
    this.ids.add(id)
    region.objects.push({
      id,
      role: input.role,
      regionId: region.id,
      bounds: input.bounds,
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.status ? { status: input.status } : {}),
      svg: input.svg,
      collisionSensitive: input.collisionSensitive === true,
    })
    return id
  }

  finish(): { body: string; collisions: number; outOfBounds: number; manifest: VisualSceneManifest } {
    let collisions = 0
    let outOfBounds = this.regions.filter(region => !contains(VIEWPORT, region.bounds)).length
    for (const region of this.regions) {
      outOfBounds += region.objects.filter(object => (
        !contains(VIEWPORT, object.bounds) || !contains(region.bounds, object.bounds)
      )).length
      const sensitive = region.objects.filter(object => object.collisionSensitive)
      for (let left = 0; left < sensitive.length; left += 1) {
        for (let right = left + 1; right < sensitive.length; right += 1) {
          if (intersects(sensitive[left].bounds, sensitive[right].bounds)) collisions += 1
        }
      }
    }
    const body = this.regions.map(region => `<g id="${region.id}">${region.background}${region.objects.map(object => `<g id="${object.id}">${object.svg}</g>`).join('')}</g>`).join('')
    return {
      body,
      collisions,
      outOfBounds,
      manifest: {
        viewport: VIEWPORT,
        regions: this.regions.map(({ id, role, bounds }) => ({ id, role, bounds })),
        objects: this.regions.flatMap(region => region.objects.map(({ id, role, regionId, bounds, value, status }) => ({
          id,
          role,
          regionId,
          bounds,
          ...(value !== undefined ? { value } : {}),
          ...(status ? { status } : {}),
        }))),
      },
    }
  }
}

function addHeader(scene: SceneBuilder, spec: LearningVisualSpec, badge: string) {
  const bounds: Bounds = [24, 16, 952, 54]
  const regionId = scene.addRegion('header', 'title-and-context', bounds)
  scene.addObject({
    regionId,
    rawId: 'title',
    prefix: 'heading',
    role: 'visual-title',
    bounds,
    svg: `${textLines(spec.title, 28, 38, { anchor: 'start', size: 22, weight: 790, lineLength: 48, maxLines: 1 })}<rect x="806" y="22" width="166" height="30" rx="15" fill="${COLOR.greenSoft}" stroke="${COLOR.green}"></rect>${textLines(badge, 889, 41, { size: 11, weight: 720, color: COLOR.green, lineLength: 18, maxLines: 1 })}`,
  })
}

function addFooter(scene: SceneBuilder, stateCue: string) {
  if (!cleanText(stateCue)) return
  const bounds: Bounds = [24, 598, 952, 28]
  const regionId = scene.addRegion('state-cue', 'non-color-state-cue', bounds)
  scene.addObject({
    regionId,
    rawId: 'state-cue',
    prefix: 'cue',
    role: 'state-description',
    bounds,
    svg: `<rect x="24" y="598" width="952" height="28" rx="10" fill="${COLOR.amberSoft}" stroke="#dfbd68"></rect>${textLines(`状态：${stateCue}`, 38, 616, { anchor: 'start', size: 11, weight: 680, color: '#684e12', lineLength: 108, maxLines: 1 })}`,
    status: 'current-state',
  })
}

function svgShell(spec: LearningVisualSpec, body: string, description: string) {
  return `<svg viewBox="0 0 1000 640" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg"><title>${escapeXml(spec.title)}</title><desc>${escapeXml(description)}</desc><defs><marker id="lf_arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${COLOR.line}"></path></marker><marker id="lf_arrow_active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${COLOR.green}"></path></marker><marker id="lf_arrow_update" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${COLOR.amber}"></path></marker><linearGradient id="lf_scene_bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbfdfc"></stop><stop offset="1" stop-color="${COLOR.background}"></stop></linearGradient></defs><rect x="5" y="5" width="990" height="630" rx="26" fill="url(#lf_scene_bg)" stroke="${COLOR.border}"></rect>${body}</svg>`
}

function complete(scene: SceneBuilder, spec: LearningVisualSpec, stateCue: string): DerivedTeachingRenderResult {
  addFooter(scene, stateCue)
  const result = scene.finish()
  const description = spec.kind === 'animation'
    ? cleanText(stateCue) || cleanText(spec.subtitle) || cleanText(spec.title)
    : spec.accessibility.summary
  return { svg: svgShell(spec, result.body, description), collisions: result.collisions, outOfBounds: result.outOfBounds, manifest: result.manifest }
}

function matrixCellSize(values: number[][]) {
  return Math.max(25, Math.min(38, Math.floor(224 / Math.max(1, values[0]?.length || 1)), Math.floor(206 / Math.max(1, values.length))))
}

function drawMatrix(scene: SceneBuilder, regionId: string, input: {
  id: string
  label: string
  values: number[][]
  centerX: number
  focusRow?: number
  focusColumn?: number
  focusCell?: readonly [number, number]
}) {
  const cell = matrixCellSize(input.values)
  const rows = input.values.length
  const columns = input.values[0]?.length || 0
  const width = columns * cell
  const height = rows * cell
  const left = input.centerX - width / 2
  const top = 154 + (196 - height) / 2
  const bracketLeft = left - 11
  const bracketRight = left + width + 11
  scene.addObject({
    regionId,
    rawId: input.id,
    prefix: 'matrix',
    role: 'matrix-brackets-and-label',
    bounds: [bracketLeft - 5, 105, width + 32, 250],
    svg: `${textLines(input.label, input.centerX, 125, { size: 18, weight: 780, lineLength: 16, maxLines: 1 })}<path d="M ${left - 3} ${top} L ${bracketLeft} ${top} L ${bracketLeft} ${top + height} L ${left - 3} ${top + height}" fill="none" stroke="${COLOR.ink}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M ${left + width + 3} ${top} L ${bracketRight} ${top} L ${bracketRight} ${top + height} L ${left + width + 3} ${top + height}" fill="none" stroke="${COLOR.ink}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>`,
    status: `${rows}x${columns}`,
  })
  input.values.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    const x = left + columnIndex * cell
    const y = top + rowIndex * cell
    const focusedCell = input.focusCell?.[0] === rowIndex && input.focusCell?.[1] === columnIndex
    const focusedRow = input.focusRow === rowIndex
    const focusedColumn = input.focusColumn === columnIndex
    const focused = focusedCell || focusedRow || focusedColumn
    const fill = focusedCell ? COLOR.amber : focusedRow ? COLOR.amberSoft : focusedColumn ? COLOR.blueSoft : '#ffffff'
    scene.addObject({
      regionId,
      rawId: `${input.id}.r${rowIndex}.c${columnIndex}`,
      prefix: 'matrix_cell',
      role: 'matrix-cell',
      bounds: [x, y, cell, cell],
      svg: `<rect x="${x + 1}" y="${y + 1}" width="${cell - 2}" height="${cell - 2}" rx="5" fill="${fill}" stroke="${focused ? (focusedCell ? COLOR.amber : focusedRow ? '#c38b17' : COLOR.blue) : '#e0e8e3'}" stroke-width="${focusedCell ? 2.5 : 1}"></rect>${textLines(numberLabel(value), x + cell / 2, y + cell / 2 + 5, { size: Math.min(15, cell * 0.43), weight: focused ? 780 : 610, color: focusedCell ? '#ffffff' : COLOR.ink, lineLength: 10, maxLines: 1 })}`,
      value,
      status: focusedCell ? 'focus-result' : focusedRow ? 'focus-row' : focusedColumn ? 'focus-column' : 'normal',
      collisionSensitive: true,
    })
  }))
}

function factorLabel(value: number) {
  return value < 0 ? `(${numberLabel(value)})` : numberLabel(value)
}

function renderMatrix(spec: LearningVisualSpec, semantic: MatrixOperationSemantic, state: VisualStateSnapshot, stateCue: string) {
  const derived = deriveMatrixOperation(semantic)
  const scene = new SceneBuilder()
  addHeader(scene, spec, '可计算矩阵教学图')
  const matrixBounds: Bounds = [24, 82, 952, 304]
  const matrixRegion = scene.addRegion('matrix-workspace', 'matrix-operation', matrixBounds, panel(matrixBounds, 'A × B = C', '行 × 列 → 结果格', 'blue'))
  drawMatrix(scene, matrixRegion, {
    id: semantic.left.id,
    label: semantic.left.label,
    values: semantic.left.values,
    centerX: 180,
    focusRow: semantic.focus?.row,
  })
  drawMatrix(scene, matrixRegion, {
    id: semantic.right.id,
    label: semantic.right.label,
    values: semantic.right.values,
    centerX: 500,
    focusColumn: semantic.focus?.column,
  })
  drawMatrix(scene, matrixRegion, {
    id: semantic.resultId,
    label: 'C',
    values: derived.result,
    centerX: 820,
    focusCell: semantic.focus ? [semantic.focus.row, semantic.focus.column] : undefined,
  })
  scene.addObject({
    regionId: matrixRegion,
    rawId: 'multiply-symbol',
    prefix: 'operator',
    role: 'multiplication-operator',
    bounds: [320, 224, 28, 42],
    svg: textLines('×', 334, 251, { size: 28, weight: 500, color: COLOR.blue, maxLines: 1 }),
  })
  scene.addObject({
    regionId: matrixRegion,
    rawId: 'equals-symbol',
    prefix: 'operator',
    role: 'equals-operator',
    bounds: [654, 224, 28, 42],
    svg: textLines('=', 668, 251, { size: 28, weight: 500, color: COLOR.green, maxLines: 1 }),
  })
  const leftShape = `${semantic.left.values.length}×${semantic.left.values[0].length}`
  const rightShape = `${semantic.right.values.length}×${semantic.right.values[0].length}`
  const resultShape = `${derived.result.length}×${derived.result[0].length}`
  scene.addObject({
    regionId: matrixRegion,
    rawId: 'shape-contract',
    prefix: 'matrix_shape',
    role: 'dimension-contract',
    bounds: [210, 344, 580, 32],
    svg: `<rect x="210" y="344" width="580" height="32" rx="16" fill="${COLOR.greenSoft}" stroke="${COLOR.green}"></rect>${textLines(`${leftShape} · ${rightShape} → ${resultShape}　内维 ${semantic.left.values[0].length} = ${semantic.right.values.length}，可以相乘`, 500, 365, { size: 12, weight: 720, color: COLOR.green, lineLength: 72, maxLines: 1 })}`,
    status: 'inner-dimensions-match',
  })

  const derivationBounds: Bounds = [24, 400, 952, 182]
  const derivationRegion = scene.addRegion('matrix-derivation', 'focus-cell-derivation', derivationBounds, panel(derivationBounds, '聚焦一个结果格', '高亮不能只靠颜色：行、列、结果格分别有边框', 'amber'))
  const focus = derived.focus
  const formula = focus
    ? `C${subscript(focus.row + 1)}${subscript(focus.column + 1)} = ${focus.terms.map(term => `${factorLabel(term.left)}×${factorLabel(term.right)}`).join(' + ')} = ${numberLabel(focus.value)}`
    : 'Cᵢⱼ = A 的第 i 行 · B 的第 j 列'
  scene.addObject({
    regionId: derivationRegion,
    rawId: 'dot-product',
    prefix: 'formula',
    role: 'dot-product-expansion',
    bounds: [52, 440, 896, 52],
    svg: `<rect x="52" y="440" width="896" height="52" rx="13" fill="#ffffff" stroke="#ddc27d" stroke-width="1.5"></rect>${textLines(formula, 500, 472, { size: 18, weight: 760, color: COLOR.ink, lineLength: 82, maxLines: 1, font: 'mono' })}`,
    value: focus?.value,
    status: focus ? 'verified-result' : 'general-rule',
  })
  const prompt = semantic.transferPrompt || '迁移检查：换一个结果格，先指出它对应 A 的哪一行、B 的哪一列。'
  scene.addObject({
    regionId: derivationRegion,
    rawId: 'transfer-prompt',
    prefix: 'prompt',
    role: 'transfer-question',
    bounds: [52, 510, 896, 50],
    svg: `<rect x="52" y="510" width="896" height="50" rx="13" fill="${COLOR.plumSoft}" stroke="#c4a6cc"></rect>${textLines(`再想一步：${prompt}`, 70, 540, { anchor: 'start', size: 12, weight: 660, color: COLOR.plum, lineLength: 102, maxLines: 1 })}`,
  })
  return complete(scene, spec, stateCue || (state.activeIds.length ? `聚焦 ${state.activeIds.join('、')}` : '行、列与结果格保持一一对应'))
}

type PositionedNode = { x: number; y: number }

type GraphTopologyLayout = {
  positions: Map<string, PositionedNode>
  depths: Map<string, number>
  nodeOrder: Map<string, number>
}

type GraphEdgeGeometry = {
  start: PositionedNode
  control: PositionedNode
  end: PositionedNode
  bounds: Bounds
  path: string
}

type RoutedGraphEdge = {
  edge: GraphAlgorithmSemantic['edges'][number]
  geometry: GraphEdgeGeometry
  label: string
  labelBounds: Bounds
  labelX: number
  labelY: number
}

function graphLayout(semantic: GraphAlgorithmSemantic): GraphTopologyLayout {
  const nodeOrder = new Map(semantic.nodes.map((node, index) => [node.id, index]))
  const adjacency = new Map(semantic.nodes.map(node => [node.id, [] as string[]]))
  semantic.edges.forEach(edge => {
    adjacency.get(edge.from)!.push(edge.to)
    if (!semantic.directed) adjacency.get(edge.to)!.push(edge.from)
  })
  adjacency.forEach(neighbors => neighbors.sort((left, right) => nodeOrder.get(left)! - nodeOrder.get(right)!))

  const depths = new Map<string, number>([[semantic.sourceId, 0]])
  const queue = [semantic.sourceId]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const nodeId = queue[cursor]
    const nextDepth = depths.get(nodeId)! + 1
    for (const neighborId of adjacency.get(nodeId) || []) {
      if (depths.has(neighborId)) continue
      depths.set(neighborId, nextDepth)
      queue.push(neighborId)
    }
  }
  const unreachableDepth = Math.max(0, ...depths.values()) + 1
  semantic.nodes.forEach(node => {
    if (!depths.has(node.id)) depths.set(node.id, unreachableDepth)
  })

  const layers = new Map<number, string[]>()
  semantic.nodes.forEach(node => {
    const depth = depths.get(node.id)!
    layers.set(depth, [...(layers.get(depth) || []), node.id])
  })
  const columns = [...layers.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([depth, ids]) => Array.from({ length: Math.ceil(ids.length / 4) }, (_, index) => ({
      depth,
      ids: ids.slice(index * 4, index * 4 + 4),
    })))
  const left = 72
  const right = 570
  const centerY = (150 + 405) / 2
  const positions = new Map<string, PositionedNode>()
  columns.forEach((column, columnIndex) => {
    const x = columns.length === 1 ? (left + right) / 2 : left + (columnIndex / (columns.length - 1)) * (right - left)
    const verticalSpan = Math.min(255, Math.max(0, column.ids.length - 1) * 100)
    const top = centerY - verticalSpan / 2
    column.ids.forEach((id, index) => {
      positions.set(id, {
        x,
        y: column.ids.length === 1 ? centerY : top + (index / (column.ids.length - 1)) * verticalSpan,
      })
    })
  })
  return { positions, depths, nodeOrder }
}

function quadraticPoint(geometry: GraphEdgeGeometry, t: number): PositionedNode {
  const inverse = 1 - t
  return {
    x: inverse * inverse * geometry.start.x + 2 * inverse * t * geometry.control.x + t * t * geometry.end.x,
    y: inverse * inverse * geometry.start.y + 2 * inverse * t * geometry.control.y + t * t * geometry.end.y,
  }
}

function graphEdgeGeometry(from: PositionedNode, to: PositionedNode, offset: number): GraphEdgeGeometry {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.max(1, Math.hypot(dx, dy))
  const perpendicularX = -dy / distance
  const perpendicularY = dx / distance
  const control = {
    x: Math.max(34, Math.min(608, (from.x + to.x) / 2 + perpendicularX * offset)),
    y: Math.max(116, Math.min(448, (from.y + to.y) / 2 + perpendicularY * offset)),
  }
  const startDx = control.x - from.x
  const startDy = control.y - from.y
  const startDistance = Math.max(1, Math.hypot(startDx, startDy))
  const endDx = to.x - control.x
  const endDy = to.y - control.y
  const endDistance = Math.max(1, Math.hypot(endDx, endDy))
  const start = { x: from.x + (startDx / startDistance) * 27, y: from.y + (startDy / startDistance) * 27 }
  const end = { x: to.x - (endDx / endDistance) * 29, y: to.y - (endDy / endDistance) * 29 }
  return {
    start,
    control,
    end,
    bounds: [
      Math.min(start.x, control.x, end.x) - 8,
      Math.min(start.y, control.y, end.y) - 8,
      Math.max(start.x, control.x, end.x) - Math.min(start.x, control.x, end.x) + 16,
      Math.max(start.y, control.y, end.y) - Math.min(start.y, control.y, end.y) + 16,
    ],
    path: `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} Q ${control.x.toFixed(2)} ${control.y.toFixed(2)} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`,
  }
}

function graphRouteOffsets(input: {
  depthDelta: number
  edgeIndex: number
  fromIndex: number
  toIndex: number
  middleX: number
}) {
  const pairSeed = (Math.min(input.fromIndex, input.toIndex) * 17 + Math.max(input.fromIndex, input.toIndex) * 31 + input.edgeIndex * 7) % 2
  let sign = pairSeed ? 1 : -1
  if (input.depthDelta === 0 && Math.abs(input.middleX - 321) > 55) sign = input.middleX < 321 ? -1 : 1
  const magnitude = input.depthDelta === 0 ? 54 : input.depthDelta < 0 ? 48 : input.depthDelta > 1 ? 36 : 14
  const candidates = [
    sign * magnitude,
    -sign * magnitude,
    sign * (magnitude + 22),
    -sign * (magnitude + 22),
    sign * Math.max(8, magnitude - 10),
    -sign * Math.max(8, magnitude - 10),
    sign * (magnitude + 44),
    -sign * (magnitude + 44),
    sign * (magnitude + 66),
    -sign * (magnitude + 66),
    sign * (magnitude + 90),
    -sign * (magnitude + 90),
    sign * (magnitude + 120),
    -sign * (magnitude + 120),
    0,
  ]
  return [...new Set(candidates)]
}

function graphRouteNodeHits(
  geometry: GraphEdgeGeometry,
  edge: GraphAlgorithmSemantic['edges'][number],
  semantic: GraphAlgorithmSemantic,
  positions: Map<string, PositionedNode>,
) {
  let hits = 0
  for (const node of semantic.nodes) {
    if (node.id === edge.from || node.id === edge.to) continue
    const point = positions.get(node.id)!
    for (let sample = 1; sample < 20; sample += 1) {
      const candidate = quadraticPoint(geometry, sample / 20)
      if (Math.abs(candidate.x - point.x) <= 31 && Math.abs(candidate.y - point.y) <= 34) {
        hits += 1
        break
      }
    }
  }
  return hits
}

function segmentIntersectsBounds(start: PositionedNode, end: PositionedNode, bounds: Bounds) {
  const [left, top, width, height] = bounds
  const right = left + width
  const bottom = top + height
  let minimum = 0
  let maximum = 1
  const dx = end.x - start.x
  const dy = end.y - start.y
  const constraints = [
    [-dx, start.x - left],
    [dx, right - start.x],
    [-dy, start.y - top],
    [dy, bottom - start.y],
  ] as const
  for (const [direction, distance] of constraints) {
    if (direction === 0) {
      if (distance < 0) return false
      continue
    }
    const ratio = distance / direction
    if (direction < 0) minimum = Math.max(minimum, ratio)
    else maximum = Math.min(maximum, ratio)
    if (minimum > maximum) return false
  }
  return true
}

function graphRouteIntersectsBounds(geometry: GraphEdgeGeometry, bounds: Bounds) {
  let previous = geometry.start
  for (let sample = 1; sample <= 80; sample += 1) {
    const current = quadraticPoint(geometry, sample / 80)
    if (segmentIntersectsBounds(previous, current, bounds)) return true
    previous = current
  }
  return false
}

function routeGraphEdges(
  semantic: GraphAlgorithmSemantic,
  layout: GraphTopologyLayout,
  graphBounds: Bounds,
): RoutedGraphEdge[] {
  const occupied: Bounds[] = semantic.nodes.map(node => {
    const point = layout.positions.get(node.id)!
    return [point.x - 28, point.y - 28, 56, 67]
  })
  const labelArea: Bounds = [graphBounds[0], graphBounds[1] + 48, graphBounds[2], graphBounds[3] - 48]
  const labelTimes = [0.5, 0.38, 0.62, 0.27, 0.73, 0.18, 0.82]
  const placedLabelBounds: Bounds[] = []
  const routedGeometries: GraphEdgeGeometry[] = []

  const routed = [...semantic.edges].reverse().map(edge => {
    const edgeIndex = semantic.edges.indexOf(edge)
    const from = layout.positions.get(edge.from)
    const to = layout.positions.get(edge.to)
    if (!from || !to) throw new Error(`visual_scene_graph_endpoint_missing:${edge.id}`)
    const offsets = graphRouteOffsets({
      depthDelta: layout.depths.get(edge.to)! - layout.depths.get(edge.from)!,
      edgeIndex,
      fromIndex: layout.nodeOrder.get(edge.from)!,
      toIndex: layout.nodeOrder.get(edge.to)!,
      middleX: (from.x + to.x) / 2,
    })
    let choice: { geometry: GraphEdgeGeometry; labelBounds: Bounds; labelX: number; labelY: number; score: number } | undefined
    offsets.forEach((offset, offsetIndex) => {
      const geometry = graphEdgeGeometry(from, to, offset)
      if (!contains(graphBounds, geometry.bounds)) return
      const nodeHits = graphRouteNodeHits(geometry, edge, semantic, layout.positions)
      if (nodeHits > 0) return
      if (placedLabelBounds.some(bounds => graphRouteIntersectsBounds(geometry, bounds))) return
      labelTimes.forEach((time, timeIndex) => {
        const point = quadraticPoint(geometry, time)
        const labelBounds: Bounds = [point.x - 25, point.y - 11, 50, 22]
        if (!contains(labelArea, labelBounds) || occupied.some(bounds => intersects(bounds, labelBounds))) return
        if (routedGeometries.some(route => graphRouteIntersectsBounds(route, labelBounds))) return
        const score = offsetIndex * 100 + timeIndex
        if (!choice || score < choice.score) choice = { geometry, labelBounds, labelX: point.x, labelY: point.y, score }
      })
    })
    if (!choice) throw new Error(`visual_scene_graph_edge_or_label_route_blocked:${edge.id}`)
    const selected = choice
    occupied.push(selected.labelBounds)
    placedLabelBounds.push(selected.labelBounds)
    routedGeometries.push(selected.geometry)
    return {
      edge,
      geometry: selected.geometry,
      label: numberLabel(edge.weight),
      labelBounds: selected.labelBounds,
      labelX: selected.labelX,
      labelY: selected.labelY,
    }
  })
  routed.forEach((item, index) => {
    routed.forEach((other, otherIndex) => {
      if (index === otherIndex) return
      if (graphRouteIntersectsBounds(other.geometry, item.labelBounds)) {
        throw new Error(`visual_scene_graph_foreign_edge_crosses_label:${item.edge.id}:${other.edge.id}`)
      }
    })
  })
  return routed.sort((left, right) => semantic.edges.indexOf(left.edge) - semantic.edges.indexOf(right.edge))
}

function selectTraceStep(spec: LearningVisualSpec, state: VisualStateSnapshot, semanticId: string, length: number) {
  const raw = state.values[semanticId]
  const fallback = spec.kind === 'diagram' ? length - 1 : 0
  const selected = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : fallback
  return Math.max(0, Math.min(length - 1, selected))
}

function distanceLabel(value: number | null) {
  return value === null ? '∞' : numberLabel(value)
}

function renderGraphAlgorithm(spec: LearningVisualSpec, semantic: GraphAlgorithmSemantic, state: VisualStateSnapshot, stateCue: string) {
  const derived = deriveDijkstra(semantic)
  const step = selectTraceStep(spec, state, semantic.id, derived.snapshots.length)
  const snapshot = derived.snapshots[step]
  const layout = graphLayout(semantic)
  const positions = layout.positions
  const scene = new SceneBuilder()
  addHeader(scene, spec, 'Dijkstra 可重放轨迹')
  const graphBounds: Bounds = [24, 82, 594, 376]
  const graphRegion = scene.addRegion('weighted-graph', 'weighted-directed-graph', graphBounds, panel(graphBounds, '带权图', semantic.directed ? '有向边 · 权重不可省略' : '无向边 · 权重不可省略', 'green'))
  const targetReached = snapshot.settledIds.includes(semantic.targetId)
  const visiblePathEdges = new Set(derived.pathEdgeIds.filter((edgeId, index) => targetReached || snapshot.settledIds.includes(derived.pathNodeIds[index + 1])))
  const updatedEdges = new Set(snapshot.updates.map(update => update.edgeId))
  const routedEdges = routeGraphEdges(semantic, layout, graphBounds)

  routedEdges.forEach(({ edge, geometry }) => {
    const path = visiblePathEdges.has(edge.id)
    const updating = updatedEdges.has(edge.id)
    const stroke = path ? COLOR.green : updating ? COLOR.amber : COLOR.line
    const marker = path ? 'lf_arrow_active' : updating ? 'lf_arrow_update' : 'lf_arrow'
    scene.addObject({
      regionId: graphRegion,
      rawId: edge.id,
      prefix: 'edge',
      role: 'weighted-edge',
      bounds: geometry.bounds,
      svg: `<path d="${geometry.path}" fill="none" stroke="${stroke}" stroke-width="${path ? 5 : updating ? 3 : 1.8}" ${path ? '' : 'stroke-dasharray="6 5"'} ${semantic.directed ? `marker-end="url(#${marker})"` : ''} stroke-linecap="round"></path>`,
      value: edge.weight,
      status: path ? 'shortest-path' : updating ? 'relaxed-this-step' : 'unselected-edge',
    })
  })

  routedEdges.forEach(({ edge, label, labelBounds, labelX, labelY }) => {
    const path = visiblePathEdges.has(edge.id)
    const updating = updatedEdges.has(edge.id)
    const stroke = path ? COLOR.green : updating ? COLOR.amber : COLOR.line
    const labelLength = Math.max(1, Array.from(label).length)
    const labelSize = Math.max(7, Math.min(11, 42 / (labelLength * 0.62)))
    scene.addObject({
      regionId: graphRegion,
      rawId: edge.id,
      prefix: 'edge_weight',
      role: 'edge-weight-label',
      bounds: labelBounds,
      svg: `<rect x="${labelBounds[0]}" y="${labelBounds[1]}" width="${labelBounds[2]}" height="${labelBounds[3]}" rx="8" fill="#ffffff" stroke="${stroke}" stroke-width="1.5"></rect>${textLines(label, labelX, labelY + labelSize * 0.34, { size: labelSize, weight: 760, color: stroke, lineLength: 12, maxLines: 1, font: 'mono' })}`,
      value: edge.weight,
      status: path ? 'shortest-path' : updating ? 'relaxed-this-step' : 'unselected-edge',
      collisionSensitive: true,
    })
  })

  semantic.nodes.forEach(node => {
    const point = positions.get(node.id)!
    const current = snapshot.currentId === node.id
    const settled = snapshot.settledIds.includes(node.id)
    const onPath = derived.pathNodeIds.includes(node.id) && (targetReached || settled)
    const fill = current ? COLOR.amberSoft : onPath ? COLOR.greenSoft : settled ? '#edf4f0' : '#ffffff'
    const stroke = current ? COLOR.amber : onPath ? COLOR.green : COLOR.line
    const suffix = node.id === semantic.sourceId ? '起点' : node.id === semantic.targetId ? '终点' : settled ? '✓' : ''
    scene.addObject({
      regionId: graphRegion,
      rawId: node.id,
      prefix: 'node',
      role: 'graph-node',
      bounds: [point.x - 28, point.y - 28, 56, 67],
      svg: `<circle cx="${point.x}" cy="${point.y}" r="26" fill="${fill}" stroke="${stroke}" stroke-width="${current ? 4 : onPath ? 3 : 2}"></circle>${textLines(node.label, point.x, point.y + 5, { size: 14, weight: 790, color: COLOR.ink, lineLength: 8, maxLines: 1 })}${suffix ? textLines(suffix, point.x, point.y + 39, { size: 9, weight: 720, color: stroke, lineLength: 8, maxLines: 1 }) : ''}`,
      value: snapshot.distances[node.id],
      status: current ? 'current' : onPath ? 'shortest-path' : settled ? 'settled' : 'unsettled',
      collisionSensitive: true,
    })
  })

  const tableBounds: Bounds = [638, 82, 338, 376]
  const tableRegion = scene.addRegion('distance-table', 'distance-and-parent-table', tableBounds, panel(tableBounds, '距离 / parent', `步骤 ${step} / ${derived.snapshots.length - 1}`, 'blue'))
  scene.addObject({
    regionId: tableRegion,
    rawId: 'table-header',
    prefix: 'table',
    role: 'column-headings',
    bounds: [656, 122, 302, 30],
    svg: `<rect x="656" y="122" width="302" height="30" rx="8" fill="${COLOR.blueSoft}"></rect>${textLines('节点', 690, 142, { size: 11, weight: 750, color: COLOR.blue, maxLines: 1 })}${textLines('d', 782, 142, { size: 11, weight: 750, color: COLOR.blue, maxLines: 1 })}${textLines('parent', 888, 142, { size: 11, weight: 750, color: COLOR.blue, maxLines: 1 })}`,
  })
  const rowHeight = Math.min(36, 278 / Math.max(1, semantic.nodes.length))
  semantic.nodes.forEach((node, index) => {
    const y = 158 + index * rowHeight
    const current = snapshot.currentId === node.id
    const settled = snapshot.settledIds.includes(node.id)
    scene.addObject({
      regionId: tableRegion,
      rawId: node.id,
      prefix: 'distance_row',
      role: 'distance-parent-row',
      bounds: [656, y, 302, rowHeight - 3],
      svg: `<rect x="656" y="${y}" width="302" height="${rowHeight - 3}" rx="7" fill="${current ? COLOR.amberSoft : settled ? COLOR.greenSoft : index % 2 ? '#f8faf9' : '#ffffff'}" stroke="${current ? COLOR.amber : '#e0e8e3'}"></rect>${textLines(`${settled ? '✓ ' : ''}${node.label}`, 674, y + rowHeight / 2 + 4, { anchor: 'start', size: 11, weight: current ? 780 : 620, color: current ? COLOR.amber : COLOR.ink, lineLength: 14, maxLines: 1 })}${textLines(distanceLabel(snapshot.distances[node.id]), 782, y + rowHeight / 2 + 4, { size: 12, weight: 780, color: snapshot.distances[node.id] === null ? COLOR.muted : COLOR.blue, maxLines: 1 })}${textLines(snapshot.parents[node.id] ? semantic.nodes.find(item => item.id === snapshot.parents[node.id])?.label || snapshot.parents[node.id] : '—', 888, y + rowHeight / 2 + 4, { size: 11, weight: 650, color: COLOR.ink, maxLines: 1 })}`,
      value: snapshot.distances[node.id],
      status: current ? 'current' : settled ? 'settled' : 'tentative',
      collisionSensitive: true,
    })
  })

  const summaryBounds: Bounds = [24, 474, 952, 108]
  const summaryRegion = scene.addRegion('relax-summary', 'relaxation-and-shortest-path-summary', summaryBounds, panel(summaryBounds, '本步 relax', '先比较候选距离，再决定是否改 parent', 'amber'))
  const updateText = step === 0
    ? `初始化：d(${semantic.nodes.find(node => node.id === semantic.sourceId)?.label || semantic.sourceId}) = 0，其余节点 = ∞`
    : snapshot.updates.length
      ? snapshot.updates.slice(0, 3).map(update => {
        const edge = semantic.edges.find(item => item.id === update.edgeId)!
        const node = semantic.nodes.find(item => item.id === update.nodeId)?.label || update.nodeId
        const parent = semantic.nodes.find(item => item.id === update.parentId)?.label || update.parentId
        return `d(${node}): ${distanceLabel(update.before)} → min(${distanceLabel(update.before)}, d(${parent})+${numberLabel(edge.weight)}) = ${numberLabel(update.after)}`
      }).join('；')
      : `固定 ${semantic.nodes.find(node => node.id === snapshot.currentId)?.label || snapshot.currentId || '—'}：没有找到更短的候选距离`
  const finalPathText = derived.cost === null
    ? '终点不可达'
    : `最短路：${derived.pathNodeIds.map(id => semantic.nodes.find(node => node.id === id)?.label || id).join(' → ')}；总代价 ${numberLabel(derived.cost)}`
  const pathText = targetReached || spec.kind === 'diagram'
    ? finalPathText
    : `终点尚未 settled；当前 d(${semantic.nodes.find(node => node.id === semantic.targetId)?.label || semantic.targetId})=${distanceLabel(snapshot.distances[semantic.targetId])}`
  scene.addObject({
    regionId: summaryRegion,
    rawId: 'relax-formula',
    prefix: 'formula',
    role: 'relaxation-formula',
    bounds: [48, 512, 904, 26],
    svg: textLines(updateText, 48, 529, { anchor: 'start', size: 11, weight: 650, color: COLOR.ink, lineLength: 116, maxLines: 1, font: 'mono' }),
    status: snapshot.updates.length ? 'distance-updated' : 'no-update',
  })
  scene.addObject({
    regionId: summaryRegion,
    rawId: 'shortest-path',
    prefix: 'summary',
    role: 'shortest-path-result',
    bounds: [48, 544, 904, 27],
    svg: textLines(`${targetReached || spec.kind === 'diagram' ? '结论' : '进度'}：${pathText}${semantic.transferPrompt ? `　｜　${semantic.transferPrompt}` : ''}`, 48, 562, { anchor: 'start', size: 12, weight: 740, color: COLOR.green, lineLength: 112, maxLines: 1 }),
    value: derived.cost,
    status: targetReached ? 'target-settled' : 'target-pending',
  })
  return complete(scene, spec, stateCue || `已 settled：${snapshot.settledIds.map(id => semantic.nodes.find(node => node.id === id)?.label || id).join('、') || '无'}`)
}

function connector(x1: number, y1: number, x2: number, y2: number, active = false, dashed = false) {
  return `<path d="M ${x1} ${y1} L ${x2} ${y2}" fill="none" stroke="${active ? COLOR.green : COLOR.line}" stroke-width="${active ? 3.5 : 2}" ${dashed ? 'stroke-dasharray="7 5"' : ''} marker-end="url(#${active ? 'lf_arrow_active' : 'lf_arrow'})" stroke-linecap="round"></path>`
}

function frequencyCard(scene: SceneBuilder, regionId: string, input: {
  id: string
  label: string
  detail: string
  count: number
  bounds: Bounds
  tone: 'green' | 'blue' | 'amber' | 'red' | 'plain'
  status: string
}) {
  const [x, y, width, height] = input.bounds
  const fill = input.tone === 'green' ? COLOR.greenSoft
    : input.tone === 'blue' ? COLOR.blueSoft
      : input.tone === 'amber' ? COLOR.amberSoft
        : input.tone === 'red' ? COLOR.redSoft
          : '#ffffff'
  const stroke = input.tone === 'green' ? COLOR.green
    : input.tone === 'blue' ? COLOR.blue
      : input.tone === 'amber' ? COLOR.amber
        : input.tone === 'red' ? COLOR.red
          : COLOR.line
  scene.addObject({
    regionId,
    rawId: input.id,
    prefix: 'frequency',
    role: 'frequency-count',
    bounds: input.bounds,
    svg: `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="2"></rect>${textLines(input.label, x + width / 2, y + 22, { size: 11, weight: 740, color: stroke, lineLength: 16, maxLines: 1 })}${textLines(numberLabel(input.count), x + width / 2, y + 47, { size: 20, weight: 820, color: COLOR.ink, maxLines: 1 })}${textLines(input.detail, x + width / 2, y + height - 9, { size: 9, weight: 560, color: COLOR.muted, lineLength: 22, maxLines: 1 })}`,
    value: input.count,
    status: input.status,
    collisionSensitive: true,
  })
}

function renderNaturalFrequency(spec: LearningVisualSpec, semantic: NaturalFrequencySemantic, state: VisualStateSnapshot, stateCue: string) {
  const derived = deriveNaturalFrequency(semantic)
  const scene = new SceneBuilder()
  addHeader(scene, spec, '自然频数 · 贝叶斯')
  const treeBounds: Bounds = [24, 82, 744, 500]
  const treeRegion = scene.addRegion('frequency-tree', 'three-level-natural-frequency-tree', treeBounds, panel(treeBounds, '把概率换成具体人数', `总人数 ${numberLabel(semantic.population)}`, 'blue'))

  const cards = {
    population: [44, 274, 112, 80] as Bounds,
    condition: [210, 142, 132, 78] as Bounds,
    noCondition: [210, 414, 132, 78] as Bounds,
    tp: [410, 102, 132, 72] as Bounds,
    fn: [410, 230, 132, 72] as Bounds,
    fp: [410, 350, 132, 72] as Bounds,
    tn: [410, 478, 132, 72] as Bounds,
    positives: [620, 236, 128, 94] as Bounds,
  }
  const connections = [
    ['population-condition', 156, 314, 210, 181, false],
    ['population-no-condition', 156, 314, 210, 453, false],
    ['condition-tp', 342, 181, 410, 138, true],
    ['condition-fn', 342, 181, 410, 266, false],
    ['no-condition-fp', 342, 453, 410, 386, true],
    ['no-condition-tn', 342, 453, 410, 514, false],
    ['tp-positive-pool', 542, 138, 620, 268, true],
    ['fp-positive-pool', 542, 386, 620, 294, true],
  ] as const
  connections.forEach(([id, x1, y1, x2, y2, active]) => scene.addObject({
    regionId: treeRegion,
    rawId: id,
    prefix: 'frequency_flow',
    role: active ? 'positive-flow' : 'branch-flow',
    bounds: boundsOf(x1, y1, x2, y2, 5),
    svg: connector(x1, y1, x2, y2, active, !active),
    status: active ? 'joins-positive-pool' : 'branch',
  }))
  frequencyCard(scene, treeRegion, { id: 'population', label: '总样本', detail: '第 1 层', count: semantic.population, bounds: cards.population, tone: 'plain', status: 'population' })
  frequencyCard(scene, treeRegion, { id: 'condition', label: semantic.conditionLabel, detail: `流行率 ${percent(semantic.prevalence)}`, count: derived.condition, bounds: cards.condition, tone: 'blue', status: 'condition' })
  frequencyCard(scene, treeRegion, { id: 'no-condition', label: `非${semantic.conditionLabel}`, detail: `占比 ${percent(1 - semantic.prevalence)}`, count: derived.noCondition, bounds: cards.noCondition, tone: 'plain', status: 'no-condition' })
  frequencyCard(scene, treeRegion, { id: 'true-positive', label: 'TP 真阳性', detail: `敏感度 ${percent(semantic.sensitivity)}`, count: derived.truePositive, bounds: cards.tp, tone: 'green', status: 'positive-and-condition' })
  frequencyCard(scene, treeRegion, { id: 'false-negative', label: 'FN 假阴性', detail: '有条件但未检出', count: derived.falseNegative, bounds: cards.fn, tone: 'red', status: 'negative-but-condition' })
  frequencyCard(scene, treeRegion, { id: 'false-positive', label: 'FP 假阳性', detail: `假阳性率 ${percent(1 - semantic.specificity)}`, count: derived.falsePositive, bounds: cards.fp, tone: 'amber', status: 'positive-but-no-condition' })
  frequencyCard(scene, treeRegion, { id: 'true-negative', label: 'TN 真阴性', detail: `特异度 ${percent(semantic.specificity)}`, count: derived.trueNegative, bounds: cards.tn, tone: 'plain', status: 'negative-and-no-condition' })
  frequencyCard(scene, treeRegion, { id: 'positive-pool', label: `${semantic.positiveLabel}总数`, detail: `TP ${numberLabel(derived.truePositive)} + FP ${numberLabel(derived.falsePositive)}`, count: derived.positives, bounds: cards.positives, tone: 'green', status: 'positive-pool' })

  const analysisBounds: Bounds = [784, 82, 192, 500]
  const analysisRegion = scene.addRegion('posterior-analysis', 'posterior-ratio-and-formula', analysisBounds, panel(analysisBounds, '阳性里谁更多？', 'TP : FP', 'amber'))
  const barX = 804
  const barY = 152
  const barWidth = 152
  const trueWidth = barWidth * derived.posterior
  scene.addObject({
    regionId: analysisRegion,
    rawId: 'tp-fp-ratio',
    prefix: 'ratio_bar',
    role: 'true-positive-false-positive-ratio',
    bounds: [barX, barY, barWidth, 52],
    svg: `<rect x="${barX}" y="${barY}" width="${barWidth}" height="52" rx="12" fill="${COLOR.amberSoft}" stroke="${COLOR.amber}"></rect><path d="M ${barX + trueWidth} ${barY} L ${barX + trueWidth} ${barY + 52}" stroke="#ffffff" stroke-width="3"></path><rect x="${barX}" y="${barY}" width="${trueWidth}" height="52" rx="12" fill="${COLOR.green}"></rect>${textLines('TP', barX + Math.max(12, trueWidth / 2), barY + 32, { size: 10, weight: 800, color: '#ffffff', maxLines: 1 })}${textLines('FP', barX + trueWidth + (barWidth - trueWidth) / 2, barY + 32, { size: 10, weight: 800, color: COLOR.amber, maxLines: 1 })}`,
    value: derived.posterior,
    status: 'true-proportion-of-positive-pool',
  })
  scene.addObject({
    regionId: analysisRegion,
    rawId: 'ratio-legend',
    prefix: 'legend',
    role: 'ratio-counts',
    bounds: [804, 216, 152, 40],
    svg: `${textLines(`TP ${numberLabel(derived.truePositive)}`, 804, 232, { anchor: 'start', size: 11, weight: 700, color: COLOR.green, maxLines: 1 })}${textLines(`FP ${numberLabel(derived.falsePositive)}`, 956, 232, { anchor: 'end', size: 11, weight: 700, color: COLOR.amber, maxLines: 1 })}${textLines(`真实宽度比 ${numberLabel(derived.truePositive)}:${numberLabel(derived.falsePositive)}`, 880, 251, { size: 9, weight: 560, color: COLOR.muted, lineLength: 28, maxLines: 1 })}`,
  })
  scene.addObject({
    regionId: analysisRegion,
    rawId: 'posterior-formula',
    prefix: 'formula',
    role: 'posterior-formula',
    bounds: [802, 278, 156, 126],
    svg: `<rect x="802" y="278" width="156" height="126" rx="15" fill="#ffffff" stroke="#d6c07f"></rect>${textLines(`P(${semantic.conditionLabel}|${semantic.positiveLabel})`, 880, 304, { size: 10, weight: 720, color: COLOR.ink, lineLength: 20, maxLines: 1 })}${textLines(`= TP ÷ (TP + FP)`, 880, 332, { size: 11, weight: 620, color: COLOR.muted, lineLength: 22, maxLines: 1, font: 'mono' })}${textLines(`= ${numberLabel(derived.truePositive)} ÷ ${numberLabel(derived.positives)}`, 880, 359, { size: 12, weight: 720, color: COLOR.ink, lineLength: 22, maxLines: 1, font: 'mono' })}${textLines(`= ${percent(derived.posterior)}`, 880, 389, { size: 22, weight: 840, color: COLOR.green, maxLines: 1 })}`,
    value: derived.posterior,
    status: 'verified-posterior',
  })
  scene.addObject({
    regionId: analysisRegion,
    rawId: 'prediction-prompt',
    prefix: 'prompt',
    role: 'prediction-question',
    bounds: [802, 430, 156, 126],
    svg: `<rect x="802" y="430" width="156" height="126" rx="15" fill="${COLOR.plumSoft}" stroke="#c4a6cc"></rect>${textLines('先预测，再看比例', 880, 455, { size: 11, weight: 760, color: COLOR.plum, lineLength: 20, maxLines: 1 })}${textLines(semantic.predictionPrompt || `若${semantic.positiveLabel}，真正${semantic.conditionLabel}的比例会高于 50% 吗？`, 880, 503, { size: 10, weight: 610, color: COLOR.ink, lineLength: 15, maxLines: 4 })}`,
  })
  return complete(scene, spec, stateCue || `人数守恒：${derived.truePositive}+${derived.falseNegative}+${derived.falsePositive}+${derived.trueNegative}=${semantic.population}`)
}

type EventLocation = 'code' | 'stack' | 'web-api' | 'microtasks' | 'tasks' | 'output'

function eventGridToken(bounds: Bounds, slot: number, columns: number, rows: number, reserveBottom = 0) {
  const gapX = 6
  const gapY = 5
  const left = bounds[0] + 14
  const top = bounds[1] + 50
  const availableWidth = bounds[2] - 28
  const availableHeight = bounds[3] - 62 - reserveBottom
  const width = (availableWidth - gapX * (columns - 1)) / columns
  const height = Math.min(32, (availableHeight - gapY * (rows - 1)) / rows)
  return {
    x: left + (slot % columns) * (width + gapX),
    y: top + Math.floor(slot / columns) * (height + gapY),
    width,
    height,
  }
}

function completedOperationIds(semantic: EventLoopSemantic, snapshot: EventLoopSnapshot) {
  const ordered = [...semantic.operations].sort((left, right) => left.order - right.order)
  const executionOrder = [
    ...ordered.filter(operation => operation.kind === 'sync'),
    ...ordered.filter(operation => operation.kind === 'microtask'),
    ...ordered.filter(operation => operation.kind === 'task'),
  ]
  return executionOrder.slice(0, snapshot.output.length).map(operation => operation.id)
}

function eventLocation(operation: EventLoopSemantic['operations'][number], snapshot: EventLoopSnapshot, completed: Set<string>): EventLocation {
  if (snapshot.activeOperationId === operation.id) return 'stack'
  if (completed.has(operation.id)) return 'output'
  if (snapshot.microtasks.includes(operation.id)) return 'microtasks'
  if (snapshot.tasks.includes(operation.id)) return 'tasks'
  if (snapshot.webApi.includes(operation.id)) return 'web-api'
  return 'code'
}

function renderEventLoop(spec: LearningVisualSpec, semantic: EventLoopSemantic, state: VisualStateSnapshot, stateCue: string) {
  const derived = deriveEventLoop(semantic)
  const step = selectTraceStep(spec, state, semantic.id, derived.snapshots.length)
  const snapshot = derived.snapshots[step]
  const scene = new SceneBuilder()
  addHeader(scene, spec, 'JavaScript Event Loop')
  const zones: Record<EventLocation, { bounds: Bounds; title: string; role: string; tone: 'plain' | 'green' | 'blue' | 'amber' | 'plum' }> = {
    code: { bounds: [24, 82, 360, 500], title: '代码', role: 'source-code', tone: 'plain' },
    stack: { bounds: [404, 82, 174, 150], title: '调用栈', role: 'call-stack', tone: 'amber' },
    'web-api': { bounds: [598, 82, 378, 150], title: 'Web API', role: 'web-api', tone: 'blue' },
    microtasks: { bounds: [404, 252, 270, 150], title: '微任务队列', role: 'microtask-queue', tone: 'green' },
    tasks: { bounds: [694, 252, 282, 150], title: '任务队列', role: 'task-queue', tone: 'plum' },
    output: { bounds: [404, 422, 572, 160], title: '输出', role: 'output-sequence', tone: 'plain' },
  }
  const regionIds = Object.fromEntries((Object.entries(zones) as Array<[EventLocation, typeof zones[EventLocation]]>).map(([key, zone]) => [
    key,
    scene.addRegion(`event-${key}`, zone.role, zone.bounds, panel(zone.bounds, zone.title, key === 'output' ? '严格记录可观察顺序' : '', zone.tone)),
  ])) as Record<EventLocation, string>

  const lineHeight = Math.min(26, 416 / Math.max(1, semantic.lines.length))
  const linePositions = new Map<string, { y: number; index: number }>()
  semantic.lines.forEach((line, index) => {
    const y = 126 + index * lineHeight
    linePositions.set(line.id, { y, index })
    const active = snapshot.activeLineId === line.id
    scene.addObject({
      regionId: regionIds.code,
      rawId: line.id,
      prefix: 'code_line',
      role: 'source-line',
      bounds: [36, y - 17, 336, lineHeight - 2],
      svg: `<rect x="36" y="${y - 17}" width="336" height="${lineHeight - 2}" rx="6" fill="${active ? COLOR.amberSoft : index % 2 ? '#f7faf8' : '#ffffff'}" stroke="${active ? COLOR.amber : '#edf1ef'}" stroke-width="${active ? 2 : 1}"></rect>${textLines(`${active ? '▶' : ' '} ${line.number}  ${line.text}`, 45, y, { anchor: 'start', size: 10, weight: active ? 760 : 560, color: active ? COLOR.amber : COLOR.ink, lineLength: 34, maxLines: 1, font: 'mono' })}`,
      status: active ? 'executing' : 'idle',
      collisionSensitive: true,
    })
  })

  if (snapshot.callStack.includes('main')) {
    scene.addObject({
      regionId: regionIds.stack,
      rawId: 'main',
      prefix: 'stack_frame',
      role: 'stack-frame',
      bounds: [422, 178, 138, 34],
      svg: `<rect x="422" y="178" width="138" height="34" rx="9" fill="#ffffff" stroke="${COLOR.amber}"></rect>${textLines('main()', 491, 200, { size: 11, weight: 740, color: COLOR.amber, font: 'mono', maxLines: 1 })}`,
      status: 'on-stack',
    })
  }

  const completedIds = completedOperationIds(semantic, snapshot)
  const completed = new Set(completedIds)
  const outputSlots = new Map(completedIds.map((operationId, index) => [operationId, index]))
  const locationCounts: Record<EventLocation, number> = { code: 0, stack: 0, 'web-api': 0, microtasks: 0, tasks: 0, output: 0 }
  const orderedOperations = [...semantic.operations].sort((left, right) => left.order - right.order)
  const operationSlots = new Map(orderedOperations.map((operation, index) => [operation.id, index]))
  const maximumQueueDepth = Math.max(
    orderedOperations.filter(operation => operation.kind === 'microtask').length,
    orderedOperations.filter(operation => operation.kind === 'task').length,
  )
  const denseLayout = maximumQueueDepth > 2 || orderedOperations.length > 6
  const denseColumns = orderedOperations.length <= 8 ? 2 : 4
  const denseRows = Math.ceil(orderedOperations.length / denseColumns)
  orderedOperations.forEach(operation => {
    const location = eventLocation(operation, snapshot, completed)
    const slot = location === 'output'
      ? outputSlots.get(operation.id) ?? locationCounts.output++
      : denseLayout && location !== 'code' && location !== 'stack'
        ? operationSlots.get(operation.id) ?? locationCounts[location]++
        : locationCounts[location]++
    let x = 0
    let y = 0
    let width = 0
    let height = 32
    if (location === 'code') {
      const line = linePositions.get(operation.lineId)
      x = 270
      y = (line?.y || 130) - 14
      width = 92
    } else if (location === 'stack') {
      x = 422
      y = 135 + slot * 42
      width = 138
    } else if (location === 'web-api') {
      if (denseLayout) ({ x, y, width, height } = eventGridToken(zones['web-api'].bounds, slot, denseColumns, denseRows))
      else {
        x = 618 + (slot % 2) * 174
        y = 135 + Math.floor(slot / 2) * 40
        width = 158
      }
    } else if (location === 'microtasks') {
      if (denseLayout) ({ x, y, width, height } = eventGridToken(zones.microtasks.bounds, slot, denseColumns, denseRows))
      else {
        x = 424
        y = 305 + slot * 39
        width = 230
      }
    } else if (location === 'tasks') {
      if (denseLayout) ({ x, y, width, height } = eventGridToken(zones.tasks.bounds, slot, denseColumns, denseRows))
      else {
        x = 714
        y = 305 + slot * 39
        width = 242
      }
    } else {
      if (denseLayout) ({ x, y, width, height } = eventGridToken(zones.output.bounds, slot, denseColumns, denseRows, 32))
      else {
        x = 424 + (slot % 3) * 178
        y = 470 + Math.floor(slot / 3) * 38
        width = 162
      }
    }
    const active = snapshot.activeOperationId === operation.id
    const fill = location === 'output' ? COLOR.greenSoft
      : location === 'microtasks' ? '#edf9f3'
        : location === 'tasks' ? COLOR.plumSoft
          : location === 'web-api' ? COLOR.blueSoft
            : active ? COLOR.amberSoft : '#ffffff'
    const stroke = location === 'output' ? COLOR.green
      : location === 'microtasks' ? COLOR.green
        : location === 'tasks' ? COLOR.plum
          : location === 'web-api' ? COLOR.blue
            : active ? COLOR.amber : COLOR.line
    const label = location === 'output' ? `${operation.label} → ${operation.output}` : operation.label
    const labelSize = denseLayout && location !== 'code' && location !== 'stack' ? (denseColumns === 4 ? 6.8 : 8.5) : 9.5
    scene.addObject({
      regionId: regionIds[location],
      rawId: operation.id,
      prefix: 'callback_token',
      role: 'stable-callback-token',
      bounds: [x, y, width, height],
      svg: `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${Math.min(10, height / 3)}" fill="${fill}" stroke="${stroke}" stroke-width="${active ? 2.5 : 1.5}" ${location === 'tasks' ? 'stroke-dasharray="6 3"' : ''}></rect>${textLines(label, x + width / 2, y + height / 2 + labelSize * 0.34, { size: labelSize, weight: active || location === 'output' ? 750 : 620, color: stroke, lineLength: Math.max(6, Math.floor(width / (labelSize * 0.62))), maxLines: 1, font: 'mono' })}`,
      value: operation.output,
      status: `${location}${active ? ':active' : ''}`,
      collisionSensitive: location !== 'code',
    })
  })

  scene.addObject({
    regionId: regionIds.output,
    rawId: 'output-order',
    prefix: 'output',
    role: 'observable-output-order',
    bounds: [424, 548, 532, 25],
    svg: textLines(`当前输出：${snapshot.output.length ? snapshot.output.join(' → ') : '（空）'}`, 424, 565, { anchor: 'start', size: 12, weight: 760, color: COLOR.green, lineLength: 72, maxLines: 1, font: 'mono' }),
    value: snapshot.output.join(','),
    status: snapshot.phase,
  })
  const phaseLabels: Record<EventLoopSnapshot['phase'], string> = {
    initial: '等待执行',
    script: '执行整段 script',
    drain_microtasks: '清空微任务',
    next_task: '取下一个任务',
    complete: '完成',
  }
  return complete(scene, spec, stateCue || `${phaseLabels[snapshot.phase]}；输出顺序 ${snapshot.output.join(' → ') || '尚无'}`)
}

function renderOptimization(spec: LearningVisualSpec, semantic: OptimizationSemantic, state: VisualStateSnapshot, stateCue: string) {
  const derived = deriveOptimization(semantic)
  const step = selectTraceStep(spec, state, semantic.id, derived.snapshots.length)
  const snapshot = derived.snapshots[step]
  const scene = new SceneBuilder()
  addHeader(scene, spec, '梯度下降 · 固定相机')
  const plotBounds: Bounds = [24, 82, 650, 500]
  const plotRegion = scene.addRegion('optimization-plot', 'fixed-camera-objective-plot', plotBounds, panel(plotBounds, 'f(x) = (x − c)²', `固定坐标域 [${numberLabel(semantic.axes.xDomain[0])}, ${numberLabel(semantic.axes.xDomain[1])}]`, 'blue'))
  const chart = { left: 72, top: 134, width: 552, height: 380 }
  const xMin = semantic.axes.xDomain[0]
  const xMax = semantic.axes.xDomain[1]
  const yMin = semantic.axes.yDomain[0]
  const yMax = semantic.axes.yDomain[1]
  const xToPixel = (value: number) => chart.left + ((value - xMin) / (xMax - xMin)) * chart.width
  const yToPixel = (value: number) => chart.top + chart.height - ((value - yMin) / (yMax - yMin)) * chart.height
  const clampX = (value: number) => Math.max(chart.left, Math.min(chart.left + chart.width, value))
  const clampY = (value: number) => Math.max(chart.top, Math.min(chart.top + chart.height, value))
  const axisX = clampX(xToPixel(0))
  const axisY = clampY(yToPixel(0))
  const grid = Array.from({ length: 6 }, (_, index) => {
    const x = chart.left + index * chart.width / 5
    const y = chart.top + index * chart.height / 5
    const xValue = xMin + index * (xMax - xMin) / 5
    const yValue = yMax - index * (yMax - yMin) / 5
    return `<line x1="${x}" y1="${chart.top}" x2="${x}" y2="${chart.top + chart.height}" stroke="#e3ebe7" stroke-width="1"></line><line x1="${chart.left}" y1="${y}" x2="${chart.left + chart.width}" y2="${y}" stroke="#e3ebe7" stroke-width="1"></line>${textLines(numberLabel(xValue), x, chart.top + chart.height + 19, { size: 8.5, weight: 520, color: COLOR.muted, maxLines: 1 })}${textLines(numberLabel(yValue), chart.left - 9, y + 3, { anchor: 'end', size: 8.5, weight: 520, color: COLOR.muted, maxLines: 1 })}`
  }).join('')
  scene.addObject({
    regionId: plotRegion,
    rawId: 'fixed-axes',
    prefix: 'axes',
    role: 'fixed-coordinate-system',
    bounds: [48, 116, 596, 430],
    svg: `${grid}<line x1="${chart.left}" y1="${axisY}" x2="${chart.left + chart.width}" y2="${axisY}" stroke="${COLOR.ink}" stroke-width="2"></line><line x1="${axisX}" y1="${chart.top}" x2="${axisX}" y2="${chart.top + chart.height}" stroke="${COLOR.ink}" stroke-width="2"></line>${textLines(semantic.axes.xLabel, chart.left + chart.width, axisY - 10, { anchor: 'end', size: 10, weight: 720, color: COLOR.ink, maxLines: 1 })}${textLines(semantic.axes.yLabel, axisX + 10, chart.top + 12, { anchor: 'start', size: 10, weight: 720, color: COLOR.ink, maxLines: 1 })}`,
    status: 'camera-fixed-across-frames',
  })
  const curvePoints = Array.from({ length: 101 }, (_, index) => {
    const x = xMin + index * (xMax - xMin) / 100
    const y = (x - semantic.center) ** 2
    return [xToPixel(x), clampY(yToPixel(y))] as const
  })
  const curvePath = curvePoints.map((point, index) => `${index ? 'L' : 'M'} ${point[0].toFixed(2)} ${point[1].toFixed(2)}`).join(' ')
  scene.addObject({
    regionId: plotRegion,
    rawId: semantic.id,
    prefix: 'objective_curve',
    role: 'objective-curve',
    bounds: [chart.left, chart.top, chart.width, chart.height],
    svg: `<path d="${curvePath}" fill="none" stroke="${COLOR.blue}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path>`,
    status: 'fixed-curve',
  })
  const historyPath = snapshot.history.map((point, index) => `${index ? 'L' : 'M'} ${clampX(xToPixel(point.x)).toFixed(2)} ${clampY(yToPixel(point.y)).toFixed(2)}`).join(' ')
  if (snapshot.history.length > 1) {
    scene.addObject({
      regionId: plotRegion,
      rawId: 'optimization-history',
      prefix: 'history_path',
      role: 'optimization-history',
      bounds: [chart.left, chart.top, chart.width, chart.height],
      svg: `<path d="${historyPath}" fill="none" stroke="${COLOR.green}" stroke-width="2.5" stroke-dasharray="6 4" stroke-linecap="round"></path>`,
      status: 'visited-points',
    })
  }
  snapshot.history.forEach(point => {
    const x = clampX(xToPixel(point.x))
    const y = clampY(yToPixel(point.y))
    scene.addObject({
      regionId: plotRegion,
      rawId: `${semantic.id}.history.${point.step}`,
      prefix: 'history_point',
      role: 'visited-point',
      bounds: [x - 6, y - 6, 12, 12],
      svg: `<circle cx="${x}" cy="${y}" r="5" fill="#ffffff" stroke="${COLOR.green}" stroke-width="2"></circle>`,
      value: point.x,
      status: point.step === snapshot.point.step ? 'current-history-point' : 'past',
    })
  })
  const currentX = clampX(xToPixel(snapshot.point.x))
  const currentY = clampY(yToPixel(snapshot.point.y))
  scene.addObject({
    regionId: plotRegion,
    rawId: semantic.id,
    prefix: 'current_point',
    role: 'stable-current-point',
    bounds: [currentX - 12, currentY - 12, 24, 41],
    svg: `<circle cx="${currentX}" cy="${currentY}" r="10" fill="${COLOR.amberSoft}" stroke="${COLOR.amber}" stroke-width="4"></circle>${textLines(`x=${numberLabel(snapshot.point.x)}`, currentX, currentY - 18, { size: 10, weight: 780, color: COLOR.amber, lineLength: 16, maxLines: 1, font: 'mono' })}`,
    value: snapshot.point.x,
    status: `iteration-${snapshot.iteration}:${snapshot.phase}`,
  })
  const tangentDx = (xMax - xMin) * 0.13
  const tangentX1 = snapshot.point.x - tangentDx
  const tangentX2 = snapshot.point.x + tangentDx
  const tangentY1 = snapshot.point.y + snapshot.point.gradient * (tangentX1 - snapshot.point.x)
  const tangentY2 = snapshot.point.y + snapshot.point.gradient * (tangentX2 - snapshot.point.x)
  scene.addObject({
    regionId: plotRegion,
    rawId: `${semantic.id}.tangent`,
    prefix: 'tangent',
    role: 'gradient-tangent',
    bounds: boundsOf(clampX(xToPixel(tangentX1)), clampY(yToPixel(tangentY1)), clampX(xToPixel(tangentX2)), clampY(yToPixel(tangentY2)), 4),
    svg: `<line x1="${clampX(xToPixel(tangentX1))}" y1="${clampY(yToPixel(tangentY1))}" x2="${clampX(xToPixel(tangentX2))}" y2="${clampY(yToPixel(tangentY2))}" stroke="${COLOR.plum}" stroke-width="3" stroke-dasharray="8 4" stroke-linecap="round"></line>`,
    value: snapshot.point.gradient,
    status: 'local-gradient',
  })
  if (snapshot.nextX !== undefined) {
    const nextY = (snapshot.nextX - semantic.center) ** 2
    const nextPixelX = clampX(xToPixel(snapshot.nextX))
    const nextPixelY = clampY(yToPixel(nextY))
    scene.addObject({
      regionId: plotRegion,
      rawId: `${semantic.id}.update.${snapshot.iteration}`,
      prefix: 'update_arrow',
      role: 'parameter-update-arrow',
      bounds: boundsOf(currentX, currentY, nextPixelX, nextPixelY, 8),
      svg: `<path d="M ${currentX} ${currentY} L ${nextPixelX} ${nextPixelY}" fill="none" stroke="${COLOR.amber}" stroke-width="4" marker-end="url(#lf_arrow_update)" stroke-linecap="round"></path>`,
      value: snapshot.nextX,
      status: 'next-step',
    })
  }

  const formulaBounds: Bounds = [694, 82, 282, 500]
  const formulaRegion = scene.addRegion('optimization-formulas', 'gradient-and-update-formulas', formulaBounds, panel(formulaBounds, '一步怎么算？', `轨迹 ${step} / ${derived.snapshots.length - 1}`, 'amber'))
  scene.addObject({
    regionId: formulaRegion,
    rawId: 'objective-formula',
    prefix: 'formula',
    role: 'objective-formula',
    bounds: [716, 132, 238, 64],
    svg: `<rect x="716" y="132" width="238" height="64" rx="13" fill="#ffffff" stroke="${COLOR.border}"></rect>${textLines(`f(x) = (x − ${numberLabel(semantic.center)})²`, 835, 160, { size: 16, weight: 760, color: COLOR.blue, font: 'mono', maxLines: 1 })}${textLines(`f(${numberLabel(snapshot.point.x)}) = ${numberLabel(snapshot.point.y)}`, 835, 184, { size: 11, weight: 620, color: COLOR.muted, font: 'mono', maxLines: 1 })}`,
    value: snapshot.point.y,
  })
  scene.addObject({
    regionId: formulaRegion,
    rawId: 'gradient-formula',
    prefix: 'formula',
    role: 'gradient-formula',
    bounds: [716, 214, 238, 78],
    svg: `<rect x="716" y="214" width="238" height="78" rx="13" fill="${COLOR.plumSoft}" stroke="#c4a6cc"></rect>${textLines(`∇f = 2(x − ${numberLabel(semantic.center)})`, 835, 242, { size: 15, weight: 760, color: COLOR.plum, font: 'mono', maxLines: 1 })}${textLines(`= ${numberLabel(snapshot.point.gradient)}`, 835, 272, { size: 18, weight: 820, color: COLOR.plum, font: 'mono', maxLines: 1 })}`,
    value: snapshot.point.gradient,
    status: 'current-gradient',
  })
  const updatePresentation = snapshot.nextX !== undefined
    ? {
        headline: 'x(k+1) = x(k) − α·∇f',
        calculation: `= ${numberLabel(snapshot.point.x)} − ${numberLabel(semantic.learningRate)}×${numberLabel(snapshot.point.gradient)}`,
        result: `= ${numberLabel(snapshot.nextX)}`,
        value: snapshot.nextX,
        status: 'next-value',
      }
    : snapshot.phase === 'initial'
      ? {
          headline: 'x₁ = x₀ − α·∇f₀',
          calculation: `= ${numberLabel(snapshot.point.x)} − ${numberLabel(semantic.learningRate)}×${numberLabel(snapshot.point.gradient)}`,
          result: '= ?（先预测）',
          value: null,
          status: 'prediction-pending',
        }
      : snapshot.phase === 'move'
        ? {
            headline: `已应用第 ${snapshot.iteration} 步更新`,
            calculation: `x${snapshot.iteration} = ${numberLabel(snapshot.point.x)}`,
            result: '下一步先读新梯度',
            value: snapshot.point.x,
            status: 'move-complete',
          }
        : {
            headline: '本演示的最后一点',
            calculation: `x${snapshot.iteration} = ${numberLabel(snapshot.point.x)}`,
            result: `距最小点 ${numberLabel(Math.abs(snapshot.point.x - semantic.center))}`,
            value: snapshot.point.x,
            status: 'trace-summary',
          }
  scene.addObject({
    regionId: formulaRegion,
    rawId: 'update-formula',
    prefix: 'formula',
    role: 'gradient-descent-update',
    bounds: [716, 310, 238, 108],
    svg: `<rect x="716" y="310" width="238" height="108" rx="13" fill="${COLOR.amberSoft}" stroke="#dfbd68"></rect>${textLines(updatePresentation.headline, 835, 338, { size: 13, weight: 760, color: COLOR.amber, font: 'mono', maxLines: 1 })}${textLines(updatePresentation.calculation, 835, 370, { size: 12, weight: 680, color: COLOR.ink, font: 'mono', maxLines: 1 })}${textLines(updatePresentation.result, 835, 402, { size: 18, weight: 840, color: COLOR.green, font: 'mono', maxLines: 1 })}`,
    value: updatePresentation.value,
    status: updatePresentation.status,
  })
  scene.addObject({
    regionId: formulaRegion,
    rawId: 'iteration-sequence',
    prefix: 'summary',
    role: 'parameter-sequence',
    bounds: [716, 440, 238, 116],
    svg: `<rect x="716" y="440" width="238" height="116" rx="13" fill="${COLOR.greenSoft}" stroke="${COLOR.green}"></rect>${textLines('x 的收敛轨迹', 835, 466, { size: 12, weight: 760, color: COLOR.green, maxLines: 1 })}${textLines([
      ...snapshot.history.map(point => numberLabel(point.x)),
      ...(snapshot.phase === 'initial' ? ['?'] : []),
      ...(snapshot.phase === 'gradient' && snapshot.nextX !== undefined ? [numberLabel(snapshot.nextX)] : []),
    ].join(' → '), 835, 507, { size: 12, weight: 720, color: COLOR.ink, lineLength: 28, maxLines: 3, font: 'mono' })}${textLines(`目标 x* = ${numberLabel(semantic.center)}`, 835, 545, { size: 11, weight: 700, color: COLOR.green, maxLines: 1 })}`,
    status: snapshot.phase,
  })
  const phaseLabels: Record<OptimizationSnapshot['phase'], string> = { initial: '从初值出发', gradient: '读取局部斜率并预测下一点', move: '沿负梯度移动', summary: '观察收敛' }
  return complete(scene, spec, stateCue || `第 ${snapshot.iteration} 轮：${phaseLabels[snapshot.phase]}；x=${numberLabel(snapshot.point.x)}，∇f=${numberLabel(snapshot.point.gradient)}`)
}

/**
 * Compile a high-level, computable teaching semantic into a deterministic SVG
 * scene. The public spec never supplies drawing commands or pixel geometry;
 * stable coordinates and safe SVG primitives live exclusively in this module.
 */
export function renderDerivedTeachingVisual(
  spec: LearningVisualSpec,
  state: VisualStateSnapshot,
  stateCue = '',
): DerivedTeachingRenderResult {
  const semantic = spec.semantic
  if (semantic.type === 'matrix_operation') return renderMatrix(spec, semantic, state, stateCue)
  if (semantic.type === 'graph_algorithm') return renderGraphAlgorithm(spec, semantic, state, stateCue)
  if (semantic.type === 'natural_frequency') return renderNaturalFrequency(spec, semantic, state, stateCue)
  if (semantic.type === 'event_loop') return renderEventLoop(spec, semantic, state, stateCue)
  if (semantic.type === 'optimization') return renderOptimization(spec, semantic, state, stateCue)
  throw new Error(`visual_scene_semantic_unsupported:${semantic.type}`)
}
