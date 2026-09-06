import { runtimeFetch } from './runtime-client.ts'
import type { ProjectBrief, ProjectMode } from './project'

export type ArtifactReference = { kind: string; ref: string; revision?: string }
export type ProjectPaper = { id: string; title: string; kind: 'note' | 'question' | 'hypothesis' | 'reflection'; body: string; artifact_ref?: ArtifactReference }
export type WorkbenchState = {
  active_tab: string; papers: ProjectPaper[]; open_files: string[]
  delivery_drafts?: Record<string, { answers: Record<string, string>; artifact_refs: ArtifactReference[]; assistance_level: string }>
  active_checkpoint_id?: number | null; active_file?: string; active_paper_id?: string
}
export type MilestoneFeedback = { accepted: boolean; checks: Array<{ key: string; label: string; passed: boolean; detail: string }>; review_required: boolean; summary: string; mastery_inference: false }
export type WorkflowMilestone = {
  checkpoint_id: number; key: string; title: string; objective: string; status: 'available' | 'locked' | 'accepted'
  materials: Array<{ id: string; title: string; body: string }>
  fields: Array<{ key: string; label: string; kind: 'text' | 'textarea'; placeholder?: string }>
  required_artifacts: boolean; hint_levels?: number; hints_used?: Array<{ level: number; body: string }>
  submission?: { id: number; answers: Record<string, string>; artifact_refs?: ArtifactReference[]; feedback: MilestoneFeedback; assistance_level: string; created_at: string }
}
export type PracticeCaseSummary = { id: string; version: string; root_hash: string; title: string; summary: string; provenance: Record<string, unknown>; estimated_minutes: number }
export type ProjectWorkflow = {
  schema_version: 'learnflow.project-workflow.v1'; project_mode: ProjectMode; revision: number; initialized: boolean
  brief: ProjectBrief; workbench: WorkbenchState; milestones: WorkflowMilestone[]
  case_ref?: { id: string; version: string; root_hash: string; title: string; provenance: Record<string, unknown> }
  reading_records: Array<{ id: number; source_id: number; source_version_id: number; locator: string; notes: string; created_at: string }>
  activity: Array<Record<string, unknown>>; mastery_inference: false
}
export class WorkbenchRequestError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}
export function workbenchActionId(prefix = 'workbench') { return `${prefix}:${crypto.randomUUID()}` }
export async function workbenchRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await runtimeFetch(path, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = payload.detail
    const message = typeof detail === 'string' ? detail : detail?.message || detail?.detail || (Array.isArray(detail) ? detail.map(item => item.msg).join('；') : `请求失败 (${response.status})`)
    throw new WorkbenchRequestError(message, response.status)
  }
  return payload as T
}
const workflowPath = (id: number) => `/api/vnext-projects/${id}`
export const loadProjectWorkflow = (id: number) => workbenchRequest<ProjectWorkflow>(`${workflowPath(id)}/workflow`)
export const listPracticeCases = () => workbenchRequest<{ cases: PracticeCaseSummary[] }>('/api/practice-cases')
export const loadPracticeCase = (id: string) => workbenchRequest<PracticeCaseSummary & { starter_files: Array<{ path: string; content: string }> }>(`/api/practice-cases/${encodeURIComponent(id)}`)
export const initializeProjectWorkflow = (id: number, selected?: PracticeCaseSummary) => workbenchRequest<ProjectWorkflow>(`${workflowPath(id)}/workflow/initialize`, 'POST', { client_action_id: workbenchActionId('initialize'), ...(selected ? { case_id: selected.id, case_version: selected.version, case_root_hash: selected.root_hash } : {}) })
export const saveProjectWorkbench = (id: number, revision: number, workbench: WorkbenchState) => workbenchRequest<ProjectWorkflow>(`${workflowPath(id)}/workbench`, 'PUT', { expected_revision: revision, client_action_id: workbenchActionId('layout'), workbench })
export const deliverProjectMilestone = (id: number, checkpointId: number, answers: Record<string, string>, artifact_refs: ArtifactReference[], assistance_level: string) => workbenchRequest<ProjectWorkflow>(`${workflowPath(id)}/checkpoints/${checkpointId}/deliver`, 'POST', { client_action_id: workbenchActionId('deliver'), answers, artifact_refs, assistance_level })
export const saveProjectReading = (id: number, record: { source_id: number; source_version_id: number; locator: string; notes: string }) => workbenchRequest<ProjectWorkflow>(`${workflowPath(id)}/reading`, 'POST', { ...record, client_action_id: workbenchActionId('reading') })

export type WorkspaceNode = { name: string; path: string; kind: string; is_directory: boolean; size?: number; children?: WorkspaceNode[]; protected_reason?: string }
export type WorkspaceFile = { path: string; kind: string; content: string | null; sha256: string; size: number; read_only: boolean; modified_at: string }
export type WorkspaceTree = { workspace_id: number; project_id: number; root_name: string; nodes: WorkspaceNode[] }
const filesPath = (id: number) => `/api/projects/${id}/workspace`
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')
export const loadWorkspaceTree = (id: number) => workbenchRequest<WorkspaceTree>(`${filesPath(id)}/tree`)
export const linkProjectDirectory = (id: number, root_path: string, create: boolean) => workbenchRequest(`${filesPath(id)}/link`, 'POST', { root_path, create, platform: navigator.platform, client_request_id: workbenchActionId('link') })
export const readProjectFile = (id: number, path: string) => workbenchRequest<WorkspaceFile>(`${filesPath(id)}/files/${encodePath(path)}`)
export const writeProjectFile = (id: number, path: string, content: string, base_hash: string | null) => workbenchRequest(`${filesPath(id)}/files/${encodePath(path)}`, 'PUT', { content, base_hash, idempotency_key: workbenchActionId('write') })
export const revealProjectFile = (id: number, path: string, open = false) => workbenchRequest(`${filesPath(id)}/${open ? 'open' : 'reveal'}`, 'POST', { path })

export type ExperimentAction = 'syntax' | 'build' | 'run' | 'verify'
export type ExperimentProfile = { id: string; name: string; available: boolean; compiler?: string; actions: ExperimentAction[]; warning?: string }
export type ExperimentRun = {
  id: number; project_id: number; checkpoint_id?: number; profile_id: string; action: ExperimentAction; status: string; snapshot_hash: string
  manifest: Array<{ path: string; sha256: string; size: number }>; created_at?: string
  request: Record<string, unknown>
  result: { warning?: string; passed?: boolean | null; steps?: Array<{ name: string; command: string[]; stdout: string; stderr: string; exit_code: number; timed_out?: boolean; output_limited?: boolean; passed?: boolean }>; error?: string }
}
export type ExperimentRunInput = { profile_id: string; action: ExperimentAction; files: string[]; stdin: string; args: string[]; test_cases: Array<{ name: string; stdin: string; expected_stdout: string }>; checkpoint_id?: number }
const runsPath = (id: number) => `/api/projects/${id}/experiments`
export const listExperimentProfiles = (id: number) => workbenchRequest<{ profiles: ExperimentProfile[] }>(`${runsPath(id)}/profiles`)
export const listExperimentRuns = (id: number) => workbenchRequest<{ runs: ExperimentRun[] }>(`${runsPath(id)}/runs`)
export const previewExperimentRun = (id: number, request: ExperimentRunInput) => workbenchRequest<ExperimentRun>(`${runsPath(id)}/runs/preview`, 'POST', { ...request, client_request_id: workbenchActionId('experiment') })
export const confirmExperimentRun = (id: number, run: ExperimentRun) => workbenchRequest<ExperimentRun>(`${runsPath(id)}/runs/${run.id}/confirm`, 'POST', { snapshot_hash: run.snapshot_hash, acknowledge_trusted_local: true })
export const loadExperimentRun = (id: number, runId: number) => workbenchRequest<ExperimentRun>(`${runsPath(id)}/runs/${runId}`)

export const validatePracticeCase = (selected: PracticeCaseSummary) => workbenchRequest<{ status: string; candidate: unknown; requires_confirmation: boolean }>(`/api/practice-cases/${encodeURIComponent(selected.id)}/validate`, 'POST', { version: selected.version, root_hash: selected.root_hash })
export const requestMilestoneHint = (id: number, checkpoint: number, level: 1 | 2) => workbenchRequest<{ hint: { level: number; body: string }; workflow: ProjectWorkflow }>(`${workflowPath(id)}/checkpoints/${checkpoint}/hint`, 'POST', { client_action_id: workbenchActionId('hint'), level })
