import assert from "node:assert/strict";
import test from "node:test";
import { researchOptionsSchema } from "@/lib/research/protocol";
import { researchDepths, researchDepthContext, normalizeResearchDepth } from "@/lib/research/depth";
import { buildResearchAgent } from "@/lib/iteration/research-agent";
import { conversationIterationRequest, iterationRunBrief, defaultIterationDraft } from "@/lib/iteration/brief";
import type { ModelInvoker } from "@/lib/agent/model";

test("四档改变研究目标而不是 token 配额，旧表单兼容且显式预算保留", () => {
  assert.equal(researchOptionsSchema.parse({}).depth, "high");
  assert.equal(normalizeResearchDepth("focused"), "low");
  assert.equal(normalizeResearchDepth("deep"), "high");
  for (const depth of researchDepths) {
    const request = conversationIterationRequest({ runId: `depth-${depth}`, context: { projectId: "proj", conversationId: "conv", versionId: "vers", snapshotId: "snap", roleTitle: "工程师" }, draft: { ...defaultIterationDraft(), depth }, prompt: "修复学习支撑", materials: [], webResearch: false });
    assert.equal(request.research?.depth, depth);
    assert.equal(iterationRunBrief(request)?.depth, depth);
    assert.deepEqual(request.research?.budget, researchOptionsSchema.parse({}).budget);
    assert.match(researchDepthContext(depth).completion, /所有深度均需完整任务接口/);
    assert.equal(researchOptionsSchema.parse({ depth, budget: { tokens: 234567 } }).budget.tokens, 234567);
  }
  assert.throws(() => researchOptionsSchema.parse({ depth: "extreme" }));
});

test("深度控制真实调查批次与上下文，达到批次边界仍有剩余额度", async () => {
  for (const [depth, turns, concurrency] of [["low", 4, 2], ["max", 12, 4]] as const) {
    let calls = 0;
    const model: ModelInvoker = async function* () { throw new Error("native only"); };
    model.chat = async request => {
      if (!calls) assert.ok(JSON.stringify(request.messages).includes(researchDepthContext(depth).instruction));
      return { message: { role: "assistant", content: "", tool_calls: [{ id: `read-${++calls}`, type: "function", function: { name: "read_source", arguments: '{"segmentId":"s1"}' } }] }, finishReason: "tool_calls", usage: { inputTokens: 100, outputTokens: 50, estimated: false } };
    };
    const agent = buildResearchAgent({ model, depth, yieldForSynthesis: true });
    assert.equal(agent.concurrency, concurrency);
    const result = await agent.run({ id: "question", question: "岗位职责依据是什么", sourceClass: "job_market", why: { findingIds: [], detail: "核对边界" }, queriesHint: [], budget: { queries: 2 } }, { request: { runId: "r", projectId: "p", roleTitle: "工程师", roleDescription: "", market: "", audience: [], snapshotAsOf: "2026-09-13", sources: [] }, assets: [], segments: [{ id: "s1", sourceId: "a1", ordinal: 0, contentHash: "h", text: "排查故障并交付处理记录" }] });
    assert.equal(calls, turns);
    assert.equal(result.stopReason, "max_turns");
    assert.ok(agent.budgetLedger.snapshot().remainingResearch.tokens > 3_000_000);
  }
});
