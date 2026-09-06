export const LEARNING_TASK_CONVERSION_PLUGIN = {
  id: 'learning_task_conversion',
  name: '学习型任务转化',
  version: '1.3.0',
  description: '将工作任务转成学习任务，或校验本地版本化工作案例；候选经用户确认后由宿主建立正式任务与阶段。',
  icon: '转',
} as const

export const LEARNING_TASK_OBJECT_SCHEMA_VERSION = 'role-learning-task-candidate.v1' as const
export const LEARNING_TASK_CONFIRMATION_SCHEMA_VERSION = 'learning-task-candidate-confirmation-result.v1' as const

export const LEARNING_TASK_OBJECT_TYPES = [
  'learning_task_intake',
  'learning_task_candidate',
  'learning_task_evidence',
  'learning_task_audit',
  'learning_task_handoff',
  'learning_task_confirmation',
  'work_case_candidate',
] as const

export const LEARNING_TASK_RENDERERS = {
  intake: 'learning_task_intake',
  candidate: 'learning_task_candidate',
  evidence: 'learning_task_evidence',
  audit: 'learning_task_audit',
  handoff: 'learning_task_handoff',
  confirmation: 'learning_task_confirmation',
} as const
