import {
  VISUAL_STORYBOARD_VERSION,
  type StoryboardAssertion,
  type StoryboardOperation,
  type StoryboardScalar,
  type VisualStoryboardContext,
} from '../src/visual-storyboard.ts'
import {
  ASCII_RENDERER_VERSION,
  PROMPT_VERSION,
  RENDERER_VERSION,
  VISUAL_VERSION,
  type GeneratedLearningVisual,
  type LearningVisualFrame,
  type LearningVisualSpec,
  type SemanticSceneSemantic,
  type VisualPatch,
  type VisualStateSnapshot,
} from './visual-spec/types.ts'
import { cloneState, emptyState, equivalent, provenance } from './visual-spec/validation.ts'
import { inspectLearningVisualSpec, replayAnimation } from './visual-spec/runtime.ts'
import type { GenerateText } from './visual-spec/types.ts'

const ID = /^[a-z][a-z0-9_]{0,63}$/
const PROPERTY_KEY = /^[a-z][a-z0-9_]{0,31}$/
const MAX_ENTITIES = 32
const MAX_RELATIONS = 48
const MAX_GROUPS = 12
const MAX_FRAMES = 16
const DEFAULT_ASCII_WIDTH = 160
const DEFAULT_ASCII_HEIGHT = 40
const MAX_ASCII_WIDTH = 160
const MAX_ASCII_HEIGHT = 48
const ASCII_DESIGN_TOTAL_TIMEOUT_MS = 720_000
const ASCII_DESIGN_FIRST_TIMEOUT_MS = 420_000
const ASCII_DESIGN_MAX_TOKENS = 32_768
export const ASCII_STORYBOARD_DESIGN_VERSION = 'learnflow.ascii-storyboard-design.v1' as const

function unique(values: string[], path: string) {
  if (new Set(values).size !== values.length) throw new Error(`visual_storyboard_duplicate_id:${path}`)
}

function text(value: string, path: string, maximum: number) {
  const output = String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  if (!output || output.length > maximum) throw new Error(`visual_storyboard_text_invalid:${path}`)
  return output
}

function assertIds(values: string[], references: Set<string>, path: string) {
  values.forEach(value => {
    if (!ID.test(value)) throw new Error(`visual_storyboard_id_invalid:${path}.${value}`)
    if (!references.has(value)) throw new Error(`visual_storyboard_reference_invalid:${path}.${value}`)
  })
}

function assertScalar(value: unknown, path: string) {
  if (value !== null && typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'number') throw new Error(`visual_storyboard_scalar_invalid:${path}`)
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`visual_storyboard_scalar_invalid:${path}`)
  if (typeof value === 'string' && value.length > 160) throw new Error(`visual_storyboard_scalar_invalid:${path}`)
}

function canvasLines(raw: string, width: number, height: number, path: string) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) throw new Error(`visual_storyboard_ascii_control_invalid:${path}`)
  const lines = raw.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').split('\n')
  while (lines.length > 1 && !lines[lines.length - 1]) lines.pop()
  if (lines.length < 2 || lines.length > height) throw new Error(`visual_storyboard_ascii_height_invalid:${path}`)
  if (lines.some(line => [...line].length > width)) throw new Error(`visual_storyboard_ascii_width_invalid:${path}`)
  return lines.join('\n')
}

function asciiSize(context: VisualStoryboardContext) {
  const width = Number(context.presentation.asciiWidth || DEFAULT_ASCII_WIDTH)
  const height = Number(context.presentation.asciiHeight || DEFAULT_ASCII_HEIGHT)
  if (!Number.isInteger(width) || width < 48 || width > MAX_ASCII_WIDTH) throw new Error('visual_storyboard_ascii_width_invalid:presentation')
  if (!Number.isInteger(height) || height < 12 || height > MAX_ASCII_HEIGHT) throw new Error('visual_storyboard_ascii_height_invalid:presentation')
  return { width, height }
}

function validateAnchorCatalog(
  anchors: Record<string, string> | undefined,
  references: Set<string>,
  path: string,
) {
  if (!anchors) return
  for (const [id, token] of Object.entries(anchors)) {
    if (!references.has(id)) throw new Error(`visual_storyboard_ascii_anchor_reference_invalid:${path}.${id}`)
    if (!token || [...token].length > 48 || /[\n\r\u0000-\u001f\u007f]/.test(token)) {
      throw new Error(`visual_storyboard_ascii_anchor_invalid:${path}.${id}`)
    }
  }
}

export function validateVisualStoryboard(context: VisualStoryboardContext) {
  if (!context || typeof context !== 'object') throw new Error('visual_storyboard_object_required')
  if (context.version !== VISUAL_STORYBOARD_VERSION) throw new Error('visual_storyboard_version_invalid')
  if (!ID.test(context.id)) throw new Error('visual_storyboard_id_invalid:id')
  text(context.title, 'title', 80)
  text(context.learningGoal, 'learningGoal', 260)
  text(context.explanation, 'explanation', 5_000)
  text(context.claimBoundary, 'claimBoundary', 600)
  if (!Array.isArray(context.entities) || !Array.isArray(context.relations) || !Array.isArray(context.groups) || !Array.isArray(context.frames)) throw new Error('visual_storyboard_catalog_required')
  if (!context.initial || typeof context.initial !== 'object' || !Array.isArray(context.initial.visibleIds) || !context.initial.groupMembers || typeof context.initial.groupMembers !== 'object') throw new Error('visual_storyboard_initial_state_required')
  if (!context.presentation || typeof context.presentation !== 'object') throw new Error('visual_storyboard_presentation_required')
  const { width, height } = asciiSize(context)
  if (!Array.isArray(context.invariants) || !Array.isArray(context.misconceptions)) throw new Error('visual_storyboard_teaching_context_required')
  if (context.entities.length < 2 || context.entities.length > MAX_ENTITIES) throw new Error('visual_storyboard_entities_invalid')
  if (context.relations.length > MAX_RELATIONS || context.groups.length > MAX_GROUPS) throw new Error('visual_storyboard_catalog_too_large')
  if (context.frames.length < 2 || context.frames.length > MAX_FRAMES) throw new Error('visual_storyboard_frames_invalid')
  unique(context.entities.map(item => item.id), 'entities')
  unique(context.relations.map(item => item.id), 'relations')
  unique(context.groups.map(item => item.id), 'groups')
  unique(context.frames.map(item => item.id), 'frames')
  unique([...context.entities.map(item => item.id), ...context.relations.map(item => item.id), ...context.groups.map(item => item.id)], 'catalog')
  const entityIds = new Set(context.entities.map(item => item.id))
  const relationIds = new Set(context.relations.map(item => item.id))
  const groupIds = new Set(context.groups.map(item => item.id))
  const references = new Set([...entityIds, ...relationIds, ...groupIds])
  context.entities.forEach((item, index) => {
    if (!ID.test(item.id)) throw new Error(`visual_storyboard_id_invalid:entities[${index}]`)
    text(item.label, `entities[${index}].label`, 34)
  })
  context.relations.forEach((item, index) => {
    if (!ID.test(item.id) || !entityIds.has(item.from) || !entityIds.has(item.to) || item.from === item.to) {
      throw new Error(`visual_storyboard_relation_invalid:relations[${index}]`)
    }
    if (item.label) text(item.label, `relations[${index}].label`, 28)
  })
  context.groups.forEach((item, index) => text(item.label, `groups[${index}].label`, 34))
  assertIds(context.initial.visibleIds, references, 'initial.visibleIds')
  unique(context.initial.visibleIds, 'initial.visibleIds')
  assertIds(context.initial.focusIds || [], references, 'initial.focusIds')
  unique(context.initial.focusIds || [], 'initial.focusIds')
  Object.entries(context.initial.groupMembers).forEach(([groupId, members]) => {
    if (!groupIds.has(groupId)) throw new Error(`visual_storyboard_group_invalid:${groupId}`)
    assertIds(members, entityIds, `initial.groupMembers.${groupId}`)
    unique(members, `initial.groupMembers.${groupId}`)
  })
  Object.entries(context.initial.orders || {}).forEach(([groupId, members]) => {
    if (!groupIds.has(groupId)) throw new Error(`visual_storyboard_group_invalid:${groupId}`)
    assertIds(members, entityIds, `initial.orders.${groupId}`)
    unique(members, `initial.orders.${groupId}`)
  })
  Object.entries(context.initial.properties || {}).forEach(([targetId, properties]) => {
    assertIds([targetId], references, `initial.properties.${targetId}`)
    const entries = Object.entries(properties)
    if (entries.length > 8) throw new Error(`visual_storyboard_properties_too_large:${targetId}`)
    entries.forEach(([key, value]) => {
      if (!PROPERTY_KEY.test(key)) throw new Error(`visual_storyboard_property_key_invalid:initial.properties.${targetId}`)
      assertScalar(value, `initial.properties.${targetId}.${key}`)
    })
  })
  if (!context.invariants.length || context.invariants.length > 12 || context.misconceptions.length > 12) throw new Error('visual_storyboard_teaching_context_invalid')
  context.invariants.forEach((item, index) => text(item, `invariants[${index}]`, 280))
  context.misconceptions.forEach((item, index) => text(item, `misconceptions[${index}]`, 280))
  if (context.presentation.preserveIdentity !== true) throw new Error('visual_storyboard_identity_contract_invalid')
  if (context.initial.asciiCanvas) canvasLines(context.initial.asciiCanvas, width, height, 'initial.asciiCanvas')
  validateAnchorCatalog(context.initial.asciiAnchors, entityIds, 'initial.asciiAnchors')
  context.frames.forEach((frame, frameIndex) => {
    if (!frame || typeof frame !== 'object' || !Array.isArray(frame.operations) || !Array.isArray(frame.assertions)
      || !ID.test(frame.id) || !frame.operations.length || frame.operations.length > 32 || !frame.assertions.length || frame.assertions.length > 12) throw new Error(`visual_storyboard_frame_invalid:${frameIndex}`)
    text(frame.title, `frames[${frameIndex}].title`, 72)
    text(frame.narration, `frames[${frameIndex}].narration`, 320)
    if (frame.asciiCanvas) canvasLines(frame.asciiCanvas, width, height, `frames[${frameIndex}].asciiCanvas`)
    validateAnchorCatalog(frame.asciiAnchors, entityIds, `frames[${frameIndex}].asciiAnchors`)
    frame.operations.forEach((operation, operationIndex) => validateOperation(operation, references, entityIds, relationIds, groupIds, `frames[${frameIndex}].operations[${operationIndex}]`))
    frame.assertions.forEach((assertion, assertionIndex) => {
      const path = `frames[${frameIndex}].assertions[${assertionIndex}]`
      if (assertion.type === 'visible') assertIds([assertion.targetId], references, path)
      else if (assertion.type === 'property') {
        assertIds([assertion.targetId], references, path)
        if (!PROPERTY_KEY.test(assertion.key)) throw new Error(`visual_storyboard_property_key_invalid:${path}`)
        assertScalar(assertion.equals, `${path}.equals`)
      } else {
        if (!groupIds.has(assertion.groupId)) throw new Error(`visual_storyboard_group_invalid:${path}`)
        assertIds(assertion.equals, entityIds, `${path}.equals`)
        unique(assertion.equals, `${path}.equals`)
      }
    })
  })
  return context
}

function scalarText(value: StoryboardScalar) {
  if (value === null) return 'null'
  return String(value)
}

function entityText(context: VisualStoryboardContext, state: VisualStateSnapshot, id: string) {
  const entity = context.entities.find(item => item.id === id)
  if (!entity) return id
  const properties = Object.entries(state.properties?.[id] || {})
    .map(([key, value]) => `${key}=${scalarText(value)}`)
  return properties.length ? `${entity.label}{${properties.join(',')}}` : entity.label
}

/**
 * Honest topic-independent fallback. It preserves every visible object and
 * relation as text, but deliberately does not pretend to be a designed frame.
 */
function fallbackAscii(context: VisualStoryboardContext, state: VisualStateSnapshot, title: string) {
  const visible = new Set(state.visibleIds || [])
  const focus = new Set(state.focusIds || [])
  const { width, height } = asciiSize(context)
  const lines = [`+-- ${title} --+`]
  const pushPacked = (prefix: string, items: string[]) => {
    let line = prefix
    for (const item of items) {
      const separator = line === prefix ? '' : '  '
      if ([...`${line}${separator}${item}`].length <= width) {
        line += `${separator}${item}`
      } else {
        if (line !== prefix) lines.push(line)
        line = `  ${item}`
        if ([...line].length > width) {
          while ([...line].length > width) {
            lines.push([...line].slice(0, width).join(''))
            line = `  ${[...line].slice(width).join('')}`
          }
        }
      }
    }
    if (line !== prefix) lines.push(line)
  }
  for (const group of context.groups) {
    const members = state.orders?.[group.id] || state.groupMembers?.[group.id] || []
    if (!members.length) continue
    const rendered = members.map(id => {
      const entity = context.entities.find(item => item.id === id)
      const label = entity?.label || id
      return `${focus.has(id) ? '*' : ''}[${label}]${focus.has(id) ? '*' : ''}`
    })
    if (group.layout === 'column') {
      lines.push(`${group.label}:`)
      rendered.forEach(item => lines.push(`  | ${item}`))
    } else {
      pushPacked(`${group.label}: `, rendered)
    }
  }
  const grouped = new Set(Object.values(state.groupMembers || {}).flat())
  const ungrouped = context.entities.filter(item => visible.has(item.id) && !grouped.has(item.id))
  if (ungrouped.length) pushPacked('对象: ', ungrouped.map(item => `[${item.label}]`))
  const relations = context.relations.filter(item => visible.has(item.id) && visible.has(item.from) && visible.has(item.to))
  if (relations.length) {
    lines.push('关系:')
    relations.forEach(item => lines.push(`  ${item.id}: ${item.from} --${item.label || item.kind}--> ${item.to}`))
  }
  const canvas = lines.join('\n')
  if (lines.length > height || lines.some(line => [...line].length > width)) {
    throw new Error('visual_storyboard_ascii_fallback_capacity_exceeded')
  }
  return canvas
}

function validateAuthoredCanvas(
  context: VisualStoryboardContext,
  state: VisualStateSnapshot,
  raw: string,
  anchors: Record<string, string> | undefined,
  path: string,
) {
  const { width, height } = asciiSize(context)
  const canvas = canvasLines(raw, width, height, path)
  const missing = context.entities
    .filter(item => {
      if (!(state.visibleIds || []).includes(item.id)) return false
      const token = anchors?.[item.id] || item.label
      return !canvas.includes(token)
    })
    .map(item => item.id)
  if (missing.length) throw new Error(`visual_storyboard_ascii_objects_missing:${path}.${missing.join(',')}`)
  const unanchored = context.entities
    .filter(item => (state.visibleIds || []).includes(item.id) && anchors && !anchors[item.id])
    .map(item => item.id)
  if (unanchored.length) throw new Error(`visual_storyboard_ascii_anchors_missing:${path}.${unanchored.join(',')}`)
  if (!/[|+\-<>=\/\\[\]{}()┌┐└┘├┤┬┴┼─│→←↑↓⇄]/.test(canvas)) throw new Error(`visual_storyboard_ascii_structure_missing:${path}`)
  return canvas
}

function supplementMissingObjects(
  context: VisualStoryboardContext,
  state: VisualStateSnapshot,
  raw: string,
  anchors: Record<string, string> | undefined,
  path: string,
) {
  const { width, height } = asciiSize(context)
  const canvas = canvasLines(raw, width, height, path)
  const missing = context.entities
    .filter(entity => (state.visibleIds || []).includes(entity.id))
    .map(entity => anchors?.[entity.id] || entity.label)
    .filter(token => !canvas.includes(token))
  if (!missing.length) return { canvas, supplemented: false }
  const lines = canvas.split('\n')
  lines.push('+-- 仍在状态中的对象 --+')
  let row = '  '
  for (const token of missing.map(item => `[${item}]`)) {
    const candidate = row.trim() ? `${row}  ${token}` : `  ${token}`
    if ([...candidate].length <= width) row = candidate
    else {
      lines.push(row)
      row = `  ${token}`
    }
  }
  if (row.trim()) lines.push(row)
  if (lines.length > height || lines.some(line => [...line].length > width)) {
    throw new Error(`visual_storyboard_ascii_supplement_capacity_exceeded:${path}`)
  }
  return { canvas: lines.join('\n'), supplemented: true }
}

function asciiDesignState(context: VisualStoryboardContext, state: VisualStateSnapshot) {
  const visible = new Set(state.visibleIds || [])
  return {
    visibleEntities: context.entities
      .filter(entity => visible.has(entity.id))
      .map(entity => ({
        id: entity.id,
        label: entity.label,
        kind: entity.kind,
        detail: entity.detail,
        properties: state.properties?.[entity.id] || {},
        focused: (state.focusIds || []).includes(entity.id),
      })),
    visibleRelations: context.relations
      .filter(relation => visible.has(relation.id))
      .map(relation => ({ ...relation })),
    groups: context.groups.map(group => ({
      ...group,
      members: state.orders?.[group.id] || state.groupMembers?.[group.id] || [],
    })),
  }
}

export function buildAsciiStoryboardDesignContext(contextInput: VisualStoryboardContext) {
  const context = validateVisualStoryboard(contextInput)
  // Compile once through the semantic replay path. Missing ASCII canvases use
  // the honest fallback temporarily; only the replayed states are exposed to
  // the designer.
  const baseline = compileVisualStoryboard(context)
  if (baseline.spec.kind !== 'animation') throw new Error('ascii_storyboard_requires_animation_timeline')
  const replay = replayAnimation(baseline.spec)
  return {
    version: ASCII_STORYBOARD_DESIGN_VERSION,
    storyboardId: context.id,
    title: context.title,
    learningGoal: context.learningGoal,
    invariants: context.invariants,
    misconceptions: context.misconceptions,
    claimBoundary: context.claimBoundary,
    canvas: asciiSize(context),
    initial: {
      id: 'initial',
      title: '初始状态',
      narration: context.learningGoal,
      ...asciiDesignState(context, initialState(context)),
    },
    frames: context.frames.map((frame, index) => ({
      id: frame.id,
      title: frame.title,
      narration: frame.narration,
      ...asciiDesignState(context, replay.states[index]),
    })),
  }
}

export function asciiStoryboardDesignPrompt(repairReason = '') {
  return [
    '你是 ASCII 教学画面设计器。输入已经是 Tool 确定性重放后的逐帧完整状态；只负责空间设计，不解释主题、不修改语义。',
    `只输出 JSON：{"version":"${ASCII_STORYBOARD_DESIGN_VERSION}","initial":{"asciiCanvas":"...","asciiAnchors":{"entity_id":"画布中的短文本"}},"frames":[{"id":"原帧id","asciiCanvas":"...","asciiAnchors":{...}}]}。`,
    '不要复制 entities、relations、groups、properties、讲解或断言。不要输出 Markdown、SVG、HTML、CSS、ANSI 转义或像素坐标。',
    '每张画布必须是完整快照，2 行以上；宽高不得超过输入 canvas。可自由使用树、泳道、表格、矩阵、时间线、队列、栈或组合布局，禁止统一套用“输入→处理→输出”。',
    '对该帧每个 visibleEntities 项都必须给 asciiAnchors，anchor 是它在画布中实际出现的唯一短文本并逐字匹配。关系不是实体，不要为 relation id 建 anchor。',
    '相邻帧尽量保持对象位置稳定；使用 +-|/\\<>[]=*(){} 等结构字符，焦点同时用 * 或明确文字提示。主体对象和变化必须仅看画布即可识别。',
    repairReason ? `上一版未通过 Tool：${repairReason}。只修画布或 anchors，逐项核对每帧 visibleEntities；不要扩大事实。` : '',
  ].filter(Boolean).join('\n')
}

function extractDesignJson(raw: string) {
  const candidate = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() || raw.trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('ascii_storyboard_design_json_missing')
  return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>
}

export function applyAsciiStoryboardDesign(contextInput: VisualStoryboardContext, raw: string) {
  const context = validateVisualStoryboard(contextInput)
  const designContext = buildAsciiStoryboardDesignContext(context)
  const payload = extractDesignJson(raw)
  if (payload.version !== ASCII_STORYBOARD_DESIGN_VERSION) throw new Error('ascii_storyboard_design_version_invalid')
  const initial = payload.initial && typeof payload.initial === 'object' ? payload.initial as Record<string, unknown> : {}
  const frames = Array.isArray(payload.frames) ? payload.frames : []
  const frameMap = new Map(frames.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    return typeof row.id === 'string' ? [[row.id, row] as const] : []
  }))
  const designed: VisualStoryboardContext = {
    ...context,
    initial: (() => {
      const asciiCanvas = typeof initial.asciiCanvas === 'string' ? initial.asciiCanvas : undefined
      if (!asciiCanvas) return { ...context.initial, asciiCanvas: undefined, asciiAnchors: undefined }
      const asciiAnchors = initial.asciiAnchors && typeof initial.asciiAnchors === 'object' ? initial.asciiAnchors as Record<string, string> : undefined
      const supplemented = supplementMissingObjects(
        context,
        { ...emptyState(), visibleIds: designContext.initial.visibleEntities.map(entity => entity.id) },
        asciiCanvas,
        asciiAnchors,
        'initial.asciiCanvas',
      )
      return {
      ...context.initial,
        asciiCanvas: supplemented.canvas,
        asciiAnchors,
        asciiSupplemented: supplemented.supplemented,
      }
    })(),
    frames: context.frames.map((frame, index) => {
      const design = frameMap.get(frame.id)
      if (!design || typeof design.asciiCanvas !== 'string') throw new Error(`ascii_storyboard_design_frame_missing:${frame.id}`)
      const asciiAnchors = design.asciiAnchors && typeof design.asciiAnchors === 'object' ? design.asciiAnchors as Record<string, string> : undefined
      const supplemented = supplementMissingObjects(
        context,
        { ...emptyState(), visibleIds: designContext.frames[index].visibleEntities.map(entity => entity.id) },
        design.asciiCanvas,
        asciiAnchors,
        `frames[${index}].asciiCanvas`,
      )
      return {
        ...frame,
        asciiCanvas: supplemented.canvas,
        asciiAnchors,
        asciiSupplemented: supplemented.supplemented,
      }
    }),
  }
  // Compilation is the proof: it replays semantics, checks every visible
  // entity anchor, bounds each canvas and rejects control sequences.
  compileVisualStoryboard(designed)
  return designed
}

export async function designAsciiStoryboard(context: VisualStoryboardContext, generate: GenerateText) {
  const startedAt = Date.now()
  const designContext = buildAsciiStoryboardDesignContext(context)
  const input = JSON.stringify(designContext)
  const first = await generate(
    asciiStoryboardDesignPrompt(),
    input,
    ASCII_DESIGN_FIRST_TIMEOUT_MS,
    ASCII_DESIGN_MAX_TOKENS,
    { responseFormat: 'json_object' },
  )
  try {
    return applyAsciiStoryboardDesign(context, first)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'ascii_storyboard_design_invalid'
    const repairTimeoutMs = Math.max(30_000, ASCII_DESIGN_TOTAL_TIMEOUT_MS - (Date.now() - startedAt))
    const repaired = await generate(
      asciiStoryboardDesignPrompt(reason),
      JSON.stringify({ context: designContext, previousDesign: extractDesignJson(first) }),
      repairTimeoutMs,
      ASCII_DESIGN_MAX_TOKENS,
      { responseFormat: 'json_object' },
    )
    return applyAsciiStoryboardDesign(context, repaired)
  }
}

function validateOperation(
  operation: StoryboardOperation,
  references: Set<string>,
  entityIds: Set<string>,
  relationIds: Set<string>,
  groupIds: Set<string>,
  path: string,
) {
  if (operation.op === 'create_entity' || operation.op === 'remove_entity') return assertIds([operation.targetId], entityIds, path)
  if (operation.op === 'connect' || operation.op === 'disconnect') return assertIds([operation.relationId], relationIds, path)
  if (operation.op === 'set_property') {
    assertIds([operation.targetId], references, path)
    if (!PROPERTY_KEY.test(operation.key)) throw new Error(`visual_storyboard_property_key_invalid:${path}`)
    assertScalar(operation.value, `${path}.value`)
    return
  }
  if (operation.op === 'set_group_members' || operation.op === 'reorder') {
    if (!groupIds.has(operation.groupId)) throw new Error(`visual_storyboard_group_invalid:${path}`)
    const ids = operation.op === 'reorder' ? operation.itemIds : operation.memberIds
    assertIds(ids, entityIds, path)
    unique(ids, path)
    return
  }
  if (operation.op === 'focus') assertIds(operation.targetIds, references, path)
}

function initialState(context: VisualStoryboardContext): VisualStateSnapshot {
  return {
    ...emptyState(),
    visibleIds: [...context.initial.visibleIds],
    focusIds: [...(context.initial.focusIds || [])],
    groupMembers: Object.fromEntries(Object.entries(context.initial.groupMembers).map(([key, value]) => [key, [...value]])),
    orders: Object.fromEntries(Object.entries(context.initial.orders || {}).map(([key, value]) => [key, [...value]])),
    properties: Object.fromEntries(Object.entries(context.initial.properties || {}).map(([key, value]) => [key, { ...value }])),
  }
}

function patchesFor(operation: StoryboardOperation): VisualPatch[] {
  switch (operation.op) {
    case 'create_entity': return [{ type: 'set_visibility', targetId: operation.targetId, visible: true }]
    case 'remove_entity': return [{ type: 'set_visibility', targetId: operation.targetId, visible: false }]
    case 'connect': return [{ type: 'set_visibility', targetId: operation.relationId, visible: true }]
    case 'disconnect': return [{ type: 'set_visibility', targetId: operation.relationId, visible: false }]
    case 'set_property': return [{ type: 'set_property', targetId: operation.targetId, key: operation.key, value: operation.value }]
    case 'set_group_members': return [{ type: 'set_group_members', groupId: operation.groupId, memberIds: operation.memberIds }]
    case 'reorder': return [{ type: 'set_order', groupId: operation.groupId, itemIds: operation.itemIds }]
    case 'focus': return [{ type: 'set_focus', targetIds: operation.targetIds }]
  }
}

function assertFrame(assertions: StoryboardAssertion[], state: VisualStateSnapshot, frameId: string) {
  for (const assertion of assertions) {
    const actual = assertion.type === 'visible' ? (state.visibleIds || []).includes(assertion.targetId)
      : assertion.type === 'property' ? state.properties?.[assertion.targetId]?.[assertion.key]
        : assertion.type === 'group_members' ? state.groupMembers?.[assertion.groupId] || []
          : state.orders?.[assertion.groupId] || state.groupMembers?.[assertion.groupId] || []
    if (!equivalent(actual, assertion.equals)) throw new Error(`visual_storyboard_assertion_failed:${frameId}.${assertion.type}`)
  }
}

export function compileVisualStoryboard(contextInput: VisualStoryboardContext, outputKind: 'diagram' | 'animation' = 'animation'): GeneratedLearningVisual {
  const context = validateVisualStoryboard(contextInput)
  const semantic: SemanticSceneSemantic = {
    type: 'semantic_scene',
    entities: context.entities.map(item => ({ ...item })),
    relations: context.relations.map(item => ({ ...item })),
    groups: context.groups.map(item => ({ ...item })),
  }
  const frames: LearningVisualFrame[] = context.frames.map(frame => ({
    id: frame.id,
    title: frame.title,
    narration: frame.narration,
    durationMs: context.presentation.pacing === 'continuous' ? 1050 : 1450,
    patches: frame.operations.flatMap(patchesFor),
  }))
  const requestText = JSON.stringify(context)
  const base = {
    version: VISUAL_VERSION,
    title: context.title,
    subtitle: context.learningGoal,
    explanation: context.explanation,
    accessibility: {
      summary: `${context.learningGoal}。${context.claimBoundary}`,
      readingOrder: [...context.entities.map(item => item.id), ...context.relations.map(item => item.id), ...context.groups.map(item => item.id)],
      nonColorStateCue: '当前对象同时使用粗边框、文字状态和逐帧说明；集合成员以文字清单重复表达。',
    },
    provenance: { ...provenance(requestText), promptVersion: PROMPT_VERSION, rendererVersion: RENDERER_VERSION },
    generation: {
      source: 'context_compiler' as const,
      plannerSucceeded: true,
      degraded: false,
      repairs: [],
    },
    domain: 'computer' as const,
    abstraction: 'semantic_scene' as const,
    semantic,
  }
  const initial = initialState(context)
  const provisional = {
    ...base,
    kind: 'animation' as const,
    initialState: initial,
    frames,
    invariants: [{ type: 'references_resolve' as const }],
    finalState: cloneState(initial),
  } satisfies LearningVisualSpec
  const replay = replayAnimation(provisional)
  context.frames.forEach((frame, index) => assertFrame(frame.assertions, replay.states[index], frame.id))
  const spec = { ...provisional, finalState: replay.finalState } satisfies LearningVisualSpec
  const qualityBeforeLayout = inspectLearningVisualSpec(spec)
  if (qualityBeforeLayout.status === 'rejected') throw new Error(`visual_storyboard_quality_gate:${qualityBeforeLayout.issues.join(',')}`)
  const states = [initial, ...replay.states]
  const authoredCanvases = [context.initial.asciiCanvas, ...context.frames.map(frame => frame.asciiCanvas)]
  const titles = ['初始状态', ...context.frames.map(frame => frame.title)]
  const narrations = [context.learningGoal, ...context.frames.map(frame => frame.narration)]
  const steps = states.map((state, index) => {
    const authored = authoredCanvases[index]
    const ascii = authored
      ? validateAuthoredCanvas(
        context,
        state,
        authored,
        index === 0 ? context.initial.asciiAnchors : context.frames[index - 1].asciiAnchors,
        index === 0 ? 'initial.asciiCanvas' : `frames[${index - 1}].asciiCanvas`,
      )
      : fallbackAscii(context, state, titles[index])
    return {
      title: titles[index],
      text: narrations[index],
      svg: '',
      ascii,
      durationMs: index === 0 ? 900 : frames[index - 1]?.durationMs,
      stateDescription: narrations[index],
    }
  })
  const supplemented = Boolean(context.initial.asciiSupplemented || context.frames.some(frame => frame.asciiSupplemented))
  const fallbackUsed = authoredCanvases.some(canvas => !canvas) || supplemented
  const quality = {
    ...qualityBeforeLayout,
    warnings: [
      ...qualityBeforeLayout.warnings,
      ...(authoredCanvases.some(canvas => !canvas) ? ['ascii_design_fallback_used'] : []),
      ...(supplemented ? ['ascii_object_ledger_supplemented'] : []),
    ],
    layout: { collisions: 0, outOfBounds: 0 },
    security: { executableContentRejected: true, finiteDataOnly: true },
  }
  const artifactSteps = outputKind === 'diagram' ? [steps[steps.length - 1]] : steps
  const artifact = {
    kind: outputKind === 'diagram' ? 'image' as const : 'animation' as const,
    title: context.title,
    subtitle: context.learningGoal,
    steps: artifactSteps,
    specVersion: VISUAL_STORYBOARD_VERSION,
    domain: 'computer' as const,
    abstraction: 'semantic_scene',
    renderer: ASCII_RENDERER_VERSION,
    canvasFormat: 'ascii' as const,
    fallbackUsed,
    status: fallbackUsed ? 'degraded' as const : 'usable' as const,
    degraded: fallbackUsed,
    plannerSucceeded: true,
    provenance: base.provenance,
    quality,
    readable: {
      summary: `${context.learningGoal}。${context.claimBoundary}`,
      readingOrder: [...context.entities.map(item => item.id), ...context.relations.map(item => item.id), ...context.groups.map(item => item.id)],
      frameDescriptions: narrations,
      nonColorStateCue: '当前对象使用等宽文本、连接符和逐帧说明表达；星号表示当前焦点。',
    },
    replay: { spec, rendererVersion: ASCII_RENDERER_VERSION },
  }
  return {
    spec,
    artifact,
    explanation: context.explanation,
    quality,
    plannerSucceeded: true,
    degraded: fallbackUsed,
    generation: {
      source: 'context_compiler', compileStatus: 'exact', plannerAttempts: 0,
      repairAttempted: false, syntaxRepairApplied: false, attempts: [],
    },
  }
}
