import { createHash } from 'node:crypto'
import type { PluginJson } from '../../src/plugin-api.ts'
import {
  prepareLearningTaskIntake,
  type LearningTaskConversionIntake,
  type LearningTaskIntakeCandidate,
  type PrepareLearningTaskIntakeInput,
} from './intake.ts'

export type LearningTaskConversionIntakeEnvelope = LearningTaskConversionIntake & {
  intakeRootHash: string
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  )
}

export function learningTaskIntakeRootHash(intake: LearningTaskConversionIntake) {
  return createHash('sha256').update(JSON.stringify(canonical({
    schemaVersion: intake.schemaVersion,
    intakeId: intake.intakeId,
    originalInput: intake.originalInput,
    taskContract: {
      title: intake.taskContract.title,
      description: intake.taskContract.description,
      source: intake.taskContract.source,
      sourceRef: intake.taskContract.sourceRef,
    },
  }))).digest('hex')
}

export function prepareLearningTaskIntakeEnvelope(
  input: PrepareLearningTaskIntakeInput,
): LearningTaskConversionIntakeEnvelope {
  const intake = prepareLearningTaskIntake(input)
  return { ...intake, intakeRootHash: learningTaskIntakeRootHash(intake) }
}

export type ConfirmedLearningTaskIntakeInput = {
  originalInput: string
  intakeId: string
  intakeRootHash: string
  intakeConfirmed: boolean
  taskTitle: string
  taskDescription?: string
  taskSource: 'user_explicit' | LearningTaskIntakeCandidate['source']
  taskSourceRef?: string
}

export function assertConfirmedLearningTaskIntake(
  input: ConfirmedLearningTaskIntakeInput,
): LearningTaskConversionIntakeEnvelope {
  if (input.intakeConfirmed !== true) {
    throw new Error('learning_task_intake_confirmation_required:请先确认任务转化准备单')
  }
  const sourceCandidate = input.taskSource === 'user_explicit' ? [] : [{
    title: input.taskTitle,
    description: input.taskDescription || '',
    source: input.taskSource,
    sourceRef: input.taskSourceRef || '',
  }]
  const intake = prepareLearningTaskIntakeEnvelope({
    rawInput: input.originalInput,
    taskDescription: input.taskDescription,
    candidateTasks: sourceCandidate,
    selectedTaskTitle: input.taskSource === 'user_explicit' ? undefined : input.taskTitle,
    selectedTaskDescription: input.taskDescription,
    // Confirmation rebuilds the exact learner-approved task contract without
    // making a second model call. The semantic kind was already established in
    // the preparation turn; local keyword extraction must not invalidate it.
    modelAssessment: input.taskSource === 'user_explicit' ? {
      schemaVersion: 'learning-task-intake-model.v1',
      model: 'confirmed-preflight',
      assessedKind: 'work_task',
      confidence: 1,
      rationale: '沿用学习者已确认的语义预检任务合同。',
      nextQuestion: '',
    } : undefined,
  })
  if (input.taskSource === 'user_explicit' && intake.taskContract.title !== input.taskTitle.trim()) {
    throw new Error('learning_task_intake_anchor_mismatch:任务名称必须保持用户已确认的原始工作任务')
  }
  if (intake.status !== 'ready_for_confirmation') {
    throw new Error(`learning_task_intake_not_ready:${intake.nextQuestion}`)
  }
  if (intake.intakeId !== input.intakeId || intake.intakeRootHash !== input.intakeRootHash) {
    throw new Error('learning_task_intake_hash_mismatch:准备单已变化，请重新确认后再生成')
  }
  return intake
}

export function intakeEnvelopeJson(intake: LearningTaskConversionIntakeEnvelope) {
  return intake as unknown as PluginJson
}
