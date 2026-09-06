import type { LearningEvent, LearningSkillId } from './learning'
import type {
  LearningPathPlan,
  LearningPathPlanProposal,
  LearnerPathState,
  LearnerPathStatus,
  PersonalPathNodeProposal,
} from './learning-path-graph'
import type { PlanningEvent, ValueClaimProposal } from './planning'
import type { FormalProjectWorkspace, ProjectRoadmapProposal, ProjectMode, ProjectBrief } from './project'
import {
  activateRuntimeAuth,
  captureRuntimeAuth,
  clearRuntimeAuth,
  runtimeFetch,
} from './runtime-client.ts'

export type KernelName = 'structure' | 'knowledge' | 'human' | 'value' | 'practice'
export type FormalRuntimeStatus = 'connecting' | 'connected' | 'offline' | 'auth_required'

export type FormalLearner = {
  id: number
  display_name: string
  education_stage: string
}

export type FormalKernelMemory = {
  memory_id: string
  title: string
  summary: string
  retention: 'long' | 'recent'
  retention_label: string
  source_kind: string
  source_label: string
  related_record_count: number
  updated_at?: string | null
  status: 'active' | 'archived'
}

export type FormalGrowthArea = {
  id: string
  title: string
  description?: string
  active_count: number
  memories: FormalKernelMemory[]
}

export type FormalClaim = {
  id: number
  text: string
  status: string
  confidence: number
  predicate: string
  verification_status: string
}

export type FormalMemoryModule = {
  id: number
  kernel: KernelName
  subject_key: string
  title: string
  summary: string
  version: number
  revision_kind: string
  evidence_fact_ids: number[]
  claims: FormalClaim[]
}

export type FormalLearningTask = {
  id: number
  title: string
  objective: string
  status: 'proposed' | 'queued' | 'active' | 'paused' | 'completed' | 'canceled'
  origin_kind: string
  session_id?: number | null
  project_id?: number | null
  checkpoint_id?: number | null
  priority: number
  queue_position: number
  estimated_minutes: number
  preferred_skills?: string[]
  source_refs: Array<Record<string, unknown>>
  artifact_refs: Array<Record<string, unknown>>
  success_criteria: string[]
  plan: {
    schema_version?: string
    phases?: Array<{ id: string; title?: string; kind?: string; status?: string; required?: boolean }>
  }
  current_phase_id: string
  navigation?: { kind: string; path: string }
  origin_navigation?: { kind: string; path: string }
  management_navigation?: { kind: string; path: string }
  available_actions: string[]
  version: number
  created_at?: string | null
  updated_at?: string | null
}

export type FormalKnowledgeSource = {
  id: number
  type: 'file' | 'url' | 'github'
  name: string
  url: string
  status: 'pending' | 'processing' | 'processed' | 'failed'
  error: string
  chunk_count: number
  knowledge_domains: Array<{ label: string; evidence: string; summary?: string }>
  format?: {
    registry_version?: string
    format_id?: string
    format_label?: string
    content_type?: string
    size_bytes?: number
    previewable?: boolean
    extractable?: boolean
    source_eligible?: boolean
    execution_performed?: false
    warnings?: string[]
    counters?: Record<string, number>
  }
  created_at?: string | null
  mastery_inference: false
}

export type FormalSourcePaper = FormalKnowledgeSource & {
  project_id: number
  sections: Array<{
    chunk_id: number
    index: number
    title: string
    content: string
    provenance: { source_id: number; chunk_id: number; chunk_index: number }
  }>
  content_truncated: boolean
  trust_boundary: string
}

export type FormalLearningFileRef = {
  kind: 'lecture' | 'practice'
  practice_kind?: 'exercise' | 'concept_question_set'
  ref: string
  id?: number
  title: string
  logical_filename: string
  project_id?: number
  checkpoint_id: number
  path: string
  question_count?: number
}

export type FormalLearningSkillRun = {
  id: number
  skill: { id: LearningSkillId; name: string; description?: string }
  goal: string
  status: string
  state: string
  stage_label: string
  step_index: number
  total_steps: number
  turn_count: number
  turn_budget: number
  support_count: number
  gap_loop_count: number
  calibration: Record<string, string>
  calibration_axes: Array<{
    id: string
    title: string
    description: string
    default: string
    options: Array<{ id: string; label: string }>
  }>
  teach_back_diagnostic: {
    schema_version?: string
    learner_wording?: string
    candidate_gap?: string
    candidate_gap_label?: string
    status?: string
    verification?: string
    mastery_inference?: boolean
  }
  flow_note: string
  version: number
  next_prompt: string
  can_start_verification: boolean
  can_pause: boolean
  can_resume: boolean
  learning_task?: {
    id: number
    title: string
    status: string
    current_phase_id: string
    plan_version: number
    version: number
    path?: string | null
    management_path?: string | null
    artifact_path?: string | null
  } | null
  micro_learning_run?: {
    id: number
    goal: string
    status: string
    state: string
    version: number
  } | null
}

export type FormalTutorSession = {
  id: number
  title: string
  session_type: 'global' | 'project' | 'checkpoint'
  project_id?: number | null
  checkpoint_id?: number | null
  client_conversation_id?: string
  vnext_managed?: boolean
  vnext_mode?: 'free' | 'simple_explain' | 'guided_learning' | 'learning_plan'
  plugin_ids?: string[]
  role_package_binding?: Record<string, unknown> | null
  chat_mode?: { id?: 'free' | 'explain' | 'learn' | 'plan'; status?: string }
  messages?: FormalTutorMessage[]
  created_at?: string | null
  updated_at?: string | null
  active_skill_run?: FormalLearningSkillRun | null
  learning_tasks: FormalLearningTask[]
}

export type FormalTutorMessage = {
  id: number
  role: 'assistant' | 'user' | 'system'
  content: string
  meta_data?: {
    client_message_id?: string
    vnext?: Record<string, unknown>
    [key: string]: unknown
  }
  created_at?: string | null
}

export type FormalTutorSessionSummary = Pick<FormalTutorSession,
  'id' | 'title' | 'session_type' | 'project_id' | 'checkpoint_id' |
  'client_conversation_id' | 'vnext_managed' | 'vnext_mode' | 'chat_mode' |
  'created_at' | 'updated_at'
> & { last_message?: string }

export type FormalPathOverlay = {
  version: 1 | 2
  statuses: Record<string, { status?: LearnerPathStatus; node_title?: string } | LearnerPathStatus>
  personal_nodes: Array<Record<string, unknown>>
  plans?: Array<Record<string, unknown>>
  active_plan_id?: string | null
  event_backed: true
  knowledge_mastery_inference: false
}

export type FormalConceptTimelineEntry = {
  fact_id: number
  event_id: number
  occurred_at: string
  event_type: string
  observation_type: string
  statement: string
  evidence_grade: string
  verification: string
  source_tag: string
  raw_text: string
  question_ref: Record<string, unknown>
  mastery_inference: boolean | null
  correctable: boolean
}

export type FormalConceptEvidenceClaim = {
  claim_id: number
  statement: string
  predicate: string
  verification_status: string
  status: string
  confidence: number
  module_version: number
  evidence_fact_ids: number[]
}

export type FormalConceptNode = {
  concept_key: string
  name: string
  aliases: string[]
  origin: string
  official_node_id?: string | null
  knowledge_event_count: number
  structure_relation_count: number
  knowledge: {
    timeline: FormalConceptTimelineEntry[]
    latest_observation?: FormalConceptTimelineEntry | null
    evidence_grades: string[]
    verified_count: number
    self_reported_count: number
    claims: FormalConceptEvidenceClaim[]
    current_state: {
      status: string
      certain_claims: FormalConceptEvidenceClaim[]
      uncertain_observations: FormalConceptTimelineEntry[]
      conflicts: FormalConceptTimelineEntry[]
    }
    mastery_claim: FormalConceptEvidenceClaim | null
  }
}

export type FormalConceptEdge = {
  id: string
  source_key: string
  target_key: string
  relation_type: string
  label: string
  rationale: string
  evidence_event_id: number
  verification: string
  source_tag: string
  mastery_inference: false
}

export type FormalConceptGraph = {
  version: string
  authority: string
  nodes: FormalConceptNode[]
  edges: FormalConceptEdge[]
  manifest: {
    node_count: number
    edge_count: number
    knowledge_owns_node_history: true
    structure_owns_relations: true
    shared_identity_only: true
    official_course_graph_is_separate: true
    self_report_never_implies_mastery: true
    truncated_at_fact_count: number
  }
}

export type FormalLearnerSnapshot = {
  authority: string
  learner: FormalLearner
  profile: {
    background: string
    focus_areas: string[]
    weekly_hours: number
    preferred_modes: string[]
    career_goal: string
    career_goal_status: string
  }
  kernels: Record<KernelName, { short_term: Record<string, unknown>; long_term: Record<string, unknown>; confidence: number; evidence_refs: unknown[] }>
  growth: {
    overview: Record<string, unknown>
    stats: Record<string, number>
    areas: FormalGrowthArea[]
    evidence: Array<Record<string, unknown>>
  }
  modules: FormalMemoryModule[]
  concept_graph: FormalConceptGraph
  learning_path: FormalPathOverlay
  learning_tasks: FormalLearningTask[]
}

export type FormalLearnerProfilePatch = Partial<FormalLearnerSnapshot['profile']>

export type FormalRuntimeConnection = {
  status: FormalRuntimeStatus
  detail: string
  learner?: FormalLearner
}

export type FormalAuthenticatedProfile = {
  education_stage: string
  background: string
  focus_areas: string[]
  weekly_hours: number
  preferred_modes: string[]
  career_goal: string
  career_goal_status: string
}

export type FormalAccount = {
  id: number
  account_number: number
  username: string
  display_name: string
  learner_id: number
  role: 'user' | 'admin'
  status: string
  must_change_password: boolean
  is_legacy_demo: boolean
  profile: FormalAuthenticatedProfile
  dev_test_login_enabled: boolean
  is_dev_login: boolean
  desktop_auth_token?: string
  desktop_pet_capability_token?: string
}

export type FormalAuthStatus = {
  authenticated: false
  dev_test_login_enabled?: boolean
} | ({ authenticated: true } & FormalAccount)

export type FormalDemoStatus = {
  enabled: boolean
  offline: boolean
}

export type FormalRegistrationInput = {
  username: string
  password: string
  display_name: string
  education_stage: 'middle_school' | 'high_school' | 'undergraduate' | 'graduate' | 'working' | 'other'
  background: string
  focus_areas: string[]
  weekly_hours: number
  preferred_modes: string[]
  career_goal?: string
  career_goal_status?: 'exploring' | 'confirmed'
}

export type FormalDevAccount = {
  id: number
  account_number: number
  username: string
  display_name: string
  role: 'user' | 'admin'
  last_login_at?: string | null
  is_legacy_demo?: boolean
}

export type FormalModelCredentialMetadata = {
  configured: boolean
  key_hint: string
  updated_at?: string | null
  base_url: string
  model: string
}

export type FormalVisionCredentialMetadata = {
  configured: boolean
  uses_tutor_key: boolean
  key_hint: string
  updated_at?: string | null
  base_url: string
  model: string
}

export type FormalModelCredentialTestResult = {
  status: 'ok'
  model: string
  latency_ms: number
}

export type FormalAdminAccount = {
  account_number: number
  username: string
  display_name: string
  role: 'user' | 'admin'
  status: string
  created_at?: string | null
  updated_at?: string | null
  last_login_at?: string | null
  project_count: number
  api_key_configured: boolean
}

function errorText(payload: unknown, fallback: string) {
  if (payload && typeof payload === 'object') {
    const detail = (payload as Record<string, unknown>).detail || (payload as Record<string, unknown>).error
    if (typeof detail === 'string' && detail.trim()) return detail
    if (Array.isArray(detail)) {
      const messages = detail.flatMap(item => item && typeof item === 'object'
        && typeof (item as Record<string, unknown>).msg === 'string'
        ? [String((item as Record<string, unknown>).msg).replace(/^Value error,\s*/i, '')]
        : [])
      if (messages.length > 0) return messages.join('；')
    }
  }
  return fallback
}

export class FormalRequestError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'FormalRequestError'
    this.status = status
  }
}

async function jsonRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await runtimeFetch(url, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  })
  const text = await response.text()
  let payload: unknown = null
  try { payload = text ? JSON.parse(text) : null } catch { payload = text }
  captureRuntimeAuth(payload)
  if (!response.ok) {
    if (response.status === 401) identityInitialization = undefined
    throw new FormalRequestError(response.status, errorText(payload, `请求失败（${response.status}）`))
  }
  return payload as T
}

async function formRequest<T>(url: string, form: FormData): Promise<T> {
  const response = await runtimeFetch(url, { method: 'POST', body: form, credentials: 'include' })
  const text = await response.text()
  let payload: unknown = null
  try { payload = text ? JSON.parse(text) : null } catch { payload = text }
  captureRuntimeAuth(payload)
  if (!response.ok) {
    if (response.status === 401) identityInitialization = undefined
    throw new FormalRequestError(response.status, errorText(payload, `请求失败（${response.status}）`))
  }
  return payload as T
}

export async function listFormalDevAccounts() {
  return jsonRequest<FormalDevAccount[]>('/api/dev/accounts')
}

let identityInitialization: Promise<FormalAccount> | undefined
let demoLoginInitialization: Promise<FormalAccount> | undefined

export function activateFormalIdentity(account: FormalAccount) {
  activateRuntimeAuth(account)
  identityInitialization = Promise.resolve(account)
  return account
}

export function invalidateFormalIdentity(clearRuntime = true) {
  identityInitialization = undefined
  demoLoginInitialization = undefined
  if (clearRuntime) clearRuntimeAuth()
}

export async function getFormalAuthStatus() {
  return jsonRequest<FormalAuthStatus>('/api/auth/status')
}

export async function getFormalDemoStatus() {
  return jsonRequest<FormalDemoStatus>('/api/demo/status')
}

export function loginFormalDemoAccount() {
  if (!demoLoginInitialization) {
    clearRuntimeAuth()
    demoLoginInitialization = jsonRequest<FormalAccount>('/api/demo/login', { method: 'POST' })
      .then(activateFormalIdentity)
      .catch(error => {
        demoLoginInitialization = undefined
        throw error
      })
  }
  return demoLoginInitialization
}

export async function loginFormalAccount(username: string, password: string) {
  demoLoginInitialization = undefined
  clearRuntimeAuth()
  const account = await jsonRequest<FormalAccount>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  return activateFormalIdentity(account)
}

export async function registerFormalAccount(input: FormalRegistrationInput) {
  demoLoginInitialization = undefined
  clearRuntimeAuth()
  const account = await jsonRequest<FormalAccount>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return activateFormalIdentity(account)
}

export async function loginFormalDevAccount(accountId: number) {
  demoLoginInitialization = undefined
  clearRuntimeAuth()
  const account = await jsonRequest<FormalAccount>(`/api/dev/accounts/${accountId}/login`, { method: 'POST' })
  return activateFormalIdentity(account)
}

export async function logoutFormalAccount() {
  await jsonRequest<{ status: 'ok' }>('/api/auth/logout', { method: 'POST' })
  invalidateFormalIdentity()
}

export async function loadFormalModelCredential() {
  return jsonRequest<FormalModelCredentialMetadata>('/api/auth/model-credential')
}

export async function saveFormalModelCredential(apiKey: string, baseUrl = '', model = '') {
  const body: Record<string, string> = { api_key: apiKey }
  if (baseUrl.trim()) body.base_url = baseUrl
  if (model.trim()) body.model = model
  return jsonRequest<FormalModelCredentialMetadata>('/api/auth/model-credential', {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function deleteFormalModelCredential() {
  return jsonRequest<FormalModelCredentialMetadata>('/api/auth/model-credential', {
    method: 'DELETE',
  })
}

export async function testFormalModelCredential(baseUrl: string, model: string) {
  return jsonRequest<FormalModelCredentialTestResult>('/api/auth/model-credential/test', {
    method: 'POST',
    body: JSON.stringify({ base_url: baseUrl, model }),
  })
}

export async function loadFormalVisionCredential() {
  return jsonRequest<FormalVisionCredentialMetadata>('/api/auth/vision-credential')
}

export async function saveFormalVisionCredential(input: {
  apiKey: string
  baseUrl: string
  model: string
  useTutorKey: boolean
}) {
  return jsonRequest<FormalVisionCredentialMetadata>('/api/auth/vision-credential', {
    method: 'PUT',
    body: JSON.stringify({
      api_key: input.apiKey,
      base_url: input.baseUrl,
      model: input.model,
      use_tutor_key: input.useTutorKey,
    }),
  })
}

export async function deleteFormalVisionCredential() {
  return jsonRequest<FormalVisionCredentialMetadata>('/api/auth/vision-credential', {
    method: 'DELETE',
  })
}

export async function testFormalVisionCredential() {
  return jsonRequest<FormalModelCredentialTestResult>('/api/auth/vision-credential/test', {
    method: 'POST',
  })
}

export async function listFormalAdminAccounts() {
  const accounts = await jsonRequest<FormalAdminAccount[]>('/api/admin/accounts')
  return accounts.map(account => ({
    account_number: account.account_number,
    username: account.username,
    display_name: account.display_name,
    role: account.role,
    status: account.status,
    created_at: account.created_at,
    updated_at: account.updated_at,
    last_login_at: account.last_login_at,
    project_count: account.project_count,
    api_key_configured: account.api_key_configured,
  }))
}

async function ensureFormalIdentity() {
  if (!identityInitialization) {
    identityInitialization = getFormalAuthStatus()
      .then(status => {
        if (!status.authenticated) throw new FormalRequestError(401, '请先登录')
        activateRuntimeAuth(status)
        return status
      })
      .catch(error => {
        identityInitialization = undefined
        throw error
      })
  }
  return identityInitialization
}

export async function loadFormalLearnerSnapshot(includeTerminalTasks = false): Promise<FormalLearnerSnapshot> {
  await ensureFormalIdentity()
  return jsonRequest<FormalLearnerSnapshot>(`/api/learner-state/snapshot?include_terminal_tasks=${includeTerminalTasks ? 'true' : 'false'}`)
}

export async function updateFormalLearnerProfile(patch: FormalLearnerProfilePatch) {
  return jsonRequest<{ profile: FormalLearnerSnapshot['profile']; evidence_id: number }>('/api/profile', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export async function bootstrapFormalRuntime(): Promise<{ connection: FormalRuntimeConnection; snapshot?: FormalLearnerSnapshot }> {
  try {
    const snapshot = await loadFormalLearnerSnapshot()
    return {
      connection: { status: 'connected', detail: snapshot.authority, learner: snapshot.learner },
      snapshot,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : '正式后端暂不可用'
    return {
      connection: {
        status: error instanceof FormalRequestError && error.status === 401 ? 'auth_required' : 'offline',
        detail,
      },
    }
  }
}

export async function syncFormalEvent(event: LearningEvent | PlanningEvent | {
  id: string
  type: 'chat_mode_entered' | 'learning_action_segment_completed' | 'vnext_human_adaptation_requested' | 'vnext_planning_profile_self_reported' | 'vnext_teaching_input_received'
  at: number
  detail: string
  payload?: Record<string, unknown>
}) {
  const explicitScope = 'payload' in event && event.payload && typeof event.payload === 'object'
    ? event.payload as Record<string, unknown>
    : {}
  const payload: Record<string, unknown> = {
    detail: event.detail,
    ...('taskId' in event ? { local_task_id: event.taskId } : {}),
    ...('planId' in event ? { local_plan_id: event.planId } : {}),
    ...('skillId' in event && event.skillId ? { skill_id: event.skillId } : {}),
    ...('stepId' in event && event.stepId ? { step_id: event.stepId } : {}),
    ...('signals' in event && event.signals ? { signals: event.signals } : {}),
    ...('valueProposal' in event && event.valueProposal ? { value_proposal: event.valueProposal } : {}),
    ...('payload' in event && event.payload ? event.payload : {}),
  }
  return jsonRequest<{ event_id: number; learner_seq: number }>('/api/learner-state/events', {
    method: 'POST',
    body: JSON.stringify({
      event_type: event.type,
      client_event_id: event.id,
      occurred_at: new Date(event.at).toISOString(),
      session_id: typeof explicitScope.session_id === 'number' ? explicitScope.session_id : undefined,
      project_id: typeof explicitScope.project_id === 'number' ? explicitScope.project_id : undefined,
      checkpoint_id: typeof explicitScope.checkpoint_id === 'number' ? explicitScope.checkpoint_id : undefined,
      payload,
    }),
  })
}

/** Only direct learner text enters this evidence event; never attach tool context. */
export async function syncFormalTeachingInput(input: {
  messageId: string
  text: string
  occurredAt: number
  sessionId?: number
  projectId?: number
  checkpointId?: number
}) {
  return syncFormalEvent({
    id: `teaching-input:${input.messageId}`,
    type: 'vnext_teaching_input_received',
    at: input.occurredAt,
    detail: '学习者本轮直接输入',
    payload: {
      text: input.text,
      session_id: input.sessionId,
      project_id: input.projectId,
      checkpoint_id: input.checkpointId,
    },
  })
}

export async function syncFormalEvents(events: Array<LearningEvent | PlanningEvent>) {
  // EvidenceEvent.learner_seq is monotonic per learner. Serializing a local
  // batch avoids racing two `max(sequence) + 1` writes against the same
  // learner while preserving the exact event order for deterministic replay.
  for (const event of events) await syncFormalEvent(event)
}

export async function setFormalPathStatus(nodeId: string, nodeTitle: string, status: LearnerPathStatus, clientEventId: string) {
  return jsonRequest<{ learning_path: FormalPathOverlay }>('/api/learner-state/learning-path/status', {
    method: 'POST',
    body: JSON.stringify({ node_id: nodeId, node_title: nodeTitle, status, client_event_id: clientEventId }),
  })
}

export async function addFormalPersonalPathNode(proposal: PersonalPathNodeProposal, clientEventId: string) {
  const node = {
    id: proposal.id,
    title: proposal.title,
    summary: proposal.summary,
    aliases: proposal.aliases,
    domains: proposal.domains,
    stage: proposal.stage,
    order: proposal.order,
    origin: 'personal',
    sourceRefs: proposal.sourceUrls,
  }
  const edges = proposal.connections.map((connection, index) => ({
    id: `personal-edge:${proposal.id}:${connection.nodeId}:${index}`,
    from: connection.kind === 'co_learning' ? proposal.id : connection.nodeId,
    to: connection.kind === 'co_learning' ? connection.nodeId : proposal.id,
    kind: connection.kind,
    rationale: connection.rationale,
    origin: 'personal',
  }))
  return jsonRequest<{ learning_path: FormalPathOverlay }>('/api/learner-state/learning-path/personal-nodes', {
    method: 'POST',
    body: JSON.stringify({ node, edges, reason: '学习者确认加入个人学习路径', client_event_id: clientEventId }),
  })
}

export async function removeFormalPersonalPathNode(nodeId: string, nodeTitle: string, clientEventId: string) {
  const query = new URLSearchParams({ client_event_id: clientEventId, node_title: nodeTitle })
  return jsonRequest<{ learning_path: FormalPathOverlay }>(`/api/learner-state/learning-path/personal-nodes/${encodeURIComponent(nodeId)}?${query}`, {
    method: 'DELETE',
  })
}

export async function commitFormalLearningPathPlan(proposal: LearningPathPlanProposal, clientEventId: string) {
  return jsonRequest<{ learning_path: FormalPathOverlay }>('/api/learner-state/learning-path/plans', {
    method: 'POST',
    body: JSON.stringify({
      plan_id: proposal.id,
      title: proposal.title,
      objective: proposal.objective,
      horizon: proposal.horizon,
      target_node_ids: proposal.targetNodeIds,
      route_node_ids: proposal.routeNodeIds,
      milestone_node_ids: proposal.milestoneNodeIds,
      rationale: proposal.rationale,
      evidence_quote: proposal.evidenceQuote,
      source_plan_id: proposal.sourcePlanId || '',
      client_event_id: clientEventId,
    }),
  })
}

export async function archiveFormalLearningPathPlan(planId: string, clientEventId: string) {
  const query = new URLSearchParams({ client_event_id: clientEventId })
  return jsonRequest<{ learning_path: FormalPathOverlay }>(`/api/learner-state/learning-path/plans/${encodeURIComponent(planId)}?${query}`, {
    method: 'DELETE',
  })
}

export async function confirmFormalValueClaim(proposal: ValueClaimProposal, clientEventId: string) {
  return jsonRequest<{ event_id: number; status: string }>('/api/learner-state/value-claims/confirm', {
    method: 'POST',
    body: JSON.stringify({
      proposal_id: proposal.id,
      current_claim: proposal.currentClaim,
      proposed_claim: proposal.proposedClaim,
      evidence_quote: proposal.evidenceQuote,
      scope: proposal.scope,
      client_event_id: clientEventId,
    }),
  })
}

export async function recordFormalConceptStatement(rawText: string, clientEventId: string) {
  return jsonRequest<{
    statement_event_id: number
    knowledge_event_ids: number[]
    structure_event_ids: number[]
    extracted: { concepts: Array<Record<string, unknown>>; relations: Array<Record<string, unknown>> }
    concept_graph: FormalConceptGraph
  }>('/api/learner-state/concept-graph/statements', {
    method: 'POST',
    body: JSON.stringify({
      raw_text: rawText,
      source_tag: 'user_self_input',
      client_event_id: clientEventId,
    }),
  })
}

/** Native turn owns its own evidence write; an empty direct text excludes control/context. */
export async function requestFormalTutorTurn(sessionId: number, input: {
  message: string
  direct_user_text: string
  client_turn_id: string
  project_id?: number
  checkpoint_id?: number
  selected_skill_id?: string
  context?: Record<string, unknown>
}, signal?: AbortSignal) {
  return jsonRequest<{ message?: unknown }>(`/api/agent/sessions/${sessionId}/turns`, {
    method: 'POST', body: JSON.stringify(input), signal,
  })
}

export async function createFormalTutorSession(
  createNew = true,
  scope: {
    projectId?: number
    checkpointId?: number
    title?: string
    clientConversationId?: string
  } = {},
) {
  return jsonRequest<FormalTutorSession>('/api/agent/sessions', {
    method: 'POST',
    body: JSON.stringify({
      session_type: scope.checkpointId ? 'checkpoint' : scope.projectId ? 'project' : 'global',
      project_id: scope.projectId,
      checkpoint_id: scope.checkpointId,
      create_new: createNew,
      title: scope.title,
      client_conversation_id: scope.clientConversationId,
    }),
  })
}

export async function consumeFormalRolePackageLaunch(token: string, clientConversationId: string) {
  return jsonRequest<FormalTutorSession>('/api/agent/role-package-launches/consume', {
    method: 'POST',
    body: JSON.stringify({ token, client_conversation_id: clientConversationId }),
  })
}

export async function listFormalGlobalChatSessions() {
  const pageSize = 100
  const sessions: FormalTutorSessionSummary[] = []
  for (let offset = 0; ; offset += pageSize) {
    const page = await jsonRequest<FormalTutorSessionSummary[]>(
      `/api/agent/sessions?session_type=global&limit=${pageSize}&offset=${offset}`,
    )
    sessions.push(...page)
    if (page.length < pageSize) break
  }
  return sessions.filter(item => item.vnext_managed && item.client_conversation_id)
}

export type FormalGlobalChatHydration = {
  sessions: FormalTutorSession[]
  missingSessionIds: number[]
  unavailableSessionIds: number[]
}

/**
 * Load the complete server-authoritative global chat set. Browser-known ids that
 * are absent from the paginated active-session listing are deletion tombstones.
 * Individual load failures remain unavailable rather than being misclassified
 * as deletions, so the caller can preserve its local projection and retry later.
 */
export async function loadFormalGlobalChatsForHydration(
  knownSessionIds: number[] = [],
): Promise<FormalGlobalChatHydration> {
  const summaries = await listFormalGlobalChatSessions()
  const sessionIds = [...new Set(summaries.map(item => item.id))]
  const activeSessionIds = new Set(sessionIds)
  const loaded = await Promise.allSettled(sessionIds.map(loadFormalTutorSession))
  const sessions: FormalTutorSession[] = []
  const missingSessionIds = [...new Set(
    knownSessionIds.filter(item => Number.isInteger(item) && item > 0 && !activeSessionIds.has(item)),
  )]
  const unavailableSessionIds: number[] = []
  loaded.forEach((result, index) => {
    const sessionId = sessionIds[index]
    if (result.status === 'fulfilled') {
      if (result.value.vnext_managed && result.value.client_conversation_id) sessions.push(result.value)
      return
    }
    unavailableSessionIds.push(sessionId)
  })
  return { sessions, missingSessionIds, unavailableSessionIds }
}

export async function syncFormalGlobalChat(
  sessionId: number,
  conversation: {
    id: string
    title: string
    mode: 'free' | 'simple_explain' | 'guided_learning' | 'learning_plan'
    messages: Array<{
      id: string
      role: 'assistant' | 'user' | 'system'
      content: string
      createdAt: number
      metaData?: Record<string, unknown>
    }>
  },
) {
  return jsonRequest<FormalTutorSession>(`/api/agent/sessions/${sessionId}/vnext`, {
    method: 'PUT',
    body: JSON.stringify({
      client_conversation_id: conversation.id,
      title: conversation.title,
      mode: conversation.mode,
      messages: conversation.messages.map(message => ({
        client_message_id: message.id,
        role: message.role,
        content: message.content,
        created_at_ms: message.createdAt,
        meta_data: message.metaData || {},
      })),
    }),
  })
}

export async function syncFormalGlobalChatWithRecovery(
  sessionId: number | undefined,
  conversation: Parameters<typeof syncFormalGlobalChat>[1],
) {
  let activeSessionId = sessionId
  if (!activeSessionId) {
    const created = await createFormalTutorSession(true, {
      title: conversation.title,
      clientConversationId: conversation.id,
    })
    activeSessionId = created.id
  }
  try {
    return await syncFormalGlobalChat(activeSessionId, conversation)
  } catch (error) {
    if (!(error instanceof FormalRequestError) || error.status !== 404) throw error
    const replacement = await createFormalTutorSession(true, {
      title: conversation.title,
      clientConversationId: conversation.id,
    })
    return syncFormalGlobalChat(replacement.id, conversation)
  }
}

export async function deleteFormalTutorSession(sessionId: number) {
  return jsonRequest<{ status: string; id: number }>(`/api/agent/sessions/${sessionId}`, {
    method: 'DELETE',
  })
}

export async function listFormalProjects() {
  await ensureFormalIdentity()
  return jsonRequest<{ schema_version: string; projects: FormalProjectWorkspace['project'][] }>('/api/vnext-projects')
}

export async function createFormalProject(input: {
  name: string; objective: string; expectedOutcome: string; userLevel?: string; projectMode?: ProjectMode; projectBrief?: ProjectBrief
}) {
  await ensureFormalIdentity()
  return jsonRequest<FormalProjectWorkspace>('/api/vnext-projects', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      objective: input.objective,
      expected_outcome: input.expectedOutcome,
      user_level: input.userLevel || 'beginner',
      project_mode: input.projectMode || 'learning',
      project_brief: input.projectBrief || { deliverables: [], constraints: [], success_criteria: [] },
    }),
  })
}

export async function loadFormalProject(projectId: number) {
  await ensureFormalIdentity()
  return jsonRequest<FormalProjectWorkspace>(`/api/vnext-projects/${projectId}`)
}

export async function deleteFormalProject(projectId: number) {
  await ensureFormalIdentity()
  return jsonRequest<{ status: string; project_id: number }>(`/api/projects/${projectId}`, { method: 'DELETE' })
}

export async function applyFormalProjectRoadmap(projectId: number, proposal: ProjectRoadmapProposal) {
  await ensureFormalIdentity()
  return jsonRequest<FormalProjectWorkspace>(`/api/vnext-projects/${projectId}/roadmap/apply`, {
    method: 'POST',
    body: JSON.stringify({
      project_theme: proposal.project_theme,
      rationale: proposal.rationale,
      checkpoints: proposal.checkpoints,
      client_action_id: `vnext-project:${projectId}:roadmap:${Date.now()}`,
    }),
  })
}

export async function reviseFormalProjectRoadmap(projectId: number, proposal: ProjectRoadmapProposal) {
  await ensureFormalIdentity()
  if (proposal.operation !== 'revise' || !proposal.expected_revision) throw new Error('缺少正式路线修订版本')
  return jsonRequest<FormalProjectWorkspace>(`/api/vnext-projects/${projectId}/roadmap`, {
    method: 'PUT',
    body: JSON.stringify({
      project_theme: proposal.project_theme,
      rationale: proposal.rationale,
      checkpoints: proposal.checkpoints,
      expected_revision: proposal.expected_revision,
      client_action_id: `vnext-project:${projectId}:roadmap-revision:${proposal.expected_revision}:${Date.now()}`,
    }),
  })
}

export async function createFormalProjectFreeSession(projectId: number, title = '项目自由对话') {
  await ensureFormalIdentity()
  return jsonRequest<{ session_id: number; title: string; project_id: number; mode: 'free' }>(`/api/vnext-projects/${projectId}/sessions`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'free', title, client_action_id: `vnext-project:${projectId}:free:${Date.now()}` }),
  })
}

export async function addFormalProjectUrl(projectId: number, url: string) {
  await ensureFormalIdentity()
  return jsonRequest<{ id: number; status: string }>(`/api/projects/${projectId}/sources`, {
    method: 'POST', body: JSON.stringify({ type: 'url', url }),
  })
}

export async function uploadFormalProjectFile(projectId: number, file: File) {
  await ensureFormalIdentity()
  const form = new FormData()
  form.append('file', file)
  return formRequest<{ id: number; status: string }>(`/api/projects/${projectId}/sources/upload`, form)
}

export async function processFormalProjectSource(projectId: number, sourceId: number) {
  await ensureFormalIdentity()
  return jsonRequest<Record<string, unknown>>(`/api/projects/${projectId}/sources/${sourceId}/process`, { method: 'POST' })
}

export async function removeFormalProjectSource(projectId: number, sourceId: number) {
  await ensureFormalIdentity()
  return jsonRequest<{ status: string }>(`/api/vnext-projects/${projectId}/sources/${sourceId}`, { method: 'DELETE' })
}

export async function proposeFormalProjectKnowledgeBaseline(projectId: number, sourceIds: number[], query = '') {
  await ensureFormalIdentity()
  return jsonRequest<{ proposal: Record<string, any>; requires_confirmation: true }>(
    `/api/vnext-projects/${projectId}/knowledge-baseline/proposals`, {
      method: 'POST', body: JSON.stringify({ source_ids: sourceIds.slice(0, 30), query }),
    },
  )
}

export async function confirmFormalProjectKnowledgeBaseline(projectId: number, packetId: number) {
  await ensureFormalIdentity()
  return jsonRequest<{ baseline: Record<string, any>; mastery_unchanged: true }>(
    `/api/vnext-projects/${projectId}/knowledge-baseline/${packetId}/confirm`, { method: 'POST' },
  )
}

export async function updateFormalProjectSourceHealth(
  projectId: number, sourceId: number,
  action: 'quarantine' | 'restore' | 'mark_stale' | 'mark_conflicted', reason = '',
) {
  await ensureFormalIdentity()
  return jsonRequest<Record<string, unknown>>(`/api/vnext-projects/${projectId}/sources/${sourceId}/health`, {
    method: 'POST', body: JSON.stringify({ action, reason }),
  })
}

export type FormalDesktopPetCapabilityRefresh = {
  desktop_pet_capability_token: string
}

export type FormalDesktopPetBootstrap = {
  authority: 'formal_learnflow_objects'
  learner: Pick<FormalLearner, 'id' | 'display_name'>
  capability: { scopes: string[]; expires_at?: string | null }
  sessions: FormalTutorSessionSummary[]
  tasks: FormalLearningTask[]
  review: {
    due: number
    focus_subjects: Array<{ subject: string; reason_code: 'recent_retrieval_failure' | 'review_lapse' }>
    mastery_unchanged: true
  }
  model: { configured: boolean; status: 'ready' | 'unavailable' }
}

export type FormalDesktopPetContext = {
  id: string
  kind: 'text' | 'ocr_text' | 'image_observation' | 'document_excerpt' | 'video_transcript'
  status: 'pending' | 'confirmed' | 'consumed' | 'expired' | 'deleted'
  preview: string
  content_length: number
  source_label: string
  captured_at: string
  expires_at?: string | null
  requires_confirmation: boolean
  mastery_unchanged: true
}

export async function refreshFormalDesktopPetCapability() {
  return jsonRequest<FormalDesktopPetCapabilityRefresh>('/api/auth/desktop-pet-capability', {
    method: 'POST',
  })
}

export async function loadFormalDesktopPetBootstrap() {
  return jsonRequest<FormalDesktopPetBootstrap>('/api/pet/bootstrap')
}

export async function createFormalDesktopPetContext(input: {
  kind?: FormalDesktopPetContext['kind']
  content: string
  sourceLabel?: string
  capturedAt?: string
}) {
  return jsonRequest<FormalDesktopPetContext>('/api/pet/context-packages', {
    method: 'POST',
    body: JSON.stringify({
      kind: input.kind || 'text',
      content: input.content,
      source_label: input.sourceLabel || '用户主动提供的外部参考',
      captured_at: input.capturedAt || new Date().toISOString(),
    }),
  })
}

export async function createFormalDesktopPetImageContext(input: {
  file: File
  questionHint?: string
  clientContextId: string
}) {
  const form = new FormData()
  form.append('file', input.file, input.file.name || 'attached-image.png')
  form.append('question_hint', input.questionHint || '')
  form.append('client_context_id', input.clientContextId)
  return formRequest<FormalDesktopPetContext>('/api/pet/context-packages/image', form)
}

export async function transcribeFormalDesktopPetSelection(file: File) {
  const form = new FormData()
  form.append('file', file, file.name || 'desktop-selection.png')
  return formRequest<{ text: string; source_label: string; mastery_unchanged: true }>(
    '/api/pet/selection-text',
    form,
  )
}

export async function confirmFormalDesktopPetContext(contextId: string, sessionId: number) {
  return jsonRequest<FormalDesktopPetContext>(`/api/pet/context-packages/${encodeURIComponent(contextId)}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId }),
  })
}

export async function deleteFormalDesktopPetContext(contextId: string) {
  return jsonRequest<{ status: 'deleted'; mastery_unchanged: true }>(
    `/api/pet/context-packages/${encodeURIComponent(contextId)}`,
    { method: 'DELETE' },
  )
}

export async function loadFormalTutorSession(sessionId: number) {
  return jsonRequest<FormalTutorSession>(`/api/agent/sessions/${sessionId}`)
}

export async function startFormalLearningSkillRun(
  sessionId: number,
  skillId: LearningSkillId,
  goal: string,
  clientRequestId: string,
  domainSourceIds: number[] = [],
  learningTaskId?: number,
) {
  return jsonRequest<{
    session_id: number
    active_skill_run: FormalLearningSkillRun
    created: boolean
  }>(`/api/agent/sessions/${sessionId}/skill-runs`, {
    method: 'POST',
    body: JSON.stringify({
      skill_id: skillId,
      goal,
      client_request_id: clientRequestId,
      domain_source_ids: domainSourceIds.slice(0, 20),
      learning_task_id: learningTaskId,
    }),
  })
}

export async function advanceFormalLearningSkillTurn(
  sessionId: number,
  runId: number,
  message: string,
  expectedVersion: number,
  clientTurnId: string,
  domainSourceIds: number[] = [],
  directUserText?: string,
) {
  return jsonRequest<{
    session_id: number
    active_skill_run: FormalLearningSkillRun
    turn_plan?: { directive?: string; fallback?: string }
    created: boolean
  }>(`/api/agent/sessions/${sessionId}/skill-runs/${runId}/turns`, {
    method: 'POST',
    body: JSON.stringify({
      message,
      direct_user_text: directUserText ?? '',
      expected_version: expectedVersion,
      client_turn_id: clientTurnId,
      domain_source_ids: domainSourceIds.slice(0, 20),
    }),
  })
}

export async function actOnFormalLearningSkillRun(
  sessionId: number,
  run: Pick<FormalLearningSkillRun, 'id' | 'version'>,
  action: 'pause' | 'resume' | 'start_verification' | 'calibrate',
  calibrationPatch: Partial<{
    audience_level: string
    cognitive_demand: string
    scaffold_level: string
    representation_mode: string
  }> = {},
) {
  return jsonRequest<{
    session_id: number
    active_skill_run: FormalLearningSkillRun
    learning_run?: Record<string, unknown> | null
  }>(`/api/agent/sessions/${sessionId}/skill-runs/${run.id}/actions`, {
    method: 'POST',
    body: JSON.stringify({
      action,
      expected_version: run.version,
      client_action_id: `vnext-skill-action:${run.id}:${action}:${Date.now()}`,
      ...calibrationPatch,
    }),
  })
}

export type FormalLearningTaskAction = 'start' | 'pause' | 'resume' | 'cancel' | 'reopen' | 'complete_phase' | 'complete_task'

export async function actOnFormalLearningTask(task: FormalLearningTask, action: FormalLearningTaskAction) {
  return jsonRequest<FormalLearningTask>(`/api/learning-tasks/${task.id}/actions`, {
    method: 'POST',
    body: JSON.stringify({
      action,
      expected_version: task.version,
      client_action_id: `vnext-task-action:${task.id}:${action}:${Date.now()}`,
      phase_id: action === 'complete_phase' ? task.current_phase_id : '',
      evidence_refs: [],
    }),
  })
}

export async function loadKnowledgeLibrary() {
  await ensureFormalIdentity()
  return jsonRequest<{ library_id: number; sources: FormalKnowledgeSource[]; boundary: string }>('/api/knowledge-library/sources')
}

export async function addKnowledgeLibraryUrl(url: string) {
  await ensureFormalIdentity()
  return jsonRequest<FormalKnowledgeSource>('/api/knowledge-library/sources/url', {
    method: 'POST', body: JSON.stringify({ url }),
  })
}

export async function uploadKnowledgeLibraryFile(file: File) {
  await ensureFormalIdentity()
  const form = new FormData()
  form.append('file', file)
  return formRequest<FormalKnowledgeSource>('/api/knowledge-library/sources/upload', form)
}

export async function processKnowledgeLibrarySource(sourceId: number) {
  await ensureFormalIdentity()
  return jsonRequest<{ status: string; source: FormalKnowledgeSource }>(`/api/knowledge-library/sources/${sourceId}/process`, { method: 'POST' })
}

export async function loadSourcePaper(sourceId: number) {
  await ensureFormalIdentity()
  return jsonRequest<FormalSourcePaper>(`/api/knowledge-library/sources/${sourceId}/paper`)
}

export async function loadLearningFiles() {
  await ensureFormalIdentity()
  return jsonRequest<{ lectures: FormalLearningFileRef[]; practices: FormalLearningFileRef[]; boundary: string }>('/api/learning-files')
}

export async function loadLectureFile(lectureId: number) {
  await ensureFormalIdentity()
  return jsonRequest<FormalLearningFileRef & {
    id: number; version: number; status: string
    sections: Array<{ title?: string; content?: string; keywords?: string[] }>
    concept_graph: Record<string, unknown>
    provenance: Record<string, unknown>
    mastery_inference: false
  }>(`/api/learning-files/lecture/${lectureId}`)
}

export async function loadPracticeFile(ref: string) {
  await ensureFormalIdentity()
  return jsonRequest<FormalLearningFileRef & {
    practice_kind: 'exercise' | 'concept_question_set' | 'dynamic_question_set'
    description?: string
    starter_code?: string
    hints?: string[]
    questions?: Array<{ id: number; question: string; options: string[]; q_type: string; difficulty: string; code?: string; response_schema?: string; target_skill?: string; quality?: Record<string, unknown> }>
    answers_hidden: true
  }>(`/api/learning-files/practice/${encodeURIComponent(ref)}`)
}

export async function generateFormalLearningFiles(task: FormalLearningTask, sourceText = '') {
  await ensureFormalIdentity()
  return jsonRequest<FormalLearningTask>(`/api/learning-files/tasks/${task.id}/generate`, {
    method: 'POST',
    body: JSON.stringify({
      source_text: sourceText,
      expected_version: task.version,
      client_request_id: `vnext-learning-files:${task.id}:${task.version}:${Date.now()}`,
    }),
  })
}

export async function recordLearningFileAccess(
  kind: 'lecture' | 'practice' | 'source',
  ref: string,
  action: 'opened' | 'attached',
  context: { conversation_id?: string; sheet_id?: string } = {},
) {
  await ensureFormalIdentity()
  return jsonRequest<{ status: string; mastery_unchanged: true }>(`/api/learning-files/${kind}/${encodeURIComponent(ref)}/${action}`, {
    method: 'POST',
    body: JSON.stringify({ ...context, client_event_id: `vnext-file:${action}:${kind}:${ref}:${Date.now()}` }),
  })
}

export async function markFormalLectureRead(lectureId: number) {
  await ensureFormalIdentity()
  return jsonRequest<{ status: string; evidence_role: 'exposure'; mastery_unchanged: true }>(`/api/learning-files/lecture/${lectureId}/read`, {
    method: 'POST',
    body: JSON.stringify({ explicit_completion: true, client_event_id: `vnext-lecture-read:${lectureId}:${Date.now()}` }),
  })
}

export async function submitFormalConceptAnswer(
  checkpointId: number,
  questionId: number,
  submission: {
    answer_indexes?: number[]
    response?: unknown
    blocker_concept_key?: string
    helpful_format?: string
    support_effective?: boolean
  },
) {
  await ensureFormalIdentity()
  return jsonRequest<{ correct: boolean; answer_indexes: number[]; explanation?: string; attempt_id: number }>(`/api/checkpoints/${checkpointId}/concepts/${questionId}/submit`, {
    method: 'POST',
    body: JSON.stringify({
      ...submission,
      assistance_level: 'none',
      attempt_role: 'original',
      client_submission_id: `vnext-practice:${questionId}:${Date.now()}`,
    }),
  })
}

export async function submitFormalExercise(exerciseId: number, code: string) {
  await ensureFormalIdentity()
  return jsonRequest<{ passed: boolean; stdout?: string; stderr?: string; results?: Array<Record<string, unknown>>; attempt_id: number }>(`/api/exercises/${exerciseId}/submit`, {
    method: 'POST',
    body: JSON.stringify({
      code,
      files: [],
      assistance_level: 'none',
      attempt_role: 'original',
      client_submission_id: `vnext-exercise:${exerciseId}:${Date.now()}`,
    }),
  })
}

export async function submitFormalClaimFeedback(claimId: number, action: 'confirm' | 'correct' | 'retract', correction = '', reason = '') {
  return jsonRequest<Record<string, unknown>>(`/api/memory/claims/${claimId}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ action, correction, reason }),
  })
}

export async function setFormalMemoryArchived(memoryId: string, archived: boolean) {
  return jsonRequest<Record<string, unknown>>(`/api/profile/memories/${encodeURIComponent(memoryId)}/${archived ? 'archive' : 'restore'}`, {
    method: 'POST',
    body: archived ? JSON.stringify({ reason: '学习者在五核画像页选择不再提供给 Agent 参考' }) : undefined,
  })
}

function statusValue(value: FormalPathOverlay['statuses'][string]): LearnerPathStatus {
  if (typeof value === 'string') return value
  return value?.status || 'unmarked'
}

export function learnerPathStateFromFormal(overlay: FormalPathOverlay): LearnerPathState {
  let sequence = 0
  const events: LearnerPathState['events'] = []
  Object.entries(overlay.statuses || {}).forEach(([nodeId, value]) => {
    const status = statusValue(value)
    if (status === 'unmarked') return
    events.push({
      id: `formal-path-status:${nodeId}`,
      sequence: ++sequence,
      at: sequence,
      type: 'vnext_learning_path_node_status_set',
      detail: '从正式结构核恢复的学习者自报节点状态',
      nodeId,
      status,
    })
  })
  for (const raw of overlay.personal_nodes || []) {
    const id = String(raw.id || '')
    const title = String(raw.title || '')
    if (!id || !title) continue
    const sourceRefs = Array.isArray(raw.sourceRefs) ? raw.sourceRefs.map(String) : []
    const edges = Array.isArray(raw.edges) ? raw.edges.filter(item => item && typeof item === 'object').map(item => item as any) : []
    events.push({
      id: `formal-personal-node:${id}`,
      sequence: ++sequence,
      at: sequence,
      type: 'vnext_personal_path_node_added',
      detail: '从正式结构核恢复的个人节点',
      node: {
        id,
        title,
        summary: String(raw.summary || ''),
        aliases: Array.isArray(raw.aliases) ? raw.aliases.map(String) : [],
        domains: Array.isArray(raw.domains) ? raw.domains.map(String) : [],
        audiences: ['self_directed'],
        stage: ['foundation', 'core', 'domain', 'advanced', 'research'].includes(String(raw.stage)) ? raw.stage as any : 'advanced',
        order: Number(raw.order || 6),
        origin: 'personal',
        sourceRefs,
      },
      edges,
    })
  }
  for (const raw of overlay.plans || []) {
    const id = String(raw.id || '')
    const targetNodeIds = Array.isArray(raw.target_node_ids) ? raw.target_node_ids.map(String).slice(0, 8) : []
    const routeNodeIds = Array.isArray(raw.route_node_ids) ? raw.route_node_ids.map(String).slice(0, 40) : []
    if (!id || !targetNodeIds.length || !targetNodeIds.every(nodeId => routeNodeIds.includes(nodeId))) continue
    const plan: LearningPathPlan = {
      id,
      title: String(raw.title || raw.objective || id),
      objective: String(raw.objective || ''),
      horizon: String(raw.horizon || '长期'),
      targetNodeIds,
      routeNodeIds,
      milestoneNodeIds: Array.isArray(raw.milestone_node_ids) ? raw.milestone_node_ids.map(String).slice(0, 16) : [],
      rationale: String(raw.rationale || ''),
      evidenceQuote: String(raw.evidence_quote || ''),
      sourcePlanId: raw.source_plan_id ? String(raw.source_plan_id) : undefined,
      status: 'active',
      revision: Math.max(1, Number(raw.revision) || 1),
    }
    events.push({
      id: `formal-path-plan:${id}:${plan.revision}`,
      sequence: ++sequence,
      at: sequence,
      type: 'vnext_learning_path_plan_committed',
      detail: '从正式结构核恢复的长期学习路径',
      plan,
    })
  }
  return { version: 1, events }
}
