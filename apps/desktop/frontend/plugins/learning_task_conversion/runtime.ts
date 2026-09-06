import { createHash } from 'node:crypto'
import {
  LEARNFLOW_PLUGIN_OBJECT_VERSION,
  type LearnFlowPluginObject,
  type PluginJson,
  type PluginToolContext,
  type PluginToolResult,
} from '../../src/plugin-api.ts'
import {
  LEARNING_TASK_CONVERSION_PLUGIN,
  LEARNING_TASK_CONFIRMATION_SCHEMA_VERSION,
  LEARNING_TASK_OBJECT_SCHEMA_VERSION,
  LEARNING_TASK_RENDERERS,
} from './shared.ts'
import {
  assertConfirmedLearningTaskIntake,
  intakeEnvelopeJson,
  prepareLearningTaskIntakeEnvelope,
} from './intake-runtime.ts'
import { suggestLearningTaskStepCount } from './intake.ts'

type JsonRecord = Record<string, any>

const INTAKE_KINDS = new Set(['role', 'role_or_direction', 'work_task', 'learning_topic', 'ambiguous'])

function normalizedModelAssessment(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as JsonRecord
  if (!INTAKE_KINDS.has(String(input.assessedKind || ''))) return undefined
  return {
    schemaVersion: String(input.schemaVersion || 'learning-task-intake-model.v1'),
    model: String(input.model || 'semantic-preflight'),
    assessedKind: String(input.assessedKind) as 'role' | 'role_or_direction' | 'work_task' | 'learning_topic' | 'ambiguous',
    confidence: Math.max(0, Math.min(1, Number(input.confidence) || 0)),
    rationale: String(input.rationale || ''),
    nextQuestion: String(input.nextQuestion || ''),
  }
}

function integration(context: PluginToolContext) {
  if (!context.scope.projectId) throw new Error('plugin_contract_invalid:learning-task conversion requires a project')
  if (!context.projectIntegration) throw new Error('plugin_integration_error:backend_unavailable:项目集成通道不可用')
  return context.projectIntegration
}

function normalizedSourceVersionIds(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is number => Number.isInteger(item) && item > 0))]
    .sort((left, right) => left - right)
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value as JsonRecord).sort().reduce<JsonRecord>((result, key) => {
    result[key] = canonicalJson((value as JsonRecord)[key])
    return result
  }, {})
}

function stableRequestId(
  input: JsonRecord,
  context: PluginToolContext,
  request: {
    taskTitle: string
    taskDescription: string
    upstreamTask: JsonRecord
    sourceVersionIds: number[]
    targetStepCount: number
    maxSourceSegments: number
  },
) {
  if (typeof input.requestId === 'string' && input.requestId.trim()) return input.requestId.trim()
  const fingerprint = createHash('sha256').update(JSON.stringify(canonicalJson({
    projectId: context.scope.projectId,
    conversationId: context.scope.conversationId || '',
    intakeRootHash: input.intakeRootHash || '',
    ...request,
  }))).digest('hex').slice(0, 24)
  return `plugin:${context.scope.projectId}:${fingerprint}`
}

function object(
  objectType: string,
  objectId: string,
  label: string,
  value: PluginJson,
  schemaVersion = LEARNING_TASK_OBJECT_SCHEMA_VERSION,
): LearnFlowPluginObject {
  return {
    protocol: LEARNFLOW_PLUGIN_OBJECT_VERSION,
    pluginId: LEARNING_TASK_CONVERSION_PLUGIN.id,
    objectType,
    objectId,
    schemaVersion,
    label,
    value,
  }
}

function candidateResult(candidate: JsonRecord, summary = ''): PluginToolResult {
  const title = String(candidate.task?.title || '学习型任务候选')
  return {
    summary: summary || `已生成“${title}”候选，共 ${candidate.task?.steps?.length || 0} 个步骤；尚未创建正式 LearningTask。`,
    objects: [object('learning_task_candidate', String(candidate.candidateId), title, candidate as PluginJson)],
    payload: {
      candidateId: candidate.candidateId,
      lifecycle: candidate.lifecycle,
      groundingStatus: candidate.groundingStatus,
      sourceSnapshot: candidate.sourceSnapshot,
      coverage: candidate.coverage,
      warnings: candidate.warnings,
      formalLearningTaskCreated: false,
      kernelWrites: 0,
    },
    presentation: { renderer: LEARNING_TASK_RENDERERS.candidate },
  }
}

export const learningTaskConversionRuntime = {
  prepare(input: JsonRecord): PluginToolResult {
    const intake = prepareLearningTaskIntakeEnvelope({
      rawInput: String(input.rawInput || ''),
      roleName: String(input.roleName || ''),
      taskDescription: String(input.taskDescription || ''),
      candidateTasks: Array.isArray(input.candidateTasks) ? input.candidateTasks : [],
      selectedTaskTitle: String(input.selectedTaskTitle || ''),
      selectedTaskDescription: String(input.selectedTaskDescription || ''),
      // This field is normally injected by the host preflight, but the model
      // can also attempt the public tool directly. Never let a partial object
      // introduce undefined values into the plugin's JSON result envelope.
      modelAssessment: normalizedModelAssessment(input.modelAssessment),
    })
    const ready = intake.status === 'ready_for_confirmation'
    return {
      summary: ready
        ? `已锁定企业工作任务“${intake.taskContract.title}”，等待你确认；本轮没有调用讯飞。`
        : intake.nextQuestion,
      objects: [object(
        'learning_task_intake',
        intake.intakeId,
        ready ? intake.taskContract.title : '学习型任务转化准备单',
        intakeEnvelopeJson(intake),
        intake.schemaVersion,
      )],
      payload: intakeEnvelopeJson(intake),
      presentation: { renderer: LEARNING_TASK_RENDERERS.intake },
    }
  },

  async draft(input: JsonRecord, context: PluginToolContext): Promise<PluginToolResult> {
    const intake = assertConfirmedLearningTaskIntake({
      originalInput: String(input.originalInput || ''),
      intakeId: String(input.intakeId || ''),
      intakeRootHash: String(input.intakeRootHash || ''),
      intakeConfirmed: input.intakeConfirmed === true,
      taskTitle: String(input.taskTitle || ''),
      taskDescription: String(input.taskDescription || ''),
      taskSource: String(input.taskSource || 'user_explicit') as 'user_explicit' | 'role_package' | 'project_source' | 'model_proposed',
      taskSourceRef: String(input.taskSourceRef || ''),
    })
    const suppliedUpstreamTask = input.upstreamTask && typeof input.upstreamTask === 'object'
      ? input.upstreamTask as JsonRecord : {}
    const origin = {
      ...(context.scope.sessionId ? { sessionId: context.scope.sessionId } : {}),
      ...(context.scope.conversationId ? { conversationId: context.scope.conversationId } : {}),
      ...(context.scope.sheetId ? { sheetId: context.scope.sheetId } : {}),
    }
    const upstreamTask = {
      ...suppliedUpstreamTask,
      taskSource: {
        kind: intake.taskContract.source,
        ref: intake.taskContract.sourceRef,
      },
      ...(Object.keys(origin).length ? { learnflowOrigin: origin } : {}),
    }
    const sourceVersionIds = normalizedSourceVersionIds(input.sourceVersionIds)
    const targetStepCount = Number.isInteger(input.targetStepCount)
      ? Number(input.targetStepCount)
      : suggestLearningTaskStepCount(intake.taskContract.title, intake.taskContract.description)
    const maxSourceSegments = Number(input.maxSourceSegments || 16)
    const requestIdentity = {
      taskTitle: intake.taskContract.title,
      taskDescription: intake.taskContract.description,
      upstreamTask,
      sourceVersionIds,
      targetStepCount,
      maxSourceSegments,
    }
    const candidate = await integration(context).request('create_candidate', {
      schemaVersion: 'role-learning-task-candidate-request.v1',
      requestId: stableRequestId(input, context, requestIdentity),
      ...requestIdentity,
    }) as JsonRecord
    return candidateResult(candidate)
  },

  async read(input: JsonRecord, context: PluginToolContext): Promise<PluginToolResult> {
    const candidate = await integration(context).request('read_candidate', {
      candidateId: String(input.candidateId || ''),
    }) as JsonRecord
    return candidateResult(candidate, `已读取“${candidate.task?.title || candidate.candidateId}”候选；生命周期仍为未确认。`)
  },

  async evidence(input: JsonRecord, context: PluginToolContext): Promise<PluginToolResult> {
    const evidence = await integration(context).request('inspect_evidence', {
      candidateId: String(input.candidateId || ''),
    }) as JsonRecord
    return {
      summary: `候选 ${evidence.candidateId} 绑定 ${evidence.citations?.length || 0} 条可核验引用；不构成掌握证据。`,
      objects: [object('learning_task_evidence', String(evidence.candidateId), '候选来源与引用', evidence as PluginJson)],
      payload: evidence as PluginJson,
      presentation: { renderer: LEARNING_TASK_RENDERERS.evidence },
    }
  },

  async audit(input: JsonRecord, context: PluginToolContext): Promise<PluginToolResult> {
    const audit = await integration(context).request('audit_candidate', {
      candidateId: String(input.candidateId || ''),
    }) as JsonRecord
    return {
      summary: audit.validation?.valid
        ? `候选 ${audit.candidateId} 已通过当前确定性结构校验；仍需用户确认。`
        : `候选 ${audit.candidateId} 未通过当前确定性结构校验。`,
      objects: [object('learning_task_audit', String(audit.candidateId), '学习任务候选审计', audit as PluginJson)],
      payload: audit as PluginJson,
      presentation: { renderer: LEARNING_TASK_RENDERERS.audit },
    }
  },

  async handoff(input: JsonRecord, context: PluginToolContext): Promise<PluginToolResult> {
    const handoff = await integration(context).request('prepare_handoff', {
      candidateId: String(input.candidateId || ''),
    }) as JsonRecord
    return {
      summary: `候选 ${handoff.candidateId} 已整理为 Tutor 审阅包；用户确认前不会创建正式学习任务。`,
      objects: [object('learning_task_handoff', String(handoff.candidateId), 'Tutor 审阅候选包', handoff as PluginJson)],
      payload: handoff as PluginJson,
      presentation: { renderer: LEARNING_TASK_RENDERERS.handoff },
    }
  },

  async confirm(input: JsonRecord, context: PluginToolContext): Promise<PluginToolResult> {
    const candidateId = String(input.candidateId || '').trim()
    const expectedRootHash = String(input.expectedRootHash || '').trim()
    const confirmationId = typeof input.confirmationId === 'string' && input.confirmationId.trim()
      ? input.confirmationId.trim()
      : `plugin-confirm:${createHash('sha256').update(JSON.stringify({
          projectId: context.scope.projectId,
          candidateId,
          expectedRootHash,
        })).digest('hex').slice(0, 24)}`
    const result = await integration(context).request('confirm_candidate', {
      candidateId,
      schemaVersion: 'learning-task-candidate-confirmation.v1',
      confirmationId,
      expectedRootHash,
      confirmed: input.confirmed === true,
    }) as JsonRecord
    const task = (result.learningTask || {}) as JsonRecord
    return {
      summary: result.created
        ? `已按你的明确确认创建正式学习任务“${task.title || candidateId}”；现在可以进入个性化学习。`
        : `该候选已确认过，已返回同一个正式学习任务“${task.title || candidateId}”。`,
      objects: [object(
        'learning_task_confirmation',
        String(task.id || candidateId),
        String(task.title || '正式学习任务'),
        result as PluginJson,
        LEARNING_TASK_CONFIRMATION_SCHEMA_VERSION,
      )],
      payload: result as PluginJson,
      presentation: { renderer: LEARNING_TASK_RENDERERS.confirmation },
    }
  },
}
