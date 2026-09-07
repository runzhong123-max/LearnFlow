export type VerificationState = 'learning_card' | 'teach_back' | 'teach_back_feedback' | 'verification' | 'remediation' | 'completed' | 'paused'
export type VerificationAction = 'complete_card' | 'continue_after_feedback' | 'pause' | 'resume'

export type VerificationRun = {
  id: number
  goal: string
  status: 'active' | 'paused' | 'completed'
  state: VerificationState
  version: number
  checkpoint_id: number
  project_id: number
  session_id: number
  learning_card: {
    title?: string
    objective?: string
    key_points?: string[]
    example?: string
    common_confusion?: string
    success_criteria?: string
    quality_status?: string
  }
  teach_back: {
    response?: string
    covered_points?: string[]
    missing_points?: string[]
    diagnostic_question?: string
    status?: string
  }
  verification: {
    question_ids?: number[]
    completed_question_ids?: number[]
    current_question_id?: number | null
    active_remediation_case_id?: number | null
  }
  progress?: { current: number; total: number; completed_questions: number; total_questions: number }
  summary: {
    independently_verified_question_ids?: number[]
    remediated_question_ids?: number[]
    review_schedule_ids?: number[]
    next_step?: string
    mastery_claim?: string
  }
}

export type VerificationTransport = <T>(path: string, init?: RequestInit) => Promise<T>

const labels: Record<VerificationState, string> = {
  learning_card: '准备验证', teach_back: '用自己的话解释', teach_back_feedback: '查看复述反馈',
  verification: '正式作答', remediation: '完成纠错与变式', completed: '本轮验证完成', paused: '验证已暂停',
}

export function verificationPresentation(run: VerificationRun) {
  const completed = run.status === 'completed' && run.state === 'completed'
  const active = run.status === 'active'
  const actions: VerificationAction[] = []
  if (active && run.state === 'learning_card' && run.learning_card.quality_status !== 'blocked') actions.push('complete_card')
  if (active && run.state === 'teach_back_feedback') actions.push('continue_after_feedback')
  if (active && !['completed', 'paused'].includes(run.state)) actions.push('pause')
  if (run.status === 'paused' && run.state === 'paused') actions.push('resume')
  return {
    completed,
    label: run.state === 'completed' && !completed ? '请刷新验证状态' : labels[run.state],
    actions,
    canTeachBack: active && run.state === 'teach_back',
    practiceRef: active && ['verification', 'remediation'].includes(run.state) ? `questions-${run.checkpoint_id}` : null,
  }
}

function validateRun(value: VerificationRun, expectedId: number): VerificationRun {
  if (!value || value.id !== expectedId || !Number.isSafeInteger(value.version) || value.version < 1
    || !Number.isSafeInteger(value.checkpoint_id) || value.checkpoint_id < 1
    || !Object.prototype.hasOwnProperty.call(labels, value.state) || !['active', 'paused', 'completed'].includes(value.status)) {
    throw new Error('验证状态响应不完整，请刷新重试')
  }
  return { ...value, learning_card: value.learning_card || {}, teach_back: value.teach_back || {},
    verification: value.verification || {}, summary: value.summary || {} }
}

function validateRunId(runId: number) {
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('验证记录无效')
}

/** Stable across retries and reloads; contains no learner-authored text. */
export function verificationRequestId(run: Pick<VerificationRun, 'id' | 'version'>, operation: string, response = '') {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(response.trim())) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `verification:${run.id}:v${run.version}:${operation}:${hash.toString(16)}`
}

export function validateTeachBack(response: string) {
  const text = response.trim()
  const count = [...text].length
  if (count < 20) throw new Error('请至少写20个字，说明关键关系和一个具体例子')
  if (count > 6000) throw new Error('复述请控制在6000字以内')
  return text
}

export function createVerificationRuntime(request: VerificationTransport) {
  const post = async (run: VerificationRun, endpoint: string, body: Record<string, unknown>) => {
    validateRunId(run.id)
    return validateRun(await request<VerificationRun>(`/api/micro-learning/runs/${run.id}/${endpoint}`, {
      method: 'POST', body: JSON.stringify({ expected_version: run.version, ...body }),
    }), run.id)
  }
  return {
    async load(runId: number) {
      validateRunId(runId)
      return validateRun(await request<VerificationRun>(`/api/micro-learning/runs/${runId}`), runId)
    },
    advance(run: VerificationRun, action: VerificationAction) {
      if (!verificationPresentation(run).actions.includes(action)) throw new Error('当前步骤不能执行此操作，请刷新状态')
      return post(run, 'advance', { action, client_action_id: verificationRequestId(run, action) })
    },
    teachBack(run: VerificationRun, response: string) {
      if (!verificationPresentation(run).canTeachBack) throw new Error('当前步骤不能提交复述，请刷新状态')
      const text = validateTeachBack(response)
      return post(run, 'teach-back', { response: text, client_submission_id: verificationRequestId(run, 'teach-back', text) })
    },
    sync(run: VerificationRun) {
      return post(run, 'sync', { client_action_id: verificationRequestId(run, 'sync') })
    },
  }
}
