import assert from 'node:assert/strict'
import test from 'node:test'

import { reasoningContentFromProviderResponse, toolCallsFromProviderResponse } from './agent-runtime.ts'
import { readProviderStream } from './provider-stream.ts'
import { textFromTutorProviderResponse } from '../src/tutor.ts'

function sseResponse(chunks: string[]) {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk)))
      controller.close()
    },
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
}

test('chat completions text is delivered as provider deltas and rebuilt', async () => {
  const deltas: string[] = []
  const response = sseResponse([
    'data: {"choices":[{"delta":{"content":"梯度"}}]}\n',
    '\ndata: {"choices":[{"delta":{"content":"下降"}}]}\n\ndata: [DONE]\n\n',
  ])
  const result = await readProviderStream(response, delta => deltas.push(delta))
  assert.deepEqual(deltas, ['梯度', '下降'])
  assert.equal(textFromTutorProviderResponse(result.payload), '梯度下降')
  assert.equal(result.streamed, true)
})

test('chat completion length stops survive stream normalization', async () => {
  const response = sseResponse([
    'data: {"choices":[{"delta":{"content":"未完成正文"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
    'data: [DONE]\n\n',
  ])
  const result = await readProviderStream(response)
  assert.equal((result.payload as any).choices[0].finish_reason, 'length')
})

test('responses API incomplete status and details survive stream normalization', async () => {
  const response = sseResponse([
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"未完成正文"}\n\n',
    'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}}\n\n',
  ])
  const result = await readProviderStream(response)
  assert.equal((result.payload as any).status, 'incomplete')
  assert.equal((result.payload as any).incomplete_details.reason, 'max_output_tokens')
  assert.equal(textFromTutorProviderResponse(result.payload), '未完成正文')
})

test('chat completions tool-call argument deltas are reassembled without leaking text', async () => {
  const deltas: string[] = []
  const response = sseResponse([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"search_computer_knowledge","arguments":"{\\"query\\":\\"梯度"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"下降\\"}"}}]}}]}\n\n',
    'data: [DONE]\n\n',
  ])
  const result = await readProviderStream(response, delta => deltas.push(delta))
  assert.deepEqual(deltas, [])
  assert.deepEqual(toolCallsFromProviderResponse(result.payload), [{
    id: 'call-1', name: 'search_computer_knowledge', arguments: { query: '梯度下降' },
  }])
})

test('chat completions preserve streamed reasoning content for the next tool round', async () => {
  const response = sseResponse([
    'data: {"choices":[{"delta":{"reasoning_content":"先核对"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"学习路径","tool_calls":[{"index":0,"id":"call-reasoning","type":"function","function":{"name":"read_learner_context","arguments":"{}"}}]}}]}\n\n',
    'data: [DONE]\n\n',
  ])
  const result = await readProviderStream(response)
  assert.equal(reasoningContentFromProviderResponse(result.payload), '先核对学习路径')
  assert.deepEqual(toolCallsFromProviderResponse(result.payload), [{
    id: 'call-reasoning', name: 'read_learner_context', arguments: {},
  }])
})

test('responses API semantic events stream text and preserve function calls', async () => {
  const deltas: string[] = []
  const response = sseResponse([
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"先解释"}\n\n',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc-1","call_id":"call-2","name":"read_learner_context","arguments":""}}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc-1","delta":"{\\"query\\":\\"梯度下降\\"}"}\n\n',
  ])
  const result = await readProviderStream(response, delta => deltas.push(delta))
  assert.deepEqual(deltas, ['先解释'])
  assert.equal(textFromTutorProviderResponse(result.payload), '先解释')
  assert.deepEqual(toolCallsFromProviderResponse(result.payload), [{
    id: 'call-2', name: 'read_learner_context', arguments: { query: '梯度下降' },
  }])
})

test('non-streaming provider fallback keeps the same callback contract', async () => {
  const deltas: string[] = []
  const response = new Response(JSON.stringify({
    choices: [{ message: { content: '完整回退回答' } }],
  }), { headers: { 'Content-Type': 'application/json' } })
  const result = await readProviderStream(response, delta => deltas.push(delta))
  assert.deepEqual(deltas, ['完整回退回答'])
  assert.equal(result.streamed, false)
})

test('semantic stream failures surface instead of becoming empty answers', async () => {
  const response = sseResponse([
    'data: {"type":"response.failed","response":{"error":{"message":"provider overloaded"}}}\n\n',
    'data: [DONE]\n\n',
  ])
  await assert.rejects(() => readProviderStream(response), /provider overloaded/)
})
