import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInvoker } from "@/lib/agent/model";
import {
  buildActionSystemPrompt,
  DEFAULT_RESEARCH_BUDGET,
  renderToolCatalog,
  runResearchLoop,
  type ResearchLoopEvent,
  type ResearchTool,
} from "@/lib/agent/research-loop";

/** Answers each turn from a script; records the user prompts it was given. */
function scriptedModel(replies: string[], prompts: string[] = []): ModelInvoker {
  let index = 0;
  return async function* (input) {
    prompts.push(input.user);
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    yield { type: "text", delta: reply };
  };
}

function tool(name: string, run: ResearchTool["run"]): ResearchTool {
  return { name, description: `工具 ${name}`, args: { query: "检索词" }, run };
}

test("循环按观察推进，并在 final 处停止", async () => {
  const prompts: string[] = [];
  const replies = [
    '{"thought":"先查岗位职责","action":{"tool":"search_web","args":{"query":"软件测试职责"}}}',
    '{"thought":"已获得足够依据","final":{"claims":[{"statement":"负责功能测试"}]}}',
  ];
  const events: ResearchLoopEvent[] = [];
  const result = await runResearchLoop<{ claims: Array<{ statement: string }> }>({
    model: scriptedModel(replies, prompts),
    system: "你是研究员",
    task: "研究软件测试技术员岗位",
    tools: [tool("search_web", async () => ({ summary: "找到 2 条来源", data: { hits: 2 } }))],
    onEvent: event => events.push(event),
  });

  assert.equal(result.stopReason, "final");
  assert.deepEqual(result.final, { claims: [{ statement: "负责功能测试" }] });
  assert.deepEqual(result.usage, { turns: 2, toolCalls: 1 });
  assert.equal(events.filter(event => event.type === "tool.completed").length, 1);

  // 第二轮必须带着第一轮的观察，否则模型无法据结果推进。
  assert.match(prompts[1], /找到 2 条来源/);
  assert.match(prompts[1], /"hits":2/u);
  assert.equal(events[events.length - 1].type, "loop.stopped");
});

test("工具失败变成可继续的观察，不会中止研究也不会伪造结果", async () => {
  const replies = [
    '{"thought":"先查一次","action":{"tool":"search_web","args":{"query":"x"}}}',
    '{"thought":"检索不可用，如实说明缺口","final":{"claims":[],"gap":"检索不可用"}}',
  ];
  const events: ResearchLoopEvent[] = [];
  const result = await runResearchLoop({
    model: scriptedModel(replies),
    system: "你是研究员",
    task: "研究岗位",
    tools: [tool("search_web", async () => { throw new Error("provider_429"); })],
    onEvent: event => events.push(event),
  });

  assert.equal(result.stopReason, "final");
  assert.deepEqual(result.final, { claims: [], gap: "检索不可用" });
  const failure = events.find(event => event.type === "tool.completed" && !event.ok);
  assert.ok(failure, "工具失败必须留下可审计事件");
  assert.match(String((failure as { error?: string }).error), /provider_429/u);
  // 失败仍然消耗一次工具预算，但循环继续。
  assert.equal(result.usage.toolCalls, 1);
});

test("编造的工具名不执行任何东西，只消耗一轮并告知可用工具", async () => {
  const prompts: string[] = [];
  const replies = [
    '{"thought":"试一个不存在的","action":{"tool":"delete_graph","args":{}}}',
    '{"thought":"改用已列出的工具","final":{"ok":true}}',
  ];
  let executed = 0;
  const result = await runResearchLoop({
    model: scriptedModel(replies, prompts),
    system: "你是研究员",
    task: "研究岗位",
    tools: [tool("search_web", async () => { executed += 1; return { summary: "ok" }; })],
  });

  assert.equal(executed, 0, "未登记的工具绝不能被调用");
  assert.equal(result.usage.toolCalls, 0);
  assert.equal(result.stopReason, "final");
  const observed = prompts[1];
  assert.match(observed, /delete_graph/u);
  assert.match(observed, /search_web/u);
});

test("预算由代码截断：轮数、工具次数分别生效", async () => {
  const callTool = '{"thought":"继续","action":{"tool":"search_web","args":{"query":"q"}}}';
  const cappedTurns = await runResearchLoop({
    model: scriptedModel([callTool]),
    system: "s", task: "t",
    tools: [tool("search_web", async () => ({ summary: "ok" }))],
    budget: { maxTurns: 3, maxToolCalls: 99 },
  });
  assert.equal(cappedTurns.stopReason, "max_turns");
  assert.equal(cappedTurns.usage.turns, 3);
  assert.equal(cappedTurns.final, null, "预算耗尽不得返回伪造结论");

  const cappedTools = await runResearchLoop({
    model: scriptedModel([callTool]),
    system: "s", task: "t",
    tools: [tool("search_web", async () => ({ summary: "ok" }))],
    budget: { maxTurns: 99, maxToolCalls: 2 },
  });
  assert.equal(cappedTools.stopReason, "max_tool_calls");
  assert.equal(cappedTools.usage.toolCalls, 2);
});

test("无法解析的输出终止循环，不重复同一提示", async () => {
  let calls = 0;
  const model: ModelInvoker = async function* () { calls += 1; yield { type: "text", delta: "我不会输出 JSON" }; };
  const result = await runResearchLoop({
    model, system: "s", task: "t", tools: [],
  });
  assert.equal(result.stopReason, "invalid_action");
  assert.equal(calls, 1, "解析失败不得重试同一个提示，否则可能形成无限循环");
  assert.equal(result.final, null);
});

test("模型异常终止循环并保留原因", async () => {
  const model: ModelInvoker = async function* () { throw new Error("provider_down"); yield { type: "text", delta: "" }; };
  const result = await runResearchLoop({ model, system: "s", task: "t", tools: [] });
  assert.equal(result.stopReason, "model_error");
  assert.match(String(result.stopDetail), /provider_down/u);
});

test("final 校验失败按不合法处理，不会把坏结果交出去", async () => {
  const result = await runResearchLoop<{ id: string }>({
    model: scriptedModel(['{"thought":"完成","final":{"wrong":1}}']),
    system: "s", task: "t", tools: [],
    validateFinal: value => {
      const record = value as Record<string, unknown>;
      if (typeof record.id !== "string") throw new Error("final 缺少 id");
      return { id: record.id };
    },
  });
  assert.equal(result.stopReason, "invalid_action");
  assert.match(String(result.stopDetail), /final 缺少 id/u);
  assert.equal(result.final, null);
});

test("上下文有界：观察被截断，较早条目在超预算时显式省略", async () => {
  const prompts: string[] = [];
  const huge = "字".repeat(5_000);
  const callTool = '{"thought":"继续","action":{"tool":"search_web","args":{"query":"q"}}}';
  await runResearchLoop({
    model: scriptedModel([callTool, callTool, callTool, '{"thought":"够了","final":{}}'], prompts),
    system: "s", task: "t",
    tools: [tool("search_web", async () => ({ summary: huge }))],
    budget: { maxTurns: 10, maxToolCalls: 10, maxTranscriptChars: 3_000 },
  });
  const last = prompts[prompts.length - 1];
  assert.ok(last.length < 8_000, `上下文必须被截断，实际 ${last.length}`);
  assert.match(last, /已省略较早的 \d+ 条观察/u);
});

test("系统提示列出工具与纪律，空工具集明确说明", () => {
  const catalog = renderToolCatalog([tool("search_web", async () => ({ summary: "" }))]);
  assert.match(catalog, /search_web\(query: 检索词\)/u);
  assert.match(renderToolCatalog([]), /没有可用工具/u);

  const prompt = buildActionSystemPrompt({
    persona: "你是岗位研究员",
    tools: [tool("search_web", async () => ({ summary: "" }))],
    finalShape: '{"claims":[...]}',
  });
  assert.match(prompt, /只能输出一个 JSON 对象/u);
  assert.match(prompt, /不得把观察里没有的内容写进 final/u);
  assert.match(prompt, /\{"thought":"一句话说明依据","final":\{"claims":\[\.\.\.\]\}\}/u);
});

test("默认预算是有界的，避免无上限研究", () => {
  assert.ok(DEFAULT_RESEARCH_BUDGET.maxTurns > 0 && DEFAULT_RESEARCH_BUDGET.maxTurns <= 32);
  assert.ok(DEFAULT_RESEARCH_BUDGET.maxToolCalls >= DEFAULT_RESEARCH_BUDGET.maxTurns);
  assert.ok(DEFAULT_RESEARCH_BUDGET.maxTranscriptChars <= 64_000);
});
