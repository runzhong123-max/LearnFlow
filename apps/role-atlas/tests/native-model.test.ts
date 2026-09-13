import assert from "node:assert/strict";
import test from "node:test";
import { createChatInvoker } from "@/lib/agent/native-model";
import type { ProviderConfig } from "@/lib/providers";

for (const provider of ["mimo", "deepseek"] as const) test(`${provider} 原生 SSE 分片、会话字段、认证、usage 和输出上限`, async () => {
  const frames = [
    { choices: [{ delta: { reasoning_content: "局部研究状态", tool_calls: [{ index: 0, id: "call-1", function: { name: "read_source", arguments: '{"segment' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Id":"s1"}' } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 71, completion_tokens: 21 } },
  ];
  const text = frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
  let calls = 0;
  const invoke = createChatInvoker({ provider, apiKey: "test-only", model: "fixture", thinking: true } as ProviderConfig, async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body)), headers = init?.headers as Record<string, string>;
    assert.equal(body[provider === "mimo" ? "max_completion_tokens" : "max_tokens"], 100);
    assert.equal(headers[provider === "mimo" ? "api-key" : "authorization"], provider === "mimo" ? "test-only" : "Bearer test-only");
    assert.equal(body.messages[0].reasoning_content, "保留的供应商状态");
    assert.equal(body.tool_choice, undefined);
    return new Response(new ReadableStream({ start(controller) { const bytes = new TextEncoder().encode(text); for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
  });
  const result = await invoke({ messages: [{ role: "assistant", content: null, reasoning_content: "保留的供应商状态" }], maxCompletionTokens: 100 });
  assert.equal(calls, 1); assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.message.tool_calls?.[0].function.arguments, '{"segmentId":"s1"}');
  assert.equal(result.message.reasoning_content, "局部研究状态");
  assert.deepEqual(result.usage, { inputTokens: 71, outputTokens: 21, estimated: false });
});

test("中断的供应商流不能伪装成完成，缺失 usage 明确使用估算", async () => {
  const config = { provider: "deepseek", apiKey: "test", model: "fixture" } as ProviderConfig;
  const truncated = createChatInvoker(config, async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { "content-type": "text/event-stream" } }));
  await assert.rejects(truncated({ messages: [{ role: "user", content: "test" }] }), /finish_reason/u);
  const withoutUsage = createChatInvoker(config, async () => Response.json({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: {} }));
  assert.equal((await withoutUsage({ messages: [{ role: "user", content: "test" }] })).usage.estimated, true);
});
