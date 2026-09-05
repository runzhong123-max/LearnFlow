import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import {
  buildProviderRequest,
  errorFromTutorProviderResponse,
  isTutorMode,
  textFromTutorProviderResponse,
  tutorConfigurationIssue,
} from './src/tutor.ts'
import { isTutorToolChoice } from './src/tooling.ts'
import { sanitizeLearningTaskTutorContext } from './src/learning.ts'
import { sanitizeLearningPlanTutorContext } from './src/planning.ts'
import {
  directLearningTaskCandidateOperationRequest,
  directLearningTaskCandidateSelectionRequest,
  directLearningTaskDraftConfirmationRequest,
  directLearningTaskIntakeRequest,
  DEFAULT_TUTOR_GENERATION_CONFIG,
  runTutorAgentTurn,
} from './server/agent-runtime.ts'
import type { TutorAgentGenerationConfig } from './server/agent-runtime.ts'
import { readProviderStream } from './server/provider-stream.ts'
import type { SearchProviderConfiguration } from './server/computer-knowledge-search.ts'
import { sanitizeLearnerPathState } from './src/learning-path-graph.ts'
import { createAccountCredentialResolver, type ModelCredential } from './server/account-model-credential.ts'
import { buildBackendProxyHeaders } from './server/backend-proxy-security.ts'
import { AI_LATENCY_BUDGETS } from './src/latency-budgets.ts'
import { createLearnFlowPluginRegistryProvider } from './server/plugin-loader.ts'
import { parsePluginObjectDragData, type LearnFlowPluginObject } from './src/plugin-api.ts'

function loadTutorKey(mode: string): ModelCredential {
  const localEnv = loadEnv(mode, process.cwd(), '')
  const candidates: Array<[string, string | undefined]> = [
    ['启动环境', process.env.LEARNFLOW_API_KEY],
    ['frontend/.env.local', localEnv.LEARNFLOW_API_KEY],
  ]
  const match = candidates.find(([, value]) => value && value !== 'sk-your-key-here')
  return { apiKey: match?.[1]?.trim() || '', source: match?.[0] || '' }
}

function loadTutorConfiguration(mode: string) {
  const localEnv = loadEnv(mode, process.cwd(), '')
  return {
    baseUrl: String(process.env.LEARNFLOW_LLM_BASE_URL || localEnv.LEARNFLOW_LLM_BASE_URL || '').trim(),
    model: String(process.env.LEARNFLOW_LLM_MODEL || localEnv.LEARNFLOW_LLM_MODEL || '').trim(),
  }
}

function loadTutorGenerationConfiguration(mode: string): TutorAgentGenerationConfig {
  const localEnv = loadEnv(mode, process.cwd(), '')
  const value = (name: string) => String(process.env[name] || localEnv[name] || '').trim()
  const integer = (name: string, fallback: number, minimum: number, maximum: number) => {
    const parsed = Number.parseInt(value(name), 10)
    return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback
  }
  return {
    maxOutputTokens: integer('LEARNFLOW_TUTOR_MAX_OUTPUT_TOKENS', DEFAULT_TUTOR_GENERATION_CONFIG.maxOutputTokens, 400, 32_768),
    planningMaxOutputTokens: integer('LEARNFLOW_TUTOR_PLANNING_MAX_OUTPUT_TOKENS', DEFAULT_TUTOR_GENERATION_CONFIG.planningMaxOutputTokens, 400, 32_768),
    planningRecoveryMaxOutputTokens: integer('LEARNFLOW_TUTOR_PLANNING_RECOVERY_MAX_OUTPUT_TOKENS', DEFAULT_TUTOR_GENERATION_CONFIG.planningRecoveryMaxOutputTokens, 400, 32_768),
    planningContextMessages: integer('LEARNFLOW_TUTOR_PLANNING_CONTEXT_MESSAGES', DEFAULT_TUTOR_GENERATION_CONFIG.planningContextMessages, 4, 18),
    planningContextEnvelopeChars: integer('LEARNFLOW_TUTOR_PLANNING_CONTEXT_ENVELOPE_CHARS', DEFAULT_TUTOR_GENERATION_CONFIG.planningContextEnvelopeChars, 2_000, 24_000),
    planningContextObservationChars: integer('LEARNFLOW_TUTOR_PLANNING_CONTEXT_OBSERVATION_CHARS', DEFAULT_TUTOR_GENERATION_CONFIG.planningContextObservationChars, 400, 8_000),
    planningContextObservationTotalChars: integer('LEARNFLOW_TUTOR_PLANNING_CONTEXT_OBSERVATION_TOTAL_CHARS', DEFAULT_TUTOR_GENERATION_CONFIG.planningContextObservationTotalChars, 1_000, 24_000),
    planningToolDescriptionChars: integer('LEARNFLOW_TUTOR_PLANNING_TOOL_DESCRIPTION_CHARS', DEFAULT_TUTOR_GENERATION_CONFIG.planningToolDescriptionChars, 120, 2_000),
  }
}

function loadLearningTaskPreflightConfiguration(mode: string) {
  const localEnv = loadEnv(mode, process.cwd(), '')
  const value = (name: string) => String(process.env[name] || localEnv[name] || '').trim()
  return {
    apiKey: value('LEARNING_TASK_PREFLIGHT_API_KEY'),
    baseUrl: value('LEARNING_TASK_PREFLIGHT_BASE_URL') || 'https://api.deepseek.com/v1',
    model: value('LEARNING_TASK_PREFLIGHT_MODEL') || 'deepseek-chat',
  }
}

function loadRuntimeBridgeToken(mode: string) {
  const frontendEnv = loadEnv(mode, process.cwd(), '')
  const backendEnv = loadEnv(mode, resolve(process.cwd(), '../backend'), '')
  return String(
    process.env.AUTH_RUNTIME_BRIDGE_TOKEN
      || backendEnv.AUTH_RUNTIME_BRIDGE_TOKEN
      || frontendEnv.AUTH_RUNTIME_BRIDGE_TOKEN
      || '',
  ).trim()
}

function loadSearchConfiguration(mode: string): SearchProviderConfiguration {
  const localEnv = loadEnv(mode, process.cwd(), '')
  const value = (name: string) => String(process.env[name] || localEnv[name] || '').trim()
  return {
    jinaApiKey: value('JINA_API_KEY'),
    exaApiKey: value('EXA_API_KEY'),
    tavilyApiKey: value('TAVILY_API_KEY'),
    youtubeApiKey: value('YOUTUBE_API_KEY'),
  }
}

function loadBackendBase(mode: string) {
  const localEnv = loadEnv(mode, process.cwd(), '')
  return String(
    process.env.LEARNFLOW_BACKEND_URL
      || process.env.LEARNFLOW_FORMAL_BACKEND_URL
      || process.env.VNEXT_BACKEND_URL
      || localEnv.LEARNFLOW_BACKEND_URL
      || localEnv.VNEXT_BACKEND_URL
      || localEnv.LEARNFLOW_FORMAL_BACKEND_URL
      || 'http://127.0.0.1:8010',
  ).replace(/\/$/, '')
}

function loadTutorAllowedOrigins(mode: string) {
  const localEnv = loadEnv(mode, process.cwd(), '')
  const configured = String(process.env.LEARNFLOW_PUBLIC_ORIGIN || localEnv.LEARNFLOW_PUBLIC_ORIGIN || '')
    .split(',').map(value => value.trim()).filter(Boolean)
  return new Set(['http://127.0.0.1:4174', 'http://localhost:4174', ...configured])
}

function readJsonBody(request: any): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let body = ''
    let tooLarge = false
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      if (tooLarge) return
      body += chunk
      if (body.length > 1_000_000) tooLarge = true
    })
    request.on('end', () => {
      if (tooLarge) {
        rejectBody(new Error('请求内容过大'))
        return
      }
      try {
        resolveBody(JSON.parse(body || '{}'))
      } catch {
        rejectBody(new Error('请求不是有效 JSON'))
      }
    })
    request.on('error', rejectBody)
  })
}

function readRawBody(request: any, maxBytes = 30_000_000): Promise<Uint8Array> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Uint8Array[] = []
    let total = 0
    request.on('data', (chunk: Uint8Array) => {
      total += chunk.length
      if (total > maxBytes) {
        rejectBody(new Error('请求内容过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const body = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.length
      }
      resolveBody(body)
    })
    request.on('error', rejectBody)
  })
}

function sendJson(response: any, status: number, payload: unknown) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(payload))
}

function sendStreamEvent(response: any, payload: unknown) {
  response.write(`${JSON.stringify(payload)}\n`)
}

function tutorProxy(mode: string, backendBase: string): Plugin {
  const legacyKeyConfiguration = loadTutorKey(mode)
  const platformTutor = loadTutorConfiguration(mode)
  const runtimeBridgeToken = loadRuntimeBridgeToken(mode)
  const searchConfiguration = loadSearchConfiguration(mode)
  const learningTaskPreflight = loadLearningTaskPreflightConfiguration(mode)
  const tutorGeneration = loadTutorGenerationConfiguration(mode)
  const resolveAccountKey = createAccountCredentialResolver({
    mode,
    backendBase,
    runtimeBridgeToken,
    legacyDevelopmentCredential: legacyKeyConfiguration,
  })
  // Production packages are immutable for the life of the server. During local
  // development, however, the client glob can discover a newly added plugin
  // without restarting Vite. Reload the server registry per turn as well so the
  // UI never advertises a capability that the Tutor process cannot resolve.
  const pluginRegistryProvider = createLearnFlowPluginRegistryProvider({ reload: mode !== 'production' })
  const allowedOrigins = loadTutorAllowedOrigins(mode)

  const callProvider = async (options: {
    endpoint: string
    body: unknown
    apiKey?: string
    timeoutMs?: number
    onTextDelta?: (delta: string) => void
  }) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || AI_LATENCY_BUDGETS.providerProxyDefault)
    try {
      const requestBody = options.onTextDelta && options.body && typeof options.body === 'object'
        ? { ...(options.body as Record<string, unknown>), stream: true }
        : options.body
      const providerResponse = await fetch(options.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })
      if (options.onTextDelta) {
        const streamed = await readProviderStream(providerResponse, options.onTextDelta)
        if (!providerResponse.ok) {
          throw new Error(errorFromTutorProviderResponse(streamed.payload, providerResponse.status))
        }
        return streamed.payload
      }
      const providerBody = await providerResponse.text()
      let providerPayload: unknown = null
      try {
        providerPayload = JSON.parse(providerBody)
      } catch {
        const streamParts = providerBody.split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim())
          .filter(line => line && line !== '[DONE]')
          .flatMap(line => {
            try {
              const part = textFromTutorProviderResponse(JSON.parse(line))
              return part ? [part] : []
            } catch {
              return []
            }
          })
        providerPayload = streamParts.length ? streamParts.join('') : providerBody
      }
      if (!providerResponse.ok) {
        throw new Error(errorFromTutorProviderResponse(providerPayload, providerResponse.status))
      }
      return providerPayload
    } finally {
      clearTimeout(timeout)
    }
  }

  const middleware = async (request: any, response: any, next: () => void) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1:4174')
    if (requestUrl.pathname === '/api/tutor/status') {
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: '只允许 GET' })
        return
      }
      try {
        const keyConfiguration = await resolveAccountKey(request)
        sendJson(response, 200, {
          configured: Boolean(keyConfiguration.apiKey),
          source: keyConfiguration.source,
          model: platformTutor.model,
        })
      } catch (error) {
        sendJson(response, 503, {
          configured: false,
          source: '账户凭据服务不可用',
          error: error instanceof Error ? error.message : '账户凭据服务不可用',
        })
      }
      return
    }

    const streamResponse = requestUrl.pathname === '/api/tutor/stream'
    if (requestUrl.pathname !== '/api/tutor' && !streamResponse) {
      next()
      return
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: '只允许 POST' })
      return
    }

    const origin = request.headers.origin
    if (origin && !allowedOrigins.has(origin)) {
      sendJson(response, 403, { error: '拒绝非本地页面请求' })
      return
    }

    const requestId = `tutor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const startedAt = Date.now()
    if (streamResponse) {
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store, no-transform')
      response.setHeader('X-Accel-Buffering', 'no')
      response.flushHeaders?.()
    }
    try {
      const payload = await readJsonBody(request)
      if (!payload || typeof payload !== 'object') throw new Error('请求内容无效')
      const input = payload as Record<string, unknown>
      const baseUrl = platformTutor.baseUrl
      const model = platformTutor.model
      const modeValue = input.mode
      const toolChoice = isTutorToolChoice(input.toolChoice) ? input.toolChoice : 'auto'
      const selectionContext = typeof input.selectionContext === 'string' ? input.selectionContext.slice(0, 1600) : ''
      const learningTaskContext = sanitizeLearningTaskTutorContext(input.learningTaskContext)
      const learningPlanContext = sanitizeLearningPlanTutorContext(input.learningPlanContext)
      const learnerPathState = sanitizeLearnerPathState(input.learnerPathState)
      const taskQueue = Array.isArray(input.taskQueue) ? input.taskQueue.filter((item): item is any => (
        item && typeof item === 'object' && typeof item.id === 'number'
        && typeof item.objective === 'string' && typeof item.status === 'string'
      )).slice(0, 30).map(item => ({
        id: item.id,
        objective: item.objective.slice(0, 300),
        status: item.status.slice(0, 60),
        sourceType: typeof item.sourceType === 'string' ? item.sourceType.slice(0, 80) : undefined,
        sourceId: typeof item.sourceId === 'string' ? item.sourceId.slice(0, 180) : undefined,
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt.slice(0, 80) : undefined,
      })) : []
      const knowledgeDomains = Array.isArray(input.knowledgeDomains) ? input.knowledgeDomains.filter((item): item is any => (
        item && typeof item === 'object' && typeof item.id === 'string' && typeof item.title === 'string'
      )).slice(0, 30).map(item => ({
        id: item.id.slice(0, 120),
        title: item.title.slice(0, 160),
        summary: typeof item.summary === 'string' ? item.summary.slice(0, 600) : undefined,
        labels: Array.isArray(item.labels) ? item.labels.filter((value: unknown) => typeof value === 'string').slice(0, 16) : [],
        sourceIds: Array.isArray(item.sourceIds) ? item.sourceIds.filter((value: unknown) => typeof value === 'string').slice(0, 12) : [],
      })) : []
      const rawFormalScope = input.formalScope && typeof input.formalScope === 'object'
        ? input.formalScope as Record<string, unknown> : {}
      const positiveInteger = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0
        ? value : undefined
      const formalScope = {
        sessionId: positiveInteger(rawFormalScope.sessionId),
        projectId: positiveInteger(rawFormalScope.projectId),
        checkpointId: positiveInteger(rawFormalScope.checkpointId),
        projectRole: typeof rawFormalScope.projectRole === 'string' ? rawFormalScope.projectRole : undefined,
      }
      const domainSourceIds = Array.isArray(input.domainSourceIds)
        ? [...new Set(input.domainSourceIds.filter(positiveInteger))].slice(0, 12) as number[]
        : []
      const activePluginIds = Array.isArray(input.activePluginIds)
        ? [...new Set(input.activePluginIds.filter((value): value is string => (
          typeof value === 'string' && /^[a-z][a-z0-9_]{1,23}$/.test(value)
        )))].slice(0, 16)
        : undefined
      const referencedPluginObjects = Array.isArray(input.referencedPluginObjects)
        ? input.referencedPluginObjects.flatMap(value => {
          const parsed = parsePluginObjectDragData(JSON.stringify(value))
          return parsed ? [parsed] : []
        }).slice(0, 12) as LearnFlowPluginObject[]
        : []
      const submittedMessages = Array.isArray(input.messages)
        ? input.messages.filter((message): message is { role: 'assistant' | 'user'; content: string; toolRuns?: any[] } => {
            if (!message || typeof message !== 'object') return false
            const item = message as Record<string, unknown>
            return (item.role === 'assistant' || item.role === 'user') && typeof item.content === 'string'
          })
        : []
      const latestSubmittedMessage = [...submittedMessages].reverse().find(message => message.role === 'user')?.content || ''
      const directIntake = directLearningTaskIntakeRequest(
        activePluginIds,
        formalScope.projectId,
        latestSubmittedMessage,
        referencedPluginObjects,
        modeValue,
      )
      const directDraft = directLearningTaskDraftConfirmationRequest(activePluginIds, formalScope.projectId, latestSubmittedMessage)
      const directCandidateOperation = directLearningTaskCandidateOperationRequest(
        activePluginIds,
        formalScope.projectId,
        latestSubmittedMessage,
      )
      const directCandidateSelection = directLearningTaskCandidateSelectionRequest(
        activePluginIds,
        formalScope.projectId,
        latestSubmittedMessage,
        submittedMessages,
      )
      const directPluginTurn = Boolean(directIntake || directDraft || directCandidateOperation || directCandidateSelection)
      const providerRequired = Boolean(directIntake) || !directPluginTurn
      const runtimeBaseUrl = directIntake ? learningTaskPreflight.baseUrl : baseUrl
      const runtimeModel = directIntake ? learningTaskPreflight.model : model
      const configurationIssue = tutorConfigurationIssue(runtimeBaseUrl, runtimeModel)
      if (directIntake && !learningTaskPreflight.apiKey) {
        throw new Error('学习型任务语义预检模型尚未配置，请设置服务端私密 LEARNING_TASK_PREFLIGHT_API_KEY。')
      }
      if (configurationIssue && providerRequired) throw new Error(configurationIssue)
      if (!isTutorMode(modeValue)) throw new Error('Tutor 状态无效')

      let localProvider = false
      if (providerRequired) {
        const providerUrl = new URL(runtimeBaseUrl)
        localProvider = ['localhost', '127.0.0.1', '::1'].includes(providerUrl.hostname)
        if (!localProvider && providerUrl.protocol !== 'https:') {
          throw new Error('非本机模型服务必须使用 HTTPS，避免账户密钥明文传输。')
        }
        if (providerUrl.username || providerUrl.password) {
          throw new Error('Base URL 不能内嵌账号或密码。')
        }
      }
      const keyConfiguration: ModelCredential = directIntake
        ? { apiKey: learningTaskPreflight.apiKey, source: '学习型任务转化私密语义预检' }
        : directPluginTurn
          ? { apiKey: '', source: '学习型任务插件确认直达' }
        : await resolveAccountKey(request)
      const invokeProvider = (providerRequest: {
        endpoint: string
        body: unknown
        timeoutMs?: number
        onTextDelta?: (delta: string) => void
      }) => callProvider({ ...providerRequest, apiKey: keyConfiguration.apiKey })

      const messages = submittedMessages
      if (messages.length === 0) throw new Error('没有可发送的对话内容')

      console.info('[tutor] turn started', {
        requestId,
        conversationId: typeof input.conversationId === 'string' ? input.conversationId.slice(0, 160) : undefined,
        sheetId: typeof input.sheetId === 'string' ? input.sheetId.slice(0, 160) : undefined,
        formalSessionId: formalScope.sessionId,
        referencedPluginObjects,
        mode: modeValue,
        model,
        messageCount: messages.length,
        toolChoice,
      })

      if (providerRequired && !localProvider && !keyConfiguration.apiKey) {
        throw new Error('当前账号尚未配置模型 API Key。请在账号设置中保存并测试连接。')
      }

      const latestMessage = [...messages].reverse().find(message => message.role === 'user')?.content || ''
      if (streamResponse) {
        sendStreamEvent(response, {
          type: 'trajectory',
          event: {
            sequence: 0,
            phase: 'observe',
            detail: '正在读取学习状态与当前作用域',
            at: Date.now(),
            status: 'started',
          },
        })
      }
      let formalLearnerContext: unknown = null
      let formalWorkspaceContext: unknown = null
      let formalDomainKnowledgeContext: unknown = null
      let formalReviewContext: unknown = null
      let formalProjectContext: unknown = null
      try {
        const contextPurpose = modeValue === 'learning_plan'
          ? 'learning_plan'
          : modeValue === 'guided_learning' ? 'learning_task' : 'global_tutor'
        const contextQuery = new URLSearchParams({
          query: latestMessage.slice(0, 1800),
          purpose: contextPurpose,
        })
        if (formalScope.projectId) contextQuery.set('project_id', String(formalScope.projectId))
        if (formalScope.checkpointId) contextQuery.set('checkpoint_id', String(formalScope.checkpointId))
        if (formalScope.sessionId) contextQuery.set('session_id', String(formalScope.sessionId))
        const contextResponse = await fetch(`${backendBase}/api/learner-state/context?${contextQuery}`, {
          headers: request.headers.cookie ? { Cookie: request.headers.cookie } : {},
          signal: AbortSignal.timeout(4_000),
        })
        if (contextResponse.ok) {
          formalLearnerContext = await contextResponse.json()
        }
      } catch {
        formalLearnerContext = null
      }
      if (formalScope.projectId) try {
        const projectQuery = new URLSearchParams({ query: latestMessage.slice(0, 1800) })
        if (formalScope.checkpointId) projectQuery.set('checkpoint_id', String(formalScope.checkpointId))
        if (formalScope.sessionId) projectQuery.set('session_id', String(formalScope.sessionId))
        const projectResponse = await fetch(
          `${backendBase}/api/vnext-projects/${formalScope.projectId}/agent-context?${projectQuery}`,
          {
            headers: request.headers.cookie ? { Cookie: request.headers.cookie } : {},
            signal: AbortSignal.timeout(5_000),
          },
        )
        if (projectResponse.ok) formalProjectContext = await projectResponse.json()
      } catch {
        formalProjectContext = null
      }
      if (modeValue === 'guided_learning' || modeValue === 'learning_plan') {
        try {
          const workspaceQuery = new URLSearchParams()
          if (formalScope.sessionId) workspaceQuery.set('session_id', String(formalScope.sessionId))
          if (formalScope.projectId) workspaceQuery.set('project_id', String(formalScope.projectId))
          if (formalScope.checkpointId) workspaceQuery.set('checkpoint_id', String(formalScope.checkpointId))
          const workspaceResponse = await fetch(
            `${backendBase}/api/learner-state/agent-workspace-context?${workspaceQuery}`,
            {
              headers: request.headers.cookie ? { Cookie: request.headers.cookie } : {},
              signal: AbortSignal.timeout(4_000),
            },
          )
          if (workspaceResponse.ok) formalWorkspaceContext = await workspaceResponse.json()
        } catch {
          formalWorkspaceContext = null
        }
      }
      if (domainSourceIds.length > 0) try {
        const domainQuery = new URLSearchParams({
          query: latestMessage.slice(0, 1800),
          limit: '8',
          source_ids: domainSourceIds.join(','),
        })
        const domainResponse = await fetch(`${backendBase}/api/knowledge-library/context?${domainQuery}`, {
          headers: request.headers.cookie ? { Cookie: request.headers.cookie } : {},
          signal: AbortSignal.timeout(4_000),
        })
        if (domainResponse.ok) formalDomainKnowledgeContext = await domainResponse.json()
      } catch {
        formalDomainKnowledgeContext = null
      }
      if (/复习|错题|遗忘|记不住|熟练度|掌握度|记忆曲线|间隔|回忆|薄弱/i.test(latestMessage)) {
        try {
          const reviewQuery = new URLSearchParams({ query: latestMessage.slice(0, 1800), limit: '8' })
          const reviewResponse = await fetch(`${backendBase}/api/review/agent-context?${reviewQuery}`, {
            headers: request.headers.cookie ? { Cookie: request.headers.cookie } : {},
            signal: AbortSignal.timeout(4_000),
          })
          if (reviewResponse.ok) formalReviewContext = await reviewResponse.json()
        } catch {
          formalReviewContext = null
        }
      }
      const generate = async (
        instructions: string,
        inputText: string,
        timeoutMs?: number,
        maxTokens?: number,
        generationOptions?: { responseFormat?: 'json_object' },
      ) => {
        const request = buildProviderRequest({
          baseUrl: runtimeBaseUrl, model: runtimeModel, instructions,
          messages: [{ role: 'user', content: inputText }],
          maxTokens: Math.max(400, Math.min(7_000, Number(maxTokens) || 1_200)),
          responseFormat: generationOptions?.responseFormat,
        })
        const payload = await invokeProvider({ ...request, timeoutMs: timeoutMs || AI_LATENCY_BUDGETS.providerRequest })
        const text = textFromTutorProviderResponse(payload)
        if (!text) throw new Error('模型没有返回可用的生成内容')
        return text
      }
      const pluginRegistry = await pluginRegistryProvider.get()
      console.info('[tutor] plugin activation', {
        requestId,
        requestedPluginIds: activePluginIds || [],
        installedPluginIds: pluginRegistry.packages.map(item => item.manifest.id),
      })
      const result = await runTutorAgentTurn({
        baseUrl: runtimeBaseUrl,
        model: runtimeModel,
        mode: modeValue,
        messages,
        toolChoice,
        selectionContext,
        activeArtifactContext: input.activeArtifactContext && typeof input.activeArtifactContext === 'object'
          ? input.activeArtifactContext as any
          : undefined,
        learningTaskContext,
        learningPlanContext,
        learnerPathState,
        taskQueue,
        knowledgeDomains,
        formalLearnerContext,
        formalWorkspaceContext,
        formalDomainKnowledgeContext,
        formalReviewContext,
        formalProjectContext: formalProjectContext as any,
        formalProjectId: formalScope.projectId,
        formalCheckpointId: formalScope.checkpointId,
        formalSessionId: formalScope.sessionId,
        backendBase,
        requestCookie: typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined,
        conversationId: typeof input.conversationId === 'string' ? input.conversationId.slice(0, 160) : undefined,
        sheetId: typeof input.sheetId === 'string' ? input.sheetId.slice(0, 160) : undefined,
        pluginRegistry,
        activePluginIds,
        referencedPluginObjects,
        generationConfig: tutorGeneration,
        generate,
        searchConfiguration,
        invokeProvider,
        observe: streamResponse ? event => sendStreamEvent(response, event) : undefined,
      })
      console.info('[tutor] turn completed', {
        requestId,
        elapsedMs: Date.now() - startedAt,
        replyLength: result.reply.length,
        toolRunCount: result.toolRuns.length,
      })
      if (streamResponse) {
        sendStreamEvent(response, { type: 'done', result, requestId })
        response.end()
      } else {
        sendJson(response, 200, { ...result, requestId })
      }
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError'
        ? '模型请求超过当前时间预算，已停止等待'
        : error instanceof TypeError
          ? '本地服务无法连接模型地址，请检查 Base URL 和网络'
          : error instanceof Error ? error.message : 'Tutor 请求失败'
      console.error('[tutor] turn failed', {
        requestId,
        elapsedMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : typeof error,
        message,
      })
      if (streamResponse) {
        sendStreamEvent(response, { type: 'error', error: message, requestId })
        response.end()
      } else {
        sendJson(response, 400, { error: message, requestId })
      }
    }
  }

  return {
    name: 'learnflow-local-tutor-proxy',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

function backendApiProxy(backendBase: string): Plugin {
  const middleware = async (request: any, response: any, next: () => void) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1:4174')
    if (!requestUrl.pathname.startsWith('/api/') || requestUrl.pathname === '/api/tutor' || requestUrl.pathname === '/api/tutor/stream' || requestUrl.pathname === '/api/tutor/status') {
      next()
      return
    }
    try {
      const method = String(request.method || 'GET').toUpperCase()
      const incomingContentType = String(request.headers['content-type'] || '')
      const multipart = incomingContentType.toLowerCase().startsWith('multipart/form-data')
      const body = method === 'GET' || method === 'HEAD'
        ? undefined
        : multipart ? await readRawBody(request) : JSON.stringify(await readJsonBody(request))
      const upstream = await fetch(`${backendBase}${requestUrl.pathname}${requestUrl.search}`, {
        method,
        headers: buildBackendProxyHeaders(request.headers, {
          bodyPresent: Boolean(body),
          multipart,
          contentType: incomingContentType,
        }),
        body,
        signal: AbortSignal.timeout(AI_LATENCY_BUDGETS.backendProxy),
      })
      response.statusCode = upstream.status
      response.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      const setCookie = upstream.headers.get('set-cookie')
      if (setCookie) response.setHeader('Set-Cookie', setCookie)
      response.end(await upstream.text())
    } catch (error) {
      sendJson(response, 503, {
        detail: error instanceof Error && error.name === 'TimeoutError'
          ? '正式后端请求超时'
          : '正式五核后端未启动或无法连接',
      })
    }
  }
  return {
    name: 'learnflow-formal-backend-proxy',
    configureServer(server) { server.middlewares.use(middleware) },
    configurePreviewServer(server) { server.middlewares.use(middleware) },
  }
}

export default defineConfig(({ mode }) => {
  const backendBase = loadBackendBase(mode)
  return {
  plugins: [react(), tutorProxy(mode, backendBase), backendApiProxy(backendBase)],
  server: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true,
  },
  preview: {
    allowedHosts: ['learn.learnflow.club', 'learnflow.club'],
  },
  }
})
