export const LEARNING_TASK_CONVERSION_PLUGIN = {
  id: 'learning_task_conversion',
  name: '工作任务转学习项目',
  version: '1.3.0',
  description: '在对话中选择知识学习、实验或带教实践。知识学习沿用讯飞转换；实验与带教由 LearnFlow 设计，在桌面执行。',
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
