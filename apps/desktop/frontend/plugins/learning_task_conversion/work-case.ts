import { LEARNFLOW_PLUGIN_OBJECT_VERSION, type PluginJson, type PluginToolContext, type PluginToolResult } from '../../src/plugin-api.ts'

export const WORK_CASE_CANDIDATE_SCHEMA = 'learnflow.work-case-candidate.v1' as const

/** A host-validated, unconfirmed selector; never a copy of future case material. */
export type LocalWorkCaseCandidate = {
  case_id: string
  case_version: string
  case_root_hash: string
  title: string
  summary: string
  project_mode: 'practice'
}

export function validateLocalWorkCaseCandidate(value: unknown): LocalWorkCaseCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('案例候选格式无效')
  const candidate = value as Record<string, unknown>
  if (candidate.project_mode !== 'practice' || !/^[a-zA-Z0-9_-]{1,100}$/.test(String(candidate.case_id || ''))
    || !/^[a-f0-9]{64}$/.test(String(candidate.case_root_hash || ''))
    || typeof candidate.case_version !== 'string' || !candidate.case_version
    || typeof candidate.title !== 'string' || !candidate.title) throw new Error('案例候选缺少固定版本或完整性标识')
  return { case_id: String(candidate.case_id), case_version: candidate.case_version, case_root_hash: String(candidate.case_root_hash),
    title: candidate.title, summary: String(candidate.summary || ''), project_mode: 'practice' }
}

export function localWorkCaseResult(value: unknown): PluginToolResult {
  const candidate = validateLocalWorkCaseCandidate(value)
  return {
    summary: `已准备“${candidate.title}”的固定版本候选。请在项目工作台确认开始；尚未创建路线或完成任何学习。`,
    objects: [{ protocol: LEARNFLOW_PLUGIN_OBJECT_VERSION, pluginId: 'learning_task_conversion', objectType: 'work_case_candidate',
      objectId: `${candidate.case_id}@${candidate.case_version}:${candidate.case_root_hash}`, schemaVersion: WORK_CASE_CANDIDATE_SCHEMA,
      label: candidate.title, value: candidate as unknown as PluginJson }],
    payload: { requires_confirmation: true, mastery_changed: false, candidate: candidate as unknown as PluginJson },
    presentation: { renderer: 'work_case_candidate' },
  }
}

export async function listLocalWorkCases(context: PluginToolContext): Promise<PluginToolResult> {
  if (!context.projectIntegration) throw new Error('案例宿主接口不可用')
  const result = await context.projectIntegration.request('list_work_cases')
  return { summary: '以下是当前宿主可用的版本化教学案例；来源等级以各案例声明为准。', objects: [], payload: result }
}

export async function prepareLocalWorkCase(input: Record<string, PluginJson>, context: PluginToolContext): Promise<PluginToolResult> {
  if (!context.projectIntegration) throw new Error('案例宿主接口不可用')
  const result = await context.projectIntegration.request('validate_work_case', {
    caseId: input.caseId, version: input.version, root_hash: input.rootHash,
  }) as Record<string, PluginJson>
  if (result.status !== 'ready' || result.requires_confirmation !== true) throw new Error('案例尚未通过宿主校验')
  return localWorkCaseResult(result.candidate)
}
