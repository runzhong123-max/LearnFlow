import { nativeFixture } from "./helpers/native-model";
import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInvoker } from "@/lib/agent/model";
import type { ResearchTool } from "@/lib/agent/research-loop";
import type { Claim } from "@/lib/iteration/evidence-review";
import {
  researchTaskCardSchema,
  runResearchWorker,
  runResearchWorkers,
  verifiedClaims,
  workerBudgetSchema,
  type ResearchWorkerResult,
} from "@/lib/iteration/worker";

function card(overrides: Record<string, unknown> = {}) {
  return researchTaskCardSchema.parse({
    id: "card-1",
    question: "软件测试技术员的典型任务需要哪些知识技能？",
    sourceClass: "official_standard",
    ...overrides,
  });
}

function observedClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: "c1",
    statement: "需要按等价类划分设计用例",
    kind: "observed",
    evidenceSpans: [{ segmentId: "segment-1", quote: "按等价类划分设计测试用例。" }],
    falsifier: "权威标准中不存在用例设计职责",
    confidence: 0.7,
    affectedNodeIds: [],
    ...overrides,
  } as Claim;
}

/**
 * Serves both halves of the worker: the research loop (action/final) and the
 * evidence reviewer (verdicts). The system prompt distinguishes them.
 */
function workerModel(input: {
  final?: unknown
  verdicts?: Array<{ claimId: string; verdict: string; note: string }>
  loops?: string[]
  systems?: string[]
}): ModelInvoker {
  let turns = 0;
  return nativeFixture(async function* (request) {
    input.systems?.push(request.system);
    if (request.system.includes("独立的证据复核员")) {
      yield { type: "text", delta: JSON.stringify({ verdicts: input.verdicts || [] }) };
      return;
    }
    const scripted = input.loops?.[Math.min(turns, (input.loops?.length || 1) - 1)];
    turns += 1;
    if (scripted) { yield { type: "text", delta: scripted }; return; }
    yield { type: "text", delta: JSON.stringify({ thought: "够了", final: input.final }) };
  });
}

const tool: ResearchTool = {
  name: "search_web",
  description: "检索",
  args: { query: "检索词" },
  run: async () => ({ summary: "找到 1 条来源" }),
};

test("复核通过的断言才允许进入下游写图", async () => {
  const result = await runResearchWorker({
    model: workerModel({
      final: { claims: [observedClaim()] },
      verdicts: [{ claimId: "c1", verdict: "supported", note: "片段直接写明" }],
    }),
    card: card(),
    tools: [tool],
  });
  assert.equal(result.stopReason, "final");
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].verification, "verified");
  assert.deepEqual(verifiedClaims(result).map(claim => claim.id), ["c1"]);
});

test("复核不通过的断言保留在结果里，但不进入可写集合", async () => {
  const result = await runResearchWorker({
    model: workerModel({
      final: { claims: [observedClaim()] },
      verdicts: [{ claimId: "c1", verdict: "unsupported", note: "片段只提到测试执行" }],
    }),
    card: card(),
    tools: [tool],
  });
  assert.equal(result.claims.length, 1, "复核不通过不得删除断言");
  assert.equal(result.claims[0].verification, "unverified");
  assert.match(result.claims[0].note, /复核不支持/u);
  assert.deepEqual(verifiedClaims(result), []);
  assert.equal(result.rejectedCount, 1);
});

test("无证据的 observed 断言不进可写集合，也不消耗复核调用", async () => {
  const systems: string[] = [];
  const result = await runResearchWorker({
    model: workerModel({ final: { claims: [observedClaim({ evidenceSpans: [] })] }, systems }),
    card: card(),
    tools: [tool],
  });
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].verification, "unverified");
  assert.match(result.claims[0].note, /缺少原文/u);
  assert.equal(systems.some(system => system.includes("独立的证据复核员")), false);
});

test("复核器失败时全部保持待核实，既不升级也不删除", async () => {
  const model: ModelInvoker = async function* (request) {
    if (request.system.includes("独立的证据复核员")) throw new Error("reviewer_down");
    yield { type: "text", delta: JSON.stringify({ thought: "完成", final: { claims: [observedClaim()] } }) };
  };
  const result = await runResearchWorker({ model: nativeFixture(model), card: card(), tools: [tool] });
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].verification, "unverified");
  assert.match(result.claims[0].note, /复核不可用/u);
  assert.deepEqual(verifiedClaims(result), []);
});

test("最终产物结构非法即终止，不静默丢弃部分断言", async () => {
  const duplicate = await runResearchWorker({
    model: workerModel({ final: { claims: [observedClaim(), observedClaim()] } }),
    card: card(), tools: [tool],
  });
  assert.equal(duplicate.stopReason, "max_turns");
  assert.ok(duplicate.transcript.some(event => event.type === "turn.invalid" && event.reason.includes("claim id 重复")));
  assert.deepEqual(duplicate.claims, []);

  const malformed = await runResearchWorker({
    model: workerModel({ final: { claims: [{ id: "x", statement: "", kind: "observed" }] } }),
    card: card(), tools: [tool],
  });
  assert.equal(malformed.stopReason, "max_turns");
  assert.deepEqual(malformed.claims, []);
});

test("工具失败仍能收敛为带缺口的结论，不伪造断言", async () => {
  const failing: ResearchTool = { ...tool, run: async () => { throw new Error("provider_429"); } };
  const result = await runResearchWorker({
    model: workerModel({
      loops: [
        '{"thought":"先检索","action":{"tool":"search_web","args":{"query":"q"}}}',
        '{"thought":"检索不可用，如实记录缺口","final":{"claims":[],"gaps":["检索不可用，未获得证据"]}}',
      ],
      verdicts: [],
    }),
    card: card(), tools: [failing],
  });
  assert.equal(result.stopReason, "final");
  assert.deepEqual(result.claims, []);
  assert.deepEqual(verifiedClaims(result), []);
  assert.equal(result.usage.toolCalls, 1);
});

test("worker 提示包含任务、证据类型与无证据断言的后果", () => {
  const systems: string[] = [], tasks: string[] = [];
  const payload = '{"thought":"完成","final":{"claims":[]}}';
  return runResearchWorker({
    model: nativeFixture(async function* (request) { systems.push(request.system); tasks.push(request.user); yield { type: "text", delta: payload }; }),
    card: card({ sourceClass: "job_market", queriesHint: ["招聘要求", "岗位职责"] }),
    tools: [tool],
  }).then(() => {
    const system = systems[0];
    assert.doesNotMatch(system, /招聘要求/u);
    assert.match(tasks[0], /job_market/u);
    assert.match(tasks[0], /招聘要求/u);
    assert.match(system, /kind=observed 时必须附至少一条原文片段/u);
    assert.match(system, /按需填写 falsifier/u);
    assert.match(system, /证据不足时把它写进 gaps/u);
  });
});

test("并发扇出受上限约束，且不遗漏任何任务卡", async () => {
  let inFlight = 0;
  let peak = 0;
  const cards = Array.from({ length: 7 }, (_, index) => card({ id: `card-${index}` }));
  const results = await runResearchWorkers({
    cards,
    concurrency: 3,
    runOne: async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight -= 1;
      return { cardId: item.id, claims: [], rejectedCount: 0, stopReason: "final", transcript: [], usage: { turns: 0, toolCalls: 0 } } as ResearchWorkerResult;
    },
  });
  assert.equal(results.length, 7);
  assert.deepEqual(results.map(result => result.cardId).sort(), cards.map(item => item.id).sort());
  assert.ok(peak <= 3, `并发必须受上限约束，实际峰值 ${peak}`);
});

test("任务卡与预算契约有明确边界", () => {
  assert.throws(() => researchTaskCardSchema.parse({ id: "x", question: "q", sourceClass: "unknown" }), /sourceClass|invalid/u);
  assert.equal(researchTaskCardSchema.parse({ id: "x", question: "q", sourceClass: "academic" }).budget.queries, 8);
  assert.throws(() => workerBudgetSchema.parse({ maxTurns: 999 }), /maxTurns|too_big/u);
  assert.equal(workerBudgetSchema.parse({}).maxToolCalls, 128);
});
