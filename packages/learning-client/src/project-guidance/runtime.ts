import { createHash } from 'node:crypto'
import { PROJECT_GUIDANCE_PLUGIN_ID, PROJECT_GUIDANCE_RENDERER, PROJECT_GUIDANCE_VERSION, PROJECT_MODE_CHOICES } from './contract.ts'
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type RecordValue = Record<string, any>
type Context = {
  scope: { conversationId?: string; sessionId?: number; sheetId?: string; learnerId?: number; projectId?: number }
  projectIntegration?: { request: (operation: string, payload?: Json) => Promise<Json> }
}
const text = (value: unknown, limit = 2000) => {
  const result = typeof value === 'string' ? value.trim() : ''
  if (result.length > limit) throw new Error(`plugin_contract_invalid:project_guidance_text_too_long:字段超过 ${limit} 字符，请缩小当前任务范围`)
  return result
}
const list = (value: unknown) => {
  const items = Array.isArray(value) ? value.map(item => text(item, 1200)).filter(Boolean) : []
  if (items.length > 12) throw new Error('plugin_contract_invalid:project_guidance_list_too_long:每组最多 12 项，请合并或缩小任务范围')
  return items
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function listProjectPracticeCases(_input: RecordValue, context: Context) {
  if (!context.projectIntegration) throw new Error('plugin_integration_error:backend_unavailable:案例目录不可用')
  const catalog = await context.projectIntegration.request('list_work_cases') as RecordValue
  const cases = Array.isArray(catalog?.cases) ? catalog.cases.map((item: RecordValue) => ({
    id: text(item.id, 100), version: text(item.version, 100), root_hash: text(item.root_hash, 64),
    title: text(item.title, 300), summary: text(item.summary),
  })).filter((item: RecordValue) => item.id && item.version && /^[a-f0-9]{64}$/.test(item.root_hash)) : []
  return result({ schema_version: PROJECT_GUIDANCE_VERSION, status: 'case_catalog', name: '选择匹配的带教案例',
    project_mode: 'practice', case_catalog: cases, mastery_inference: false },
  '以下为已登记的带教案例。请先核对工作情境并选择匹配案例；没有匹配项时继续设计任务书，不能自动套用。')
}
function result(value: RecordValue, summary: string) {
  return { summary, objects: [{ protocol: 'learnflow.plugin-object.v1' as const, pluginId: PROJECT_GUIDANCE_PLUGIN_ID,
    objectType: 'project_guidance', objectId: String(value.candidate_id || `guidance_${hash(value).slice(0, 24)}`),
    schemaVersion: PROJECT_GUIDANCE_VERSION, label: String(value.name || '选择学习项目类型'), value: value as Json }],
    payload: value as Json, presentation: { renderer: PROJECT_GUIDANCE_RENDERER } }
}
export async function prepareProjectGuidance(input: RecordValue, context: Context) {
  const rawInput = text(input.rawInput || input.name)
  const mode = input.projectMode
  const common = { schema_version: PROJECT_GUIDANCE_VERSION, raw_input: rawInput, mastery_inference: false,
    execution_surface: 'desktop', requires_confirmation: true }
  if (mode !== 'experiment' && mode !== 'practice') return result({ ...common, status: 'needs_mode_selection',
    choices: PROJECT_MODE_CHOICES, name: '把工作任务变成哪种学习项目？' },
  '请选择知识学习、实验或带教实践。知识学习沿用现有转换流程；实验和带教由 LearnFlow 设计，在桌面执行。')
  const name = text(input.name, 120)
  const objective = text(input.objective)
  const brief = { deliverables: list(input.deliverables), constraints: list(input.constraints), success_criteria: list(input.successCriteria) }
  const missing = [name.length < 2 && '任务名称', objective.length < 2 && '要练习的目标', !brief.deliverables.length && '交付物',
    !brief.success_criteria.length && '验收标准'].filter(Boolean)
  if (missing.length) return result({ ...common, project_mode: mode, name: name || rawInput, objective,
    project_brief: brief, status: 'needs_input', missing_fields: missing },
  `已选择${mode === 'experiment' ? '实验项目' : '带教实践项目'}。请补充${missing.join('、')}，Tutor 会先整理任务书供你确认。`)
  if (!context.projectIntegration) throw new Error('plugin_integration_error:backend_unavailable:项目方案服务不可用')
  // Source ownership is bound to the actual conversation by the host. Never accept model-provided session IDs.
  const sourceRefs = context.scope.conversationId && context.scope.sessionId ? [{ type: 'conversation', id: context.scope.conversationId,
    ...(context.scope.sessionId ? { session_id: context.scope.sessionId } : {}),
    ...(context.scope.sheetId ? { sheet_id: context.scope.sheetId } : {}) }] : []
  const request = { project_mode: mode, name, objective, expected_outcome: text(input.expectedOutcome, 1200),
    project_brief: brief, source_refs: sourceRefs,
    ...(mode === 'practice' && input.caseId ? { case_id: text(input.caseId, 100), case_version: text(input.caseVersion, 50),
      case_root_hash: text(input.caseRootHash, 64) } : {}) }
  if (mode === 'practice' && !input.caseId) return result({ ...common, ...request, status: 'needs_case_selection' },
    '任务书已整理。带教实践还需要一个匹配的版本化案例：先查看案例目录并由你选择；若没有匹配案例，当前只能继续设计任务书，不能把任意任务套入现有案例。')
  const response = await context.projectIntegration.request('prepare_project_guidance', {
    ...request, client_action_id: `project-guidance:${hash({ learner: context.scope.learnerId, ...request }).slice(0, 40)}`,
  } as Json) as RecordValue
  if (response.schema_version !== PROJECT_GUIDANCE_VERSION || !response.candidate_id || !/^[a-f0-9]{64}$/.test(response.root_hash)
    || response.requires_confirmation !== true || !response.candidate) throw new Error('plugin_contract_invalid:invalid_project_guidance_candidate')
  return result({ ...common, ...request, status: 'ready_for_confirmation', candidate_id: response.candidate_id,
    root_hash: response.root_hash, candidate: response.candidate }, `已准备“${name}”项目任务书。核对目标、交付物和验收要求后，可在桌面确认创建；尚未创建项目。`)
}
export async function confirmProjectGuidance(input: RecordValue, context: Context) {
  if (input.confirmed !== true || !/^[A-Za-z0-9_-]{1,100}$/.test(text(input.candidateId, 100))
    || !/^[a-f0-9]{64}$/.test(text(input.expectedRootHash, 64))) throw new Error('plugin_contract_invalid:project_guidance_confirmation_required')
  if (!context.projectIntegration) throw new Error('plugin_integration_error:backend_unavailable:项目确认服务不可用')
  const response = await context.projectIntegration.request('confirm_project_guidance', {
    candidateId: input.candidateId, client_action_id: `project-guidance-confirm:${hash([input.candidateId, input.expectedRootHash]).slice(0, 40)}`,
    expected_root_hash: input.expectedRootHash, confirmed: true,
  }) as RecordValue
  if (response.requires_desktop_confirmation === true && response.candidate?.candidate_id === input.candidateId
    && response.candidate?.root_hash === input.expectedRootHash) {
    return result({ ...response.candidate, status: 'ready_for_confirmation' },
      '项目方案已固定。请在桌面任务书卡片点击“确认创建桌面项目”，由本机宿主完成创建；当前仍未创建项目。')
  }
  throw new Error('plugin_contract_invalid:desktop_confirmation_required')
}
