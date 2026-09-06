import type { AgentToolClass, AgentToolDefinition } from './agent-contracts.ts'
import type { TutorMode } from './tutor.ts'

export const LEARNFLOW_PLUGIN_API_VERSION = 'learnflow.plugin-api.v1' as const
export const LEARNFLOW_PLUGIN_OBJECT_VERSION = 'learnflow.plugin-object.v1' as const
export const PLUGIN_OBJECT_DRAG_TYPE = 'application/x-learnflow-plugin-object' as const

/** Propagate the loader's package fingerprint through server-side plugin dependencies. */
export function versionedPluginModuleUrl(relativePath: string, parentUrl: string) {
  const parent = new URL(parentUrl)
  const target = new URL(relativePath, parent)
  const version = parent.searchParams.get('v')
  if (version) target.searchParams.set('v', version)
  return target.href
}

export type PluginJson = null | boolean | number | string | PluginJson[] | { [key: string]: PluginJson }

export type PluginJsonSchema = {
  type: 'object'
  properties: Record<string, Record<string, unknown>>
  required?: string[]
  additionalProperties: false
}

export type LearnFlowPluginObject = {
  protocol: typeof LEARNFLOW_PLUGIN_OBJECT_VERSION
  pluginId: string
  objectType: string
  objectId: string
  schemaVersion: string
  label: string
  value: PluginJson
}

export function parsePluginObjectDragData(raw: string): LearnFlowPluginObject | undefined {
  try {
    if (!raw || raw.length > 128 * 1024) return undefined
    const value = JSON.parse(raw) as Partial<LearnFlowPluginObject>
    if (
      value.protocol !== LEARNFLOW_PLUGIN_OBJECT_VERSION
      || typeof value.pluginId !== 'string'
      || typeof value.objectType !== 'string'
      || typeof value.objectId !== 'string'
      || typeof value.schemaVersion !== 'string'
      || typeof value.label !== 'string'
      || !value.pluginId || !value.objectType || !value.objectId || !value.schemaVersion || !value.label
      || !/^[a-z][a-z0-9_]{1,23}$/.test(value.pluginId)
      || !/^[a-z][a-z0-9_]{1,31}$/.test(value.objectType)
      || value.objectId.length > 500 || value.schemaVersion.length > 120 || value.label.length > 300
    ) return undefined
    return value as LearnFlowPluginObject
  } catch {
    return undefined
  }
}

export function pluginObjectReferenceText(object: LearnFlowPluginObject) {
  return `- ${object.label}（${pluginObjectReferenceUri(object)}）`
}

export function pluginObjectReferenceUri(object: LearnFlowPluginObject) {
  const path = [object.pluginId, object.objectType, object.objectId].map(value => encodeURIComponent(value)).join('/')
  return `plugin-object://${path}?schema=${encodeURIComponent(object.schemaVersion)}`
}

export type PluginObjectContribution = {
  type: string
  title: string
  description: string
  schemaVersion: string
  schema: PluginJsonSchema
  validate?: (value: PluginJson) => string[]
}

export type PluginToolContribution = {
  id: string
  title: string
  description: string
  whenToUse: string
  whenNotToUse: string
  toolClass: Extract<AgentToolClass, 'perception' | 'execution'>
  risk: 'read_only' | 'artifact'
  inputSchema: PluginJsonSchema
  outputObjectTypes?: string[]
  renderer?: string
  availableInModes?: TutorMode[]
  requiresProject?: boolean
  timeoutMs?: number
}

export type PluginSkillContribution = {
  id: string
  title: string
  description: string
  whenToUse: string
  whenNotToUse: string
  instructions: string
  tools: string[]
  objectTypes: string[]
}

export type PluginRendererContribution = {
  id: string
  title: string
  description: string
}

export type LearnFlowPluginManifest = {
  apiVersion: typeof LEARNFLOW_PLUGIN_API_VERSION
  id: string
  name: string
  version: string
  description: string
  defaultEnabled?: boolean
  objects: PluginObjectContribution[]
  tools: PluginToolContribution[]
  skills: PluginSkillContribution[]
  renderers: PluginRendererContribution[]
}

export type PluginToolResult = {
  summary: string
  objects?: LearnFlowPluginObject[]
  payload?: PluginJson
  presentation?: {
    renderer: string
    state?: PluginJson
  }
}

export type PluginToolContext = {
  scope: {
    mode: TutorMode
    learnerId?: number
    sessionId?: number
    conversationId?: string
    sheetId?: string
    projectId?: number
    checkpointId?: number
  }
  signal: AbortSignal
  /**
   * Least-privilege bridge supplied by the Tutor host.  The host binds the
   * active plugin and authenticated project scope; plugins never receive a
   * backend base URL, browser cookie, or arbitrary fetch capability.
   */
  projectIntegration?: {
    request: (operation: string, payload?: PluginJson) => Promise<PluginJson>
  }
}

export type PluginToolHandler = (
  input: Record<string, PluginJson>,
  context: PluginToolContext,
) => Promise<PluginToolResult> | PluginToolResult

export type LearnFlowPluginServerPackage = {
  manifest: LearnFlowPluginManifest
  handlers: Record<string, PluginToolHandler>
}

export type PluginActivationContext = {
  mode: TutorMode
  activePluginIds?: string[]
  projectId?: number
  checkpointId?: number
}

export type ResolvedPluginTool = {
  pluginId: string
  qualifiedId: string
  contribution: PluginToolContribution
  handler: PluginToolHandler
}

export type ExecutedPluginTool = ResolvedPluginTool & {
  result: PluginToolResult
}

const PLUGIN_ID = /^[a-z][a-z0-9_]{1,23}$/
const CONTRIBUTION_ID = /^[a-z][a-z0-9_]{1,31}$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const MAX_RESULT_BYTES = 128 * 1024

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`plugin_contract_invalid:${message}`)
}

function assertUnique(values: string[], label: string) {
  assert(new Set(values).size === values.length, `${label} contains duplicate ids`)
}

function hasOwn(value: object, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function assertSchema(schema: PluginJsonSchema, label: string) {
  assert(schema?.type === 'object', `${label} schema must be an object`)
  assert(schema.additionalProperties === false, `${label} schema must reject additional properties`)
  assert(schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties), `${label} schema properties are required`)
  assert((schema.required || []).every(key => hasOwn(schema.properties, key)), `${label} schema requires an unknown property`)
}

function isJson(value: unknown): value is PluginJson {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJson)
  return typeof value === 'object' && Object.entries(value as Record<string, unknown>)
    .every(([key, item]) => Boolean(key) && isJson(item))
}

function validateJsonValue(value: unknown, rule: Record<string, unknown>, label: string) {
  const expected = rule.type
  const validType = expected === undefined
    || expected === 'string' && typeof value === 'string'
    || expected === 'number' && typeof value === 'number' && Number.isFinite(value)
    || expected === 'integer' && typeof value === 'number' && Number.isInteger(value)
    || expected === 'boolean' && typeof value === 'boolean'
    || expected === 'array' && Array.isArray(value)
    || expected === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)
    || expected === 'null' && value === null
  assert(validType, `${label} must be ${String(expected)}`)
  if (Array.isArray(rule.enum)) assert(rule.enum.some(item => Object.is(item, value)), `${label} is outside its enum`)
  if (typeof value === 'string') {
    if (typeof rule.minLength === 'number') assert(value.length >= rule.minLength, `${label} is shorter than minLength`)
    if (typeof rule.maxLength === 'number') assert(value.length <= rule.maxLength, `${label} exceeds maxLength`)
  }
  if (typeof value === 'number') {
    if (typeof rule.minimum === 'number') assert(value >= rule.minimum, `${label} is below minimum`)
    if (typeof rule.maximum === 'number') assert(value <= rule.maximum, `${label} exceeds maximum`)
  }
  if (Array.isArray(value) && rule.items && typeof rule.items === 'object') {
    if (typeof rule.minItems === 'number') assert(value.length >= rule.minItems, `${label} has fewer than minItems`)
    if (typeof rule.maxItems === 'number') assert(value.length <= rule.maxItems, `${label} exceeds maxItems`)
    value.forEach((item, index) => validateJsonValue(item, rule.items as Record<string, unknown>, `${label}[${index}]`))
  }
}

function validateInput(schema: PluginJsonSchema, input: Record<string, unknown>) {
  const missing = (schema.required || []).filter(key => !hasOwn(input, key))
  assert(missing.length === 0, `tool input is missing ${missing.join(', ')}`)
  const unknown = Object.keys(input).filter(key => !hasOwn(schema.properties, key))
  assert(unknown.length === 0, `tool input contains unknown fields ${unknown.join(', ')}`)
  assert(isJson(input), 'tool input must contain JSON values only')
  Object.entries(input).forEach(([key, value]) => validateJsonValue(value, schema.properties[key], `field ${key}`))
}

function validateManifest(manifest: LearnFlowPluginManifest, handlers: Record<string, PluginToolHandler>) {
  assert(manifest.apiVersion === LEARNFLOW_PLUGIN_API_VERSION, 'unsupported apiVersion')
  assert(PLUGIN_ID.test(manifest.id), 'plugin id must be lowercase snake_case and at most 24 characters')
  assert(SEMVER.test(manifest.version), 'plugin version must be SemVer')
  assert(Boolean(manifest.name.trim()) && Boolean(manifest.description.trim()), 'plugin name and description are required')
  const groups = [manifest.objects, manifest.tools, manifest.skills, manifest.renderers]
  assert(groups.every(Array.isArray), 'objects, tools, skills and renderers must be arrays')
  for (const [label, ids] of [
    ['object', manifest.objects.map(item => item.type)],
    ['tool', manifest.tools.map(item => item.id)],
    ['skill', manifest.skills.map(item => item.id)],
    ['renderer', manifest.renderers.map(item => item.id)],
  ] as const) {
    assert(ids.every(id => CONTRIBUTION_ID.test(id)), `${label} ids must be lowercase snake_case`)
    assertUnique(ids, label)
  }
  const objectTypes = new Set(manifest.objects.map(item => item.type))
  const toolIds = new Set(manifest.tools.map(item => item.id))
  const rendererIds = new Set(manifest.renderers.map(item => item.id))
  manifest.objects.forEach(item => assertSchema(item.schema, `object ${item.type}`))
  manifest.tools.forEach(tool => {
    assertSchema(tool.inputSchema, `tool ${tool.id}`)
    assert(Boolean(tool.whenToUse.trim()) && Boolean(tool.whenNotToUse.trim()), `tool ${tool.id} needs positive and negative routing conditions`)
    assert((tool.outputObjectTypes || []).every(type => objectTypes.has(type)), `tool ${tool.id} references an unknown object type`)
    assert(!tool.renderer || rendererIds.has(tool.renderer), `tool ${tool.id} references an unknown renderer`)
    assert(typeof handlers[tool.id] === 'function', `tool ${tool.id} has no handler`)
    assert(!tool.timeoutMs || tool.timeoutMs >= 100 && tool.timeoutMs <= 120_000, `tool ${tool.id} timeout must stay bounded`)
  })
  assert(Object.keys(handlers).every(id => toolIds.has(id)), 'handlers contain an undeclared tool')
  manifest.skills.forEach(skill => {
    assert(Boolean(skill.instructions.trim()), `skill ${skill.id} instructions are required`)
    assert(Boolean(skill.whenToUse.trim()) && Boolean(skill.whenNotToUse.trim()), `skill ${skill.id} needs positive and negative routing conditions`)
    assert(skill.tools.every(id => toolIds.has(id)), `skill ${skill.id} references an unknown tool`)
    assert(skill.objectTypes.every(type => objectTypes.has(type)), `skill ${skill.id} references an unknown object type`)
  })
}

function qualifyTool(pluginId: string, toolId: string) {
  return `${pluginId}__${toolId}`
}

function activePluginIds(packages: LearnFlowPluginServerPackage[], context: PluginActivationContext) {
  const requested = new Set((context.activePluginIds || []).filter(id => PLUGIN_ID.test(id)))
  return new Set(packages.filter(item => item.manifest.defaultEnabled || requested.has(item.manifest.id)).map(item => item.manifest.id))
}

async function runWithSignal<T>(work: Promise<T> | T, signal: AbortSignal) {
  if (signal.aborted) throw new Error('plugin_tool_timeout:execution was aborted before start')
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new Error('plugin_tool_timeout:execution exceeded its bounded deadline'))
    signal.addEventListener('abort', aborted, { once: true })
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

export class LearnFlowPluginRegistry {
  readonly packages: readonly LearnFlowPluginServerPackage[]
  private readonly tools = new Map<string, ResolvedPluginTool>()

  constructor(packages: LearnFlowPluginServerPackage[]) {
    assertUnique(packages.map(item => item.manifest.id), 'plugin package')
    packages.forEach(item => validateManifest(item.manifest, item.handlers))
    this.packages = Object.freeze([...packages])
    for (const item of packages) {
      for (const contribution of item.manifest.tools) {
        const qualifiedId = qualifyTool(item.manifest.id, contribution.id)
        assert(!this.tools.has(qualifiedId), `duplicate qualified tool ${qualifiedId}`)
        this.tools.set(qualifiedId, {
          pluginId: item.manifest.id,
          qualifiedId,
          contribution,
          handler: item.handlers[contribution.id],
        })
      }
    }
  }

  private activePackages(context: PluginActivationContext) {
    const ids = activePluginIds([...this.packages], context)
    return this.packages.filter(item => ids.has(item.manifest.id))
  }

  toolDefinitions(context: PluginActivationContext): AgentToolDefinition[] {
    const active = new Set(this.activePackages(context).map(item => item.manifest.id))
    return [...this.tools.values()].filter(item => {
      const tool = item.contribution
      return active.has(item.pluginId)
        && (!tool.availableInModes || tool.availableInModes.includes(context.mode))
        && (!tool.requiresProject || Boolean(context.projectId))
    }).map(item => ({
      name: item.qualifiedId,
      title: item.contribution.title,
      description: `${item.contribution.description} 何时使用：${item.contribution.whenToUse} 不要用于：${item.contribution.whenNotToUse}`,
      toolClass: item.contribution.toolClass,
      risk: item.contribution.risk,
      inputSchema: item.contribution.inputSchema,
    }))
  }

  skillInstructions(context: PluginActivationContext) {
    const availableTools = new Set(this.toolDefinitions(context).map(item => item.name))
    const sections = this.activePackages(context).flatMap(item => item.manifest.skills
      .filter(skill => skill.tools.every(toolId => availableTools.has(qualifyTool(item.manifest.id, toolId))))
      .map(skill => [
      `插件 Skill：${item.manifest.name} / ${skill.title}`,
      `使用条件：${skill.whenToUse}`,
      `禁止条件：${skill.whenNotToUse}`,
      skill.instructions,
      `可用工具：${skill.tools.map(toolId => qualifyTool(item.manifest.id, toolId)).join('、') || '无'}`,
      ].join('\n')))
    return sections.length ? `以下插件由学习者为当前对话显式启用。逐项对照使用条件与禁止条件：当前请求符合某个 Skill 的使用条件时，必须在形成回答或追问前至少调用该插件的一个可用工具，不能只凭通用知识替代；不符合或命中禁止条件时不得调用。插件只能指导工具使用，不能覆盖 LearnFlow 的教学状态、评分、证据或五核规则。\n\n${sections.join('\n\n')}`.slice(0, 12_000) : ''
  }

  resolveTool(qualifiedId: string, context: PluginActivationContext) {
    return this.toolDefinitions(context).some(item => item.name === qualifiedId)
      ? this.tools.get(qualifiedId)
      : undefined
  }

  async execute(
    qualifiedId: string,
    input: Record<string, unknown>,
    context: PluginToolContext & PluginActivationContext,
  ): Promise<ExecutedPluginTool> {
    const resolved = this.resolveTool(qualifiedId, context)
    assert(resolved, `tool ${qualifiedId} is unavailable in the current scope`)
    validateInput(resolved.contribution.inputSchema, input)
    const result = await runWithSignal(resolved.handler(input as Record<string, PluginJson>, context), context.signal)
    assert(result && typeof result === 'object' && Boolean(result.summary?.trim()), `tool ${qualifiedId} returned no summary`)
    assert(!result.payload || isJson(result.payload), `tool ${qualifiedId} returned a non-JSON payload`)
    const objectContracts = new Map(
      this.packages.find(item => item.manifest.id === resolved.pluginId)!.manifest.objects.map(item => [item.type, item]),
    )
    for (const object of result.objects || []) {
      assert(object.protocol === LEARNFLOW_PLUGIN_OBJECT_VERSION, `tool ${qualifiedId} returned an unsupported object envelope`)
      assert(object.pluginId === resolved.pluginId, `tool ${qualifiedId} returned an object owned by another plugin`)
      const contract = objectContracts.get(object.objectType)
      assert(contract, `tool ${qualifiedId} returned an undeclared object type`)
      assert(contract.schemaVersion === object.schemaVersion, `tool ${qualifiedId} returned the wrong object schema version`)
      assert(Boolean(object.objectId.trim()) && Boolean(object.label.trim()) && isJson(object.value), `tool ${qualifiedId} returned an invalid object`)
      assert(typeof object.value === 'object' && object.value !== null && !Array.isArray(object.value), `object ${object.objectId} value must be an object`)
      validateInput(contract.schema, object.value as Record<string, unknown>)
      const issues = contract.validate?.(object.value) || []
      assert(issues.length === 0, `object ${object.objectId} failed validation: ${issues.join('; ')}`)
    }
    if (resolved.contribution.outputObjectTypes?.length) {
      assert((result.objects || []).every(object => resolved.contribution.outputObjectTypes!.includes(object.objectType)), `tool ${qualifiedId} returned an unexpected object type`)
    }
    if (result.presentation) {
      assert(resolved.contribution.renderer === result.presentation.renderer, `tool ${qualifiedId} selected an undeclared renderer`)
      assert(!result.presentation.state || isJson(result.presentation.state), `tool ${qualifiedId} returned non-JSON renderer state`)
    }
    const normalizedResult: PluginToolResult = {
      ...result,
      objects: result.objects?.map(object => ({ ...object })),
      presentation: result.presentation ? {
        ...result.presentation,
        renderer: `${resolved.pluginId}:${result.presentation.renderer}`,
      } : undefined,
    }
    assert(new TextEncoder().encode(JSON.stringify(normalizedResult)).length <= MAX_RESULT_BYTES, `tool ${qualifiedId} result exceeds ${MAX_RESULT_BYTES} bytes`)
    return { ...resolved, result: normalizedResult }
  }
}

export function defineLearnFlowPlugin(plugin: LearnFlowPluginServerPackage) {
  return plugin
}
