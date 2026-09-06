import type { VisualArtifact } from '../../src/tooling.ts'
import {
  RENDERER_VERSION,
  type CodeTraceSemantic,
  type ConvolutionTraceSemantic,
  type DataStructureSemantic,
  type DerivationSemantic,
  type FunctionSemantic,
  type LearningVisualQuality,
  type LearningVisualFrame,
  type LearningVisualSpec,
  type LegacyLearningVisualFrame,
  type LegacyLearningVisualSpec,
  type ProbabilitySemantic,
  type ProtocolSequenceSemantic,
  type ReadableLearningVisualSpec,
  type ReadableVisualStep,
  type ReplayableVisualArtifact,
  type SemanticSceneSemantic,
  type StateMachineSemantic,
  type SystemStructureSemantic,
  type TensorShapeFlowSemantic,
  type TransformationSemantic,
  type VisualPoint,
  type VisualSceneManifest,
  type VisualStateSnapshot,
} from './types.ts'
import { describePatch, inspectLearningVisualSpec, replayAnimation } from './runtime.ts'
import { deriveConvolution, isDerivedSemantic } from './derived.ts'
import { renderDerivedTeachingVisual } from './teaching-scene.ts'

type RenderResult = { svg: string; collisions: number; outOfBounds: number; manifest?: VisualSceneManifest }
type GraphNode = { id: string; label: string; detail?: string }
type GraphEdge = { id: string; from: string; to: string; label?: string }

function escapeXml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function wrapLabel(value: string, size = 11) {
  const characters = Array.from(value)
  const lines: string[] = []
  for (let index = 0; index < characters.length; index += size) lines.push(characters.slice(index, index + size).join(''))
  return lines.slice(0, 3)
}

function svgTextLines(value: string, x: number, y: number, options: { size?: number; weight?: number; color?: string; anchor?: 'start' | 'middle' | 'end'; lineLength?: number } = {}) {
  const size = options.size ?? 13
  const anchor = options.anchor ?? 'middle'
  const lines = wrapLabel(value, options.lineLength ?? 12)
  const start = y - ((lines.length - 1) * (size + 3)) / 2
  return `<text x="${x}" y="${start}" text-anchor="${anchor}" font-size="${size}" font-weight="${options.weight ?? 650}" fill="${options.color ?? '#203a30'}">${lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : size + 3}">${escapeXml(line)}</tspan>`).join('')}</text>`
}

function svgShell(title: string, description: string, body: string, stateCue = '') {
  const safeDescription = stateCue && stateCue !== '稳定单状态图解' && stateCue !== '旧版静态图解'
    ? stateCue
    : description
  return `<svg viewBox="0 0 800 450" xmlns="http://www.w3.org/2000/svg" role="img"><title>${escapeXml(title)}</title><desc>${escapeXml(safeDescription)}</desc><defs><marker id="lf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#667d71"></path></marker><linearGradient id="lf-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f8fbf9"></stop><stop offset="1" stop-color="#eef5f1"></stop></linearGradient></defs><rect x="6" y="6" width="788" height="438" rx="24" fill="url(#lf-bg)" stroke="#d9e5de"></rect>${body}${stateCue ? `<rect x="22" y="405" width="756" height="28" rx="9" fill="#fff7df" stroke="#e1bd67"></rect>${svgTextLines(`状态变化：${stateCue}`, 35, 423, { anchor: 'start', size: 11, weight: 700, color: '#684e12', lineLength: 90 })}` : ''}</svg>`
}

function graphSvg(title: string, description: string, nodes: GraphNode[], edges: GraphEdge[], state: VisualStateSnapshot, stateCue = ''): RenderResult {
  const columns = Math.min(4, Math.max(1, nodes.length))
  const rows = Math.ceil(nodes.length / columns)
  const xGap = columns === 1 ? 0 : 640 / Math.max(1, columns - 1)
  const yGap = rows === 1 ? 0 : 250 / Math.max(1, rows - 1)
  const layout = new Map(nodes.map((node, index) => {
    const requestedPosition = state.positions[node.id]
    return [node.id, {
      x: requestedPosition?.[0] ?? (columns === 1 ? 400 : 80 + (index % columns) * xGap),
      y: requestedPosition?.[1] ?? (rows === 1 ? 210 : 92 + Math.floor(index / columns) * yGap),
    }]
  }))
  let outOfBounds = 0
  for (const item of layout.values()) if (item.x < 72 || item.x > 728 || item.y < 58 || item.y > 366) outOfBounds += 1
  let collisions = 0
  const positioned = Array.from(layout.values())
  for (let left = 0; left < positioned.length; left += 1) {
    for (let right = left + 1; right < positioned.length; right += 1) {
      if (Math.abs(positioned[left].x - positioned[right].x) < 132 && Math.abs(positioned[left].y - positioned[right].y) < 82) collisions += 1
    }
  }
  const edgeSvg = edges.map(edge => {
    const from = layout.get(edge.from)
    const to = layout.get(edge.to)
    if (!from || !to) throw new Error(`visual_render_dangling_relation:${edge.id}`)
    const active = state.activeIds.includes(edge.id)
    const middleX = (from.x + to.x) / 2
    const middleY = (from.y + to.y) / 2
    return `<g><path d="M ${from.x} ${from.y} L ${to.x} ${to.y}" fill="none" stroke="${active ? '#765000' : '#7b9185'}" stroke-width="${active ? 4 : 2}" ${active ? 'stroke-dasharray="8 4"' : ''} marker-end="url(#lf-arrow)"></path>${edge.label ? svgTextLines(`${active ? '当前：' : ''}${edge.label}`, middleX, middleY - 10, { size: 10, color: '#53665c', lineLength: 18 }) : ''}</g>`
  }).join('')
  const nodeSvg = nodes.map(node => {
    const item = layout.get(node.id)!
    const active = state.activeIds.includes(node.id) || state.currentStateId === node.id || state.activeLineId === node.id
    return `<g><rect x="${item.x - 62}" y="${item.y - 34}" width="124" height="68" rx="16" fill="${active ? '#fff1c9' : '#ffffff'}" stroke="${active ? '#765000' : '#68887a'}" stroke-width="${active ? 3 : 1.7}" ${active ? 'stroke-dasharray="7 3"' : ''}></rect>${active ? `<rect x="${item.x - 26}" y="${item.y - 48}" width="52" height="18" rx="9" fill="#765000"></rect>${svgTextLines('当前', item.x, item.y - 36, { size: 9, color: '#fff', lineLength: 6 })}` : ''}${svgTextLines(node.label, item.x, item.y - (node.detail ? 7 : 0), { size: 13, lineLength: 11 })}${node.detail ? svgTextLines(node.detail, item.x, item.y + 16, { size: 9, weight: 500, color: '#697b72', lineLength: 18 }) : ''}</g>`
  }).join('')
  return { svg: svgShell(title, description, edgeSvg + nodeSvg, stateCue), collisions, outOfBounds }
}

function protocolSvg(spec: LearningVisualSpec & { semantic: ProtocolSequenceSemantic }, state: VisualStateSnapshot, stateCue: string): RenderResult {
  const xGap = spec.semantic.participants.length === 1 ? 0 : 620 / Math.max(1, spec.semantic.participants.length - 1)
  const xFor = new Map(spec.semantic.participants.map((item, index) => [item.id, 90 + index * xGap]))
  const participants = spec.semantic.participants.map(item => {
    const x = xFor.get(item.id)!
    return `<rect x="${x - 58}" y="38" width="116" height="44" rx="14" fill="#fff" stroke="#68887a" stroke-width="1.8"></rect>${svgTextLines(item.label, x, 60, { size: 12, lineLength: 10 })}<line x1="${x}" y1="82" x2="${x}" y2="382" stroke="#9aaba2" stroke-width="1.5" stroke-dasharray="5 5"></line>`
  }).join('')
  const messageYs: number[] = []
  const messages = spec.semantic.messages.map((message, index) => {
    const from = xFor.get(message.from)
    const to = xFor.get(message.to)
    if (from === undefined || to === undefined) throw new Error(`visual_render_dangling_message:${message.id}`)
    const y = 125 + index * Math.min(74, 235 / Math.max(1, spec.semantic.messages.length - 1))
    messageYs.push(y)
    const emitted = state.emittedMessageIds.includes(message.id)
    const current = state.activeIds.includes(message.id)
    const label = `${message.order}. ${message.label}${current ? '（当前步骤）' : emitted ? '（已发送）' : '（待发送）'}`
    return `<g opacity="${emitted || current ? 1 : 0.42}"><path d="M ${from} ${y} L ${to} ${y}" fill="none" stroke="${current ? '#765000' : '#6f887b'}" stroke-width="${current ? 4 : 2}" ${current ? 'stroke-dasharray="8 4"' : ''} marker-end="url(#lf-arrow)"></path>${svgTextLines(label, (from + to) / 2, y - 12, { size: 10, color: current ? '#6c4700' : '#52675c', lineLength: 24 })}</g>`
  }).join('')
  const participantXs = Array.from(xFor.values())
  let collisions = 0
  for (let left = 0; left < participantXs.length; left += 1) {
    for (let right = left + 1; right < participantXs.length; right += 1) if (Math.abs(participantXs[left] - participantXs[right]) < 116) collisions += 1
  }
  for (let index = 1; index < messageYs.length; index += 1) if (messageYs[index] - messageYs[index - 1] < 24) collisions += 1
  return { svg: svgShell(spec.title, spec.accessibility.summary, participants + messages, stateCue), collisions, outOfBounds: 0 }
}

function codeTraceSvg(spec: LearningVisualSpec & { semantic: CodeTraceSemantic }, state: VisualStateSnapshot, stateCue: string): RenderResult {
  const lines = spec.semantic.lines.slice(0, 16)
  const lineHeight = Math.min(25, 300 / Math.max(1, lines.length))
  const lineSvg = lines.map((line, index) => {
    const y = 72 + index * lineHeight
    const active = state.activeLineId === line.id || state.activeIds.includes(line.id)
    return `<rect x="28" y="${y - 16}" width="474" height="${lineHeight - 2}" rx="6" fill="${active ? '#fff0c5' : index % 2 ? '#f6f8f7' : '#fff'}" stroke="${active ? '#765000' : 'none'}" ${active ? 'stroke-dasharray="6 3"' : ''}></rect>${svgTextLines(`${active ? '▶' : ' '} ${line.number}  ${line.text}`, 42, y, { anchor: 'start', size: 10.5, weight: active ? 750 : 520, lineLength: 64 })}`
  }).join('')
  const variables = spec.semantic.variables.map((variable, index) => `<rect x="530" y="${62 + index * 45}" width="236" height="34" rx="9" fill="#fff" stroke="#ccd9d2"></rect>${svgTextLines(`${variable.name} = ${String(state.values[variable.id] ?? variable.initialValue)}`, 548, 80 + index * 45, { anchor: 'start', size: 11, lineLength: 28 })}`).join('')
  const stackLabels = state.stack.map(frameId => spec.semantic.stackFrames.find(item => item.id === frameId)?.functionName || frameId)
  const outOfBounds = spec.semantic.variables.filter((_, index) => 62 + index * 45 + 34 > 395).length
  return { svg: svgShell(spec.title, spec.accessibility.summary, lineSvg + variables + svgTextLines(`调用栈：${stackLabels.length ? stackLabels.join(' → ') : '空'}`, 548, 346, { anchor: 'start', size: 10, lineLength: 30 }), stateCue), collisions: 0, outOfBounds }
}

function dataStructureGraph(semantic: DataStructureSemantic, state: VisualStateSnapshot) {
  const nodes = semantic.items.map(item => {
    const pointerLabels = semantic.pointers.filter(pointer => (state.pointers[pointer.id] ?? pointer.targetId) === item.id).map(pointer => pointer.label)
    const position = state.positions[item.id]
    const value = state.values[item.id] ?? item.value
    const details = [item.index === undefined ? '' : `索引 ${item.index}`, value === undefined ? '' : `值 ${String(value)}`, pointerLabels.length ? `指针 ${pointerLabels.join('/')}` : '', position ? `位置 (${position[0]}, ${position[1]})` : ''].filter(Boolean)
    return { id: item.id, label: item.label, detail: details.join(' · ') }
  })
  return { nodes, edges: semantic.links.map(item => ({ id: item.id, from: item.from, to: item.to, label: item.kind })) }
}

function tensorSvg(spec: LearningVisualSpec & { semantic: TensorShapeFlowSemantic }, state: VisualStateSnapshot, stateCue: string): RenderResult {
  const nodes: GraphNode[] = [
    ...spec.semantic.tensors.map(tensor => ({ id: tensor.id, label: tensor.label, detail: `[${(state.tensorShapes[tensor.id] || tensor.shape).join(' × ')}]${tensor.dtype ? ` · ${tensor.dtype}` : ''}` })),
    ...spec.semantic.operations.map(operation => ({ id: operation.id, label: operation.label, detail: '确定性算子' })),
  ]
  const edges: GraphEdge[] = []
  for (const operation of spec.semantic.operations) {
    operation.inputIds.forEach((inputId, index) => edges.push({ id: `${operation.id}_in_${index}`, from: inputId, to: operation.id, label: '输入' }))
    operation.outputIds.forEach((outputId, index) => edges.push({ id: `${operation.id}_out_${index}`, from: operation.id, to: outputId, label: '输出' }))
  }
  return graphSvg(spec.title, spec.accessibility.summary, nodes, edges, state, stateCue)
}

function convolutionGrid(
  values: Array<Array<number | null>>,
  x: number,
  y: number,
  cell: number,
  active?: { row: number; column: number; rows: number; columns: number },
) {
  return values.map((row, rowIndex) => row.map((value, columnIndex) => {
    const highlighted = active
      && rowIndex >= active.row && rowIndex < active.row + active.rows
      && columnIndex >= active.column && columnIndex < active.column + active.columns
    const cellX = x + columnIndex * cell
    const cellY = y + rowIndex * cell
    return `<rect x="${cellX}" y="${cellY}" width="${cell}" height="${cell}" fill="${highlighted ? '#fff0c5' : '#fff'}" stroke="${highlighted ? '#765000' : '#9aaba2'}" stroke-width="${highlighted ? 3 : 1.2}" ${highlighted ? 'stroke-dasharray="5 2"' : ''}></rect>${svgTextLines(value === null ? '·' : String(value), cellX + cell / 2, cellY + cell / 2 + 4, { size: 10, color: value === null ? '#9aaba2' : '#203a30' })}`
  }).join('')).join('')
}

function convolutionSvg(spec: LearningVisualSpec & { semantic: ConvolutionTraceSemantic }, state: VisualStateSnapshot, stateCue: string): RenderResult {
  const trace = deriveConvolution(spec.semantic)
  const requestedStep = Number(state.values[spec.semantic.id] ?? 0)
  const step = Math.max(0, Math.min(trace.snapshots.length - 1, Number.isInteger(requestedStep) ? requestedStep : 0))
  const snapshot = trace.snapshots[step]
  const inputCell = 34
  const kernelCell = 34
  const outputCell = 42
  const activeWindow = snapshot.phase === 'convolution' && snapshot.inputRow !== undefined && snapshot.inputColumn !== undefined
    ? { row: snapshot.inputRow, column: snapshot.inputColumn, rows: spec.semantic.kernel.values.length, columns: spec.semantic.kernel.values[0].length }
    : undefined
  const activeOutput = snapshot.phase === 'convolution' && snapshot.outputRow !== undefined && snapshot.outputColumn !== undefined
    ? { row: snapshot.outputRow, column: snapshot.outputColumn, rows: 1, columns: 1 }
    : undefined
  const outputValues = snapshot.phase === 'pool' && snapshot.pooled?.length
    ? snapshot.pooled
    : snapshot.phase === 'relu' && snapshot.activated
      ? snapshot.activated
      : snapshot.convolution
  const inputX = 42
  const inputY = 104
  const kernelX = 292
  const kernelY = 124
  const outputX = 520
  const outputY = 124
  const phaseLabel = snapshot.phase === 'initial' ? '准备输入与卷积核'
    : snapshot.phase === 'convolution' ? `窗口 (${snapshot.inputRow}, ${snapshot.inputColumn}) → 输出 (${snapshot.outputRow}, ${snapshot.outputColumn})`
      : snapshot.phase === 'relu' ? 'ReLU：max(0, x)'
        : '2×2 MaxPool：保留最大响应'
  const equation = snapshot.phase === 'convolution'
    ? `${snapshot.products?.join(' + ')} + ${spec.semantic.bias} = ${snapshot.sum}`
    : snapshot.phase === 'relu' ? '所有负响应归零' : snapshot.phase === 'pool' ? '每个 2×2 区域取最大值' : '卷积核将逐格滑动'
  const body = [
    svgTextLines(spec.semantic.input.label, inputX, 75, { anchor: 'start', size: 13, lineLength: 18 }),
    convolutionGrid(spec.semantic.input.values, inputX, inputY, inputCell, activeWindow),
    svgTextLines(spec.semantic.kernel.label, kernelX, 95, { anchor: 'start', size: 13, lineLength: 18 }),
    convolutionGrid(spec.semantic.kernel.values, kernelX, kernelY, kernelCell),
    svgTextLines(snapshot.phase === 'pool' ? '池化结果' : snapshot.phase === 'relu' ? 'ReLU 特征图' : '卷积特征图', outputX, 95, { anchor: 'start', size: 13, lineLength: 18 }),
    convolutionGrid(outputValues, outputX, outputY, outputCell, activeOutput),
    `<path d="M 230 210 L 278 210" fill="none" stroke="#667d71" stroke-width="2" marker-end="url(#lf-arrow)"></path>`,
    `<path d="M 410 210 L 505 210" fill="none" stroke="#667d71" stroke-width="2" marker-end="url(#lf-arrow)"></path>`,
    `<rect x="250" y="330" width="500" height="58" rx="14" fill="#ffffff" stroke="#d4ded8"></rect>`,
    svgTextLines(phaseLabel, 270, 351, { anchor: 'start', size: 12, color: '#176c96', lineLength: 58 }),
    svgTextLines(equation, 270, 373, { anchor: 'start', size: 10, weight: 560, color: '#52675c', lineLength: 72 }),
  ].join('')
  return { svg: svgShell(spec.title, spec.accessibility.summary, body, stateCue || phaseLabel), collisions: 0, outOfBounds: 0 }
}

function chartBounds(series: VisualPoint[][]) {
  const all = series.flat()
  const xs = all.map(item => item[0])
  const ys = all.map(item => item[1])
  let minX = Math.min(...xs); let maxX = Math.max(...xs); let minY = Math.min(...ys); let maxY = Math.max(...ys)
  if (minX === maxX) { minX -= 1; maxX += 1 }
  if (minY === maxY) { minY -= 1; maxY += 1 }
  return { minX, maxX, minY, maxY }
}

function chartSvg(title: string, description: string, series: Array<{ id: string; label: string; points: VisualPoint[] }>, state: VisualStateSnapshot, stateCue: string, domains?: { x: VisualPoint; y: VisualPoint }): RenderResult {
  const actualSeries = series.map(item => ({ ...item, points: state.series[item.id] || item.points }))
  const bounds = domains ? { minX: domains.x[0], maxX: domains.x[1], minY: domains.y[0], maxY: domains.y[1] } : chartBounds(actualSeries.map(item => item.points))
  const x = (value: number) => 70 + ((value - bounds.minX) / (bounds.maxX - bounds.minX)) * 650
  const y = (value: number) => 365 - ((value - bounds.minY) / (bounds.maxY - bounds.minY)) * 285
  const grid = `<line x1="70" y1="365" x2="720" y2="365" stroke="#50675b" stroke-width="2"></line><line x1="70" y1="80" x2="70" y2="365" stroke="#50675b" stroke-width="2"></line>${svgTextLines(String(bounds.minX), 70, 385, { size: 9 })}${svgTextLines(String(bounds.maxX), 720, 385, { size: 9 })}${svgTextLines(String(bounds.maxY), 52, 84, { size: 9 })}`
  const colors = ['#176c96', '#8a4c97', '#765000', '#26754f']
  const paths = actualSeries.map((item, index) => {
    const pathData = item.points.map((itemPoint, pointIndex) => `${pointIndex ? 'L' : 'M'} ${x(itemPoint[0]).toFixed(2)} ${y(itemPoint[1]).toFixed(2)}`).join(' ')
    const active = state.activeIds.includes(item.id)
    return `<path d="${pathData}" fill="none" stroke="${colors[index % colors.length]}" stroke-width="${active ? 4 : 2.6}" ${active ? 'stroke-dasharray="8 4"' : ''}></path>${svgTextLines(`${index + 1}. ${item.label}${active ? '（当前）' : ''}`, 560, 40 + index * 18, { anchor: 'start', size: 10, color: colors[index % colors.length], lineLength: 24 })}`
  }).join('')
  return { svg: svgShell(title, description, grid + paths, stateCue), collisions: 0, outOfBounds: 0 }
}

function probabilitySvg(spec: LearningVisualSpec & { semantic: ProbabilitySemantic }, state: VisualStateSnapshot, stateCue: string): RenderResult {
  const pointValues = spec.semantic.samples.map(item => [item.x, typeof state.values[item.id] === 'number' ? state.values[item.id] as number : item.y] as VisualPoint)
  if (spec.semantic.mode !== 'pmf') return chartSvg(spec.title, spec.accessibility.summary, [{ id: 'probability', label: spec.semantic.mode.toUpperCase(), points: pointValues }], state, stateCue)
  const xs = pointValues.map(item => item[0])
  let minX = Math.min(...xs); let maxX = Math.max(...xs)
  if (minX === maxX) { minX -= 1; maxX += 1 }
  const padding = Math.max(0.25, (maxX - minX) * 0.12)
  minX -= padding; maxX += padding
  const maxY = Math.max(0.01, ...pointValues.map(item => item[1])) * 1.15
  const x = (value: number) => 70 + ((value - minX) / (maxX - minX)) * 650
  const y = (value: number) => 365 - (value / maxY) * 285
  const axes = `<g id="lf_pmf_axes"><line x1="70" y1="365" x2="720" y2="365" stroke="#50675b" stroke-width="2"></line><line x1="70" y1="80" x2="70" y2="365" stroke="#50675b" stroke-width="2"></line>${svgTextLines('0', 52, 365, { size: 9 })}${svgTextLines(maxY.toFixed(2), 48, 84, { size: 9 })}${svgTextLines('PMF', 650, 48, { size: 11, color: '#176c96' })}</g>`
  const stems = pointValues.map((item, index) => `<g id="lf_pmf_${escapeXml(spec.semantic.samples[index].id)}"><line x1="${x(item[0])}" y1="365" x2="${x(item[0])}" y2="${y(item[1])}" stroke="#176c96" stroke-width="4"></line><circle cx="${x(item[0])}" cy="${y(item[1])}" r="5" fill="#fff" stroke="#176c96" stroke-width="3"></circle>${svgTextLines(String(item[0]), x(item[0]), 384, { size: 9 })}${svgTextLines(String(item[1]), x(item[0]), y(item[1]) - 13, { size: 10, color: '#176c96' })}</g>`).join('')
  return { svg: svgShell(spec.title, spec.accessibility.summary, axes + stems, stateCue), collisions: 0, outOfBounds: 0 }
}

function derivationSvg(spec: LearningVisualSpec & { semantic: DerivationSemantic }, state: VisualStateSnapshot, stateCue: string): RenderResult {
  const rows = spec.semantic.steps.map((step, index) => {
    const expression = state.expressions[step.id] || step.expression
    const active = state.activeIds.includes(step.id)
    const relation = step.relation === 'equals' ? '=' : step.relation === 'implies' ? '⇒' : step.relation === 'approximately' ? '≈' : '≔'
    return `<rect x="45" y="${50 + index * 44}" width="710" height="34" rx="10" fill="${active ? '#fff0c8' : '#fff'}" stroke="${active ? '#765000' : '#d4ded8'}" ${active ? 'stroke-dasharray="7 3"' : ''}></rect>${svgTextLines(`${index + 1}. ${relation} ${expression}${active ? '（当前变化）' : ''}`, 62, 68 + index * 44, { anchor: 'start', size: 12, lineLength: 64 })}`
  }).join('')
  return { svg: svgShell(spec.title, spec.accessibility.summary, rows, stateCue), collisions: 0, outOfBounds: 0 }
}

function semanticGraph(spec: LearningVisualSpec, state: VisualStateSnapshot): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const semantic = spec.semantic
  if (semantic.type === 'state_machine') return { nodes: semantic.states.map(item => ({ id: item.id, label: item.label, detail: item.initial ? '初始状态' : item.terminal ? '终止状态' : undefined })), edges: semantic.transitions.map(item => ({ id: item.id, from: item.from, to: item.to, label: `${item.event}${item.guard ? ` / ${item.guard}` : ''}` })) }
  if (semantic.type === 'data_structure') return dataStructureGraph(semantic, state)
  if (semantic.type === 'system_structure') return { nodes: semantic.entities.map(item => ({ id: item.id, label: item.label, detail: item.detail })), edges: semantic.relations }
  if (semantic.type === 'math_structure') return { nodes: semantic.terms.map(item => ({ id: item.id, label: item.label, detail: item.detail })), edges: semantic.relations }
  return { nodes: [], edges: [] }
}

function semanticSceneSvg(
  spec: LearningVisualSpec & { semantic: SemanticSceneSemantic },
  state: VisualStateSnapshot,
  stateCue: string,
): RenderResult {
  const visible = new Set(state.visibleIds || spec.semantic.entities.map(item => item.id))
  const focus = new Set(state.focusIds || [])
  const entities = spec.semantic.entities.filter(item => visible.has(item.id))
  const relations = spec.semantic.relations.filter(item => visible.has(item.id) && visible.has(item.from) && visible.has(item.to))
  const entityIds = new Set(entities.map(item => item.id))
  const indegree = new Map(entities.map(item => [item.id, 0]))
  const outgoing = new Map(entities.map(item => [item.id, [] as string[]]))
  const incoming = new Map(entities.map(item => [item.id, [] as string[]]))
  relations.forEach(relation => {
    indegree.set(relation.to, (indegree.get(relation.to) || 0) + 1)
    outgoing.get(relation.from)?.push(relation.to)
    incoming.get(relation.to)?.push(relation.from)
  })
  const layers = new Map<string, number>()
  const queue = entities.filter(item => (indegree.get(item.id) || 0) === 0).map(item => item.id)
  queue.forEach(id => layers.set(id, 0))
  while (queue.length) {
    const current = queue.shift()!
    for (const next of outgoing.get(current) || []) {
      layers.set(next, Math.max(layers.get(next) || 0, (layers.get(current) || 0) + 1))
      indegree.set(next, (indegree.get(next) || 0) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  const hasUsefulGraph = relations.length >= Math.max(1, Math.floor(entities.length / 2)) && layers.size === entities.length
  const positions = new Map<string, { x: number; y: number }>()
  let maximumLaneSize = 1
  if (hasUsefulGraph) {
    const maxLayer = Math.max(0, ...layers.values())
    const byLayer = new Map<number, typeof entities>()
    entities.forEach(entity => {
      const layer = layers.get(entity.id) || 0
      byLayer.set(layer, [...(byLayer.get(layer) || []), entity])
    })
    const rank = new Map<string, number>()
    for (let layer = 0; layer <= maxLayer; layer += 1) {
      const items = [...(byLayer.get(layer) || [])]
      if (layer > 0) items.sort((left, right) => {
        const barycenter = (entityId: string) => {
          const parents = incoming.get(entityId) || []
          const parentRanks = parents.map(parent => rank.get(parent)).filter((value): value is number => value !== undefined)
          return parentRanks.length ? parentRanks.reduce((sum, value) => sum + value, 0) / parentRanks.length : Number.MAX_SAFE_INTEGER
        }
        const delta = barycenter(left.id) - barycenter(right.id)
        return delta || entities.findIndex(entity => entity.id === left.id) - entities.findIndex(entity => entity.id === right.id)
      })
      items.forEach((item, index) => rank.set(item.id, index))
      maximumLaneSize = Math.max(maximumLaneSize, items.length)
      items.forEach((item, index) => positions.set(item.id, {
        x: 80 + (layer / Math.max(1, maxLayer)) * 640,
        y: 90 + ((index + 0.5) / items.length) * 280,
      }))
    }
  } else {
    const activeGroups = spec.semantic.groups.filter(group => (state.groupMembers?.[group.id] || []).some(id => entityIds.has(id)))
    const groupByEntity = new Map<string, string>()
    activeGroups.forEach(group => (state.groupMembers?.[group.id] || []).forEach(id => {
      if (entityIds.has(id) && !groupByEntity.has(id)) groupByEntity.set(id, group.id)
    }))
    const ungroupedIds = entities.filter(item => !groupByEntity.has(item.id)).map(item => item.id)
    const lanes = activeGroups.length
      ? [...activeGroups, ...(ungroupedIds.length ? [{ id: '__ungrouped', label: '', layout: 'row' as const }] : [])]
      : [{ id: '__ungrouped', label: '', layout: 'row' as const }]
    const laneWidth = 690 / Math.max(1, lanes.length)
    lanes.forEach((group, laneIndex) => {
      const declared = group.id === '__ungrouped'
        ? ungroupedIds
        : (state.orders?.[group.id] || state.groupMembers?.[group.id] || []).filter(id => entityIds.has(id))
      if (group.id === '__ungrouped' && laneIndex > 0) declared.sort((left, right) => {
        const connectedY = (entityId: string) => {
          const neighbors = relations.flatMap(relation => relation.from === entityId ? [relation.to] : relation.to === entityId ? [relation.from] : [])
          const values = neighbors.map(neighbor => positions.get(neighbor)?.y).filter((value): value is number => value !== undefined)
          return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.MAX_SAFE_INTEGER
        }
        const delta = connectedY(left) - connectedY(right)
        return delta || entities.findIndex(entity => entity.id === left) - entities.findIndex(entity => entity.id === right)
      })
      maximumLaneSize = Math.max(maximumLaneSize, declared.length)
      declared.forEach((id, index) => positions.set(id, {
        x: 55 + laneIndex * laneWidth + laneWidth / 2,
        y: 82 + ((index + 0.5) / Math.max(1, declared.length)) * 292,
      }))
    })
    entities.filter(item => !positions.has(item.id)).forEach((item, index, rest) => positions.set(item.id, {
      x: 70 + ((index + 1) / (rest.length + 1)) * 660,
      y: 360,
    }))
  }
  const groupSummary = spec.semantic.groups
    .map(group => {
      const members = (state.groupMembers?.[group.id] || []).filter(id => entityIds.has(id))
      if (!members.length) return ''
      const labels = members.map(id => spec.semantic.entities.find(item => item.id === id)?.label || id)
      return `${group.label}: ${labels.join(' · ')}`
    }).filter(Boolean).join('　|　')
  const relationSvg = relations.map(relation => {
    const from = positions.get(relation.from); const to = positions.get(relation.to)
    if (!from || !to) return ''
    const active = focus.has(relation.id)
    const middleX = (from.x + to.x) / 2; const middleY = (from.y + to.y) / 2
    return `<path d="M ${from.x} ${from.y} L ${to.x} ${to.y}" fill="none" stroke="${active ? '#765000' : '#71887c'}" stroke-width="${active ? 4 : 2}" ${active ? 'stroke-dasharray="8 4"' : ''} marker-end="url(#lf-arrow)"></path>${relation.label ? svgTextLines(relation.label, middleX, middleY - 8, { size: 9, color: '#52675c', lineLength: 14 }) : ''}`
  }).join('')
  const nodeWidth = maximumLaneSize >= 6 ? 92 : maximumLaneSize >= 5 ? 100 : 108
  const nodeHeight = maximumLaneSize >= 6 ? 34 : maximumLaneSize >= 5 ? 46 : 60
  const nodeSvg = entities.map(entity => {
    const position = positions.get(entity.id)!
    const active = focus.has(entity.id)
    const properties = Object.entries(state.properties?.[entity.id] || {}).slice(0, 3).map(([key, value]) => `${key}=${String(value)}`).join(' · ')
    const detail = properties || entity.detail || ''
    const compactNode = nodeHeight <= 40
    return `<g><rect x="${position.x - nodeWidth / 2}" y="${position.y - nodeHeight / 2}" width="${nodeWidth}" height="${nodeHeight}" rx="${entity.kind === 'value' ? nodeHeight / 2 : 12}" fill="${active ? '#fff0c4' : '#fff'}" stroke="${active ? '#765000' : '#68887a'}" stroke-width="${active ? 3.2 : 1.7}" ${active ? 'stroke-dasharray="7 3"' : ''}></rect>${active ? `<rect x="${position.x - 22}" y="${position.y - nodeHeight / 2 - 12}" width="44" height="16" rx="8" fill="#765000"></rect>${svgTextLines('当前', position.x, position.y - nodeHeight / 2, { size: 8, color: '#fff', lineLength: 6 })}` : ''}${svgTextLines(entity.label, position.x, position.y - (detail && !compactNode ? 6 : 0), { size: compactNode ? 10 : 12, lineLength: compactNode ? 12 : 10 })}${detail && !compactNode ? svgTextLines(detail, position.x, position.y + 14, { size: 8.5, weight: 520, color: '#687970', lineLength: 17 }) : ''}</g>`
  }).join('')
  const summary = groupSummary ? `<rect x="24" y="30" width="752" height="36" rx="11" fill="#edf5f0" stroke="#bfd2c7"></rect>${svgTextLines(groupSummary, 38, 51, { anchor: 'start', size: 10, weight: 650, lineLength: 96 })}` : ''
  let collisions = 0
  const positioned = [...positions.values()]
  for (let left = 0; left < positioned.length; left += 1) for (let right = left + 1; right < positioned.length; right += 1) {
    if (Math.abs(positioned[left].x - positioned[right].x) < nodeWidth + 4 && Math.abs(positioned[left].y - positioned[right].y) < nodeHeight + 4) collisions += 1
  }
  const outOfBounds = positioned.filter(item => item.x - nodeWidth / 2 < 18 || item.x + nodeWidth / 2 > 782 || item.y - nodeHeight / 2 < 72 || item.y + nodeHeight / 2 > 390).length
  return { svg: svgShell(spec.title, spec.accessibility.summary, summary + relationSvg + nodeSvg, stateCue), collisions, outOfBounds }
}

function renderSpec(spec: LearningVisualSpec, state: VisualStateSnapshot, stateCue = ''): RenderResult {
  if (spec.semantic.type === 'semantic_scene') return semanticSceneSvg(spec as LearningVisualSpec & { semantic: SemanticSceneSemantic }, state, stateCue)
  if (spec.semantic.type === 'convolution_trace') return convolutionSvg(spec as LearningVisualSpec & { semantic: ConvolutionTraceSemantic }, state, stateCue)
  if (isDerivedSemantic(spec.semantic)) return renderDerivedTeachingVisual(spec, state, stateCue)
  if (spec.semantic.type === 'protocol_sequence') return protocolSvg(spec as LearningVisualSpec & { semantic: ProtocolSequenceSemantic }, state, stateCue)
  if (spec.semantic.type === 'code_trace') return codeTraceSvg(spec as LearningVisualSpec & { semantic: CodeTraceSemantic }, state, stateCue)
  if (spec.semantic.type === 'tensor_shape_flow') return tensorSvg(spec as LearningVisualSpec & { semantic: TensorShapeFlowSemantic }, state, stateCue)
  if (spec.semantic.type === 'function') {
    const semantic = spec.semantic as FunctionSemantic
    return chartSvg(spec.title, spec.accessibility.summary, semantic.series, state, stateCue, { x: semantic.axes.xDomain, y: semantic.axes.yDomain })
  }
  if (spec.semantic.type === 'probability') return probabilitySvg(spec as LearningVisualSpec & { semantic: ProbabilitySemantic }, state, stateCue)
  if (spec.semantic.type === 'transformation') {
    const semantic = spec.semantic as TransformationSemantic
    return chartSvg(spec.title, spec.accessibility.summary, semantic.objects.map(item => ({ id: item.id, label: item.label, points: state.series[item.id] || item.points })), state, stateCue)
  }
  if (spec.semantic.type === 'derivation') return derivationSvg(spec as LearningVisualSpec & { semantic: DerivationSemantic }, state, stateCue)
  const graph = semanticGraph(spec, state)
  return graphSvg(spec.title, spec.accessibility.summary, graph.nodes, graph.edges, state, stateCue)
}

function renderLegacySpec(spec: LegacyLearningVisualSpec, frame?: LegacyLearningVisualFrame): RenderResult {
  const state: VisualStateSnapshot = { activeIds: [...(frame?.activeNodeIds || []), ...(frame?.activeRelationIds || [])], values: {}, pointers: {}, positions: {}, tensorShapes: {}, expressions: {}, series: {}, stack: [], emittedMessageIds: [] }
  return graphSvg(spec.title, `${spec.title}。旧版视觉以只读兼容模式呈现。`, spec.nodes.map(node => ({ id: node.id, label: node.label, detail: node.detail })), spec.relations, state, frame ? `旧版故事板：${frame.title}。此帧只有高亮信息，不代表已验证的状态变化。` : '旧版静态图解')
}

function frameDescription(frame: LearningVisualFrame) {
  return [frame.narration, frame.patches.map(describePatch).join('；')]
    .map(part => part.trim().replace(/[。；]+$/u, ''))
    .filter(Boolean)
    .join('；')
}

export function visualSpecToArtifact(spec: ReadableLearningVisualSpec): { artifact: ReplayableVisualArtifact; quality: LearningVisualQuality } {
  let quality = inspectLearningVisualSpec(spec)
  if (quality.status === 'rejected') throw new Error(`visual_spec_quality_gate:${quality.issues.join(',')}`)
  const rendered: RenderResult[] = []
  const steps: ReadableVisualStep[] = []
  const descriptions: string[] = []
  let artifactKind: VisualArtifact['kind'] = 'image'

  if (spec.version === 'learnflow.visual.v1') {
    const frames: Array<LegacyLearningVisualFrame | undefined> = spec.kind === 'animation' && spec.frames.length ? spec.frames : [undefined]
    for (const frame of frames) {
      const result = renderLegacySpec(spec, frame)
      const description = frame ? frame.narration || '旧版高亮帧' : '旧版静态图解'
      rendered.push(result)
      descriptions.push(description)
      steps.push({ title: frame?.title || spec.title, text: description, svg: result.svg, stateDescription: description, manifest: result.manifest })
    }
  } else if (spec.kind === 'diagram') {
    const result = renderSpec(spec, spec.state, '稳定单状态图解')
    const description = spec.accessibility.summary
    rendered.push(result)
    descriptions.push(description)
    steps.push({ title: spec.title, text: spec.subtitle || spec.explanation, svg: result.svg, stateDescription: description, manifest: result.manifest })
  } else {
    artifactKind = 'animation'
    const initial = renderSpec(spec, spec.initialState, '初始状态：尚未应用任何动画补丁')
    const initialDescription = '初始状态：尚未揭晓后续状态或最终答案。'
    rendered.push(initial)
    descriptions.push(initialDescription)
    steps.push({ title: '初始状态', text: initialDescription, svg: initial.svg, durationMs: 1200, stateDescription: initialDescription, manifest: initial.manifest })
    const replay = replayAnimation(spec)
    spec.frames.forEach((frame, index) => {
      const description = frameDescription(frame)
      const result = renderSpec(spec, replay.states[index], description)
      rendered.push(result)
      descriptions.push(description)
      steps.push({ title: frame.title, text: description, svg: result.svg, durationMs: frame.durationMs, stateDescription: description, prediction: frame.prediction, manifest: result.manifest })
    })
  }

  const collisions = rendered.reduce((total, item) => total + item.collisions, 0)
  const outOfBounds = rendered.reduce((total, item) => total + item.outOfBounds, 0)
  if (collisions || outOfBounds) {
    const issues = [...quality.issues]
    if (collisions) issues.push(`layout_collisions:${collisions}`)
    if (outOfBounds) issues.push(`layout_out_of_bounds:${outOfBounds}`)
    throw new Error(`visual_spec_quality_gate:${issues.join(',')}`)
  }
  quality = { ...quality, layout: { collisions, outOfBounds } }
  const generation = spec.generation
  const readable = spec.version === 'learnflow.visual.v1'
    ? { summary: `${spec.title}：旧版视觉兼容读取。`, readingOrder: spec.nodes.map(item => item.id), frameDescriptions: descriptions, nonColorStateCue: '旧版高亮帧明确标记为故事板，不声称语义状态变化。' }
    : { summary: spec.accessibility.summary, readingOrder: spec.accessibility.readingOrder, frameDescriptions: descriptions, nonColorStateCue: spec.accessibility.nonColorStateCue }
  const artifact: ReplayableVisualArtifact = {
    kind: artifactKind,
    title: spec.title,
    subtitle: spec.subtitle,
    steps,
    specVersion: spec.version,
    domain: spec.domain === 'general' ? undefined : spec.domain,
    abstraction: spec.abstraction,
    renderer: RENDERER_VERSION,
    quality,
    fallbackUsed: generation.source === 'deterministic_template' || generation.source === 'legacy_reader' || generation.degraded,
    status: generation.degraded ? 'degraded' : 'usable',
    degraded: generation.degraded,
    degradedTo: generation.degradedTo,
    modelError: generation.modelError,
    plannerSucceeded: generation.plannerSucceeded,
    provenance: spec.provenance,
    readable,
    replay: { spec, rendererVersion: RENDERER_VERSION },
  }
  return { artifact, quality }
}
