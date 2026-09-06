import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAgentProviderRequest,
  repairTutorDraftForObservedGaps,
  runTutorAgentTurn,
  reasoningContentFromProviderResponse,
  tutorAgentBudget,
  toolCallsFromProviderResponse,
  verifyTutorTurnOutcome,
} from './agent-runtime.ts'
import { createInitialLearnerPathState } from '../src/learning-path-graph.ts'
import { createLearningTask, learningTaskTutorContext, projectLearningTask } from '../src/learning.ts'
import { executeTutorAgentTool } from './tool-runtime.ts'
import { buildProviderRequest } from '../src/tutor.ts'
import { AI_LATENCY_BUDGETS } from '../src/latency-budgets.ts'
import { parseVisualTeachingBrief } from './visual-teaching-skill.ts'

test('project observation includes scoped guidance but omits future case and private paper content', async () => {
  const context = {
    project: { id: 7, name: '本地实验', project_mode: 'experiment' }, checkpoint_id: 10,
    roadmap: { revision: 1, checkpoints: [] }, learning_tasks: [], sources: [], learning_files: {}, tool_policy: {},
    project_workflow: { project_mode: 'experiment', initialized: true, workbench: { secret: 'PRIVATE_PAPER' },
      evaluator: 'PRIVATE_EVALUATOR', milestones: [
        { checkpoint_id: 10, title: '当前', status: 'available', materials: [{ title: '输入', body: 'CURRENT_INPUT' }], fields: [{ key: 'prediction', label: '预测' }] },
        { checkpoint_id: 11, title: '后续', status: 'locked', materials: [{ title: '隐藏', body: 'FUTURE_INPUT' }], submission: { answers: { secret: 'FUTURE_ANSWER' } } },
      ] },
  } as any
  const result = await executeTutorAgentTool('read_project_workspace', {}, { message: '如何开始', mode: 'guided_learning', formalProjectContext: context, generate: async () => 'unused' })
  const observation = JSON.stringify(result.observation)
  assert.match(observation, /CURRENT_INPUT/)
  assert.match(observation, /先请学生预测/)
  assert.doesNotMatch(observation, /PRIVATE_PAPER|PRIVATE_EVALUATOR|FUTURE_INPUT|FUTURE_ANSWER/)
})

function visualTeachingPayload(kind: 'diagram' | 'animation', topic = '联邦学习聚合过程') {
  return JSON.stringify({
    topic,
    learning_goal: `理解${topic}中的对象、关系与结果`,
    modality_rationale: kind === 'animation' ? '过程包含按顺序发生的训练、上传与聚合变化' : '图解适合同时检查客户端与聚合服务器的稳定关系',
    explanation: '联邦学习由多个客户端和一个聚合服务器组成，各客户端保留自己的本地数据。初始时客户端持有同一轮全局模型，随后分别训练并上传参数更新，服务器聚合这些更新形成新的全局模型。整个过程中原始训练数据不上传，但参数更新仍可能带来隐私风险，因此不能把联邦学习理解为天然安全。',
    objects: [
      { id: 'client', label: '客户端', role: '本地训练并上传参数更新' },
      { id: 'server', label: '聚合服务器', role: '聚合更新并发布全局模型' },
    ],
    relations: [{ from: 'client', to: 'server', label: '上传参数更新' }],
    initial_state: '客户端持有同一轮全局模型，服务器等待更新',
    steps: kind === 'animation' ? [
      { id: 'local_train', title: '本地训练', before: '客户端持有全局模型', change: '客户端使用本地数据训练', after: '客户端得到本地更新', why: '原始数据留在本地' },
      { id: 'aggregate', title: '聚合更新', before: '服务器收到多个本地更新', change: '服务器对更新进行聚合', after: '形成新一轮全局模型', why: '合并分散学习结果' },
    ] : [],
    final_state: '服务器形成新的全局模型并可广播给客户端',
    invariants: ['原始训练数据不直接上传'],
    misconceptions: ['参数不等于完全没有隐私风险'],
    claim_boundary: '只说明客户端训练、上传更新和服务器聚合，不声称具体聚合算法或隐私保证',
  })
}

const visualTeachingExplanation = '联邦学习由多个客户端和一个聚合服务器组成，各客户端保留自己的本地数据。初始时客户端持有同一轮全局模型，随后分别训练并上传参数更新，服务器聚合这些更新形成新的全局模型。整个过程中原始训练数据不上传，但参数更新仍可能带来隐私风险，因此不能把联邦学习理解为天然安全。'

test('interactive budgets preserve outer ownership and bounded provider calls', () => {
  assert.ok(AI_LATENCY_BUDGETS.tutorClient.standard > AI_LATENCY_BUDGETS.agentTurn.standard)
  assert.ok(AI_LATENCY_BUDGETS.tutorClient.diagram > AI_LATENCY_BUDGETS.agentTurn.diagram)
  assert.ok(AI_LATENCY_BUDGETS.tutorClient.animation > AI_LATENCY_BUDGETS.agentTurn.animation)
  assert.ok(AI_LATENCY_BUDGETS.agentTurn.standard > AI_LATENCY_BUDGETS.providerRequest)
  assert.ok(AI_LATENCY_BUDGETS.visualPlanner.animation > AI_LATENCY_BUDGETS.visualPlanner.diagram)
})

test('guided learning receives a larger but still bounded runtime budget', () => {
  const simple = tutorAgentBudget('simple_explain')
  const guided = tutorAgentBudget('guided_learning')
  assert.deepEqual(simple, {
    maxModelRounds: 5,
    maxToolCalls: 8,
    maxWallTimeMs: 360_000,
    finalizationAttempts: 1,
    finalizationGraceMs: 25_000,
  })
  assert.deepEqual(guided, {
    maxModelRounds: 9,
    maxToolCalls: 14,
    maxWallTimeMs: 540_000,
    finalizationAttempts: 2,
    finalizationGraceMs: 45_000,
  })
  assert.equal(tutorAgentBudget('simple_explain', 'diagram').maxWallTimeMs, 600_000)
  assert.equal(tutorAgentBudget('simple_explain', 'animation').maxWallTimeMs, 720_000)
  assert.equal(tutorAgentBudget('guided_learning', 'animation').maxWallTimeMs, 720_000)
})

test('provider tool calls are normalized for chat completions and responses APIs', () => {
  assert.deepEqual(toolCallsFromProviderResponse({
    choices: [{ message: { tool_calls: [{
      id: 'chat-1', function: { name: 'lookup_learning_path_node', arguments: '{"query":"机器学习"}' },
    }] } }],
  }), [{ id: 'chat-1', name: 'lookup_learning_path_node', arguments: { query: '机器学习' } }])

  assert.deepEqual(toolCallsFromProviderResponse({
    output: [{ type: 'function_call', call_id: 'responses-1', name: 'read_learner_context', arguments: '{"query":"先修基础"}' }],
  }), [{ id: 'responses-1', name: 'read_learner_context', arguments: { query: '先修基础' } }])
})

test('provider reasoning content is extracted only from chat assistant messages', () => {
  assert.equal(reasoningContentFromProviderResponse({
    choices: [{ message: { reasoning_content: '原样回传的思考内容' } }],
  }), '原样回传的思考内容')
  assert.equal(reasoningContentFromProviderResponse({ output: [] }), '')
})

test('provider requests expose real tool definitions in both API dialects', () => {
  const tool = {
    name: 'read_learner_context', title: '读取', description: '读取上下文', toolClass: 'perception' as const, risk: 'read_only' as const,
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false as const },
  }
  const chat = buildAgentProviderRequest({
    baseUrl: 'https://example.com/v1/chat/completions', model: 'm', instructions: 'system',
    messages: [{ role: 'user', content: 'hello' }], tools: [tool], includeTools: true,
  })
  assert.equal(Array.isArray((chat.body as any).tools), true)
  assert.equal((chat.body as any).tools[0].function.name, 'read_learner_context')

  const responses = buildAgentProviderRequest({
    baseUrl: 'https://example.com/v1/responses', model: 'm', instructions: 'system',
    messages: [{ role: 'user', content: 'hello' }], tools: [tool], includeTools: true,
  })
  assert.equal((responses.body as any).tools[0].name, 'read_learner_context')
})

test('chat continuation preserves opaque reasoning content on ordinary assistant messages', () => {
  const chat = buildAgentProviderRequest({
    baseUrl: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-reasoner', instructions: 'system',
    messages: [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答', reasoningContent: '上一轮推理载荷' },
      { role: 'user', content: '继续' },
    ],
    tools: [], includeTools: false,
  })
  const assistant = (chat.body as any).messages.find((message: any) => message.role === 'assistant')
  assert.equal(assistant.reasoning_content, '上一轮推理载荷')
})

test('DeepSeek continuation omits unreplayable legacy assistant turns', async () => {
  const requests: any[] = []
  const result = await runTutorAgentTurn({
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-reasoner',
    mode: 'free',
    messages: [
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '修复前保存、没有 reasoning_content 的旧回答' },
      { role: 'user', content: '继续说明' },
    ],
    toolChoice: 'auto',
    generate: async () => 'unused',
    invokeProvider: async request => {
      requests.push(request)
      return { choices: [{ message: { content: '可以继续。', reasoning_content: '新推理载荷' } }] }
    },
  })
  assert.equal(result.reply, '可以继续。')
  assert.equal(result.reasoningContent, '新推理载荷')
  assert.equal(requests[0].body.messages.some((message: any) => message.content?.includes('修复前保存')), false)
  assert.equal(requests[0].body.messages.some((message: any) => message.content === '旧问题'), true)
})

test('visual planning requests use provider-native JSON object mode in both API dialects', () => {
  const chat = buildProviderRequest({
    baseUrl: 'https://example.com/v1/chat/completions', model: 'm', instructions: 'json',
    messages: [{ role: 'user', content: 'plan' }], responseFormat: 'json_object',
  })
  assert.deepEqual((chat.body as any).response_format, { type: 'json_object' })
  const responses = buildProviderRequest({
    baseUrl: 'https://example.com/v1/responses', model: 'm', instructions: 'json',
    messages: [{ role: 'user', content: 'plan' }], responseFormat: 'json_object',
  })
  assert.deepEqual((responses.body as any).text, { format: { type: 'json_object' } })
})

test('final-state verifier rejects unconfirmed writes, mastery overclaims and hidden failures', () => {
  const proposalRun: any = {
    id: 'path', kind: 'path', status: 'completed', title: '路径', detail: 'proposal', durationMs: 1,
    pathProposal: { id: 'p' },
  }
  assert.deepEqual(verifyTutorTurnOutcome({
    reply: '我已经把这个节点加入个人学习路径。', mode: 'learning_plan', toolRuns: [proposalRun],
  }).violations, ['unconfirmed_path_write_claim'])
  assert.deepEqual(verifyTutorTurnOutcome({
    reply: '这说明你已经完全掌握了哈希表。', mode: 'guided_learning', toolRuns: [],
  }).violations, ['unsupported_mastery_claim'])
  assert.deepEqual(verifyTutorTurnOutcome({
    reply: '下面给出正常答案。', mode: 'free', toolRuns: [{
      id: 'search', kind: 'search', status: 'failed', title: '搜索', detail: '503', durationMs: 1,
    }],
  }).violations, ['hidden_tool_failure'])
  assert.deepEqual(verifyTutorTurnOutcome({
    reply: '我已经按新的信息更新画像，下面继续学习。', mode: 'guided_learning', toolRuns: [],
    observations: [{
      source: 'read_learner_context', authority: 'formal', answerFree: true,
      data: { conflicts: [{ subject: 'tool-calling', text: '旧 Claim 与新自述冲突' }] },
    }],
  }).violations, ['silent_memory_conflict'])
  assert.deepEqual(verifyTutorTurnOutcome({
    reply: '这里有一条新自述和旧 Claim 不一致，需要你确认保留哪一条；本轮不会静默覆盖。',
    mode: 'guided_learning', toolRuns: [],
    observations: [{
      source: 'read_learner_context', authority: 'formal', answerFree: true,
      data: { conflicts: [{ subject: 'tool-calling', text: '旧 Claim 与新自述冲突' }] },
    }],
  }).violations, [])
  const emptyEvidenceObservation: any = [{
    source: 'read_learning_workspace', authority: 'formal', answerFree: true,
    data: { learningEvidence: { manifest: { attempt_count: 0 } } },
  }]
  assert.deepEqual(verifyTutorTurnOutcome({
    reply: '这说明你是第一次正式学习贝叶斯公式。', mode: 'guided_learning', toolRuns: [],
    observations: emptyEvidenceObservation,
  }).violations, ['unsupported_learning_history_claim'])
  assert.deepEqual(verifyTutorTurnOutcome({
    reply: '当前作用域没有可见的练习记录，所以我不会假设你以前是否学过。',
    mode: 'guided_learning', toolRuns: [], observations: emptyEvidenceObservation,
  }).violations, [])
})

test('a useful teaching draft is repaired for observable tool gaps instead of being discarded', () => {
  const sourceUrl = 'https://docs.example.edu/ensembles'
  const runs: any[] = [
    {
      id: 'visual', kind: 'visual', status: 'failed', title: '生成学习图解',
      detail: '模型没有返回图解', durationMs: 50,
    },
    {
      id: 'search', kind: 'search', status: 'completed', title: '计算机知识搜索',
      detail: '取得部分来源', durationMs: 10,
      searchMeta: { status: 'partial', coverageRatio: 0.5 },
      sources: [{
        title: 'Ensemble methods', url: sourceUrl, snippet: 'Bagging and boosting.',
        source: 'Example University', quality: 'academic', role: 'course', reason: '课程资料', provider: 'test',
      }],
    },
  ]
  const repaired = repairTutorDraftForObservedGaps(
    'Bagging 并行训练多个基学习器，Boosting 则按顺序纠正前一轮的错误。',
    runs,
  )

  assert.match(repaired, /Bagging 并行训练/)
  assert.match(repaired, /生成学习图解.*暂时未能成功/s)
  assert.match(repaired, /资料覆盖仍有缺口/)
  assert.match(repaired, new RegExp(sourceUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.deepEqual(verifyTutorTurnOutcome({
    reply: repaired, mode: 'guided_learning', toolRuns: runs,
  }).violations, [])
})

test('plugin grounding disclosure is enforced without a plugin-specific host branch', () => {
  const repaired = repairTutorDraftForObservedGaps('这是插件返回的领域说明。', [{
    id: 'plugin-grounding', kind: 'plugin', status: 'completed', title: '领域概览', detail: '完成', durationMs: 1,
    plugin: {
      pluginId: 'fixture_domain', toolId: 'overview',
      result: {
        summary: '完成',
        payload: { grounding: { requiredDisclosure: '事实固定于 snapshot:fixture；其他内容必须标为非插件结论。' } },
      },
    },
  } as any])
  assert.match(repaired, /事实边界：事实固定于 snapshot:fixture/)
  assert.doesNotMatch(repaired, /role_capability_graph|岗位图谱/)
})

test('Tutor runs a bounded observe-act-observe loop and preserves tool results', async () => {
  const requests: any[] = []
  let round = 0
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'simple_explain',
    messages: [{ role: 'user', content: '机器学习之前应该先学什么？' }],
    toolChoice: 'auto',
    learnerPathState: createInitialLearnerPathState(),
    generate: async () => 'unused',
    invokeProvider: async request => {
      requests.push(request)
      round += 1
      if (round === 1) {
        return { choices: [{ message: { content: null, tool_calls: [{
          id: 'path-call', type: 'function', function: { name: 'lookup_learning_path_node', arguments: '{"query":"机器学习前置"}' },
        }] } }] }
      }
      return { choices: [{ message: { content: '建议先补线性代数、概率统计和 Python，再进入机器学习。' } }] }
    },
  })

  assert.match(result.reply, /线性代数/)
  assert.equal(result.trace.modelRounds, 2)
  assert.equal(result.trace.toolCalls, 1) // 普通解释不预读五核，只保留模型真正需要的路径读取
  assert.deepEqual(result.toolRuns.map(run => run.kind), ['path'])
  assert.equal(result.trace.decisionSummaries?.length, 1)
  assert.equal(result.trace.decisionSummaries?.[0]?.toolCallId, 'path-call')
  assert.match(result.trace.decisionSummaries?.[0]?.reason || '', /路径/)
  assert.ok(requests[0].body.tools.length >= 3)
  assert.ok(requests[1].body.messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'path-call'))
})

test('Tutor passes DeepSeek reasoning content back unchanged with the assistant tool call', async () => {
  const requests: any[] = []
  let round = 0
  const reasoningContent = '必须逐字保留的 reasoning payload'
  const result = await runTutorAgentTurn({
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-reasoner',
    mode: 'simple_explain',
    messages: [{ role: 'user', content: '机器学习之前应该先学什么？' }],
    toolChoice: 'auto',
    learnerPathState: createInitialLearnerPathState(),
    generate: async () => 'unused',
    invokeProvider: async request => {
      requests.push(request)
      round += 1
      if (round === 1) {
        return { choices: [{ message: {
          content: null,
          reasoning_content: reasoningContent,
          tool_calls: [{
            id: 'path-reasoning-call',
            type: 'function',
            function: { name: 'lookup_learning_path_node', arguments: '{"query":"机器学习前置"}' },
          }],
        } }] }
      }
      return { choices: [{ message: { content: '建议先补线性代数和概率统计。' } }] }
    },
  })

  assert.match(result.reply, /线性代数/)
  const followupMessages = requests[1].body.messages
  const assistantToolMessages = followupMessages.filter((message: any) => message.role === 'assistant' && message.tool_calls)
  assert.equal(assistantToolMessages.length, 1)
  assert.equal(assistantToolMessages[0].reasoning_content, reasoningContent)
  assert.equal(assistantToolMessages[0].tool_calls[0].id, 'path-reasoning-call')
  assert.ok(followupMessages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'path-reasoning-call'))
})

test('provider deltas reach the UI live and a tool decision resets only the draft round', async () => {
  const events: any[] = []
  let round = 0
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'simple_explain',
    messages: [{ role: 'user', content: '解释一下梯度下降' }],
    toolChoice: 'auto',
    generate: async () => 'unused',
    observe: event => events.push(event),
    invokeProvider: async request => {
      round += 1
      if (round === 1) {
        request.onTextDelta?.('我先查一下。')
        return { choices: [{ message: { content: '我先查一下。', tool_calls: [{
          id: 'search-1', function: {
            name: 'search_computer_knowledge', arguments: '{"query":"梯度下降定义"}',
          },
        }] } }] }
      }
      request.onTextDelta?.('梯度下降会沿着')
      request.onTextDelta?.('损失函数下降方向更新参数。')
      return { choices: [{ message: { content: '梯度下降会沿着损失函数下降方向更新参数。' } }] }
    },
    executeTool: async (name, args, options, meta) => {
      if (name === 'search_computer_knowledge') return {
        run: {
          id: 'search-run', kind: 'search', toolName: name, toolCallId: meta?.callId,
          status: 'completed', title: '联网搜索', detail: '已取得定义来源', durationMs: 3,
        },
        observation: { authority: 'search', query: args.query },
      }
      return executeTutorAgentTool(name, args, options, meta)
    },
  })

  const reset = events.findIndex(event => event.type === 'text_reset' && event.reason === 'tool_call')
  const toolStarted = events.findIndex(event => event.type === 'tool_started' && event.toolName === 'search_computer_knowledge')
  const decision = events.find(event => event.type === 'decision_summary' && event.summary.toolCallId === 'search-1')
  assert.ok(reset >= 0 && toolStarted > reset)
  assert.match(decision?.summary.observation || '', /定义来源/)
  const finalDeltas = events.slice(reset + 1).filter(event => event.type === 'text_delta').map(event => event.delta).join('')
  assert.equal(finalDeltas, result.reply)
  assert.equal(result.trace.timings?.totalMs >= 0, true)
  assert.equal(typeof result.trace.timings?.firstTextDeltaMs, 'number')
})

test('Tutor continues a token-limited provider answer before accepting the final state', async () => {
  const events: any[] = []
  const requests: any[] = []
  let round = 0
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'learning_plan',
    messages: [{ role: 'user', content: '给我一个三个月的大模型应用工程学习计划' }],
    toolChoice: 'auto',
    generate: async () => 'unused',
    taskQueue: [],
    knowledgeDomains: [],
    observe: event => events.push(event),
    invokeProvider: async request => {
      requests.push(request)
      round += 1
      if (round === 1) {
        request.onTextDelta?.('第一阶段先补工程基础，')
        return { choices: [{ message: { content: '第一阶段先补工程基础，' }, finish_reason: 'length' }] }
      }
      request.onTextDelta?.('第二阶段完成可评测的 RAG 项目。')
      return { choices: [{ message: { content: '第二阶段完成可评测的 RAG 项目。' }, finish_reason: 'stop' }] }
    },
  })
  assert.equal(result.reply, '第一阶段先补工程基础，第二阶段完成可评测的 RAG 项目。')
  assert.equal(result.trace.modelRounds, 2)
  assert.equal(requests[0].body.max_tokens, 6_000)
  assert.equal(requests[1].body.tools, undefined)
  assert.ok(events.some(event => event.type === 'trajectory' && /输出上限中断/.test(event.event.detail)))
})

test('guided learning keeps the learner in flow when the provider returns no teaching text', async () => {
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'empty-model',
    mode: 'guided_learning',
    messages: [{ role: 'user', content: '带我学习一下集成学习' }],
    toolChoice: 'auto',
    learningTaskContext: {
      objectType: 'learning_task_binding',
      authority: 'formal_learning_task',
      taskId: 'task-ensemble',
      objective: '集成学习',
      skillId: 'guided_explanation',
      skillName: '清晰讲解',
      substateId: 'guidance',
      substateLabel: '引导态',
      stepId: 'presenting_core_model',
      stepTitle: '建立核心模型',
      stepIndex: 0,
      stepCount: 4,
      stepInstruction: '先用一句话说明集成学习解决什么问题，再请学习者比较 Bagging 和 Boosting。',
      nextAction: '等待学习者比较两种方法',
      loopCount: 0,
      loopInstruction: '必要时提供一个最小例子。',
    },
    generate: async () => 'unused',
    invokeProvider: async () => ({ choices: [{ message: { content: '' } }] }),
    executeTool: async (name, _args, _options, meta) => ({
      run: {
        id: `run-${name}`,
        kind: name === 'read_learner_context' ? 'memory' : 'workspace',
        toolName: name,
        toolCallId: meta?.callId,
        status: 'completed',
        title: name,
        detail: '当前作用域读取完成',
        observationSummary: '当前作用域读取完成，没有需要阻断教学的冲突。',
        durationMs: 0,
      },
      observation: { authority: 'test_read_only' },
    }),
  })

  assert.match(result.reply, /集成学习/)
  assert.doesNotMatch(result.reply, /没有返回可显示的教学内容|请求失败/)
  assert.equal(result.trace.stopReason, 'forced_finalize')
  assert.equal(result.trace.decisionSummaries?.length, 2)
})

test('Tutor searches candidates, reads an allow-listed page, and cites the exact evidence URL', async () => {
  const url = 'https://docs.example.edu/gradient-descent'
  let round = 0
  let readReceivedAllowList = false
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'simple_explain',
    messages: [{ role: 'user', content: '梯度下降为什么沿负梯度更新？请给可靠依据。' }],
    toolChoice: 'auto',
    generate: async () => 'unused',
    executeTool: async (name, args, options, meta) => {
      if (name === 'search_computer_knowledge') {
        const source = {
          title: 'Gradient descent notes', url, snippet: 'The negative gradient is the steepest local descent direction.',
          source: 'Example University', quality: 'academic' as const, role: 'course' as const,
          reason: '大学课程讲义', provider: 'test', readState: 'search_snippet' as const,
        }
        return {
          run: {
            id: 'search-candidates', kind: 'search', toolName: name, toolCallId: meta?.callId,
            status: 'completed', title: '联网搜索', detail: '候选来源已取得', durationMs: 1,
            sources: [source], searchMeta: { intent: 'concept', depth: 'standard', status: 'ok', coverageRatio: 1 },
          },
          observation: { authority: 'untrusted_web_evidence_bundle_v2', sources: [source] },
          searchSourceUrls: [url], searchSources: [source],
        }
      }
      if (name === 'read_web_evidence') {
        readReceivedAllowList = meta?.sourceUrls?.includes(url) === true && args.url === url
        const source = {
          title: 'Gradient descent notes', url,
          snippet: 'For a differentiable function, the negative gradient gives the direction of steepest local decrease.',
          source: 'Example University', quality: 'academic' as const, role: 'course' as const,
          reason: '已读取的大学课程讲义', provider: 'test', readState: 'page_excerpt' as const,
        }
        return {
          run: {
            id: 'read-page', kind: 'search', toolName: name, toolCallId: meta?.callId,
            status: 'completed', title: '读取网页证据', detail: '已抽取相关段落', durationMs: 1,
            sources: [source], searchMeta: { status: 'ok', pageRead: true },
          },
          observation: { authority: 'untrusted_web_page', excerpt: source.snippet },
          searchSourceUrls: [url], searchSources: [source],
        }
      }
      return executeTutorAgentTool(name, args, options, meta)
    },
    invokeProvider: async request => {
      round += 1
      if (round === 1) return { choices: [{ message: { tool_calls: [{
        id: 'search-gradient', function: { name: 'search_computer_knowledge', arguments: '{"query":"gradient descent negative gradient reliable explanation","depth":"standard"}' },
      }] } }] }
      if (round === 2) return { choices: [{ message: { tool_calls: [{
        id: 'read-gradient', function: { name: 'read_web_evidence', arguments: JSON.stringify({ url, query: 'why negative gradient descends' }) },
      }] } }] }
      assert.ok(request.body.messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'read-gradient'))
      return { choices: [{ message: { content: `负梯度给出函数在当前位置下降最快的一阶方向。[课程讲义](${url})` } }] }
    },
  })

  assert.equal(readReceivedAllowList, true)
  const evidenceRuns = result.toolRuns.filter(run => run.kind === 'search')
  assert.deepEqual(evidenceRuns.map(run => run.toolName), ['search_computer_knowledge', 'read_web_evidence'])
  assert.equal(evidenceRuns[1].searchMeta?.pageRead, true)
  assert.match(result.reply, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(result.trace.events.some(event => event.phase === 'verify' && event.status === 'failed'), false)
})

test('duplicate tool calls are blocked and the model can recover to a final answer', async () => {
  let round = 0
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'free',
    messages: [{ role: 'user', content: '帮我看看机器学习路线' }],
    toolChoice: 'auto',
    learnerPathState: createInitialLearnerPathState(),
    generate: async () => 'unused',
    invokeProvider: async () => {
      round += 1
      if (round <= 2) return { choices: [{ message: { tool_calls: [{
        id: `path-${round}`, function: { name: 'lookup_learning_path_node', arguments: '{"query":"机器学习路线"}' },
      }] } }] }
      return { choices: [{ message: { content: '我已经依据现有路径整理出前置关系。' } }] }
    },
  })
  assert.match(result.reply, /前置关系/)
  assert.equal(result.toolRuns.filter(run => run.kind === 'path').length, 1)
  assert.ok(result.trace.events.some(event => event.status === 'blocked' && /重复/.test(event.detail)))
})

test('a transient provider failure is retried once inside the shared turn budget', async () => {
  let attempts = 0
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'free',
    messages: [{ role: 'user', content: '解释一下哈希表' }],
    toolChoice: 'auto',
    generate: async () => 'unused',
    invokeProvider: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('503 temporary provider failure')
      return { choices: [{ message: { content: '哈希表把键通过哈希函数映射到数组位置。' } }] }
    },
  })
  assert.equal(attempts, 2)
  assert.match(result.reply, /哈希函数/)
  assert.ok(result.trace.events.some(event => event.status === 'retrying'))
})

test('guided turns observe the formal task queue and never expose write tools', async () => {
  const requests: any[] = []
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'guided_learning',
    messages: [{ role: 'user', content: '继续学习二分查找' }],
    toolChoice: 'auto',
    taskQueue: [{ id: 7, objective: '实现并解释二分查找', status: 'active', sourceType: 'chat' }],
    knowledgeDomains: [],
    generate: async () => 'unused',
    invokeProvider: async request => {
      requests.push(request)
      return { choices: [{ message: { content: '我们继续围绕循环不变量，用一个最小数组检查边界更新。' } }] }
    },
  })
  assert.deepEqual(result.toolRuns.map(run => run.kind), ['memory', 'workspace'])
  assert.match(result.toolRuns[1].detail, /1 个正式队列任务/)
  const exposed = requests[0].body.tools.map((tool: any) => tool.function.name)
  assert.ok(exposed.includes('read_learning_workspace'))
  assert.ok(!exposed.some((name: string) => /write|update|commit|confirm|create|delete/.test(name)))
})

test('dynamic practice tools are scoped to a formal guided checkpoint and stream observable progress', async () => {
  const guidedProjectContext = {
    ...formalProjectContext,
    checkpoint_id: 45,
  }
  const learningTaskContext = {
    objectType: 'learning_task_binding',
    authority: 'formal_learning_task',
    formalTaskId: 81,
    taskId: 'formal-task-81',
    objective: '用执行轨迹检测 Python 循环边界理解',
    skillId: 'worked_example_fading',
    skillName: '例题渐隐',
    substateId: 'practice',
    substateLabel: '练习态',
    stepId: 'independent_attempt',
    stepTitle: '独立尝试',
    stepIndex: 2,
    stepCount: 4,
    stepInstruction: '独立完成一组短题。',
    nextAction: '检查迁移',
    loopCount: 0,
    loopInstruction: '换一组表面不同但技能相同的题。',
  } as const
  const requests: any[] = []
  const events: any[] = []
  let round = 0
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'guided_learning',
    messages: [{ role: 'user', content: '给我两道循环执行轨迹题动态检测一下' }],
    toolChoice: 'auto',
    formalProjectContext: guidedProjectContext,
    formalLearnerContext: guidedProjectContext.five_kernel_context,
    learningTaskContext: learningTaskContext as any,
    generate: async () => 'unused',
    observe: event => events.push(event),
    executeTool: async (name, args, options, meta) => {
      if (name === 'generate_dynamic_practice') {
        return {
          run: {
            id: 'dynamic-practice-run',
            kind: 'file',
            toolName: name,
            toolCallId: meta?.callId,
            status: 'completed',
            title: '生成动态练习文件',
            detail: '已生成 2 道题并通过静态质量检查。',
            observationSummary: '2 题 · validated_static_uncalibrated',
            durationMs: 12,
            learningFile: {
              kind: 'practice', ref: 'practice-set-test', title: '循环执行轨迹动态检测',
              checkpointId: 45, questionCount: 2, qualityStatus: 'validated_static_uncalibrated',
            },
          },
          observation: {
            authority: 'formal_dynamic_practice_file',
            evidence_boundary: '正式提交并确定性判题后才形成证据。',
          },
        }
      }
      return executeTutorAgentTool(name, args, options, meta)
    },
    invokeProvider: async request => {
      requests.push(request)
      round += 1
      if (round === 1) {
        return { choices: [{ message: { tool_calls: [{
          id: 'generate-practice',
          function: {
            name: 'generate_dynamic_practice',
            arguments: JSON.stringify({
              learning_task_id: 81,
              title: '循环执行轨迹动态检测',
              concept: 'Python 循环边界',
              purpose: 'diagnostic',
              difficulty: 'medium',
              item_types: ['code_output', 'trace_table'],
              count: 2,
            }),
          },
        }] } }] }
      }
      return { choices: [{ message: { content: '练习文件已经生成。打开后先独立作答；提交后系统才会形成可检查的学习证据。' } }] }
    },
  })

  const exposed = requests[0].body.tools.map((tool: any) => tool.function.name)
  assert.ok(exposed.includes('design_assessment_blueprint'))
  assert.ok(exposed.includes('generate_dynamic_practice'))
  assert.ok(exposed.includes('generate_similar_practice'))
  assert.ok(exposed.includes('inspect_practice_quality'))
  assert.equal(result.toolRuns.at(-1)?.learningFile?.ref, 'practice-set-test')
  const started = events.findIndex(event => event.type === 'tool_started' && event.toolName === 'generate_dynamic_practice')
  const completed = events.findIndex(event => event.type === 'tool_completed' && event.run.toolName === 'generate_dynamic_practice')
  const firstDelta = events.findIndex(event => event.type === 'text_delta')
  assert.ok(started >= 0 && completed > started && firstDelta > completed)
  assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.delta).join(''), result.reply)

  const freeRequests: any[] = []
  await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'free',
    messages: [{ role: 'user', content: '随便生成两道题' }],
    toolChoice: 'auto',
    formalProjectContext: guidedProjectContext,
    formalLearnerContext: guidedProjectContext.five_kernel_context,
    learningTaskContext: learningTaskContext as any,
    generate: async () => 'unused',
    invokeProvider: async request => {
      freeRequests.push(request)
      return { choices: [{ message: { content: '先进入正式关卡学习任务，再生成会留下提交证据的动态练习。' } }] }
    },
  })
  const freeExposed = freeRequests[0].body.tools.map((tool: any) => tool.function.name)
  assert.ok(!freeExposed.includes('design_assessment_blueprint'))
  assert.ok(!freeExposed.includes('generate_dynamic_practice'))
  assert.ok(!freeExposed.includes('generate_similar_practice'))
  assert.ok(!freeExposed.includes('inspect_practice_quality'))
})

test('assessment blueprint tool persists a zero-target deterministic grading contract', async () => {
  const originalFetch = globalThis.fetch
  let requestBody: any
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body || '{}'))
    return new Response(JSON.stringify({
      id: 19,
      title: 'QKV 张量形状 · 诊断蓝图',
      purpose: 'diagnostic',
      item_mix: [{ q_type: 'single', count: 2 }, { q_type: 'trace_table', count: 1 }],
      rubric: { id: 23, scoring_policy: { owner: 'practice_agent', llm_may_score: false } },
      mastery_inference: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const result = await executeTutorAgentTool('design_assessment_blueprint', {
      learning_task_id: 81,
      title: 'QKV 张量形状 · 诊断蓝图',
      concept: 'QKV 张量形状',
      purpose: 'diagnostic',
      difficulty: 'medium',
      item_types: ['single', 'trace_table'],
      count: 3,
    }, {
      message: '先设计检测蓝图',
      mode: 'guided_learning',
      formalProjectContext: { checkpoint_id: 45 } as any,
      backendBase: 'http://formal.example.test',
      generate: async () => 'unused',
    })
    assert.equal(result.run.kind, 'assessment')
    assert.equal(result.run.assessmentBlueprint?.id, 19)
    assert.equal(result.run.assessmentBlueprint?.rubricId, 23)
    assert.equal(result.observation.evidence_boundary.includes('零目标'), true)
    assert.equal(requestBody.learning_task_id, 81)
    assert.equal(requestBody.count, 3)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('dynamic practice generation receives an item-sized output budget', async () => {
  const originalFetch = globalThis.fetch
  let observedTimeout = 0
  let observedMaxTokens = 0
  globalThis.fetch = async () => new Response(JSON.stringify({
    ref: 'practice-set-budget-test',
    title: 'QKV 动态检测',
    checkpoint_id: 45,
    question_count: 4,
    quality_status: 'validated_static_uncalibrated',
    quality_reports: [],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  try {
    const result = await executeTutorAgentTool('generate_dynamic_practice', {
      learning_task_id: 81,
      title: 'QKV 动态检测',
      concept: '自注意力 QKV 与张量形状',
      purpose: 'diagnostic',
      difficulty: 'medium',
      item_types: ['single', 'ordered_blocks', 'numeric', 'code_output'],
      count: 4,
    }, {
      message: '生成四道 QKV 检测题',
      mode: 'guided_learning',
      formalProjectContext: { checkpoint_id: 45 } as any,
      backendBase: 'http://formal.example.test',
      generate: async (_instructions, _input, timeoutMs, maxTokens) => {
        observedTimeout = Number(timeoutMs)
        observedMaxTokens = Number(maxTokens)
        return JSON.stringify({ candidates: [
          { question: 'Q、K 点积除以 sqrt(d_k) 的主要目的是什么？', q_type: 'single', options: ['控制数值尺度', '增加 token 数'], answer_indexes: [0], target_skill: '缩放点积注意力', explanation: '避免维度增大时点积方差过大。' },
          { question: '将注意力计算步骤排成正确顺序。', q_type: 'ordered_blocks', options: ['QK^T', '缩放', 'softmax', '乘 V'], answer_indexes: [0, 1, 2, 3], target_skill: '注意力计算顺序', explanation: '先得到分数，再归一化并聚合 V。' },
          { question: 'batch=2、heads=4、tokens=8 时，每个 head 的注意力矩阵元素总数是多少？', q_type: 'numeric', expected_response: 512, target_skill: '注意力张量形状', explanation: '2×4×8×8=512。' },
          { question: '下列代码输出的 shape 是什么？', q_type: 'code_output', code: 'q = torch.randn(2,4,8,16)\nk = torch.randn(2,4,8,16)\nprint((q @ k.transpose(-2,-1)).shape)', expected_response: 'torch.Size([2, 4, 8, 8])', target_skill: 'QK 转置与矩阵乘', explanation: '最后两维 8×16 与 16×8 相乘。' },
        ] })
      },
    })
    assert.equal(result.run.status, 'completed')
    assert.equal(observedTimeout, 58_000)
    assert.equal(observedMaxTokens, 5_800)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an expensive practice generator cannot be retried with cosmetic argument changes in one turn', async () => {
  let modelRound = 0
  let generatorCalls = 0
  const events: any[] = []
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'guided_learning',
    messages: [{ role: 'user', content: '生成一组 QKV 检测题' }],
    toolChoice: 'auto',
    formalProjectContext: { ...formalProjectContext, checkpoint_id: 45 },
    learningTaskContext: {
      objectType: 'learning_task_binding', authority: 'formal_learning_task', formalTaskId: 81,
      taskId: 'formal-task-81', objective: '检测 QKV 形状理解', skillId: 'worked_example_fading',
      skillName: '例题渐隐', substateId: 'practice', substateLabel: '练习态', stepId: 'attempt',
      stepTitle: '独立尝试', stepIndex: 1, stepCount: 3, stepInstruction: '完成短题。',
      nextAction: '提交检测', loopCount: 0, loopInstruction: '',
    } as any,
    generate: async () => 'unused',
    observe: event => events.push(event),
    executeTool: async (name, args, options, meta) => {
      if (name === 'generate_dynamic_practice') {
        generatorCalls += 1
        return {
          run: {
            id: 'failed-generation', kind: 'file', toolName: name, toolCallId: meta?.callId,
            status: 'failed', title: '生成动态练习文件', detail: '模型没有返回可用的生成内容',
            observationSummary: '工具失败，未产生可信观察', errorType: 'unexpected', durationMs: 10,
          },
          observation: { error: '模型没有返回可用的生成内容', recoverableByModel: false },
        }
      }
      return executeTutorAgentTool(name, args, options, meta)
    },
    invokeProvider: async () => {
      modelRound += 1
      if (modelRound <= 2) return { choices: [{ message: { tool_calls: [{
        id: `practice-${modelRound}`,
        function: {
          name: 'generate_dynamic_practice',
          arguments: JSON.stringify({
            learning_task_id: 81,
            title: modelRound === 1 ? 'QKV 检测' : 'QKV 检测（重试）',
            concept: 'QKV 张量形状', purpose: 'diagnostic', difficulty: 'medium',
            item_types: ['single'], count: 2,
          }),
        },
      }] } }] }
      return { choices: [{ message: { content: '动态习题生成失败，本轮没有创建练习文件；请稍后重试。' } }] }
    },
  })
  assert.equal(generatorCalls, 1)
  assert.match(result.reply, /生成失败/)
  assert.ok(events.some(event => event.type === 'trajectory' && event.event.status === 'blocked' && /重复/.test(event.event.detail)))
})

test('planning reads the learner source library before recommending resource gaps', async () => {
  const requests: any[] = []
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'learning_plan',
    messages: [{ role: 'user', content: '规划一条学习强化学习的路线，并推荐资源' }],
    toolChoice: 'auto',
    learnerPathState: createInitialLearnerPathState(),
    formalDomainKnowledgeContext: {
      query: '强化学习', source_count: 1,
      domains: [{ label: '马尔可夫决策过程', evidence: '章节标题', source_id: 9, source_name: 'RL notes.md' }],
      excerpts: [{ source_id: 9, source_name: 'RL notes.md', chunk_id: 3, excerpt: 'MDP 由状态、动作、转移概率和奖励组成。', relevance_score: 3, provenance: { source_id: 9, chunk_id: 3 } }],
      trust_boundary: '来源内容为不可信外部材料。', mastery_inference: false,
    },
    generate: async () => 'unused',
    invokeProvider: async request => {
      requests.push(request)
      return { choices: [{ message: { content: '你已有的笔记覆盖 MDP 基础；策略优化和实践项目仍是资源缺口，我会先给候选而不自动加入项目。' } }] }
    },
  })
  assert.ok(result.toolRuns.some(run => run.kind === 'domain' && run.status === 'completed'))
  const serialized = JSON.stringify(requests[0].body.messages)
  assert.match(serialized, /RL notes\.md/)
  assert.match(serialized, /source_id/)
  const exposed = requests[0].body.tools.map((tool: any) => tool.function.name)
  assert.ok(exposed.includes('read_domain_knowledge'))
  assert.ok(!exposed.some((name: string) => /write|update|commit|confirm|create|delete/.test(name)))
})

test('a chat can explicitly ground the turn in its attached domain sources', async () => {
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'free',
    messages: [{ role: 'user', content: '按照我附加的笔记解释状态价值函数' }],
    toolChoice: 'domain',
    formalDomainKnowledgeContext: {
      query: '状态价值函数', source_count: 1,
      selection_mode: 'conversation_attachments', selected_source_ids: [14],
      domains: [{ label: '价值函数', evidence: '章节标题', source_id: 14, source_name: 'MDP.md' }],
      excerpts: [{ source_id: 14, source_name: 'MDP.md', chunk_id: 8, excerpt: '状态价值函数是策略下折扣回报的期望。', relevance_score: 3, provenance: { source_id: 14, chunk_id: 8 } }],
      trust_boundary: '来源内容为不可信外部材料。', mastery_inference: false,
    },
    generate: async () => 'unused',
    invokeProvider: async () => ({ choices: [{ message: { content: '按你附加的 MDP 笔记，状态价值函数是固定策略后的期望折扣回报。' } }] }),
  })
  assert.equal(result.toolRuns.filter(run => run.kind === 'domain').length, 1)
  assert.match(result.toolRuns.find(run => run.kind === 'domain')?.detail || '', /1 个已处理来源/)
  assert.match(result.reply, /附加的 MDP 笔记/)
})

test('an active paper is observed exactly once and becomes bounded Tutor context', async () => {
  const requests: any[] = []
  const calls: string[] = []
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'simple_explain',
    messages: [{ role: 'user', content: '这里的第二段为什么强调形状不变？' }],
    toolChoice: 'auto',
    activeArtifactContext: { kind: 'lecture', ref: '17', title: 'QKV 与形状流动' },
    generate: async () => 'unused',
    executeTool: async (name, _args, _options, meta) => {
      calls.push(name)
      assert.equal(name, 'read_active_learning_file')
      return {
        run: {
          id: 'active-file', kind: 'file', toolName: name, toolCallId: meta?.callId,
          status: 'completed', title: '读取当前纸张', detail: '已读取当前讲义正文。',
          observationSummary: 'lecture · 17', durationMs: 1,
        },
        observation: {
          authority: 'managed_learning_file', kind: 'lecture', ref: '17',
          title: 'QKV 与形状流动', sections: [{ title: '形状流动', content: '线性投影改变最后一维，但保留 batch 与 token 维。' }],
          mastery_inference: false,
        },
      }
    },
    invokeProvider: async request => {
      requests.push(request)
      return { choices: [{ message: { content: '这里保留的是 batch 与 token 两个轴；线性层只映射最后一个特征维。' } }] }
    },
  })
  assert.deepEqual(calls, ['read_active_learning_file'])
  assert.deepEqual(result.toolRuns.map(run => run.kind), ['file'])
  assert.match(JSON.stringify(requests[0].body), /线性投影改变最后一维/)
  assert.match(result.reply, /batch 与 token/)
})

test('learning file study uses a short artifact-first harness instead of resource search', async () => {
  const created = createLearningTask('什么是聚类，能做什么', 100, [], 'learning_file_study')
  const learningTaskContext = {
    ...learningTaskTutorContext(projectLearningTask(created.task, created.events)),
    authority: 'formal_learning_task' as const,
    formalTaskId: 42,
  }
  const requests: any[] = []
  const executions: string[] = []
  let round = 0
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions', model: 'test-model', mode: 'guided_learning',
    messages: [{ role: 'user', content: '什么是聚类，能做什么' }],
    toolChoice: 'auto', learningTaskContext,
    taskQueue: [{ id: 42, objective: '什么是聚类，能做什么', status: 'active', version: 2, artifactRefs: [] }],
    generate: async () => 'unused',
    executeTool: async (name, args, options, meta) => {
      executions.push(name)
      return executeTutorAgentTool(name, args, options, meta)
    },
    invokeProvider: async request => {
      requests.push(request)
      round += 1
      if (round === 1) return { choices: [{ message: { tool_calls: [{
        id: 'wrong-video-route', function: { name: 'search_learning_videos', arguments: '{"target":"聚类入门"}' },
      }] } }] }
      return { choices: [{ message: { content: '聚类就是在没有现成标签时，按相似性把数据自动分组；常用于用户分群、文档归类和异常发现。完整概念、例子与练习放到学习文件里继续。' } }] }
    },
  })

  assert.deepEqual(executions, ['read_learning_workspace', 'propose_project_learning_files'])
  assert.equal(result.toolRuns.some(run => run.kind === 'search' || run.kind === 'video'), false)
  assert.ok(result.toolRuns.some(run => run.projectLearningFileProposal?.learning_task_id === 42))
  assert.ok(result.trace.events.some(event => event.status === 'blocked' && /search_learning_videos/.test(event.detail)))
  assert.doesNotMatch(JSON.stringify(requests[0].body.tools), /search_learning_videos|search_computer_knowledge|read_web_evidence|generate_learning_diagram|generate_learning_animation/)
  assert.ok(result.reply.length < 220)
})

test('explicit visual intent prepares animation prose before the requested visual tool', async () => {
  const cases = [
    { message: '什么是联邦学习', expected: '' },
    { message: '画一张联邦学习流程图', expected: 'generate_learning_diagram' },
    { message: '用动画逐步演示联邦学习聚合过程', expected: 'generate_learning_animation' },
  ]
  for (const item of cases) {
    const requests: any[] = []
    const executions: string[] = []
    await runTutorAgentTurn({
      baseUrl: 'https://example.com/v1/chat/completions', model: 'test-model', mode: 'guided_learning',
      messages: [{ role: 'user', content: item.message }], toolChoice: 'auto',
      generate: async () => 'unused',
      executeTool: async (name, _args, _options, meta) => {
        executions.push(name)
        return {
          run: { id: String(meta?.callId || name), kind: name.endsWith('animation') ? 'animation' : 'image', toolName: name, status: 'failed', title: name, detail: 'fixture failure', durationMs: 1 },
          observation: { error: 'fixture failure' },
        } as any
      },
      invokeProvider: async request => {
        requests.push(request)
        return { choices: [{ message: { content: item.expected
          ? ((request.body as any).response_format
              ? visualTeachingPayload(item.expected === 'generate_learning_animation' ? 'animation' : 'diagram')
              : visualTeachingExplanation)
          : '先用一句话说明核心，再按需要补充学习动作。' } }] }
      },
    })
    const visualExecutions = executions.filter(name => /generate_learning_(?:diagram|animation)|search_learning_videos/.test(name))
      assert.deepEqual(visualExecutions, item.expected ? [item.expected] : [])
      if (item.expected) {
        assert.doesNotMatch(JSON.stringify(requests[0].body.tools || []), /generate_learning_diagram|generate_learning_animation|search_learning_videos/)
      }
  }
})

test('a failed animation preserves the committed explanation and cannot drift', async () => {
  const executions: string[] = []
  const events: any[] = []
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions', model: 'test-model', mode: 'simple_explain',
    messages: [
      { role: 'user', content: '讲一下 CNN 手写数字识别' },
      { role: 'assistant', content: 'CNN 会通过卷积核提取局部特征。' },
      { role: 'user', content: '用动画演示一下' },
    ],
    toolChoice: 'auto', generate: async () => 'unused',
    observe: event => events.push(event),
    executeTool: async (name, _args, _options, meta) => {
      executions.push(name)
      return {
        run: { id: String(meta?.callId || name), kind: 'animation', toolName: name, status: 'failed', title: '生成学习动画', detail: 'planner failed', durationMs: 1 },
        observation: { error: 'planner failed' },
      } as any
    },
    invokeProvider: async request => ({ choices: [{ message: { content: (request.body as any).response_format
      ? visualTeachingPayload('animation', 'CNN 卷积过程')
      : visualTeachingExplanation } }] }),
  })
  assert.deepEqual(executions, ['generate_learning_animation'])
  assert.equal(result.toolRuns.some(run => run.kind === 'video' || run.kind === 'image'), false)
  assert.equal(result.visualTeaching?.terminalState, 'explanation_only')
  assert.equal(result.visualTeaching?.explanationPreserved, true)
  assert.match(result.reply, /^联邦学习由多个客户端/)
  const committed = events.findIndex(event => event.type === 'teaching_segment_committed')
  const toolStarted = events.findIndex(event => event.type === 'tool_started')
  assert.ok(committed >= 0 && toolStarted > committed)
  assert.equal(events.slice(committed + 1).some(event => event.type === 'text_reset'), false)
})

test('a brief failure after explanation commit never invokes the renderer', async () => {
  const executions: string[] = []
  const events: any[] = []
  let calls = 0
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions', model: 'test-model', mode: 'simple_explain',
    messages: [{ role: 'user', content: '用动画演示联邦学习聚合过程' }],
    toolChoice: 'auto', generate: async () => 'unused', observe: event => events.push(event),
    executeTool: async name => {
      executions.push(name)
      throw new Error('renderer must not run')
    },
    invokeProvider: async request => {
      calls += 1
      return { choices: [{ message: { content: (request.body as any).response_format ? '{"topic":"broken"}' : visualTeachingExplanation } }] }
    },
  })
  assert.equal(calls, 3)
  assert.deepEqual(executions, [])
  assert.equal(result.visualTeaching?.terminalState, 'explanation_only')
  assert.match(result.reply, new RegExp(`^${visualTeachingExplanation}`))
  assert.ok(events.some(event => event.type === 'teaching_segment_committed'))
})

test('visual tool observations expose bounded frame grounding for truthful Tutor narration', async () => {
  const result = await executeTutorAgentTool('generate_learning_animation', {
    query: '用动画逐步演示联邦学习聚合过程',
  }, {
    message: '用动画逐步演示联邦学习聚合过程',
    recentMessages: [{ role: 'user', content: '用动画逐步演示联邦学习聚合过程' }],
    visualTeachingBrief: parseVisualTeachingBrief(visualTeachingPayload('animation'), 'animation', '用动画逐步演示联邦学习聚合过程'),
    generate: async () => { throw new Error('deterministic visual must not call the model') },
  })
  const observation = result.observation as any
  assert.equal(observation.authority, 'validated_learning_artifact')
  assert.ok(observation.artifact.grounding.semanticChanges >= 1)
  assert.equal(observation.artifact.grounding.stepTitles.length, result.run.artifact?.steps.length)
  assert.match(observation.claimBoundary, /grounding.*唯一|grounding.*只能|只能描述/)
  assert.doesNotMatch(JSON.stringify(observation), /<svg|<path|<rect/)
  assert.match(result.directReply || '', /共 \d+ 帧/)
})

test('learning file study reuses an existing lecture before proposing generation', async () => {
  const created = createLearningTask('理解聚类', 100, [], 'learning_file_study')
  const learningTaskContext = {
    ...learningTaskTutorContext(projectLearningTask(created.task, created.events)),
    authority: 'formal_learning_task' as const,
    formalTaskId: 43,
  }
  const executions: string[] = []
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions', model: 'test-model', mode: 'guided_learning',
    messages: [{ role: 'user', content: '带我学习聚类' }], toolChoice: 'auto', learningTaskContext,
    taskQueue: [{
      id: 43, objective: '理解聚类', status: 'active', artifactRefs: [
        { kind: 'lecture', ref: 17, title: '聚类：从相似性到分组' },
        { kind: 'practice', ref: 'questions-9', title: '聚类概念练习' },
      ],
    }],
    generate: async () => 'unused',
    executeTool: async (name, args, options, meta) => {
      executions.push(name)
      return executeTutorAgentTool(name, args, options, meta)
    },
    invokeProvider: async () => ({ choices: [{ message: { content: '聚类先解决“没有标签时怎样发现数据结构”。现有讲义已经放在卡片里，打开后先看“相似性如何定义”这一节。' } }] }),
  })

  assert.deepEqual(executions, ['read_learning_workspace'])
  assert.equal(result.toolRuns[0].learningFile?.ref, '17')
  assert.equal(result.toolRuns.some(run => run.projectLearningFileProposal), false)
})

test('metadata-only video inspection cannot support a positive recommendation', () => {
  const created = createLearningTask('理解聚类', 100, [], 'learning_file_study')
  const learningTaskContext = learningTaskTutorContext(projectLearningTask(created.task, created.events))
  const checked = verifyTutorTurnOutcome({
    reply: '我推荐这个视频，它很适合你。', mode: 'guided_learning', learningTaskContext,
    toolRuns: [{
      id: 'inspect', kind: 'video', status: 'failed', title: '核验学习视频内容', detail: '只有元数据',
      durationMs: 1, toolName: 'inspect_learning_video', observationSummary: 'metadata_only',
    }],
  })
  assert.equal(checked.valid, false)
  assert.ok(checked.violations.includes('unverified_video_recommendation'))
})

test('a pending learning-file proposal cannot be described as an available file', () => {
  const checked = verifyTutorTurnOutcome({
    reply: '讲义已经生成好了，直接打开这份讲义开始阅读。',
    mode: 'guided_learning',
    toolRuns: [{
      id: 'proposal', kind: 'file', status: 'completed', title: '学习文件待生成', detail: '等待确认',
      durationMs: 1, toolName: 'propose_project_learning_files', observationSummary: 'lecture + practice',
      projectLearningFileProposal: {
        project_id: 0, learning_task_id: 65, checkpoint_title: '联邦学习',
        file_kinds: ['lecture', 'practice'], source_strategy: 'task_sources_first', confirmation_required: true,
      },
    }],
  })
  assert.equal(checked.valid, false)
  assert.ok(checked.violations.includes('unmaterialized_learning_file_claim'))
})

test('review questions receive answer-free proficiency and memory observations', async () => {
  const requests: any[] = []
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'free',
    messages: [{ role: 'user', content: '我为什么今天要复习贝叶斯公式，熟练度怎么样？' }],
    toolChoice: 'auto',
    formalReviewContext: {
      authority: 'answer_free_review_evidence_projection',
      summary: { visible: 1, due: 1, stable: 0 },
      items: [{
        schedule_id: 9,
        subject_key: 'bayes-rule',
        due_at: '2026-08-26T00:00:00',
        proficiency: { score: 61, memory_state: { difficulty: 5, stability_days: 3, retrievability: 0.83 } },
        memory_notes: [{ kind: 'misconception', text: '容易混淆条件概率方向' }],
      }],
      boundaries: ['不包含答案', '熟练度不是第二套掌握权威'],
    },
    generate: async () => 'unused',
    invokeProvider: async request => {
      requests.push(request)
      return { choices: [{ message: { content: '今天复习是因为已到提取窗口；当前证据仍缺少稳定的变式迁移。' } }] }
    },
  })

  assert.deepEqual(result.toolRuns.map(run => run.kind), ['memory', 'review'])
  assert.match(result.toolRuns[1].detail, /1 个相关复习项/)
  const exposed = requests[0].body.tools.map((tool: any) => tool.function.name)
  assert.ok(exposed.includes('read_review_context'))
  assert.ok(!exposed.includes('record_review_reflection'))
})

test('planning final state observes five-kernel, workspace and path without upgrading self report', async () => {
  const requests: any[] = []
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'learning_plan',
    messages: [{ role: 'user', content: '我学过机器学习，想规划 Agent 工程路线' }],
    toolChoice: 'auto',
    learnerPathState: createInitialLearnerPathState(),
    formalLearnerContext: {
      snapshot_id: 'snapshot-1',
      kernel_heads: {
        knowledge: { summary: '自述接触过机器学习，尚无独立验证' },
        value: { summary: '希望学习 Agent 工程' },
      },
      items: [], conflicts: [], missing_facets: ['practice.transfer'],
    },
    taskQueue: [],
    knowledgeDomains: [],
    generate: async () => 'unused',
    invokeProvider: async request => {
      requests.push(request)
      return { choices: [{ message: { content: '路线会保留机器学习验证节点，不把“学过”直接当作掌握。' } }] }
    },
  })
  assert.deepEqual(result.toolRuns.map(run => run.kind), ['memory', 'workspace', 'path', 'path'])
  assert.match(result.reply, /不把“学过”直接当作掌握/)
  assert.equal(requests[0].body.messages.some((message: any) => message.role === 'tool'), false)
  assert.match(String(requests[0].body.messages[0].content), /read_learner_context/)
  assert.match(String(requests[0].body.messages[0].content), /read_learning_workspace/)
  assert.match(String(requests[0].body.messages[0].content), /lookup_learning_path_node/)
})

test('a known planning target stops after exact lookup', async () => {
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions', model: 'test-model', mode: 'learning_plan',
    messages: [{ role: 'user', content: '我想规划 Agent 开发的学习路线' }],
    toolChoice: 'auto', learnerPathState: createInitialLearnerPathState(),
    taskQueue: [], knowledgeDomains: [], generate: async () => 'unused',
    invokeProvider: async () => ({ choices: [{ message: { content: '目标已定位为智能体工程，可以据此检查前置与里程碑。' } }] }),
  })
  const pathRuns = result.toolRuns.filter(run => run.kind === 'path')
  assert.equal(pathRuns.length, 1)
  assert.match(pathRuns[0].title, /精确/)
  assert.ok(pathRuns[0].pathPlanProposal?.targetNodeIds.includes('agent-engineering'))
  assert.equal(result.toolRuns.some(run => run.kind === 'search'), false)
})

test('a misspelled planning target uses fuzzy recovery without web search', async () => {
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions', model: 'test-model', mode: 'learning_plan',
    messages: [{ role: 'user', content: '我想规划操作系統源理的学习路线' }],
    toolChoice: 'auto', learnerPathState: createInitialLearnerPathState(),
    taskQueue: [], knowledgeDomains: [], generate: async () => 'unused',
    invokeProvider: async () => ({ choices: [{ message: { content: '我把目标修复定位为操作系统，再基于它检查前置课程。' } }] }),
  })
  const pathRuns = result.toolRuns.filter(run => run.kind === 'path')
  assert.equal(pathRuns.length, 2)
  assert.match(pathRuns[0].detail, /精确读取未命中/)
  assert.match(pathRuns[1].title, /模糊/)
  assert.ok(pathRuns[1].pathPlanProposal?.targetNodeIds.includes('operating-systems'))
  assert.equal(result.toolRuns.some(run => run.kind === 'search'), false)
})

test('a model-requested web search is blocked after fuzzy path resolution unless resources were requested', async () => {
  let round = 0
  let searchExecutions = 0
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions', model: 'test-model', mode: 'learning_plan',
    messages: [{ role: 'user', content: '我想规划操作系統原里的学习路线' }],
    toolChoice: 'auto', learnerPathState: createInitialLearnerPathState(),
    taskQueue: [], knowledgeDomains: [], generate: async () => 'unused',
    executeTool: async (name, args, options, meta) => {
      if (name === 'search_computer_knowledge') searchExecutions += 1
      return executeTutorAgentTool(name, args, options, meta)
    },
    invokeProvider: async () => {
      round += 1
      if (round === 1) return { choices: [{ message: { tool_calls: [{
        id: 'redundant-search', function: {
          name: 'search_computer_knowledge',
          arguments: '{"query":"操作系统原理课程核心内容"}',
        },
      }] } }] }
      return { choices: [{ message: { content: '目标已经定位为操作系统；我直接依据正式图谱说明前置与下一步。' } }] }
    },
  })
  assert.equal(searchExecutions, 0)
  assert.equal(result.toolRuns.some(run => run.kind === 'search'), false)
  assert.ok(result.trace.events.some(event => event.status === 'blocked' && /冗余联网/.test(event.detail)))
  assert.match(result.reply, /正式图谱/)
})

test('an ambiguous path query asks for clarification and cannot create a route', async () => {
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions', model: 'test-model', mode: 'learning_plan',
    messages: [{ role: 'user', content: '我想规划安全方向' }],
    toolChoice: 'auto', learnerPathState: createInitialLearnerPathState(),
    taskQueue: [], knowledgeDomains: [], generate: async () => 'unused',
    invokeProvider: async () => ({ choices: [{ message: { content: '“安全”对应多个方向。你更想学网络安全、系统安全，还是安全运营？' } }] }),
  })
  const pathRuns = result.toolRuns.filter(run => run.kind === 'path')
  assert.equal(pathRuns.length, 2)
  assert.match(pathRuns[1].detail, /需要消歧/)
  assert.ok(pathRuns.every(run => !run.pathPlanProposal && !run.pathProposal))
  assert.equal(result.toolRuns.some(run => run.kind === 'search'), false)
})

test('the provider cannot invoke a legacy path tool that is not model-visible', async () => {
  const requests: any[] = []
  let round = 0
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'free',
    messages: [{ role: 'user', content: '帮我看看机器学习路线' }],
    toolChoice: 'auto',
    learnerPathState: createInitialLearnerPathState(),
    generate: async () => 'unused',
    invokeProvider: async request => {
      requests.push(request)
      round += 1
      if (round === 1) return { choices: [{ message: { tool_calls: [{
        id: 'legacy-path', function: { name: 'read_learning_path', arguments: '{"query":"机器学习"}' },
      }] } }] }
      return { choices: [{ message: { content: '旧接口没有向本轮开放；我不会绕过当前工具边界。' } }] }
    },
  })

  assert.equal(result.toolRuns.some(run => run.kind === 'path'), false)
  assert.ok(result.trace.events.some(event => event.status === 'blocked' && /未开放工具/.test(event.detail)))
  assert.ok(!requests[0].body.tools.some((tool: any) => tool.function.name === 'read_learning_path'))
  assert.ok(requests[1].body.messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'legacy-path'))
})

test('a path gap is searched and returned as an uncommitted personal-node proposal', async () => {
  const state = createInitialLearnerPathState()
  let round = 0
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'learning_plan',
    messages: [{ role: 'user', content: '我想系统学习量子机器学习' }],
    toolChoice: 'auto',
    learnerPathState: state,
    generate: async () => 'unused',
    executeTool: async (name, args, options, meta) => {
      if (name === 'search_computer_knowledge') {
        const sources = [{ title: 'Quantum Machine Learning', url: 'https://example.edu/qml', snippet: 'Quantum machine learning combines quantum computing with machine learning algorithms.', source: 'University', quality: 'academic' as const, role: 'course' as const, reason: '课程来源' }]
        return {
          run: {
            id: 'search-gap', kind: 'search', toolName: name, toolCallId: meta?.callId,
            status: 'completed', title: '搜索', detail: '找到一条大学课程来源',
            durationMs: 1,
            sources,
          },
          observation: { authority: 'untrusted_web_evidence_bundle' },
          searchSourceUrls: ['https://example.edu/qml'],
          searchSources: sources,
        }
      }
      return executeTutorAgentTool(name, args, options, meta)
    },
    invokeProvider: async () => {
      round += 1
      if (round === 1) return { choices: [{ message: { tool_calls: [{
        id: 'search-qml', function: { name: 'search_computer_knowledge', arguments: '{"query":"量子机器学习 大学课程 前置"}' },
      }] } }] }
      return { choices: [{ message: { content: '现有官方图没有可靠节点；我已形成个人节点提案，只有你确认后才会加入。' } }] }
    },
  })
  const refreshedPath = result.toolRuns.filter(run => run.kind === 'path').at(-1)
  assert.ok(refreshedPath?.pathProposal)
  assert.match(result.reply, /只有你确认后/)
  assert.equal(state.events.some(event => event.type === 'vnext_personal_path_node_added'), false)
})

test('an off-topic web result cannot become a personal learning-path node', async () => {
  let round = 0
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions', model: 'test-model', mode: 'learning_plan',
    messages: [{ role: 'user', content: '我想系统学习量子机器学习' }],
    toolChoice: 'auto', learnerPathState: createInitialLearnerPathState(),
    taskQueue: [], knowledgeDomains: [], generate: async () => 'unused',
    executeTool: async (name, args, options, meta) => {
      if (name === 'search_computer_knowledge') {
        const sources = [{
          title: 'Database Systems', url: 'https://example.edu/database',
          snippet: 'SQL, transactions, indexes and database design.', source: 'University',
          quality: 'academic' as const, role: 'course' as const, reason: '搜索结果',
        }]
        return {
          run: { id: 'search-off-topic', kind: 'search', status: 'completed', title: '搜索', detail: '返回一条结果', durationMs: 1, sources },
          observation: { authority: 'untrusted_web_evidence_bundle', sources },
          searchSourceUrls: sources.map(source => source.url),
          searchSources: sources,
        }
      }
      return executeTutorAgentTool(name, args, options, meta)
    },
    invokeProvider: async () => {
      round += 1
      if (round === 1) return { choices: [{ message: { tool_calls: [{
        id: 'search-qml-off-topic', function: { name: 'search_computer_knowledge', arguments: '{"query":"量子机器学习 大学课程"}' },
      }] } }] }
      return { choices: [{ message: { content: '现有结果与量子机器学习不相关，因此我不会生成个人节点；需要继续寻找可靠来源。' } }] }
    },
  })
  const proposalRun = result.toolRuns.find(run => run.toolName === 'propose_personal_path_node')
  assert.equal(proposalRun?.status, 'failed')
  assert.match(proposalRun?.detail || '', /不足以证明/)
  assert.equal(result.toolRuns.some(run => Boolean(run.pathProposal)), false)
  assert.match(result.reply, /不会生成个人节点/)
})

test('a failed tool is visible and the model can switch observations before answering', async () => {
  let round = 0
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'free',
    messages: [{ role: 'user', content: '查一下机器学习路线；如果联网失败就看内置路径' }],
    toolChoice: 'auto',
    learnerPathState: createInitialLearnerPathState(),
    generate: async () => 'unused',
    executeTool: async (name, args, options, meta) => {
      if (name === 'search_computer_knowledge') return {
        run: {
          id: 'failed-search', kind: 'search', toolName: name, toolCallId: meta?.callId,
          status: 'failed', title: '搜索', detail: '503 temporary search failure', errorType: 'transient', durationMs: 1,
        },
        observation: { error: '503 temporary search failure', recoverableByModel: true },
      }
      return executeTutorAgentTool(name, args, options, meta)
    },
    invokeProvider: async () => {
      round += 1
      if (round === 1) return { choices: [{ message: { tool_calls: [{
        id: 'search-fails', function: { name: 'search_computer_knowledge', arguments: '{"query":"机器学习路线"}' },
      }] } }] }
      if (round === 2) return { choices: [{ message: { tool_calls: [{
        id: 'fallback-path', function: { name: 'lookup_learning_path_node', arguments: '{"query":"机器学习路线"}' },
      }] } }] }
      return { choices: [{ message: { content: '联网检索暂时失败；下面仅依据内置课程图给出前置关系。' } }] }
    },
  })
  assert.equal(result.toolRuns.find(run => run.kind === 'search')?.status, 'failed')
  assert.equal(result.toolRuns.find(run => run.kind === 'path')?.status, 'completed')
  assert.match(result.reply, /联网检索暂时失败/)
})

test('learner conflicts and project source domains remain observations, never write tools', async () => {
  const requests: any[] = []
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'guided_learning',
    messages: [{ role: 'user', content: '继续完成仓库里的 Agent 工具调用章节' }],
    toolChoice: 'auto',
    formalLearnerContext: {
      snapshot_id: 'conflict-snapshot', kernel_heads: {}, items: [],
      conflicts: [{ subject: 'tool-calling', text: '旧 Claim 与本轮自述冲突，等待学习者确认' }],
    },
    taskQueue: [{ id: 8, objective: '完成 Agent 工具调用章节', status: 'active' }],
    formalWorkspaceContext: {
      authority: 'LearningAttempt + scoped project sources',
      scope: { learner_id: 1, project_id: 8, checkpoint_id: 12 },
      recent_attempts: [{
        id: 91, item_type: 'exercise', item_id: 17, attempt_role: 'original',
        status: 'evaluated', outcome: 'failed', assistance_level: 'hint', independent: false,
      }],
      open_remediations: [{
        id: 32, item_type: 'exercise', item_id: 17, status: 'explaining',
        error_class: 'tool_result_handling', misconception_tag: 'ignored_tool_failure',
      }],
      review: {
        summary: { total: 1, due: 1, policy_version: 'review-policy-v1' },
        items: [{ id: 44, item_type: 'exercise', item_id: 17, bucket: 'due' }],
      },
      project_sources: [{ id: 8, type: 'github', role: 'main', status: 'processed' }],
      knowledge_domains: [{
        id: 'repo-agent-tools', title: 'Agent 工具调用', labels: ['tool calling', 'function calling'],
        summary: '来源仓库覆盖工具定义、调用结果和失败恢复。', source_ids: ['source-8'],
      }],
      boundaries: ['有提示成功与独立成功必须区分'],
      manifest: { answer_free: true, read_only: true },
    },
    generate: async () => 'unused',
    invokeProvider: async request => {
      requests.push(request)
      return { choices: [{ message: { content: '我会按仓库覆盖范围继续，并把记忆冲突留给你确认，不会静默覆盖。' } }] }
    },
  })
  const serialized = JSON.stringify(requests[0].body.messages)
  assert.match(serialized, /旧 Claim 与本轮自述冲突/)
  assert.match(serialized, /来源仓库覆盖工具定义/)
  assert.match(serialized, /ignored_tool_failure/)
  assert.match(serialized, /review-policy-v1/)
  assert.match(serialized, /有提示成功与独立成功必须区分/)
  assert.match(serialized, /sourceConstraint/)
  assert.match(serialized, /路线节点必须能由当前来源知识领域支持/)
  assert.match(serialized, /来源覆盖只表示资料包含相关内容/)
  assert.match(result.reply, /不会静默覆盖/)
  const exposed = requests[0].body.tools.map((tool: any) => tool.function.name)
  assert.ok(!exposed.some((name: string) => /write|update|commit|confirm|create|delete/.test(name)))
})

const formalProjectContext = {
  schema_version: 'vnext.project.v1' as const,
  project: {
    id: 7,
    name: '实现一个可评测的 RAG Agent',
    objective: '理解检索、生成与评测，并完成可运行原型',
    expected_outcome: '可运行仓库与评测报告',
    user_level: 'undergraduate',
  },
  checkpoint_id: null,
  roadmap: { id: null, revision: 0, checkpoints: [] },
  learning_tasks: [],
  sources: [{
    id: 11, type: 'url' as const, name: 'RAG 教程', url: 'https://example.edu/rag',
    role: 'main', status: 'processed', error: '', chunk_count: 4, mastery_inference: false as const,
  }],
  learning_files: { lectures: [], practices: [] },
  source_excerpts: [{ source_id: 11, excerpt: 'RAG 系统需要分别评估检索与生成。' }],
  learning_file_previews: [],
  five_kernel_context: {
    snapshot_id: 'project-snapshot',
    kernel_heads: { value: { summary: '希望学习 Agent 工程并形成真实产物' } },
    items: [],
  },
  tool_policy: { read_only_observations: true, proposals_require_confirmation: true, roadmap_tool_access: 'project_tutor' },
}

test('host-prefetched project observations do not forge DeepSeek assistant tool calls', async () => {
  const requests: any[] = []
  const result = await runTutorAgentTurn({
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-reasoner',
    mode: 'free',
    messages: [{ role: 'user', content: '继续解释当前项目' }],
    toolChoice: 'auto',
    formalProjectContext,
    formalLearnerContext: formalProjectContext.five_kernel_context,
    generate: async () => 'unused',
    invokeProvider: async request => {
      requests.push(request)
      const messages = (request.body as any).messages
      assert.equal(messages.some((message: any) => message.role === 'tool'), false)
      assert.equal(messages.some((message: any) => message.role === 'assistant' && message.tool_calls?.length), false)
      assert.match(String((messages[0] as any).content), /read_project_workspace/)
      return { choices: [{ message: { content: '可以继续。', reasoning_content: '本轮真实思考数据' } }] }
    },
  })
  assert.equal(requests.length, 1)
  assert.equal(result.reply, '可以继续。')
  assert.equal(result.reasoningContent, '本轮真实思考数据')
})

test('project roadmap tool returns an exact-theme proposal without writing project state', async () => {
  const execution = await executeTutorAgentTool('propose_project_roadmap', {
    rationale: '先验证最小检索链，再建立评测闭环。',
    checkpoints: [
      {
        key: 'retrieval-baseline', title: '检索基线', objective: '实现并评估最小检索器',
        prerequisites: [], success_criteria: ['能运行检索评测'], estimated_minutes: 90,
      },
      {
        key: 'generation-eval', title: '生成与联合评测', objective: '接入生成并分析端到端误差',
        prerequisites: ['retrieval-baseline'], success_criteria: ['提交评测报告'], estimated_minutes: 120,
      },
    ],
  }, {
    message: '请规划这个项目', mode: 'learning_plan', formalProjectContext,
    generate: async () => 'unused',
  })

  assert.equal(execution.run.status, 'completed')
  assert.equal(execution.run.projectRoadmapProposal?.project_theme, formalProjectContext.project.name)
  assert.equal(execution.run.projectRoadmapProposal?.operation, 'create')
  assert.equal(execution.run.projectRoadmapProposal?.confirmation_required, true)
  assert.equal(formalProjectContext.roadmap.checkpoints.length, 0)
})

test('project roadmap tool rejects prerequisites that do not point backward', async () => {
  const execution = await executeTutorAgentTool('propose_project_roadmap', {
    rationale: '非法路线',
    checkpoints: [
      {
        key: 'first', title: '第一关', objective: '验证顺序', prerequisites: ['second'],
        success_criteria: ['完成'], estimated_minutes: 30,
      },
      {
        key: 'second', title: '第二关', objective: '后继', prerequisites: [],
        success_criteria: ['完成'], estimated_minutes: 30,
      },
    ],
  }, {
    message: '规划', mode: 'learning_plan', formalProjectContext,
    generate: async () => 'unused',
  })
  assert.equal(execution.run.status, 'failed')
  assert.match(execution.run.detail, /前置必须指向更早的关卡/)
})

test('project Tutor observes scoped project state and exposes proposals rather than write tools', async () => {
  const requests: any[] = []
  let round = 0
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions',
    model: 'test-model',
    mode: 'learning_plan',
    messages: [{ role: 'user', content: '按这个 RAG 项目和已有来源规划关卡' }],
    toolChoice: 'auto',
    formalProjectContext,
    formalLearnerContext: formalProjectContext.five_kernel_context,
    generate: async () => 'unused',
    invokeProvider: async request => {
      requests.push(request)
      round += 1
      if (round === 1) return { choices: [{ message: { tool_calls: [{
        id: 'roadmap-proposal', function: {
          name: 'propose_project_roadmap',
          arguments: JSON.stringify({
            rationale: '先做检索基线，再完成联合评测。',
            checkpoints: [
              { key: 'retrieval', title: '检索基线', objective: '实现检索器', prerequisites: [], success_criteria: ['检索评测可运行'], estimated_minutes: 90 },
              { key: 'evaluation', title: '联合评测', objective: '完成端到端评测', prerequisites: ['retrieval'], success_criteria: ['形成评测报告'], estimated_minutes: 120 },
            ],
          }),
        },
      }] } }] }
      return { choices: [{ message: { content: '我已形成两关路线提案；确认后才会创建关卡、对话和学习任务。' } }] }
    },
  })

  assert.deepEqual(result.toolRuns.slice(0, 5).map(run => run.kind), ['memory', 'project', 'project', 'project', 'workspace'])
  assert.ok(result.toolRuns.some(run => run.projectRoadmapProposal?.confirmation_required))
  assert.match(result.reply, /确认后才会创建/)
  const exposed = requests[0].body.tools.map((tool: any) => tool.function.name)
  assert.ok(exposed.includes('read_project_workspace'))
  assert.ok(exposed.includes('read_project_roadmap'))
  assert.ok(exposed.includes('read_project_sources'))
  assert.ok(exposed.includes('propose_project_roadmap'))
  assert.ok(!exposed.some((name: string) => /apply|write|commit|delete|confirm/.test(name)))
})

test('project roadmap reader returns an explicit empty graph for the project Tutor', async () => {
  const execution = await executeTutorAgentTool('read_project_roadmap', { query: '检查路线' }, {
    message: '检查路线', mode: 'learning_plan', formalProjectContext,
    generate: async () => 'unused',
  })
  assert.equal(execution.run.status, 'completed')
  assert.equal((execution.observation as any).roadmap.status, 'empty')
  assert.deepEqual((execution.observation as any).roadmap.checkpoints, [])
})

test('project free conversations cannot read or propose the project roadmap', async () => {
  const freeContext = {
    ...formalProjectContext,
    tool_policy: { ...formalProjectContext.tool_policy, roadmap_tool_access: 'none', session_role: 'project_free' },
  }
  const requests: any[] = []
  await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions', model: 'test-model', mode: 'learning_plan',
    messages: [{ role: 'user', content: '帮我改一下关卡图' }], toolChoice: 'auto',
    formalProjectContext: freeContext, formalLearnerContext: freeContext.five_kernel_context,
    generate: async () => 'unused',
    invokeProvider: async request => {
      requests.push(request)
      return { choices: [{ message: { content: '这个对话可以讨论建议，但关卡图需要回到项目 Tutor 调整。' } }] }
    },
  })
  const exposed = requests[0].body.tools.map((tool: any) => tool.function.name)
  assert.ok(exposed.includes('read_project_workspace'))
  assert.ok(!exposed.includes('read_project_roadmap'))
  assert.ok(!exposed.includes('propose_project_roadmap'))
})

test('explicit source choice in project scope reads the shared project sources', async () => {
  const result = await runTutorAgentTurn({
    baseUrl: 'https://example.com/v1/chat/completions', model: 'test-model', mode: 'free',
    messages: [{ role: 'user', content: '根据项目资料解释评测设计' }], toolChoice: 'domain',
    formalProjectContext, formalLearnerContext: formalProjectContext.five_kernel_context,
    generate: async () => 'unused',
    invokeProvider: async () => ({ choices: [{ message: { content: '我会依据项目来源中的评测片段说明。' } }] }),
  })
  assert.ok(result.toolRuns.some(run => run.toolName === 'read_project_sources' && run.status === 'completed'))
  assert.ok(!result.toolRuns.some(run => run.toolName === 'read_domain_knowledge'))
})

test('project Tutor roadmap revision preserves locked checkpoints and emits a revision proposal', async () => {
  const revisionContext = {
    ...formalProjectContext,
    roadmap: {
      id: 9,
      revision: 3,
      checkpoints: [{
        id: 31, key: 'foundation', title: '检索基础', objective: '完成最小检索链',
        prerequisites: [], learning_status: 'in_progress', editable: false, session_id: 71,
        learning_contract: { exit_criteria: ['检索可运行'], estimated_minutes: 60 },
      }],
    },
  }
  const execution = await executeTutorAgentTool('propose_project_roadmap', {
    rationale: '保留已开始关卡，补充后续评测。',
    checkpoints: [
      { id: 31, key: 'foundation', title: '检索基础', objective: '完成最小检索链', prerequisites: [], success_criteria: ['检索可运行'], estimated_minutes: 60 },
      { key: 'evaluation', title: '离线评测', objective: '区分检索和生成误差', prerequisites: ['foundation'], success_criteria: ['评测可重复'], estimated_minutes: 120 },
    ],
  }, {
    message: '调整后续路线', mode: 'learning_plan', formalProjectContext: revisionContext,
    generate: async () => 'unused',
  })
  assert.equal(execution.run.status, 'completed')
  assert.equal(execution.run.projectRoadmapProposal?.operation, 'revise')
  assert.equal(execution.run.projectRoadmapProposal?.expected_revision, 3)
  assert.equal(execution.run.projectRoadmapProposal?.checkpoints[0].id, 31)
})
