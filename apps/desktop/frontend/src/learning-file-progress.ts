export type PracticeAttemptHistory = {
  attempt_count?: number
  latest_attempt_id?: number | null
  latest_assistance_level?: string | null
  latest_passed?: boolean | null
  remediation_case_id?: number | null
}

export type PracticeSubmissionContext = {
  assistance_level?: 'none' | 'hint' | 'guided'
  attempt_role?: 'original' | 'retry'
  client_submission_id?: string
}

type ProgressStorage = Pick<Storage, 'getItem' | 'setItem'>

export function learningFileProgressKey(identity: string, kind: string, ref: string | number, version = 1) {
  return `learnflow.file-progress.v1:${encodeURIComponent(identity)}:${kind}:${encodeURIComponent(String(ref))}:${version}`
}

export function restoredLecturePosition(value: string | null, sectionCount: number, fallback = 0) {
  const position = value === null || value.trim() === '' ? fallback : Number(value)
  return Math.max(0, Math.min(Number.isFinite(position) ? Math.floor(position) : 0, Math.max(0, sectionCount - 1)))
}

export function readFileProgress(storage: ProgressStorage | undefined, key: string) {
  try { return storage?.getItem(key) ?? null } catch { return null }
}

export function saveFileProgress(storage: ProgressStorage | undefined, key: string, value: string) {
  try { storage?.setItem(key, value) } catch { /* Reading and submission remain available without browser storage. */ }
}

// This cache only prevents a browser refresh from under-reporting exposure.
// The server's owned attempt history remains authoritative.
export function practiceSubmissionContext(
  history: PracticeAttemptHistory | undefined,
  priorLocalSubmission: boolean,
  helpfulFormat = '',
  hintViewed = false,
): Required<Pick<PracticeSubmissionContext, 'assistance_level' | 'attempt_role'>> {
  const repeated = priorLocalSubmission || Number(history?.attempt_count || 0) > 0 || Number(history?.latest_attempt_id || 0) > 0
  const guided = ['worked_example', 'code_example', 'step_by_step'].includes(helpfulFormat)
    || repeated && history?.latest_assistance_level === 'guided'
  return {
    assistance_level: guided ? 'guided' : repeated || hintViewed || Boolean(helpfulFormat) ? 'hint' : 'none',
    attempt_role: repeated ? 'retry' : 'original',
  }
}

export function browserFileProgressStorage() {
  try { return globalThis.localStorage as ProgressStorage | undefined } catch { return undefined }
}

export async function notifyLearningFileProgress(onProgress?: () => Promise<void>, conversationId?: string) {
  if (onProgress) await onProgress()
  else if (conversationId && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('learnflow-learning-file-progress', { detail: { conversationId } }))
  }
}

export async function preparePracticeSubmission(
  storage: ProgressStorage | undefined,
  key: string,
  submission: unknown,
  context: PracticeSubmissionContext,
) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(submission)))
  const signature = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  try {
    const pending = JSON.parse(readFileProgress(storage, key) || 'null')
    if (pending?.signature === signature && pending.completed === false && typeof pending.context?.client_submission_id === 'string') {
      return pending.context as PracticeSubmissionContext
    }
  } catch { /* Ignore a corrupt browser cache. */ }
  const prepared = { ...context, client_submission_id: `vnext-file-submit:${crypto.randomUUID()}` }
  saveFileProgress(storage, key, JSON.stringify({ signature, completed: false, context: prepared }))
  return prepared
}

export function completePracticeSubmission(storage: ProgressStorage | undefined, key: string, context: PracticeSubmissionContext) {
  try {
    const pending = JSON.parse(readFileProgress(storage, key) || 'null')
    if (pending?.context?.client_submission_id === context.client_submission_id) {
      saveFileProgress(storage, key, JSON.stringify({ ...pending, completed: true }))
    }
  } catch { /* Server submission success does not depend on browser storage. */ }
}
