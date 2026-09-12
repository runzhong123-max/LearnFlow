import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInvoker } from "@/lib/agent/model";
import { createIterationContract } from "@/lib/iteration/planner";
import {
  createResearchSupervisor,
  deterministicCards,
  MAX_CARDS_PER_PLAN,
  QUERIES_PER_CARD,
} from "@/lib/iteration/supervisor";
import type { IterationContract, IterationWorkItem, SnapshotIterationRequest } from "@/lib/iteration/types";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";

function contract(overrides: Partial<SnapshotIterationRequest> = {}): IterationContract {
  const request = {
    runId: "supervisor-test",
    snapshotRef: { snapshotId: bundledRoleSnapshot().snapshot.id },
    initiativeProfile: "autonomous",
    prompt: "",
    targetIds: [],
    supplementalSources: [],
    webResearch: true,
    maxRounds: 4,
    sourceLimit: 16,
    maxWorkItems: 6,
    ...overrides,
  } as SnapshotIterationRequest;
  return createIterationContract(request, bundledRoleSnapshot());
}

function workItem(overrides: Partial<IterationWorkItem> = {}): IterationWorkItem {
  return {
    id: "work:aaa",
    kind: "repair",
    origin: "inspector",
    title: "任务缺少技能覆盖",
    detail: "部署客户系统缺少可检验的技能点",
    targetIds: ["task-1"],
    findingIds: ["finding-1"],
    priority: 90,
    requiresResearch: true,
    status: "planned",
    ...overrides,
  };
}

function modelReturning(payload: unknown): ModelInvoker {
  return async function* () {
    yield { type: "text", delta: JSON.stringify(payload) };
  };
}

test("模型给出的任务卡被采纳，但身份、findings 与预算由代码决定", async () => {
  const items = [workItem()];
  const supervisor = createResearchSupervisor({
    model: modelReturning({
      cards: [{
        workItemId: "work:aaa",
        question: "软件测试技术员在设计边界值用例时需要依据哪些规则？",
        sourceClass: "official_standard",
        queriesHint: ["边界值 测试 标准", "等价类 边界"],
        // 以下字段即使模型塞进来也不该被采信。
        id: "model-chosen-id",
        budget: { queries: 999 },
        why: { findingIds: ["fabricated"] },
      }],
    }),
  });
  const cards = await supervisor.plan({ contract: contract(), workItems: items, round: 1 });

  assert.equal(cards.length, 1);
  assert.equal(cards[0].question, "软件测试技术员在设计边界值用例时需要依据哪些规则？");
  assert.equal(cards[0].sourceClass, "official_standard");
  assert.deepEqual(cards[0].queriesHint, ["边界值 测试 标准", "等价类 边界"]);
  // 身份来自工作项，不是模型。
  assert.match(cards[0].id, /^research-card:/u);
  assert.notEqual(cards[0].id, "model-chosen-id");
  // findings 与预算由代码注入。
  assert.deepEqual(cards[0].why.findingIds, ["finding-1"]);
  assert.equal(cards[0].budget.queries, QUERIES_PER_CARD);
});

test("调查范围可含相邻对象，改动范围仍由用户契约固定", async () => {
  const supervisor = createResearchSupervisor({
    model: modelReturning({
      cards: [{
        workItemId: "work:aaa", question: "该岗位需要哪些技能？", sourceClass: "job_market",
        queriesHint: [], targetIds: ["task-999"], affectedNodeIds: ["task-999"],
      }],
    }),
  });
  const cards = await supervisor.plan({ contract: contract(), workItems: [workItem()], round: 1 });
  // 卡结构里根本没有范围字段，越权无处安放。
  assert.deepEqual(cards[0].targetIds, contract().targetIds);
  assert.deepEqual(cards[0].inputRefs, ["task-999"]);
  assert.equal("affectedNodeIds" in cards[0], false);
});

test("主管可提出检查清单外的新研究问题", async () => {
  const supervisor = createResearchSupervisor({
    model: modelReturning({
      cards: [
        { workItemId: "work:invented", question: "研究一个不存在的工作项", sourceClass: "academic", queriesHint: [] },
        { workItemId: "work:aaa", question: "补齐技能覆盖需要哪些依据？", sourceClass: "official_standard", queriesHint: [] },
      ],
    }),
  });
  const cards = await supervisor.plan({ contract: contract(), workItems: [workItem()], round: 1 });
  assert.equal(cards.length, 2);
  assert.ok(cards.some(card => card.why.findingIds.includes("finding-1")));
  assert.ok(cards.some(card => card.question === "研究一个不存在的工作项"));
});

test("模型漏掉的工作项仍会拿到确定性的卡，研究范围不因模型而收窄", async () => {
  const items = [
    workItem({ id: "work:a", title: "任务A缺技能", findingIds: ["f-a"] }),
    workItem({ id: "work:b", title: "任务B缺过程", findingIds: ["f-b"] }),
  ];
  const supervisor = createResearchSupervisor({
    // 只给 A 一张卡。
    model: modelReturning({
      cards: [{ workItemId: "work:a", question: "任务A需要什么技能？", sourceClass: "job_market", queriesHint: [] }],
    }),
  });
  const cards = await supervisor.plan({ contract: contract(), workItems: items, round: 1 });
  assert.equal(cards.length, 2, "被跳过的工作项必须补上确定性任务卡");
  const byFinding = cards.flatMap(card => card.why.findingIds);
  assert.ok(byFinding.includes("f-a") && byFinding.includes("f-b"));
});

test("模型失败时降级为确定性计划并报告原因，而不是放弃研究", async () => {
  const degrades: string[] = [];
  const failing: ModelInvoker = async function* () { throw new Error("provider_down"); yield { type: "text", delta: "" }; };
  const supervisor = createResearchSupervisor({ model: failing, onDegrade: info => degrades.push(info.reason) });
  const cards = await supervisor.plan({ contract: contract(), workItems: [workItem()], round: 1 });
  assert.equal(cards.length, 1, "规划失败不应让研究消失");
  assert.deepEqual(cards[0].why.findingIds, ["finding-1"]);
  assert.equal(degrades.length, 1);
  assert.match(degrades[0], /provider_down/u);
});

test("模型返回空计划按降级处理并给出去确定性计划", async () => {
  const degrades: string[] = [];
  const supervisor = createResearchSupervisor({ model: modelReturning({ cards: [] }), onDegrade: info => degrades.push(info.reason) });
  const cards = await supervisor.plan({ contract: contract(), workItems: [workItem()], round: 1 });
  assert.equal(cards.length, 1);
  assert.match(degrades[0], /没有为任何已提交工作项给出任务卡/u);
});

test("卡片数量受工作项预算与计划上限双重约束", async () => {
  const items = Array.from({ length: 30 }, (_, index) => workItem({ id: `work:${index}`, title: `任务 ${index}` }));
  const cards = deterministicCards({ contract: contract({ maxWorkItems: 5 }), workItems: items });
  assert.equal(cards.length, 5, "受 maxWorkItems 约束");

  const many = deterministicCards({ contract: contract({ maxWorkItems: 128 }), workItems: items });
  assert.equal(many.length, Math.min(items.length, MAX_CARDS_PER_PLAN), "受计划上限约束");
});

test("没有需要研究的工作项时不产生任何卡片", async () => {
  const supervisor = createResearchSupervisor({ model: modelReturning({ cards: [] }) });
  const cards = await supervisor.plan({
    contract: contract(),
    workItems: [workItem({ requiresResearch: false })],
    round: 1,
  });
  assert.deepEqual(cards, []);
});

test("同一工作项只产生一张卡，不会因模型重复而被研究两次", async () => {
  const supervisor = createResearchSupervisor({
    model: modelReturning({
      cards: [
        { workItemId: "work:aaa", question: "第一个问法是什么？", sourceClass: "job_market", queriesHint: [] },
        { workItemId: "work:aaa", question: "第二个问法是什么？", sourceClass: "academic", queriesHint: [] },
      ],
    }),
  });
  const cards = await supervisor.plan({ contract: contract(), workItems: [workItem()], round: 1 });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].question, "第一个问法是什么？");
});
