import assert from "node:assert/strict";
import test from "node:test";
import type { ColdStartRequest, SourceSegment } from "@/lib/build/types";
import {
  createReadOnlyToolset,
  createSourceReadTool,
  MAX_EXCERPTS_PER_CALL,
} from "@/lib/iteration/research-tools";

function segment(id: string, text: string, sourceId = "source-1"): SourceSegment {
  return { id, sourceId, ordinal: Number(id.replace(/\D/gu, "")) || 1, text, contentHash: `hash-${id}` };
}

test("read_source 按 id 精确读取，并标明来源与定位", async () => {
  const tool = createSourceReadTool({
    segments: [segment("segment-1", "按等价类划分设计测试用例并记录依据。")],
    assets: [{ id: "source-1", title: "软件测试标准", locator: "https://example.com/standard" } as never],
  });
  const result = await tool.run({ segmentId: "segment-1" }, { turn: 1 });
  const data = result.data as { segmentId: string; quote: string; sourceTitle: string; locator: string };
  assert.equal(data.segmentId, "segment-1");
  assert.match(data.quote, /等价类划分/u);
  assert.equal(data.sourceTitle, "软件测试标准");
  assert.equal(data.locator, "https://example.com/standard");
});

test("read_source 拒绝引用本轮未检索到的片段，避免编造出处", async () => {
  const tool = createSourceReadTool({ segments: [segment("segment-1", "已有原文。")] });
  await assert.rejects(
    tool.run({ segmentId: "segment-invented" }, { turn: 1 }),
    /不在本轮已收集的来源中/u,
  );
});

test("read_source 按关键词查找，未命中时如实说明覆盖缺口而不是断言不存在", async () => {
  const tool = createSourceReadTool({
    segments: [
      segment("segment-1", "按等价类划分设计测试用例。", "source-1"),
      segment("segment-2", "执行回归测试并记录缺陷。", "source-2"),
    ],
  });
  const hit = await tool.run({ query: "等价类" }, { turn: 1 });
  assert.equal((hit.data as { matches: unknown[] }).matches.length, 1);

  const miss = await tool.run({ query: "完全不存在的术语" }, { turn: 1 });
  assert.equal(miss.data, undefined);
  assert.match(miss.summary, /不代表事实不存在/u);
});

test("read_source 结果条数受上限约束，长文按预算截断", async () => {
  const many = Array.from({ length: 20 }, (_, index) => segment(`segment-${index}`, `命中关键词的片段 ${index} ${"字".repeat(2_000)}`));
  const tool = createSourceReadTool({ segments: many });
  const result = await tool.run({ query: "命中关键词", limit: 99 }, { turn: 1 });
  const matches = (result.data as { matches: Array<{ quote: string }> }).matches;
  assert.equal(matches.length, MAX_EXCERPTS_PER_CALL, "条数必须被上限约束");
  assert.ok(matches[0].quote.length <= 601, `长文必须截断，实际 ${matches[0].quote.length}`);
});

test("read_source 缺少 id 与关键词时明确报错，不返回空泛结果", async () => {
  const tool = createSourceReadTool({ segments: [segment("segment-1", "x")] });
  await assert.rejects(tool.run({}, { turn: 1 }), /需要 segmentId 或 query/u);
});

test("工具只读：没有网络或写库依赖也能独立构造出可调用的工具集", async () => {
  const toolset = createReadOnlyToolset({
    segments: [segment("segment-1", "已有原文。"), segment("segment-2", "另一段原文。")],
  });
  assert.deepEqual(toolset.map(tool => tool.name), ["read_source"]);
  for (const tool of toolset) {
    assert.equal(typeof tool.run, "function");
    assert.ok(Object.keys(tool.args).length > 0, "工具必须声明参数，否则模型无从调用");
  }
  const result = await toolset[0].run({ segmentId: "segment-2" }, { turn: 1 });
  assert.match((result.data as { quote: string }).quote, /另一段原文/u);
});

test("检索工具声明的参数与只读工具集契约一致", async () => {
  const { createSearchTool } = await import("@/lib/iteration/research-tools");
  const tool = createSearchTool({
    request: { runId: "t", projectId: "t", roleTitle: "x", roleDescription: "", market: "", audience: [], snapshotAsOf: "2026-09-11", sources: [] } as ColdStartRequest,
    config: { provider: "glm", apiKey: "synthetic" } as never,
  });
  assert.equal(tool.name, "search_web");
  assert.ok(tool.args.query, "必须声明 query 参数");
  // 空检索式在调用前就被拒绝，不会浪费一次网络往返。
  await assert.rejects(tool.run({ query: "   " }, { turn: 1 }), /非空检索式/u);
});
