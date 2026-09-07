import { workbenchActionId, workbenchRequest } from './project-workbench-api'

export type EngineeringTaskKind = 'code_change' | 'bug_fix' | 'test' | 'documentation'
export type EngineeringProfile = {
  id: number; name: string; adapter: string; enabled: boolean
  last_probe?: { available?: boolean; authenticated?: boolean; message?: string }
}
export type EngineeringRun = {
  id: number; project_id: number; checkpoint_id?: number; session_id?: number
  status: string; goal: string; task_type: string; snapshot_hash: string; result_hash?: string
  manifest?: { included: Record<string, { sha256: string; size: number; is_text?: boolean }>; skipped?: unknown[]; summary?: Record<string, unknown> }
  changed_files: Array<{ path: string; change?: string; kind?: string; old_path?: string; destination_path?: string; operation?: string; status?: string }>
  diff_text: string; result: Record<string, unknown>; error?: Record<string, unknown>
  learning_evidence: false
}
export type EngineeringEvent = { sequence: number; event_type: string; payload: Record<string, unknown> }
const base = (projectId: number) => `/api/projects/${projectId}/local-agent`
export const listEngineeringProfiles = (id: number) => workbenchRequest<{ profiles: EngineeringProfile[] }>(`${base(id)}/profiles`)
export const createEngineeringProfile = (id: number, executable_path: string) => workbenchRequest<EngineeringProfile>(`${base(id)}/profiles`, 'POST', {
  name: '项目工程助手', ...(executable_path.trim() ? { executable_path: executable_path.trim() } : {}), client_request_id: workbenchActionId('profile'),
})
export const updateEngineeringProfile = (id: number, profile: EngineeringProfile, executable_path: string) => workbenchRequest<EngineeringProfile>(`${base(id)}/profiles/${profile.id}`, 'PUT', {
  name: profile.name, executable_path: executable_path.trim() || 'codex', enabled: true, client_request_id: workbenchActionId('profile-update'),
})
export const listEngineeringRuns = (id: number) => workbenchRequest<{ runs: EngineeringRun[] }>(`${base(id)}/runs`)
export const readEngineeringRun = (id: number, runId: number) => workbenchRequest<EngineeringRun>(`${base(id)}/runs/${runId}`)
export const readEngineeringEvents = (id: number, runId: number, after: number) => workbenchRequest<{ events: EngineeringEvent[]; next_sequence: number }>(`${base(id)}/runs/${runId}/events?after=${after}`)
export const previewEngineeringRun = (id: number, input: { goal: string; task_type: EngineeringTaskKind; constraints: string[]; checkpoint_id?: number; session_id?: number }) => workbenchRequest<EngineeringRun>(`${base(id)}/runs/preview`, 'POST', {
  ...input, required_capabilities: input.task_type === 'test' ? ['test'] : ['code_edit'], client_request_id: workbenchActionId('engineering'),
})
export const confirmEngineeringRun = (id: number, run: EngineeringRun) => workbenchRequest<EngineeringRun>(`${base(id)}/runs/${run.id}/confirm`, 'POST', {
  snapshot_hash: run.snapshot_hash, confirm_run: true, idempotency_key: `engineering-start:${run.id}:${run.snapshot_hash}`,
})
export const cancelEngineeringRun = (id: number, run: EngineeringRun) => workbenchRequest<EngineeringRun>(`${base(id)}/runs/${run.id}/cancel`, 'POST', { idempotency_key: `engineering-cancel:${run.id}` })
export const applyEngineeringRun = (id: number, run: EngineeringRun, deletions: string[], moves: string[]) => workbenchRequest<EngineeringRun>(`${base(id)}/runs/${run.id}/apply`, 'POST', {
  snapshot_hash: run.snapshot_hash, result_hash: run.result_hash, confirm_apply: true,
  confirmed_deletions: deletions, confirmed_moves: moves, idempotency_key: `engineering-apply:${run.id}:${run.result_hash}`,
})
