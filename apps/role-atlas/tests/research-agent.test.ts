import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInvoker } from "@/lib/agent/model";
import {
  buildResearchAgent,
  DEFAULT_RESEARCH_CONCURRENCY,
  ledgerForRun,
  researchAgentEnabled,
} from "@/lib/iteration/research-agent";

const noopModel: ModelInvoker = async function* () { yield { type: "text", delta: '{"cards":[]}' }; };

test("装配开关默认关闭，只有显式设为 1 才启用", () => {
  assert.equal(researchAgentEnabled({}), false);
  assert.equal(researchAgentEnabled({ ROLE_ATLAS_RESEARCH_AGENT: "" }), false);
  assert.equal(researchAgentEnabled({ ROLE_ATLAS_RESEARCH_AGENT: "0" }), false);
  assert.equal(researchAgentEnabled({ ROLE_ATLAS_RESEARCH_AGENT: "true" }), false, "只认 1，避免歧义值被当成开启");
  assert.equal(researchAgentEnabled({ ROLE_ATLAS_RESEARCH_AGENT: " 1 " }), true);
});

test("装配产出 plan / run / 并发 / 账本四件，并发默认保守", () => {
  const agent = buildResearchAgent({ model: noopModel });
  assert.equal(typeof agent.plan, "function");
  assert.equal(typeof agent.run, "function");
  assert.equal(agent.concurrency, DEFAULT_RESEARCH_CONCURRENCY);
  assert.ok(agent.concurrency <= 4, "扇出必须保守：同一 conversation 只允许一个活跃 job");
  assert.equal(typeof agent.budgetLedger.charge, "function");
});

test("账本按本轮预算建账并预留复核额度", () => {
  const ledger = ledgerForRun({ queryBudget: 100, maxRounds: 10 });
  const spend = ledger.charge("general", { queries: 100 });
  assert.equal(spend.granted.queries, 80, "研究池应为总额减去预留");
  assert.equal(ledger.snapshot().remainingReserve.queries, 20, "复核预留必须原样保留");
});

test("无检索供应商时 run 仍可构造，但不会调用检索工具", async () => {
  const agent = buildResearchAgent({ model: noopModel });
  // 只读工具集只声明 read_source；若误装 search_web，这里会因为缺少 provider 配置而失败。
  const result = await agent.run(
    { id: "card-1", question: "该岗位需要哪些技能？", sourceClass: "official_standard", why: { findingIds: [], detail: "" }, queriesHint: [], budget: { queries: 2 } },
    {
      request: { runId: "x", projectId: "x", roleTitle: "x", roleDescription: "", market: "", audience: [], snapshotAsOf: "2026-09-11", sources: [] } as never,
      segments: [],
      assets: [],
    },
  );
  assert.equal(result.cardId, "card-1");
  assert.equal(result.claims.length, 0);
});
