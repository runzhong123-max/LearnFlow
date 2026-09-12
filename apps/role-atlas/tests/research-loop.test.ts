import test from "node:test";
import assert from "node:assert/strict";
import { runResearchLoop, type ResearchTool } from "@/lib/agent/research-loop";
import type { ModelInvoker } from "@/lib/agent/model";
import type { ChatResult, ChatRequest } from "@/lib/agent/native-model";
const tool: ResearchTool = { name: "read_source", description: "读取", args: { query: "关键词" }, run: async () => ({ summary: "原文", data: "事实" }) };
function model(replies: Array<ChatResult | Error>, requests: ChatRequest[] = []): ModelInvoker {
  const invoke: ModelInvoker = async function* () { throw new Error("research must use native protocol"); };
  let index = 0;
  invoke.chat = async request => { requests.push(structuredClone({ ...request, signal: undefined })); const value = replies[Math.min(index++, replies.length - 1)]; if (value instanceof Error) throw value; return value; };
  return invoke;
}
function reply(content: unknown): ChatResult { return { message: { role: "assistant", content: JSON.stringify(content) }, finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5, estimated: false } }; }
function call(name = "read_source", id = "call1", args = '{"query":"职责"}'): ChatResult { return { ...reply(null), message: { role: "assistant", content: null, reasoning_content: "supplier continuation field", tool_calls: [{ id, type: "function", function: { name, arguments: args } }] }, finishReason: "tool_calls" }; }
const input = { system: "调查员", task: "检查任务", tools: [tool] };
test("原生调用保留工具消息 ID、供应商连续性字段及实际 usage", async () => {
  const requests: ChatRequest[] = [];
  const result = await runResearchLoop({ ...input, model: model([call(), reply({ claims: [] })], requests) });
  assert.equal(result.stopReason, "final"); assert.equal(result.usage.toolCalls, 1); assert.equal(result.usage.inputTokens, 20);
  assert.equal(requests[1].messages[2].reasoning_content, "supplier continuation field");
  assert.equal(requests[1].messages[3].role, "tool"); assert.equal(requests[1].messages[3].tool_call_id, "call1");
});
test("工具错误回传后继续，未知工具不能执行", async () => {
  let invoked = 0;
  const result = await runResearchLoop({ ...input, tools: [{ ...tool, run: async () => { invoked++; throw new Error("unavailable"); } }], model: model([call("foreign"), call("read_source", "call2"), reply({ gaps: ["缺少资料"] })]) });
  assert.equal(invoked, 1); assert.equal(result.stopReason, "final");
  assert.equal(result.transcript.filter(event => event.type === "tool.completed" && !event.ok).length, 2);
});
test("未知参数与非对象参数拒绝执行", async () => {
  let invoked = 0;
  const result = await runResearchLoop({ ...input, tools: [{ ...tool, run: async () => { invoked++; return { summary: "" }; } }], model: model([call("read_source", "c", '{"secret":1}'), reply({})]) });
  assert.equal(invoked, 0); assert.match(result.checkpoint.observations.c, /未知参数/);
});
test("模型失败与取消分别报告并保存已完成工具", async () => {
  const result = await runResearchLoop({ ...input, model: model([call(), new Error("provider_down")]) });
  assert.equal(result.stopReason, "model_error"); assert.match(result.stopDetail!, /provider_down/); assert.ok(result.checkpoint.completedCalls.call1);
  const controller = new AbortController(); controller.abort();
  assert.equal((await runResearchLoop({ ...input, signal: controller.signal, model: model([reply({})]) })).stopReason, "cancelled");
});
test("批次与工具预算由运行时执行，恢复不重复工具", async () => {
  let invoked = 0;
  const tools = [{ ...tool, run: async () => { invoked++; return { summary: "once" }; } }];
  const first = await runResearchLoop({ ...input, tools, model: model([call()]), budget: { maxTurns: 1 } });
  assert.equal(first.stopReason, "max_turns");
  const second = await runResearchLoop({ ...input, tools, checkpoint: first.checkpoint, model: model([reply({ done: true })]) });
  assert.equal(second.stopReason, "final"); assert.equal(invoked, 1);
  const exhausted = await runResearchLoop({ ...input, model: model([call()]), budget: { maxToolCalls: 0 } });
  assert.equal(exhausted.stopReason, "max_tool_calls");
});
test("不合法产物可以修正，不能静默丢弃问题字段", async () => {
  const result = await runResearchLoop({ ...input, model: model([reply({ wrong: true }), reply({ valid: true })]), validateFinal: value => { if (!(value as any).valid) throw new Error("missing valid"); return value; } });
  assert.equal(result.stopReason, "final"); assert.equal(result.usage.turns, 2); assert.ok(result.transcript.some(event => event.type === "turn.invalid"));
});
test("长结果完整保留，并能通过归档工具继续读取", async () => {
  const longText = "事实".repeat(4000);
  const result = await runResearchLoop({ ...input, tools: [{ ...tool, run: async () => ({ summary: longText }) }], model: model([call(), reply({})]), budget: { maxTranscriptChars: 20_000 } });
  assert.ok(result.checkpoint.observations.call1.includes(longText)); assert.equal(result.stopReason, "final");
});
test("没有原生适配器时诚实失败，不退回伪工具协议", async () => {
  const result = await runResearchLoop({ ...input, model: async function* () { yield { type: "text", delta: "{}" }; } });
  assert.equal(result.stopReason, "model_error"); assert.equal(result.usage.turns, 0);
});

test("结构化工具使用自己的本地 schema 校验，不能被旧的字符串参数表误拒绝", async () => {
  let received: unknown;
  const structured: ResearchTool = { name: "submit", description: "保存候选", args: {}, parameters: { type: "object", properties: { claim: { type: "object" } } }, validate: value => { assert.equal(typeof (value as any).claim.statement, "string"); return value as Record<string, unknown>; }, run: async args => { received = args; return { summary: "候选已保存" }; } };
  const result = await runResearchLoop({ ...input, tools: [structured], model: model([call("submit", "structured", '{"claim":{"statement":"有原文的发现"}}'), reply({})]) });
  assert.equal(result.stopReason, "final"); assert.deepEqual(received, { claim: { statement: "有原文的发现" } });
});

test("无法继续压缩的上下文明确停止，不反复续批消耗模型", async () => {
  const requests: ChatRequest[] = [];
  const result = await runResearchLoop({ ...input, task: "未完成事项".repeat(100), budget: { maxTranscriptChars: 100 }, model: model([reply({})], requests) });
  assert.equal(result.stopReason, "context_full"); assert.equal(requests.length, 0); assert.match(result.checkpoint.messages[1].content!, /未完成事项/u);
});
