import type {VisualView, VisualElement, PresentationPlan, RenderDiagnostic, VisualBundle, PresentationContext} from './types.ts'

const escape = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const fmt = (n: number) => Number.isFinite(n) ? Number(n.toPrecision(5)).toString() : String(n)
const display = (value: unknown) => typeof value === 'number' ? fmt(value) : String(value ?? '∅')
const widthOf = (value: string, size = 15) => [...value].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? size : size * .56), 0)
const text = (x: number, y: number, value: unknown, size = 15, anchor = 'start', color = '#172b4d') => `<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" fill="${color}">${escape(value)}</text>`
const rectangle = (x: number, y: number, width: number, height: number, fill = '#f1f5f9', stroke = '#cbd5e1', radius = 7) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}"/>`
function wrap(value: string, width: number, size = 15): string[] {
  const lines: string[] = []
  for (const source of value.split('\n')) {
    let line = ''
    for (const character of source) {
      if (line && widthOf(line + character, size) > width) {lines.push(line); line = ''}
      line += character
    }
    lines.push(line)
  }
  return lines
}
function cells(values: unknown): Set<string> {return new Set(Array.isArray(values) ? values.map(value => Array.isArray(value) ? value.join(',') : String(value)) : [])}

/** Stable node slots come from the entire immutable trace, never from the current active subset. */
export function presentationContext(bundle: VisualBundle): PresentationContext {
  const graphNodes: Record<string, string[]> = {}
  for (const frame of bundle.frames) for (const view of frame.views) for (const element of view.elements) {
    if (element.kind !== 'graph') continue
    const nodes = graphNodes[element.id] ||= []
    for (const node of element.values?.graph?.nodes || []) if (!nodes.includes(String(node))) nodes.push(String(node))
  }
  return {graphNodes}
}

export function renderView(view: VisualView, viewport = 720, context: PresentationContext = {graphNodes: {}}): {svg: string; plan: PresentationPlan; diagnostics: RenderDiagnostic[]} {
  const targetWidth = Math.max(260, Math.min(960, viewport))
  const plan: PresentationPlan = {version: '2', viewId: view.id, width: targetWidth, height: 120, objects: [], transition: 'cut', repairs: []}
  const diagnostics: RenderDiagnostic[] = []
  const shapes: string[] = []
  const repair = (code: 'WRAP_TEXT'|'REFLOW_GRAPH'|'HORIZONTAL_SCROLL', id: string) => {
    if (!plan.repairs.some(item => item.code === code && item.object_id === id)) plan.repairs.push({code, object_id: id, semantic_mutation_allowed: false})
  }
  const fail = (code: RenderDiagnostic['code'], id: string) => diagnostics.push({code, object_id: id, semantic_mutation_allowed: false})
  const object = (id: string, label: string, x: number, y: number, w: number, h: number, overlap: 'plot'|'none' = 'none', linkId?: string) => plan.objects.push({id, label, bounds: [x, y, w, h], overlap, linkId})
  function selectable(id: string, label: string, content: string, linkId = '') {
    const selected = context.selected === id || Boolean(linkId && context.selectedLink === linkId)
    return `<g data-visual-id="${escape(id)}" data-visual-link="${escape(linkId)}" role="button" tabindex="0" aria-label="${escape(label)}" aria-pressed="${selected}" class="visualize-semantic${selected ? ' is-selected' : ''}"><title>${escape(label)}</title>${content}</g>`
  }
  // Matrices and tables keep their rows intact. If necessary the containing view scrolls.
  for (const element of view.elements) {
    const values = element.values || {}
    if (values.visible === false) continue
    let required = 0
    if (element.kind === 'matrix') {
      const matrix = values.values as unknown[][] || []
      const cellWidth = Math.max(46, Math.min(100, Math.max(0, ...matrix.flat().map(value => widthOf(display(value), 14) + 18))))
      required = 66 + (matrix[0]?.length || 0) * cellWidth
    }
    if (element.kind === 'table') required = 48 + (values.columns?.length || 0) * 110
    if (required > plan.width) {plan.width = required; repair('HORIZONTAL_SCROLL', element.id)}
  }
  const width = plan.width
  const axis = view.elements.find(element => element.kind === 'axis')?.values?.axes
  const plotKinds = new Set(['axis', 'curve', 'point', 'region'])
  let cursor = 28
  let plotSeries = 0
  function lines(value: unknown, x: number, y: number, available: number, id: string, size = 15, maxLines = 40) {
    const rendered = wrap(display(value), available, size)
    if (rendered.length > display(value).split('\n').length) repair('WRAP_TEXT', id)
    if (rendered.length > maxLines) fail('TEXT_TOO_DENSE', id)
    return {svg: rendered.map((line, i) => text(x, y + i * (size + 7), line, size)).join(''), height: rendered.length * (size + 7)}
  }
  for (const element of view.elements) {
    const values = element.values || {}
    if (values.visible === false) continue
    const start = cursor
    if (plotKinds.has(element.kind)) {
      if (!axis) {fail('INVALID_GEOMETRY', element.id); continue}
      const [xmin, xmax] = axis.x.domain, [ymin, ymax] = axis.y.domain
      const px = (x: number) => 66 + (x - xmin) / (xmax - xmin) * (width - 110)
      const py = (y: number) => 290 - (y - ymin) / (ymax - ymin) * 230
      let body = ''
      if (element.kind === 'axis') {
        body += `<path d="M66 60 V290 H${width - 44}" fill="none" stroke="#64748b"/>`
        for (let i = 0; i <= 4; i++) {
          const x = xmin + (xmax - xmin) * i / 4, y = ymin + (ymax - ymin) * i / 4
          body += text(px(x), 315, fmt(x), 12, 'middle') + text(59, py(y) + 4, fmt(y), 12, 'end')
        }
        body += text(width / 2, 338, axis.x.label, 14, 'middle') + text(66, 30, axis.y.label, 14)
      } else {
        const coordinates = element.kind === 'point' ? [values.point] : (values.points || values.polygon)
        if (!Array.isArray(coordinates) || coordinates.some(point => !Array.isArray(point) || point.some(n => !Number.isFinite(n)))) {fail('INVALID_GEOMETRY', element.id); continue}
        if (coordinates.some(([x, y]) => x < xmin || x > xmax || y < ymin || y > ymax)) fail('VIEWPORT_OVERFLOW', element.id)
        const palette = ['#2563eb', '#0f766e', '#c2410c', '#7c3aed']
        const color = palette[plotSeries % palette.length]
        const legend = lines(element.label, 66, 364 + plotSeries * 25, width - 90, element.id, 14)
        body += legend.svg
        plotSeries += Math.max(1, Math.ceil(legend.height / 25))
        if (element.kind === 'point') body += `<circle cx="${px(values.point[0])}" cy="${py(values.point[1])}" r="7" fill="${color}" stroke="white" stroke-width="2"/>`
        else body += `<${element.kind === 'region' ? 'polygon' : 'polyline'} points="${coordinates.map(([x, y]: number[]) => `${px(x)},${py(y)}`).join(' ')}" fill="${element.kind === 'region' ? color : 'none'}" fill-opacity="0.2" stroke="${color}" stroke-width="2.5" stroke-dasharray="${element.id.includes('path') ? '6 4' : 'none'}"/>`
      }
      shapes.push(selectable(element.id, element.label, body))
      object(element.id, element.label, 50, 15, width - 70, 335, 'plot')
      cursor = 390 + plotSeries * 25
      continue
    }
    const heading = lines(element.label, 24, cursor, width - 48, element.id, 15, 4)
    shapes.push(heading.svg); cursor += heading.height + 9
    if (element.kind === 'matrix') {
      const matrix = values.values as unknown[][] || []
      const rows = matrix.length, columns = matrix[0]?.length || 0
      const cellWidth = Math.max(46, Math.min(100, Math.max(0, ...matrix.flat().map(value => widthOf(display(value), 14) + 18))))
      const active = cells(values.active_cells ?? values.active)
      const computed = values.computed_cells == null ? null : cells(values.computed_cells)
      const numeric = matrix.flat().filter((value): value is number => typeof value === 'number')
      const max = Math.max(1, ...numeric.map(Math.abs))
      const xStart = 42, yStart = cursor + 18
      for (let col = 0; col < columns; col++) shapes.push(text(xStart + col * cellWidth + cellWidth / 2, cursor + 2, col, 11, 'middle', '#64748b'))
      for (let row = 0; row < rows; row++) {
        shapes.push(text(32, yStart + row * 43 + 25, row, 11, 'end', '#64748b'))
        for (let col = 0; col < columns; col++) {
          const id = `${element.id}[${row},${col}]`, value = matrix[row][col], known = !computed || computed.has(`${row},${col}`)
          const isActive = active.has(`${row},${col}`), x = xStart + col * cellWidth, y = yStart + row * 43
          const intensity = typeof value === 'number' ? Math.abs(value) / max : 0
          const fill = !known ? '#f8fafc' : isActive ? '#ffedd5' : `hsl(${typeof value === 'number' && value < 0 ? 272 : 205} 65% ${97 - intensity * 19}%)`
          const label = `${element.label}，第 ${row} 行第 ${col} 列，${known ? display(value) : '尚未计算'}${isActive ? '，当前窗口' : ''}`
          const rendered = rectangle(x + 1, y + 1, cellWidth - 3, 39, fill, isActive ? '#c2410c' : '#cbd5e1', 4) + text(x + cellWidth / 2, y + 25, known ? display(value) : '·', 14, 'middle') + (isActive ? `<path d="M${x + 6} ${y + 6} h7 M${x + 6} ${y + 6} v7" stroke="#9a3412" stroke-width="2"/>` : '')
          shapes.push(selectable(id, label, rendered)); object(id, label, x, y, cellWidth, 41)
        }
      }
      cursor = yStart + rows * 43 + 24
      shapes.push(text(42, cursor, `${rows} × ${columns} · 行、列索引从 0 开始${computed ? ' · · 表示尚未计算' : ''}`, 11, 'start', '#64748b'))
      const legend = lines('蓝色为非负，紫色为负；颜色越深绝对值越大。橙色角标为当前窗口。', 42, cursor + 19, width - 66, element.id, 10); shapes.push(legend.svg); cursor += legend.height + 31
    } else if (element.kind === 'array') {
      const items = Array.isArray(values.items) ? values.items : []
      const active = cells(values.active_indices ?? values.active)
      const pitch = Math.max(72, Math.min(160, Math.max(0, ...items.map((value: unknown) => widthOf(display(value), 14) + 22))))
      const columns = Math.max(1, Math.floor((width - 48) / pitch))
      if (!items.length) shapes.push(text(28, cursor + 25, '空'))
      items.forEach((value: unknown, i: number) => {
        const x = 24 + i % columns * pitch, y = cursor + Math.floor(i / columns) * 67
        const id = `${element.id}[${i}]`, label = `${element.label}，索引 ${i}，${display(value)}`
        const line = lines(value, x + 9, y + 26, pitch - 20, id, 14, 1)
        shapes.push(selectable(id, label, rectangle(x, y, pitch - 6, 41, active.has(String(i)) ? '#ffedd5' : '#eff6ff', active.has(String(i)) ? '#c2410c' : '#bfdbfe') + line.svg + text(x + (pitch - 6) / 2, y + 57, i, 11, 'middle', '#64748b')))
        object(id, label, x, y, pitch - 6, 60)
      })
      cursor += Math.max(1, Math.ceil(items.length / columns)) * 67 + 14
    } else if (element.kind === 'graph') {
      const graph = values.graph || {nodes: [], edges: []}
      const visibleNodes = graph.nodes as string[]
      const allNodes = context.graphNodes[element.id] || visibleNodes
      const nodes = [...allNodes]
      const columns = Math.max(1, Math.min(nodes.length, Math.floor((width - 48) / 142)))
      const pitch = (width - 48) / Math.max(1, columns), rowHeight = 115
      const positions = Object.fromEntries(nodes.map((node, i) => [node, [24 + pitch * (i % columns + .5), cursor + 42 + Math.floor(i / columns) * rowHeight]]))
      if (nodes.length > columns) repair('REFLOW_GRAPH', element.id)
      const marker = `arrow-${view.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-${element.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
      shapes.push(`<defs><marker id="${marker}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#64748b"/></marker></defs>`)
      for (const [from, to] of graph.edges as string[][]) {
        const a = positions[from], b = positions[to]
        if (!a || !b) {fail('INVALID_GEOMETRY', element.id); continue}
        const distance = Math.hypot(b[0] - a[0], b[1] - a[1])
        let path: string
        if (!distance) path = `M${a[0] + 35} ${a[1] - 12} C${a[0] + 73} ${a[1] - 65},${a[0] - 73} ${a[1] - 65},${a[0] - 35} ${a[1] - 12}`
        else {
          const dx = (b[0] - a[0]) / distance, dy = (b[1] - a[1]) / distance
          const sx = a[0] + dx * 40, sy = a[1] + dy * 30, ex = b[0] - dx * 45, ey = b[1] - dy * 33
          const bend = Math.abs(a[1] - b[1]) < 1 && Math.abs(a[0] - b[0]) > pitch * 1.5 ? -76 : graph.edges.some((edge: string[]) => edge[0] === to && edge[1] === from) ? 17 : 0
          if (Math.abs(b[1] - a[1]) > rowHeight * 1.5) {
            const direction = b[1] > a[1] ? 1 : -1
            const routeX = width - 12
            path = `M${a[0]} ${a[1] + direction * 30} V${a[1] + direction * 61} H${routeX} V${b[1] - direction * 52} H${b[0]} V${b[1] - direction * 33}`
          } else path = `M${sx} ${sy} Q${(sx + ex) / 2 - dy * bend} ${(sy + ey) / 2 + dx * bend} ${ex} ${ey}`
        }
        shapes.push(`<path d="${path}" fill="none" stroke="#64748b" stroke-width="1.8"${graph.directed ? ` marker-end="url(#${marker})"` : ''}/>`)
      }
      for (const node of visibleNodes) {
        const [x, y] = positions[node], id = `${element.id}.${node}`, label = String(graph.labels?.[node] ?? node), active = values.active === node || (Array.isArray(values.active) && values.active.includes(node))
        const labelLines = wrap(label, Math.min(112, pitch - 16), 13)
        if (labelLines.length > 3) fail('TEXT_TOO_DENSE', id)
        if (labelLines.length > 1) repair('WRAP_TEXT', id)
        const boxWidth = Math.min(120, pitch - 12), boxHeight = Math.max(44, labelLines.length * 17 + 14)
        const body = rectangle(x - boxWidth / 2, y - boxHeight / 2, boxWidth, boxHeight, active ? '#ffedd5' : '#eff6ff', active ? '#c2410c' : '#93c5fd') + labelLines.map((line, i) => text(x, y - (labelLines.length - 1) * 8.5 + i * 17 + 4, line, 13, 'middle')).join('')
        shapes.push(selectable(id, label, body, node)); object(id, label, x - boxWidth / 2, y - boxHeight / 2, boxWidth, boxHeight, 'none', node)
      }
      cursor += Math.ceil(nodes.length / Math.max(1, columns)) * rowHeight + 4
      shapes.push(text(24, cursor, graph.directed ? '箭头表示有向关系' : '线段表示无向关系', 11, 'start', '#64748b')); cursor += 28
    } else if (element.kind === 'table') {
      const columns: string[] = values.columns || [], rows: unknown[][] = values.rows || []
      const columnWidth = (width - 48) / Math.max(1, columns.length)
      for (const [rowIndex, row] of [columns, ...rows].entries()) {
        const cellLines = row.map(value => wrap(display(value), columnWidth - 18, 13))
        const height = Math.max(38, ...cellLines.map(value => value.length * 20 + 14))
        row.forEach((value, col) => {
          const x = 24 + col * columnWidth, id = `${element.id}[${rowIndex - 1},${col}]`, label = `${columns[col]}：${display(value)}`
          const body = rectangle(x, cursor, columnWidth, height, rowIndex === 0 ? '#e2e8f0' : rowIndex % 2 ? '#fff' : '#f8fafc', '#cbd5e1', 0) + cellLines[col].map((line, i) => text(x + 9, cursor + 23 + i * 20, line, 13)).join('')
          shapes.push(selectable(id, label, body)); object(id, label, x, cursor, columnWidth, height)
        })
        cursor += height
      }
      cursor += 24
    } else if (element.kind === 'timeline') {
      const events: Array<{id: string; lane: string; label: string; at: number; until?: number}> = values.events || []
      const lanes: string[] = values.lanes || [...new Set(events.map(event => event.lane || '事件'))]
      const min = Math.min(0, ...events.map(event => event.at)), max = Math.max(min + 1, ...events.map(event => event.until ?? event.at))
      const chartX = 100, chartWidth = width - chartX - 26
      const px = (at: number) => chartX + (at - min) / (max - min) * chartWidth
      for (const lane of lanes) {
        const laneEvents = events.filter(event => (event.lane || '事件') === lane).sort((a, b) => a.at - b.at)
        const laneTitle = lines(lane, 24, cursor + 18, 68, element.id, 12, 8)
        const rowHeight = Math.max(68, laneTitle.height + 10)
        // Separate event rows prevent collisions while preserving the same time axis.
        const laneHeight = Math.max(1, laneEvents.length) * rowHeight
        shapes.push(rectangle(chartX, cursor, chartWidth, laneHeight, '#f8fafc', '#e2e8f0', 0), laneTitle.svg)
        laneEvents.forEach((event, i) => {
          const x = px(event.at), y = cursor + i * rowHeight + 18, id = `${element.id}.${event.id}`
          const body = `<circle cx="${x}" cy="${y}" r="5" fill="#0f766e"/>` + (event.until != null ? `<line x1="${x}" y1="${y}" x2="${px(event.until)}" y2="${y}" stroke="#0f766e" stroke-width="5"/>` : '') + text(Math.min(x, width - 94), y - 8, display(event.at), 10, 'start', '#64748b') + lines(event.label, chartX + 8, y + 22, chartWidth - 16, id, 12, 2).svg
          shapes.push(selectable(id, `${lane}，${event.label}，位置 ${event.at}`, body)); object(id, event.label, chartX, y - 16, chartWidth, rowHeight)
        })
        cursor += laneHeight + 12
      }
      const note = lines('位置轴展示已提供的事件；不据此证明因果或并发关系。', 24, cursor + 6, width - 48, element.id, 11); shapes.push(note.svg); cursor += note.height + 16
    } else if (element.kind === 'code') {
      const source = String(values.source ?? '').split('\n'), active = cells(values.active_lines ?? (typeof values.active_line === 'number' ? [values.active_line] : values.active))
      source.forEach((line, i) => {
        const rendered = lines(line || ' ', 61, cursor + 21, width - 90, `${element.id}:${i + 1}`, 13, 12)
        const height = Math.max(29, rendered.height + 7), id = `${element.id}:${i + 1}`
        const body = rectangle(24, cursor, width - 48, height, active.has(String(i + 1)) ? '#ffedd5' : '#f8fafc', '#e2e8f0', 0) + text(48, cursor + 21, i + 1, 11, 'end', '#64748b') + rendered.svg
        shapes.push(selectable(id, `${element.label}，第 ${i + 1} 行：${line}`, body)); object(id, line, 24, cursor, width - 48, height)
        cursor += height
      }); cursor += 22
    } else {
      const rendered = lines(values.value, 28, cursor + 18, width - 56, element.id, element.kind === 'metric' ? 23 : 15, 40)
      shapes.push(selectable(element.id, `${element.label}：${display(values.value)}`, rendered.svg))
      cursor += rendered.height + 28
    }
    // Container identities remain available for dropdown selection and annotations.
    if (!plan.objects.some(item => item.id === element.id)) object(element.id, element.label, 20, start - 18, width - 40, cursor - start + 18, 'plot')
  }
  plan.height = Math.max(120, cursor + 12)
  for (const entry of plan.objects) {
    const [x, y, w, h] = entry.bounds
    if (![x, y, w, h].every(Number.isFinite)) fail('INVALID_GEOMETRY', entry.id)
    else if (x < 0 || y < 0 || x + w > width + 1 || y + h > plan.height + 1) fail('VIEWPORT_OVERFLOW', entry.id)
  }
  const summary = escape(`${view.title}。${view.elements.filter(element => element.values?.visible !== false).map(element => element.label).join('；')}`)
  return {svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${plan.height}" role="group" aria-label="${summary}" style="font-family:ui-sans-serif,system-ui,sans-serif"><title>${summary}</title><rect width="100%" height="100%" fill="#fff"/>${shapes.join('')}</svg>`, plan, diagnostics}
}

export function describeFrame(bundle: VisualBundle, index: number): string {
  const frame = bundle.frames[index]
  if (!frame) return '当前没有可显示的状态。'
  const state = frame.state
  const narration = frame.narration || state.narration
  const title = frame.title || state.title
  if (narration || title) return [title, narration].filter(Boolean).join('：')
  // Legacy traces predate authored stage metadata.
  if (bundle.spec.model.id === 'optimization.quadratic_gd') return `第 ${index} 次更新：学习率 ${bundle.params.alpha}，x = ${fmt(state.x)}，函数值 = ${fmt(state.loss)}，距最优点的有向误差 = ${fmt(state.error)}。`
  if (bundle.spec.model.id === 'algorithms.bfs') return `第 ${index} 步，${state.current === null ? '尚未展开节点' : `展开节点 ${state.current}`}。待展开队列（左为队首）：${state.queue.join(' → ') || '空'}；已发现：${state.discovered.join('、')}。`
  if (bundle.spec.model.id === 'probability.uniform_interval') return `支持区间宽度 ${bundle.params.width}，密度高度 ${fmt(state.density)}，所选区间的概率面积 ${fmt(state.probability)}。`
  return `第 ${index + 1} 个状态。${bundle.spec.teaching.goal}`
}
