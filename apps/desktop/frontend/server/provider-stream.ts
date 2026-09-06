type StreamToolCall = {
  id: string
  name: string
  arguments: string
}

export type ProviderStreamResult = {
  payload: unknown
  text: string
  streamed: boolean
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined
}

function textFromCompletedPayload(payload: unknown) {
  const root = asRecord(payload)
  if (!root) return ''
  if (typeof root.output_text === 'string') return root.output_text
  const chatContent = root.choices?.[0]?.message?.content
  if (typeof chatContent === 'string') return chatContent
  const parts: string[] = []
  for (const item of Array.isArray(root.output) ? root.output : []) {
    if (item?.type !== 'message') continue
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') parts.push(part.text)
    }
  }
  return parts.join('')
}

/**
 * Consume the two provider dialects LearnFlow accepts:
 * - Chat Completions: choices[0].delta.content/tool_calls
 * - Responses: response.output_text.delta and function-call lifecycle events
 *
 * The result is rebuilt into the same non-streaming shape consumed by the
 * existing Agent runtime, so streaming changes transport rather than policy.
 */
export async function readProviderStream(
  response: Response,
  onTextDelta?: (delta: string) => void,
): Promise<ProviderStreamResult> {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase()
  const streaming = contentType.includes('text/event-stream')
    || contentType.includes('application/x-ndjson')
    || contentType.includes('application/jsonl')

  if (!streaming || !response.body) {
    const raw = await response.text()
    let payload: unknown = raw
    try { payload = JSON.parse(raw) } catch { /* provider returned plain text */ }
    const text = textFromCompletedPayload(payload) || (typeof payload === 'string' ? payload : '')
    if (text) onTextDelta?.(text)
    return { payload, text, streamed: false }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let completedResponse: unknown
  let streamError = ''
  let dialect: 'chat' | 'responses' | undefined
  let chatFinishReason = ''
  let chatReasoningContent = ''
  const chatTools = new Map<number, StreamToolCall>()
  const responseTools = new Map<string, StreamToolCall>()
  const responseToolKeys = new Map<number, string>()

  const emitText = (delta: unknown) => {
    if (typeof delta !== 'string' || !delta) return
    text += delta
    onTextDelta?.(delta)
  }

  const consume = (event: unknown) => {
    const root = asRecord(event)
    if (!root) return
    if (Array.isArray(root.choices)) {
      dialect = 'chat'
      const choice = root.choices[0]
      if (typeof choice?.finish_reason === 'string') chatFinishReason = choice.finish_reason
      const delta = asRecord(choice?.delta)
      emitText(delta?.content)
      if (typeof delta?.reasoning_content === 'string') chatReasoningContent += delta.reasoning_content
      for (const item of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
        const index = Number.isInteger(item?.index) ? Number(item.index) : chatTools.size
        const current = chatTools.get(index) || { id: '', name: '', arguments: '' }
        chatTools.set(index, {
          id: current.id || String(item?.id || ''),
          name: current.name || String(item?.function?.name || ''),
          arguments: current.arguments + String(item?.function?.arguments || ''),
        })
      }
      return
    }

    const type = String(root.type || '')
    if (!type.startsWith('response.') && type !== 'error') return
    dialect = 'responses'
    if (type === 'error') {
      const error = asRecord(root.error)
      streamError = String(error?.message || root.message || '模型流式响应失败')
    }
    if (type === 'response.failed') {
      const failed = asRecord(root.response)
      const error = asRecord(failed?.error)
      streamError = String(error?.message || '模型流式响应失败')
    }
    if (type === 'response.output_text.delta') emitText(root.delta)
    if ((type === 'response.completed' || type === 'response.incomplete') && root.response) {
      completedResponse = root.response
    }

    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = asRecord(root.item)
      if (item?.type === 'function_call') {
        const key = String(item.call_id || item.id || `output-${root.output_index ?? responseTools.size}`)
        responseToolKeys.set(Number(root.output_index ?? responseTools.size), key)
        responseTools.set(key, {
          id: String(item.call_id || item.id || key),
          name: String(item.name || ''),
          arguments: typeof item.arguments === 'string' ? item.arguments : '',
        })
      }
    }
    if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
      const outputIndex = Number(root.output_index ?? 0)
      const key = String(root.call_id || responseToolKeys.get(outputIndex) || root.item_id || `output-${outputIndex}`)
      const current = responseTools.get(key) || { id: String(root.call_id || root.item_id || key), name: '', arguments: '' }
      responseToolKeys.set(outputIndex, key)
      responseTools.set(key, {
        ...current,
        arguments: type.endsWith('.done') && typeof root.arguments === 'string'
          ? root.arguments
          : current.arguments + String(root.delta || ''),
      })
    }
  }

  const consumeLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(':') || trimmed.startsWith('event:')) return
    const data = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
    if (!data || data === '[DONE]') return
    try { consume(JSON.parse(data)) } catch { /* ignore provider keepalives */ }
  }

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    lines.forEach(consumeLine)
    if (done) break
  }
  if (buffer.trim()) consumeLine(buffer)
  if (streamError) throw new Error(streamError)

  if (dialect === 'chat') {
    const toolCalls = [...chatTools.entries()].sort(([left], [right]) => left - right).map(([, tool]) => ({
      id: tool.id,
      type: 'function',
      function: { name: tool.name, arguments: tool.arguments },
    }))
    return {
      payload: {
        choices: [{
          message: {
            content: text || null,
            ...(chatReasoningContent ? { reasoning_content: chatReasoningContent } : {}),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          ...(chatFinishReason ? { finish_reason: chatFinishReason } : {}),
        }],
      },
      text,
      streamed: true,
    }
  }

  if (completedResponse) {
    const completedText = textFromCompletedPayload(completedResponse)
    const streamedText = text || completedText
    const payload = streamedText && !completedText
      ? { ...completedResponse, output_text: streamedText }
      : completedResponse
    return { payload, text: streamedText, streamed: true }
  }
  const output = [...responseTools.values()].map(tool => ({
    type: 'function_call', call_id: tool.id, name: tool.name, arguments: tool.arguments,
  }))
  return {
    payload: { output_text: text, output },
    text,
    streamed: true,
  }
}
