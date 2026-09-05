import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  directLearningTaskCandidateOperationRequest,
  directLearningTaskDraftConfirmationRequest,
  directLearningTaskCandidateSelectionRequest,
  directLearningTaskIntakeRequest,
  projectPluginIntegrationRequestBody,
  runTutorAgentTurn,
} from './agent-runtime.ts'
import { learningTaskDraftConfirmationPrompt } from '../plugins/learning_task_conversion/intake.ts'
import { loadLearnFlowPluginRegistry } from './plugin-loader.ts'

const activation = {
  mode: 'learning_plan' as const,
  activePluginIds: ['learning_task_conversion'],
  projectId: 7,
}

function sampleCandidate() {
  return {
    schemaVersion: 'role-learning-task-candidate.v1',
    candidateId: 'ltc_1234567890abcdef',
    requestId: 'request-12345678',
    packageId: 'learnflow-project:7', packageVersion: 'source-set.abc',
    snapshotId: 'source_snapshot_abc', rootHash: 'a'.repeat(64),
    lifecycle: 'candidate', confirmationStatus: 'unconfirmed',
    groundingStatus: 'ungrounded',
    sourceSnapshot: { packageId: 'learnflow-project:7', packageVersion: 'source-set.abc', snapshotId: 'source_snapshot_abc', rootHash: 'a'.repeat(64) },
    sourceBindings: [], citations: [],
    task: {
      title: '部署服务学习型工作任务', workContext: '在实训环境中部署并验收服务。',
      learningObjective: '完成部署并留下可检查证据。', prerequisites: [], estimatedMinutes: 120,
      inputs: [], resources: ['测试服务器'],
      steps: [1, 2, 3].map(index => ({
        id: `step_${index}`, order: index, title: `步骤 ${index}`, action: `执行操作 ${index}`,
        prerequisiteStepIds: index === 1 ? [] : [`step_${index - 1}`], dependencyDerivation: 'provider',
        inputs: [], resources: [], deliverables: [`产物 ${index}`], successCriteria: [`检查 ${index}`],
        safetyRequirements: [], knowledgeTargetIds: [], skillTargetIds: [], citationIds: [],
      })),
      deliverables: ['产物 1', '产物 2', '产物 3'], successCriteria: ['检查 1', '检查 2', '检查 3'], safetyRequirements: [],
    },
    mappings: { knowledgeTargets: [], skillTargets: [], capabilityTargets: [] },
    assessment: { evidenceRequired: ['产物 1'], rubric: [], independentVerification: { required: true } },
    coverage: { partial: false, truncated: false, omitted: 0, source: { truncated: false, omittedSegmentCount: 0 }, task: { truncated: false, omittedStepCount: 0 } },
    warnings: [{ code: 'ungrounded', message: '没有来源片段。' }], assumptions: [],
    validation: { valid: true, issues: [], warnings: [], kernelWrites: 0, masteryChanged: false },
    provenance: { provider: 'xunfei-xingchen', workflowId: 'flow', workflowRunIds: ['run'], kernelTargets: [], masteryUnchanged: true },
  }
}

async function registry() {
  return loadLearnFlowPluginRegistry(resolve(process.cwd(), 'plugins'))
}

test('candidate card actions route directly to the selected conversion plugin', () => {
  const candidateId = 'ltc_69a5b98f127ced3900858bc10686'
  const rootHash = 'b'.repeat(64)
  assert.deepEqual(
    directLearningTaskCandidateOperationRequest(
      ['learning_task_conversion'],
      7,
      `请调用学习型任务转化插件检查候选 ${candidateId} 的来源证据和 grounding 边界。`,
    ),
    {
      toolName: 'learning_task_conversion__inspect_learning_task_evidence',
      arguments: { candidateId },
    },
  )
  assert.deepEqual(
    directLearningTaskCandidateOperationRequest(
      ['learning_task_conversion'],
      7,
      `我明确确认采用候选 ${candidateId}（rootHash: ${rootHash}）。请立即调用 learning_task_conversion__confirm_learning_task_candidate。`,
    ),
    {
      toolName: 'learning_task_conversion__confirm_learning_task_candidate',
      arguments: { candidateId, expectedRootHash: rootHash, confirmed: true },
    },
  )
})

test('candidate confirmation keeps candidateId in the URL instead of the strict request body', () => {
  const requestBody = projectPluginIntegrationRequestBody(
    { method: 'POST', suffix: '/confirm' },
    {
      candidateId: 'ltc_69a5b98f127ced3900858bc10686',
      schemaVersion: 'learning-task-candidate-confirmation.v1',
      confirmationId: 'plugin-confirm:abc12345',
      expectedRootHash: 'c'.repeat(64),
      confirmed: true,
    },
  )
  assert.equal('candidateId' in requestBody, false)
  assert.equal(requestBody.confirmed, true)
  assert.equal(requestBody.expectedRootHash, 'c'.repeat(64))
})

test('explicit project plugin request maps to local intake instead of calling the provider', () => {
  assert.deepEqual(
    directLearningTaskIntakeRequest(
      ['learning_task_conversion'],
      7,
      '请把“在 Ubuntu 服务器配置 Fail2ban 并完成封禁与解封验收”转化为学习型任务，生成 6 个可验收步骤。',
    ),
    {
      rawInput: '在 Ubuntu 服务器配置 Fail2ban 并完成封禁与解封验收',
      taskDescription: '请把“在 Ubuntu 服务器配置 Fail2ban 并完成封禁与解封验收”转化为学习型任务，生成 6 个可验收步骤。',
    },
  )
  assert.equal(directLearningTaskIntakeRequest([], 7, '生成学习型任务'), undefined)
  assert.equal(directLearningTaskIntakeRequest(['learning_task_conversion'], undefined, '生成学习型任务'), undefined)
  assert.equal(directLearningTaskIntakeRequest(['learning_task_conversion'], 7, '解释一下学习型任务是什么'), undefined)
})

test('a referenced role graph task becomes the exact source-backed intake', () => {
  const reference = {
    protocol: 'learnflow-plugin-object.v1' as const,
    pluginId: 'role_capability_graph',
    objectType: 'role_object',
    objectId: 'task:llmapp:build-agent-integration',
    schemaVersion: 'role-capability.object.v1',
    label: '构建Agent工作流与工具系统集成',
    value: {
      category: 'task',
      data: {
        type: 'task',
        label: '构建Agent工作流与工具系统集成',
        summary: '实现编排、工具调用、权限、重试、确认、幂等与异常处理。',
      },
    },
  }
  assert.deepEqual(
    directLearningTaskIntakeRequest(
      ['learning_task_conversion'],
      undefined,
      '生成学习型任务\n\n引用插件对象（固定到产生它们的 ToolRun）：\n- 构建Agent工作流与工具系统集成（plugin-object://...）',
      [reference],
    ),
    {
      rawInput: '构建Agent工作流与工具系统集成',
      taskDescription: '实现编排、工具调用、权限、重试、确认、幂等与异常处理。',
      candidateTasks: [{
        id: 'task:llmapp:build-agent-integration',
        title: '构建Agent工作流与工具系统集成',
        description: '实现编排、工具调用、权限、重试、确认、幂等与异常处理。',
        source: 'role_package',
        sourceRef: 'plugin-object://role_capability_graph/role_object/task%3Allmapp%3Abuild-agent-integration?schema=role-capability.object.v1',
      }],
      selectedTaskTitle: '构建Agent工作流与工具系统集成',
      selectedTaskDescription: '实现编排、工具调用、权限、重试、确认、幂等与异常处理。',
    },
  )
})

test('selecting the plugin routes plain task text through intake without command wording', () => {
  assert.deepEqual(
    directLearningTaskIntakeRequest(
      ['learning_task_conversion'],
      7,
      'Unity游戏客户端开发工程师',
    ),
    {
      rawInput: 'Unity游戏客户端开发工程师',
      taskDescription: 'Unity游戏客户端开发工程师',
    },
  )
  assert.equal(
    directLearningTaskIntakeRequest([], 7, 'Unity游戏客户端开发工程师'),
    undefined,
  )
  assert.deepEqual(
    directLearningTaskIntakeRequest(
      ['learning_task_conversion'],
      undefined,
      'unity摄像机的放置与2D视角跟随',
    ),
    {
      rawInput: 'unity摄像机的放置与2D视角跟随',
      taskDescription: 'unity摄像机的放置与2D视角跟随',
    },
  )
})

test('sticky conversion plugin does not intercept formal guided-learning replies', () => {
  assert.equal(
    directLearningTaskIntakeRequest(
      ['learning_task_conversion'],
      7,
      '我先从定义工具契约和幂等边界开始。',
      [],
      'guided_learning',
    ),
    undefined,
  )
})

test('candidate review operations remain in Tutor tool selection instead of restarting intake', () => {
  for (const message of [
    '检查候选 ltc_1234567890abcdef 的来源证据',
    '审计候选 ltc_1234567890abcdef 并执行确定性校验',
    '为候选 ltc_1234567890abcdef 准备 Tutor 审阅包',
    '调用 learning_task_conversion__inspect_learning_task_evidence 检查候选',
  ]) {
    assert.equal(
      directLearningTaskIntakeRequest(['learning_task_conversion'], 7, message),
      undefined,
    )
  }
})

test('explicit intake shortcut accepts both task-first and command-first phrasing', () => {
  assert.equal(
    directLearningTaskIntakeRequest(
      ['learning_task_conversion'],
      7,
      '生成学习型任务：新能源汽车电池安装',
    )?.rawInput,
    '新能源汽车电池安装',
  )
  assert.equal(
    directLearningTaskIntakeRequest(
      ['learning_task_conversion'],
      7,
      '把电脑 Windows 系统安装转化为学习型任务',
    )?.rawInput,
    '电脑 Windows 系统安装',
  )
})

test('selected role candidate re-enters the independent semantic preflight as an explicit work task', () => {
  assert.equal(
    directLearningTaskIntakeRequest(
      ['learning_task_conversion'],
      7,
      '生成学习型任务：“Unity摄像机跟随与遮挡修正模块开发”（来源于“Unity游戏客户端开发工程师”的已选任务候选）',
    )?.rawInput,
    'Unity摄像机跟随与遮挡修正模块开发',
  )
})

test('clicking a displayed task candidate reuses its exact intake without another model round', () => {
  const candidate = {
    id: 'task_unity_1',
    title: '2D 横版项目主摄像机的添加、摆放与马里奥式横向跟随',
    description: '在 Unity 2D 横版场景中完成主摄像机添加、正交摆放和横向跟随。',
    source: 'model_proposed',
    sourceRef: 'model-preflight:deepseek-chat',
  }
  const originalInput = 'unity摄像机放置与2D视角的跟随（类似于马里奥的摄像机）'
  const request = directLearningTaskCandidateSelectionRequest(
    ['learning_task_conversion'],
    7,
    `生成学习型任务：“${candidate.title}”（来源于“${originalInput}”的已选任务候选）`,
    [{
      role: 'assistant',
      content: '请选择任务',
      toolRuns: [{
        id: 'prepare-1', kind: 'plugin', status: 'completed', title: '准备', detail: '请选择', durationMs: 1,
        plugin: {
          pluginId: 'learning_task_conversion', toolId: 'prepare_learning_task_intake',
          result: {
            summary: '请选择',
            objects: [{
              protocol: 'learnflow-plugin-object.v1', pluginId: 'learning_task_conversion',
              objectType: 'learning_task_intake', objectId: 'lti_unity',
              schemaVersion: 'learning-task-conversion-intake.v1', label: '准备单',
              value: {
                originalInput, roleName: '', candidateTasks: [candidate],
                preflight: {
                  method: 'semantic_model', schemaVersion: 'learning-task-intake-model.v1',
                  model: 'deepseek-chat', assessedKind: 'ambiguous', confidence: 0.8, rationale: '任务范围候选。',
                },
              },
            }],
          },
        },
      } as any],
    }],
  )

  assert.equal(request?.rawInput, originalInput)
  assert.equal(request?.selectedTaskTitle, candidate.title)
  assert.equal(request?.selectedTaskDescription, candidate.description)
  assert.equal(request?.modelAssessment?.model, 'deepseek-chat')
})

test('direct learning-task intake performs exactly one semantic model round before the local plugin gate', async () => {
  const loaded = await registry()
  let modelCalls = 0
  let providerCalls = 0
  const result = await runTutorAgentTurn({
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    mode: 'learning_plan',
    messages: [{ role: 'user', content: '生成学习型任务：Unity游戏客户端开发工程师' }],
    toolChoice: 'auto',
    pluginRegistry: loaded,
    activePluginIds: ['learning_task_conversion'],
    formalProjectContext: { project: { id: 7 } } as any,
    generate: async () => {
      modelCalls += 1
      return JSON.stringify({
        schema_version: 'learning-task-intake-model.v1',
        original_input: 'Unity游戏客户端开发工程师',
        input_kind: 'role',
        role_name: 'Unity游戏客户端开发工程师',
        selected_task: null,
        candidate_tasks: [
          { title: 'Unity角色移动模块开发与验收', description: '实现移动、转向与验收。' },
          { title: 'Unity摄像机跟随与遮挡修正模块开发', description: '实现跟随与遮挡修正。' },
          { title: 'Unity场景异步加载与切换验收', description: '实现异步加载与切换验收。' },
        ],
        confidence: 0.96,
        rationale: '输入是岗位，需要先选择具体工作任务。',
        next_question: '请选择一个具体工作任务。',
      })
    },
    invokeProvider: async () => {
      providerCalls += 1
      throw new Error('ordinary provider must not run')
    },
  })
  assert.equal(modelCalls, 1)
  assert.equal(providerCalls, 0)
  assert.equal(result.trace.modelRounds, 1)
  assert.equal(result.toolRuns.length, 1)
  assert.equal(result.toolRuns[0].toolName, 'learning_task_conversion__prepare_learning_task_intake')
  assert.equal((result.toolRuns[0].plugin?.result.objects?.[0].value as any).preflight.method, 'semantic_model')
})

test('confirmed intake prompt maps directly to the hash-bound draft without another model round', () => {
  const prompt = learningTaskDraftConfirmationPrompt({
    originalInput: '新能源汽车电池安装',
    intakeId: 'lti_e1dd07c6',
    intakeRootHash: 'a'.repeat(64),
    taskContract: {
      title: '新能源汽车电池安装',
      description: '在实训工位完成电池安装并验收。',
      action: '安装',
      workObject: '新能源汽车电池',
      source: 'user_explicit',
      sourceRef: '',
    },
  })
  assert.deepEqual(
    directLearningTaskDraftConfirmationRequest(['learning_task_conversion'], 7, prompt),
    {
      originalInput: '新能源汽车电池安装',
      intakeId: 'lti_e1dd07c6',
      intakeRootHash: 'a'.repeat(64),
      intakeConfirmed: true,
      taskTitle: '新能源汽车电池安装',
      taskDescription: '在实训工位完成电池安装并验收。',
      taskSource: 'user_explicit',
      taskSourceRef: '',
    },
  )
})

test('confirmed intake uses the request project scope when project context is not yet available', async () => {
  const loaded = await registry()
  const prompt = learningTaskDraftConfirmationPrompt({
    originalInput: '新能源汽车电池的安装',
    intakeId: 'lti_e1dd07c6',
    intakeRootHash: 'a'.repeat(64),
    taskContract: {
      title: '新能源汽车电池的安装',
      description: '完成电池定位、固定、电气连接及安全检查。',
      action: '安装',
      workObject: '新能源汽车电池',
      source: 'user_explicit',
      sourceRef: '',
    },
  })
  let providerCalls = 0
  const executed: Array<{ name: string; args: Record<string, unknown> }> = []
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'free',
    messages: [{ role: 'user', content: prompt }],
    toolChoice: 'auto',
    pluginRegistry: loaded,
    activePluginIds: ['learning_task_conversion'],
    formalProjectId: 7,
    formalSessionId: 41,
    generate: async () => {
      throw new Error('semantic preflight must not run for a confirmed intake')
    },
    executeTool: async (name, args, _options, meta) => {
      executed.push({ name, args })
      return {
        run: {
          id: 'draft-run', kind: 'plugin', status: 'completed', title: '生成学习型任务候选',
          detail: '已生成候选', durationMs: 1, toolName: name, toolCallId: meta?.callId,
        },
        observation: { authority: 'learnflow_plugin_tool', summary: '已生成候选' },
      }
    },
    invokeProvider: async () => {
      providerCalls += 1
      throw new Error('ordinary provider must not run for a confirmed intake')
    },
  })

  assert.equal(providerCalls, 0)
  assert.equal(executed.length, 1)
  assert.equal(executed[0].name, 'learning_task_conversion__draft_learning_task')
  assert.equal(executed[0].args.intakeId, 'lti_e1dd07c6')
  assert.equal(result.trace.modelRounds, 0)
  assert.equal(result.toolRuns[0].status, 'completed')
  assert.match(result.reply, /尚未提交的候选/)
})

test('learning-task conversion contributes intake, candidate, confirmation and four read-only follow-up tools', async () => {
  const loaded = await registry()
  const tools = loaded.toolDefinitions(activation).filter(tool => tool.name.startsWith('learning_task_conversion__'))
  assert.deepEqual(tools.map(tool => tool.name), [
    'learning_task_conversion__prepare_learning_task_intake',
    'learning_task_conversion__draft_learning_task',
    'learning_task_conversion__read_learning_task_candidate',
    'learning_task_conversion__inspect_learning_task_evidence',
    'learning_task_conversion__audit_learning_task_candidate',
    'learning_task_conversion__prepare_learning_handoff',
    'learning_task_conversion__confirm_learning_task_candidate',
  ])
  assert.equal(tools.filter(tool => tool.risk === 'artifact').length, 2)
  assert.equal(tools.filter(tool => tool.risk === 'read_only').length, 5)
  assert.match(loaded.skillInstructions(activation), /第一步都调用 learning_task_conversion__prepare_learning_task_intake/)
  assert.match(loaded.skillInstructions(activation), /严禁同一轮继续 draft_learning_task/)
  assert.match(loaded.skillInstructions(activation), /不得声称已进入个性化学习或正式发布/)
  assert.match(loaded.skillInstructions(activation), /sourceSnapshot\.rootHash/)
})

test('prepare tool is local and draft requires its explicit hash-bound confirmation', async () => {
  const loaded = await registry()
  const calls: Array<{ operation: string; payload: any }> = []
  const preparedExecution = await loaded.execute('learning_task_conversion__prepare_learning_task_intake', {
    rawInput: '部署 Nginx 并验收 HTTPS',
  }, {
    ...activation,
    scope: { mode: 'learning_plan', sessionId: 41, conversationId: 'conversation-1', sheetId: 'sheet-2', projectId: 7 },
    signal: AbortSignal.timeout(5_000),
  })
  const intake = preparedExecution.result.objects?.[0].value as any
  assert.equal(preparedExecution.result.objects?.[0].objectType, 'learning_task_intake')
  assert.equal(intake.status, 'ready_for_confirmation')
  assert.equal(calls.length, 0)
  const execution = await loaded.execute('learning_task_conversion__draft_learning_task', {
    originalInput: intake.originalInput,
    intakeId: intake.intakeId,
    intakeRootHash: intake.intakeRootHash,
    intakeConfirmed: true,
    taskTitle: intake.taskContract.title,
    taskDescription: intake.taskContract.description,
    taskSource: intake.taskContract.source,
  }, {
    ...activation,
    scope: { mode: 'learning_plan', sessionId: 41, conversationId: 'conversation-1', sheetId: 'sheet-2', projectId: 7 },
    signal: AbortSignal.timeout(5_000),
    projectIntegration: {
      request: async (operation, payload) => {
        calls.push({ operation, payload })
        return sampleCandidate() as any
      },
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].operation, 'create_candidate')
  assert.equal(calls[0].payload.taskTitle, '部署 Nginx 并验收 HTTPS')
  assert.deepEqual(calls[0].payload.upstreamTask.learnflowOrigin, {
    sessionId: 41,
    conversationId: 'conversation-1',
    sheetId: 'sheet-2',
  })
  assert.deepEqual(calls[0].payload.upstreamTask.taskSource, { kind: 'user_explicit', ref: '' })
  assert.match(calls[0].payload.requestId, /^plugin:7:/)
  assert.equal(execution.result.objects?.[0].objectType, 'learning_task_candidate')
  assert.equal((execution.result.objects?.[0].value as any).lifecycle, 'candidate')
  assert.equal((execution.result.objects?.[0].value as any).confirmationStatus, 'unconfirmed')
  assert.equal((execution.result.payload as any).formalLearningTaskCreated, false)
  assert.equal((execution.result.payload as any).kernelWrites, 0)
  assert.equal(execution.result.presentation?.renderer, 'learning_task_conversion:learning_task_candidate')
})

test('prepare tool keeps its JSON contract when a model sends a partial assessment', async () => {
  const loaded = await registry()
  const freeActivation = { mode: 'free' as const, projectId: 7, activePluginIds: ['learning_task_conversion'] }
  const execution = await loaded.execute('learning_task_conversion__prepare_learning_task_intake', {
    rawInput: '方向A',
    modelAssessment: {},
  }, {
    ...freeActivation,
    scope: { mode: 'free', projectId: 7 },
    signal: AbortSignal.timeout(2_000),
  })

  assert.equal(typeof execution.result.payload, 'object')
  assert.equal((execution.result.payload as any).preflight.method, 'deterministic_guard')
})

test('candidate request id treats source version ids as an ordered-independent set', async () => {
  const loaded = await registry()
  const requestPayloads: any[] = []
  const preparedExecution = await loaded.execute('learning_task_conversion__prepare_learning_task_intake', {
    rawInput: '部署 Nginx 并验收 HTTPS',
  }, {
    ...activation,
    scope: { mode: 'learning_plan', conversationId: 'conversation-1', projectId: 7 },
    signal: AbortSignal.timeout(5_000),
  })
  const intake = preparedExecution.result.objects?.[0].value as any
  const context = {
    ...activation,
    scope: { mode: 'learning_plan' as const, conversationId: 'conversation-1', projectId: 7 },
    signal: AbortSignal.timeout(5_000),
    projectIntegration: {
      request: async (_operation: string, payload: any) => {
        requestPayloads.push(payload)
        return sampleCandidate() as any
      },
    },
  }
  const baseInput = {
    originalInput: intake.originalInput,
    intakeId: intake.intakeId,
    intakeRootHash: intake.intakeRootHash,
    intakeConfirmed: true,
    taskTitle: intake.taskContract.title,
    taskDescription: intake.taskContract.description,
    taskSource: intake.taskContract.source,
  }

  await loaded.execute('learning_task_conversion__draft_learning_task', {
    ...baseInput,
    sourceVersionIds: [9, 3, 9],
  }, context)
  await loaded.execute('learning_task_conversion__draft_learning_task', {
    ...baseInput,
    sourceVersionIds: [3, 9],
  }, context)

  assert.equal(requestPayloads[0].requestId, requestPayloads[1].requestId)
  assert.deepEqual(requestPayloads[0].sourceVersionIds, [3, 9])
  assert.deepEqual(requestPayloads[1].sourceVersionIds, [3, 9])
})

test('candidate request id covers every backend idempotency input', async () => {
  const loaded = await registry()
  const requestPayloads: any[] = []
  const preparedExecution = await loaded.execute('learning_task_conversion__prepare_learning_task_intake', {
    rawInput: '部署 Nginx 并验收 HTTPS',
  }, {
    ...activation,
    scope: { mode: 'learning_plan', conversationId: 'conversation-1', projectId: 7 },
    signal: AbortSignal.timeout(5_000),
  })
  const intake = preparedExecution.result.objects?.[0].value as any
  const context = {
    ...activation,
    scope: { mode: 'learning_plan' as const, conversationId: 'conversation-1', projectId: 7 },
    signal: AbortSignal.timeout(5_000),
    projectIntegration: {
      request: async (_operation: string, payload: any) => {
        requestPayloads.push(payload)
        return sampleCandidate() as any
      },
    },
  }
  const baseInput = {
    originalInput: intake.originalInput,
    intakeId: intake.intakeId,
    intakeRootHash: intake.intakeRootHash,
    intakeConfirmed: true,
    taskTitle: intake.taskContract.title,
    taskDescription: intake.taskContract.description,
    taskSource: intake.taskContract.source,
  }

  await loaded.execute('learning_task_conversion__draft_learning_task', {
    ...baseInput, targetStepCount: 5, maxSourceSegments: 8, upstreamTask: { lane: 'a' },
  }, context)
  await loaded.execute('learning_task_conversion__draft_learning_task', {
    ...baseInput, targetStepCount: 6, maxSourceSegments: 8, upstreamTask: { lane: 'a' },
  }, context)
  await loaded.execute('learning_task_conversion__draft_learning_task', {
    ...baseInput, targetStepCount: 5, maxSourceSegments: 9, upstreamTask: { lane: 'a' },
  }, context)
  await loaded.execute('learning_task_conversion__draft_learning_task', {
    ...baseInput, targetStepCount: 5, maxSourceSegments: 8, upstreamTask: { lane: 'b' },
  }, context)

  assert.equal(new Set(requestPayloads.map(payload => payload.requestId)).size, 4)
})

test('draft tool rejects missing or changed intake confirmation before provider access', async () => {
  const loaded = await registry()
  let providerCalls = 0
  await assert.rejects(() => loaded.execute('learning_task_conversion__draft_learning_task', {
    originalInput: '新能源汽车电池安装',
    intakeId: 'lti_invalid',
    intakeRootHash: '0'.repeat(64),
    intakeConfirmed: true,
    taskTitle: '新能源汽车电池安装',
    taskSource: 'user_explicit',
  }, {
    ...activation,
    scope: { mode: 'learning_plan', projectId: 7 }, signal: AbortSignal.timeout(5_000),
    projectIntegration: { request: async () => { providerCalls += 1; return sampleCandidate() as any } },
  }), /hash_mismatch/)
  assert.equal(providerCalls, 0)
})

test('only local intake is available outside project scope and plugin exposes no transport secrets', async () => {
  const loaded = await registry()
  const noProject = loaded.toolDefinitions({ mode: 'learning_plan', activePluginIds: ['learning_task_conversion'] })
  assert.deepEqual(
    noProject.filter(tool => tool.name.startsWith('learning_task_conversion__')).map(tool => tool.name),
    ['learning_task_conversion__prepare_learning_task_intake'],
  )
  const sources = [
    readFileSync(resolve(process.cwd(), 'plugins/learning_task_conversion/runtime.ts'), 'utf8'),
    readFileSync(resolve(process.cwd(), 'plugins/learning_task_conversion/client.tsx'), 'utf8'),
  ].join('\n')
  assert.doesNotMatch(sources, /XFYUN_API_KEY|XFYUN_API_SECRET|Authorization:|requestCookie|backendBase/)
  assert.match(sources, /formalLearningTaskCreated/)
})

test('read-only handoff explicitly remains a Tutor review candidate', async () => {
  const loaded = await registry()
  const candidate = sampleCandidate()
  const handoff = {
    schemaVersion: 'learnflow.personalized-learning-handoff.v1', candidateId: candidate.candidateId,
    status: 'ready_for_tutor_review', consumer: 'Tutor', requiresUserConfirmation: true,
    knowledgeId: '', taskSteps: candidate.task.steps, skills: [], resources: [], citations: [],
    returnContract: { schemaVersion: 'learnflow.personalized-learning-return.v1', allowedActions: ['review'] },
    candidate, validation: candidate.validation,
    instruction: '等待用户确认。', formalLearningTaskCreated: false, kernelWrites: 0,
  }
  const execution = await loaded.execute('learning_task_conversion__prepare_learning_handoff', {
    candidateId: candidate.candidateId,
  }, {
    ...activation,
    scope: { mode: 'learning_plan', projectId: 7 }, signal: AbortSignal.timeout(5_000),
    projectIntegration: { request: async operation => {
      assert.equal(operation, 'prepare_handoff')
      return handoff as any
    } },
  })
  assert.equal((execution.result.objects?.[0].value as any).requiresUserConfirmation, true)
  assert.equal((execution.result.objects?.[0].value as any).formalLearningTaskCreated, false)
  assert.equal((execution.result.objects?.[0].value as any).schemaVersion, 'learnflow.personalized-learning-handoff.v1')
  assert.equal((execution.result.objects?.[0].value as any).taskSteps.length, 3)
  assert.match(execution.result.summary, /用户确认前不会创建正式学习任务/)
})

test('explicit confirmation is root-hash bound and returns a formal task without mastery claims', async () => {
  const loaded = await registry()
  const candidate = sampleCandidate()
  const calls: Array<{ operation: string; payload: any }> = []
  const result = {
    schemaVersion: 'learning-task-candidate-confirmation-result.v1',
    candidateId: candidate.candidateId,
    created: true,
    formalLearningTaskCreated: true,
    learningTask: {
      id: 91, title: candidate.task.title, objective: candidate.task.learningObjective,
      plan: { work_steps: candidate.task.steps, phases: [{ kind: 'learn' }, { kind: 'practice' }, { kind: 'verify' }, { kind: 'consolidate' }] },
    },
    navigation: { kind: 'task', path: '/tasks?task=91' },
    managementNavigation: { kind: 'task', path: '/tasks?task=91' },
    masteryChanged: false,
    kernelWrites: 0,
  }
  const execution = await loaded.execute('learning_task_conversion__confirm_learning_task_candidate', {
    candidateId: candidate.candidateId,
    expectedRootHash: candidate.sourceSnapshot.rootHash,
    confirmed: true,
  }, {
    ...activation,
    scope: { mode: 'learning_plan', projectId: 7 }, signal: AbortSignal.timeout(5_000),
    projectIntegration: { request: async (operation, payload) => {
      calls.push({ operation, payload })
      return result as any
    } },
  })
  assert.equal(calls[0].operation, 'confirm_candidate')
  assert.equal(calls[0].payload.expectedRootHash, 'a'.repeat(64))
  assert.equal(calls[0].payload.confirmed, true)
  assert.match(calls[0].payload.confirmationId, /^plugin-confirm:/)
  assert.equal(execution.result.objects?.[0].objectType, 'learning_task_confirmation')
  assert.equal(execution.result.objects?.[0].schemaVersion, 'learning-task-candidate-confirmation-result.v1')
  assert.equal((execution.result.payload as any).formalLearningTaskCreated, true)
  assert.equal((execution.result.payload as any).masteryChanged, false)
  assert.equal((execution.result.payload as any).kernelWrites, 0)
  assert.equal(execution.result.presentation?.renderer, 'learning_task_conversion:learning_task_confirmation')
})
