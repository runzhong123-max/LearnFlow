import assert from 'node:assert/strict'
import test from 'node:test'

import { runTutorAgentTurn } from './agent-runtime.ts'

/** Minimal turn input; each case overrides only what it is testing. */
const baseTurn = {
  baseUrl: 'https://example.com/v1/chat/completions',
  model: 'test-model',
  toolChoice: 'auto' as const,
  generate: async () => 'unused',
  messages: [{ role: 'user' as const, content: '什么是二分查找' }],
}

test('a provider 500 is retried once instead of ending the turn', async () => {
  let attempts = 0
  const result = await runTutorAgentTurn({
    ...baseTurn,
    mode: 'simple_explain',
    invokeProvider: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('模型服务返回 HTTP 500')
      return { choices: [{ message: { content: '二分查找每次把区间对半砍。' } }] }
    },
  })
  assert.equal(attempts, 2)
  assert.equal(result.reply, '二分查找每次把区间对半砍。')
})

test('a socket hang up is retried once', async () => {
  let attempts = 0
  const result = await runTutorAgentTurn({
    ...baseTurn,
    mode: 'free',
    invokeProvider: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('socket hang up')
      return { choices: [{ message: { content: '可以继续。' } }] }
    },
  })
  assert.equal(attempts, 2)
  assert.equal(result.reply, '可以继续。')
})

// Every mode has fallback copy in deterministicTutorFallback, but the thrown-error
// path used to reach for it only in guided_learning, so a learner in any other
// state saw the raw failure instead of a usable turn.
for (const mode of ['free', 'simple_explain', 'learning_plan', 'guided_learning'] as const) {
  test(`a hard provider outage in ${mode} still returns a usable turn`, async () => {
    const result = await runTutorAgentTurn({
      ...baseTurn,
      mode,
      invokeProvider: async () => { throw new Error('模型服务返回 HTTP 503') },
    })
    assert.ok(result.reply.trim().length > 0, '必须给出可展示的正文')
    assert.doesNotMatch(result.reply, /HTTP 503/, '不要把原始错误文本丢给学习者')
  })
}

// The opposite boundary: a missing key or an unconfigured model is not something
// a learner can wait out, and a friendly "keep asking" line would bury it.
for (const failure of [
  '模型服务错误：invalid api_key',
  '模型服务返回 HTTP 401',
  '模型服务错误：model not_found',
  '模型服务错误：insufficient quota',
]) {
  test(`an actionable failure surfaces instead of being papered over: ${failure}`, async () => {
    await assert.rejects(
      runTutorAgentTurn({
        ...baseTurn,
        mode: 'free',
        invokeProvider: async () => { throw new Error(failure) },
      }),
      /.*/,
    )
  })
}

test('guided learning keeps its unconditional continuation even for an actionable failure', async () => {
  // Dropping a turn mid-task loses the learner's place, so this state keeps the
  // pre-existing behaviour of always continuing.
  const result = await runTutorAgentTurn({
    ...baseTurn,
    mode: 'guided_learning',
    invokeProvider: async () => { throw new Error('模型服务返回 HTTP 401') },
  })
  assert.ok(result.reply.trim().length > 0)
})

test('a learner-initiated abort is not retried', async () => {
  let attempts = 0
  await assert.rejects(
    runTutorAgentTurn({
      ...baseTurn,
      mode: 'free',
      invokeProvider: async () => {
        attempts += 1
        throw new Error('The operation was aborted')
      },
    }),
    /.*/,
  )
  assert.equal(attempts, 1, '取消是学习者的意图，重试等于无视它')
})
