export type ReviewBucket = 'all' | 'due' | 'wrong' | 'upcoming' | 'stable' | 'suspended'

export type ReviewProficiency = {
  policy_version: string
  score: number
  level: string
  label: string
  confidence: number
  dimensions: Record<'accuracy' | 'retrievability' | 'independence' | 'transfer' | 'spacing', number>
  dimension_weights: Record<string, number>
  caps: Array<{ code: string; limit: number; reason: string }>
  evidence: Record<string, number>
  next_evidence: string
  memory_state: {
    model_family: string
    difficulty: number
    stability_days: number
    retrievability: number
    target_retention: number
    calibration: string
  }
  research_basis: Array<{ id: string; title: string; url: string; use: string }>
  authority: string
  mastery_boundary: string
}

export type ReviewMemoryNote = {
  id: string
  kind: 'misconception' | 'insight' | 'strength' | 'support' | 'question'
  title: string
  text: string
  status: string
  source: string
  evidence_refs: string[]
  occurred_at?: string | null
  mastery_inference: false
  correctable?: boolean
}

export type ReviewItem = {
  id: number
  learner_id: number
  project_id?: number | null
  checkpoint_id: number
  item_type: 'concept' | 'exercise'
  item_id: number
  subject_key: string
  phase: string
  bucket: string
  due_at: string
  interval_level: number
  interval_days: number
  successful_reviews: number
  lapse_count: number
  defer_count: number
  last_grade: string
  version: number
  title: string
  project_name: string
  checkpoint_title: string
  attempt_state: string
  remediation_state: string
  evidence_state: string
  wrong_state: string
  wrong_count: number
  reason_codes: string[]
  proficiency: ReviewProficiency
  memory_notes: ReviewMemoryNote[]
  learning_task?: {
    id: number
    title: string
    status: string
    current_phase_id: string
    review_handoff: { status?: string; items?: Array<Record<string, unknown>> }
  } | null
  presentation: {
    question_form: string
    version: string
    payload: {
      type: 'concept_choice' | 'predict_output' | 'code'
      title?: string
      prompt?: string
      input?: string
      options?: string[]
      multiple?: boolean
      starter_code?: string
      files?: Array<Record<string, unknown>>
    }
  }
}

export type ReviewSummary = {
  total: number
  due: number
  overdue: number
  wrong: number
  remediation: number
  upcoming: number
  stable: number
  suspended: number
  policy_version: string
  proficiency_policy_version: string
  interval_days: number[]
}

function errorText(payload: unknown, fallback: string) {
  if (payload && typeof payload === 'object') {
    const detail = (payload as Record<string, unknown>).detail || (payload as Record<string, unknown>).error
    if (typeof detail === 'string' && detail.trim()) return detail
  }
  return fallback
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
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
  if (!response.ok) throw new Error(errorText(payload, `请求失败（${response.status}）`))
  return payload as T
}

export async function loadReviewSummary() {
  return request<ReviewSummary>('/api/review/summary')
}

export async function loadReviewItems(bucket: ReviewBucket = 'all') {
  return request<{ items: ReviewItem[]; total: number; bucket: string }>(`/api/review/items?bucket=${bucket}&limit=100`)
}

export async function loadReviewHistory(scheduleId: number) {
  return request<Record<string, unknown>>(`/api/review/items/${scheduleId}/history`)
}

export async function submitReviewItem(item: ReviewItem, input: {
  responseStatus: 'answered' | 'unknown' | 'skipped'
  answerIndexes?: number[]
  answerText?: string
  code?: string
  files?: Array<Record<string, unknown>>
  assistanceLevel?: 'none' | 'hint' | 'guided'
}) {
  return request<{ outcome: string; passed?: boolean; item: ReviewItem }>(`/api/review/items/${item.id}/submit`, {
    method: 'POST',
    body: JSON.stringify({
      expected_version: item.version,
      client_submission_id: `vnext-review:${item.id}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      response_status: input.responseStatus,
      answer_indexes: input.answerIndexes || [],
      answer_text: input.answerText || '',
      code: input.code || '',
      files: input.files || [],
      assistance_level: input.assistanceLevel || 'none',
      presentation_version: item.presentation.version,
    }),
  })
}

export async function actOnReviewItem(item: ReviewItem, action: 'defer' | 'suspend' | 'resume') {
  return request<{ item: ReviewItem }>(`/api/review/items/${item.id}/${action}`, {
    method: 'POST',
    body: JSON.stringify({
      expected_version: item.version,
      client_event_id: `vnext-review:${item.id}:${action}:${Date.now()}`,
    }),
  })
}

export async function recordReviewReflection(
  item: ReviewItem,
  reflectionKind: 'insight' | 'misconception' | 'strength' | 'question',
  text: string,
) {
  return request<{ event_id: number; item: ReviewItem }>(`/api/review/items/${item.id}/reflections`, {
    method: 'POST',
    body: JSON.stringify({
      reflection_kind: reflectionKind,
      text,
      client_event_id: `vnext-review-reflection:${item.id}:${Date.now()}`,
    }),
  })
}
import { runtimeFetch } from './runtime-client.ts'
