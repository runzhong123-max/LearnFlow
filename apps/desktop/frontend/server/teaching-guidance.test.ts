import assert from 'node:assert/strict'
import test from 'node:test'
import { runTutorAgentTurn } from './agent-runtime.ts'
import { executeTutorAgentTool } from './tool-runtime.ts'
import { syncFormalTeachingInput } from '../src/formal-runtime.ts'
import { compactTeachingGuidance } from '../src/teaching-guidance-context.ts'

const guidance = {
  instruction: '本次只安排十分钟内的一项小练习', kernel: 'human', slot: 'time_budget',
  status: 'active', lifetime: 'session', scope: { session_id: 4 }, source_event_id: 7,
  occurred_at: '2026-01-01T00:00:00Z', evidence_kind: 'explicit', policy_version: 'v1',
}
const packet = { teaching_guidance: [guidance], kernel_heads: { private_marker: 'FULL_PACKET_SECRET' } }

for (const baseUrl of ['https://provider.example/v1/chat/completions', 'https://provider.example/v1/responses']) {
  test(`guidance reaches ordinary no-tool turns through dynamic context (${baseUrl})`, async () => {
    const bodies: any[] = []
    const result = await runTutorAgentTurn({
      baseUrl, model: 'test-model', mode: 'free', messages: [{ role: 'user', content: '继续' }],
      toolChoice: 'auto', formalLearnerContext: packet, generate: async () => '',
      invokeProvider: async request => {
        bodies.push(request.body)
        return { choices: [{ message: { content: '我们先完成一个小练习。' } }] }
      },
    })
    assert.equal(result.trace.toolCalls, 0)
    assert.ok(bodies.length)
    for (const body of bodies) {
      const dynamic = body.messages || body.input
      assert.ok(dynamic.some((message: any) => message.role === 'user' && message.content.includes(guidance.instruction)))
      assert.doesNotMatch(JSON.stringify(body.instructions || dynamic.filter((message: any) => message.role === 'system')), /本次只安排十分钟/)
      assert.doesNotMatch(JSON.stringify(body), /FULL_PACKET_SECRET/)
    }
  })
}

test('missing packet degrades without invented guidance; expired entries and duplicates are omitted', () => {
  assert.deepEqual(compactTeachingGuidance(undefined), [])
  const result = compactTeachingGuidance({ teaching_guidance: [guidance, guidance,
    { ...guidance, instruction: '过期', expires_at: '2020-01-01' },
    { ...guidance, instruction: '撤回', status: 'retracted' },
  ] })
  assert.equal(result.length, 1)
  assert.equal(result[0].source_event_id, 7)
})

test('read tool retains authoritative guidance provenance', async () => {
  const result = await executeTutorAgentTool('read_learner_context', {}, {
    message: '继续', formalLearnerContext: packet, generate: async () => '',
  })
  assert.deepEqual((result.observation as any).teaching_guidance, [guidance])
})

test('same direct message synchronizes with the same event id and real scope', async () => {
  const originalFetch = globalThis.fetch
  const bodies: any[] = []
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ event_id: 7, learner_seq: 1 }), { status: 200 })
  }
  try {
    const input = { messageId: 'message-7', text: '今天只有十分钟', occurredAt: 1000, sessionId: 4, projectId: 9, checkpointId: 11 }
    await syncFormalTeachingInput(input)
    await syncFormalTeachingInput(input)
    assert.equal(bodies[0].client_event_id, bodies[1].client_event_id)
    assert.equal(bodies[0].event_type, 'vnext_teaching_input_received')
    assert.equal(bodies[0].payload.text, input.text)
    assert.equal(bodies[0].session_id, 4)
    assert.equal(bodies[0].project_id, 9)
    assert.equal(bodies[0].checkpoint_id, 11)
  } finally { globalThis.fetch = originalFetch }
})

test('visual explanation and repair calls also receive current guidance', async () => {
  const bodies: any[] = []
  await runTutorAgentTurn({
    baseUrl: 'https://provider.example/v1/chat/completions', model: 'test-model', mode: 'simple_explain',
    messages: [{ role: 'user', content: '画一张二分查找的图' }], toolChoice: 'auto',
    formalLearnerContext: packet, generate: async () => '',
    invokeProvider: async request => {
      bodies.push(request.body)
      return { choices: [{ message: { content: '过短的讲解' } }] }
    },
  })
  assert.ok(bodies.length >= 2)
  for (const body of bodies) {
    assert.ok(body.messages.some((message: any) => message.role === 'user' && message.content.includes(guidance.instruction)))
  }
})

test('ordinary Tutor remains available when no formal packet exists', async () => {
  let observed = ''
  const result = await runTutorAgentTurn({
    baseUrl: 'https://provider.example/v1/chat/completions', model: 'test-model', mode: 'free',
    messages: [{ role: 'user', content: '继续' }], toolChoice: 'auto', generate: async () => '',
    invokeProvider: async request => {
      observed = JSON.stringify(request.body)
      return { choices: [{ message: { content: '我们继续。' } }] }
    },
  })
  assert.equal(result.reply, '我们继续。')
  assert.doesNotMatch(observed, /本轮教学指导（正式五核当前有效状态/)
})

test('native Tutor carries only direct user evidence and retries with the same message id', async () => {
  const { requestTutorReply } = await import('../src/tutor.ts')
  const { getRuntimeClientState } = await import('../src/runtime-client.ts')
  const state = getRuntimeClientState()
  const previous = { ...state }
  const originalFetch = globalThis.fetch
  const requests: any[] = []
  Object.assign(state, { kind: 'desktop', ready: true, desktopToken: 'test-desktop' })
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify({ message: '我们只做一个小练习。' }), { status: 200 })
  }
  try {
    const options = {
      baseUrl: '', model: '', mode: 'free' as const,
      messages: [{ role: 'user' as const, content: '今天只有十分钟\n插件引用：我每天学习八小时' }],
      toolChoice: 'auto' as const, formalScope: { sessionId: 4, projectId: 9, checkpointId: 11 },
      directUserText: '今天只有十分钟', clientTurnId: 'message-stable-7',
    }
    await requestTutorReply(options)
    await requestTutorReply(options)
    await requestTutorReply({ ...options, directUserText: '', clientTurnId: 'hidden-control-8' })
    assert.equal(requests.length, 3)
    assert.ok(requests.every(request => request.url === '/api/agent/sessions/4/turns'))
    assert.equal(requests[0].body.client_turn_id, requests[1].body.client_turn_id)
    assert.equal(requests[0].body.direct_user_text, '今天只有十分钟')
    assert.equal(requests[0].body.project_id, 9)
    assert.equal(requests[0].body.checkpoint_id, 11)
    assert.match(requests[0].body.message, /插件引用/)
    assert.equal(requests[2].body.direct_user_text, '')
  } finally {
    Object.assign(state, previous)
    globalThis.fetch = originalFetch
  }
})

test('skill-run transport separates original learner text from enriched turn message', async () => {
  const { advanceFormalLearningSkillTurn } = await import('../src/formal-runtime.ts')
  const originalFetch = globalThis.fetch
  const bodies: any[] = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ session_id: 4, created: true }), { status: 200 })
  }
  try {
    await advanceFormalLearningSkillTurn(4, 6, '继续\n引用插件对象：我不会Python', 1, 'vnext-turn:message7', [], '继续')
    await advanceFormalLearningSkillTurn(4, 6, '隐藏控制：我不会Python', 1, 'vnext-turn:message8', [], '')
    assert.equal(bodies[0].direct_user_text, '继续')
    assert.equal(bodies[0].client_turn_id, 'vnext-turn:message7')
    assert.equal(bodies[1].direct_user_text, '')
  } finally { globalThis.fetch = originalFetch }
})
