import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInvoker } from "@/lib/agent/model";
import { prepareBuildInput, compileSemanticDraft, compileRolePackage } from "@/lib/build/compiler";
import type { ColdStartRequest } from "@/lib/build/types";
import type { SemanticDraft } from "@/lib/build/model";
import { createSnapshotIterationSkill } from "@/lib/iteration/graph";
import type { IterationEvent, SnapshotIterationRequest, SnapshotIterationResult } from "@/lib/iteration/types";
import { createBudgetLedger } from "@/lib/iteration/budget-ledger";

/**
 * Characterization: each of the six user-selectable iteration capabilities
 * must produce real agent work — opportunities, work items, research queries,
 * retrieved evidence — and, when the model and search return relevant
 * material, an accepted candidate snapshot. A capability that runs empty or
 * is vetoed by the acceptance gate despite genuine progress is a bug; these
 * tests pin the expected behavior.
 *
 *   深度研究 = deep_research   风险发现 = risk_repair   时效迭代 = freshness
 *   目标增强 = prompt 驱动      自动发现 = autonomous     定向研究 = user_directed + targetIds
 */

const tasks = [
  { label: "部署客户系统", quote: "配置 JAVA_HOME 环境变量后启动 Tomcat，通过启动日志验证环境配置。", knowledge: "JAVA_HOME 环境变量的解析规则", skill: "配置环境变量并验证启动日志" },
  { label: "核验迁移后的业务数据", quote: "编写 SQL 多表关联查询，按主键核验迁移前后数据的一致性。", knowledge: "主键与多表关联查询规则", skill: "编写关联查询核验迁移数据" },
  { label: "交付用户操作手册", quote: "操作手册按用户角色组织步骤，写明每个步骤的前置条件与预期结果。", knowledge: "角色化操作说明的前置与结果规范", skill: "按角色编写带预期结果的步骤" },
  { label: "指导用户现场练习", quote: "先演示标准流程，再观察用户独立操作，对照操作检查表记录偏差并反馈。", knowledge: "操作检查表的偏差判定规则", skill: "观察独立操作并记录反馈偏差" },
];

function fixture() {
  const request: ColdStartRequest = { runId: "capability-fixture", projectId: "capability-fixture", roleTitle: "软件实施工程师",
    roleDescription: "实施交付和数据核验", market: "中国大陆", audience: [], snapshotAsOf: "2026-09-08",
    sources: [{ kind: "public_document", title: "实施交付操作指南", locator: "https://example.com/implementation", sourceTier: "primary",
      content: tasks.map(task => `${task.label}：${task.quote}`).join("\n\n") }],
  };
  const prepared = prepareBuildInput(request);
  const source = prepared.assets.find(asset => asset.kind !== "user_brief")!;
  const segments = prepared.segments.filter(segment => segment.sourceId === source.id);
  const draft: SemanticDraft = { roleSummary: "为客户部署业务系统、核验数据并交付可复核的培训与操作材料。", nodes: tasks.map((task, i) => ({
    tempId: `task-${i}`, type: "task", label: task.label, summary: task.quote, aliases: [],
    evidenceSegmentIds: [segments.find(segment => segment.text.includes(task.quote))!.id],
    evidenceSpans: [{ segmentId: segments.find(segment => segment.text.includes(task.quote))!.id, quote: task.quote }], confidence: 0.8,
  })), edges: [] };
  const semantic = compileSemanticDraft({ request, draft, assets: prepared.assets, segments: prepared.segments });
  const base = compileRolePackage({ request, ...prepared, semantic,
    process: { scenarios: [], nodes: [], edges: [], bridges: [], bindings: [] }, laneFailures: [] });
  return { base };
}

const newMaterial = "软件实施工程师负责客户系统部署、迁移数据核验、操作手册交付与现场培训。" +
  "实施流程包括环境检查、安装配置、数据迁移核验、用户培训与上线验收，每个环节需要可复核记录。".repeat(30);

function searchStub(calls: string[]) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (/bigmodel\.cn/.test(target)) {
      const body = JSON.parse(String(init?.body));
      calls.push(body.search_query);
      return Response.json({ request_id: "req-capability", search_result: [
        { title: "软件实施工程师岗位职责与交付规范", link: "https://careers.example.org/implementation-duties", content: newMaterial, publish_date: "2026-09-01" },
        { title: "软件实施项目交付流程与验收要点", link: "https://practice.example.org/implementation-delivery", content: `实施交付流程。${newMaterial}`, publish_date: "2026-08-15" },
      ] });
    }
    // Direct page fetch fallback for short snippets.
    return new Response(newMaterial, { status: 200, headers: { "content-type": "text/plain" } });
  };
  return () => { globalThis.fetch = previous; };
}

function capabilityModel(): ModelInvoker {
  return async function* ({ system, user }) {
    let response: unknown = {};
    if (system.includes("岗位边界判定器")) {
      const payload = JSON.parse(user);
      response = { verdicts: (payload.candidates as Array<{ url: string }>).map(candidate => ({
        url: candidate.url, relation: "core", note: "目标岗位资料", confidence: 0.9,
      })) };
    } else if (system.includes("岗位证据原子抽取器")) {
      const payload = JSON.parse(user);
      response = {
        mentions: tasks.flatMap(task => {
          const segment = (payload.segments as Array<{ id: string; text: string }>).find(item => item.text.includes(task.quote));
          return segment ? [{ tempId: `m-${task.label}`, kind: "task", label: task.label, definitionHint: task.quote,
            attributes: { actor: "软件实施工程师", actorRelation: "target_role", workObject: "客户系统", action: task.label, deliverable: "可复核记录", acceptance: "验收通过" },
            sourceSegmentId: segment.id, evidenceSpan: { segmentId: segment.id, quote: task.quote }, confidence: 0.8 }] : [];
        }),
        propositions: [],
      };
    } else if (system.includes("典型工作任务规范化器") || system.includes("典型工作任务全局归并器")) {
      const payload = JSON.parse(user);
      const mentions = (payload.mentions || []) as Array<{ id: string; label?: string }>;
      response = { roleSummary: "部署系统、核验数据并交付培训材料",
        tasks: tasks.map(task => ({ tempId: `t-${task.label}`, label: task.label, summary: task.quote, workObject: "客户系统",
          action: task.label, deliverable: "可复核记录", acceptance: "验收通过", aliases: [],
          mentionIds: mentions.filter(mention => mention.label === task.label).map(mention => mention.id), confidence: 0.8 })),
        roleContexts: [] };
    } else if (system.includes("任务导向的知识技能规范化器")) {
      const payload = JSON.parse(user);
      response = { skills: (payload.tasks as Array<{ id: string; label: string }>).flatMap(task => {
        const spec = tasks.find(row => row.label === task.label) || tasks[0];
        const segment = (payload.evidenceSegments as Array<{ id: string; text: string }>).find(item => item.text.includes(spec.quote));
        return (["knowledge", "skill"] as const).map(kind => ({ tempId: `${task.id}:${kind}`, label: spec[kind], summary: spec.quote,
          learningKind: kind, learningDefinition: { scopeNote: `限于${spec.label}的场景`, assessmentCriteria: [kind === "knowledge" ? "解释案例中的判断依据" : "完成操作并提供可复核记录"] },
          taskTempIds: [task.id], mentionIds: [], evidenceSpans: segment ? [{ segmentId: segment.id, quote: spec.quote }] : [], confidence: 0.7 }));
      }) };
    }
    yield { type: "text", delta: JSON.stringify(response) };
  };
}

function capabilityRequests(base: ReturnType<typeof fixture>["base"]): Array<[string, SnapshotIterationRequest]> {
  const common = { snapshotRef: { snapshotId: base.snapshot.id }, projectId: base.brief.projectId,
    targetIds: [] as string[], supplementalSources: [], webResearch: true, maxRounds: 1, sourceLimit: 12, maxWorkItems: 10 };
  const firstTask = base.semantic.nodes.find(node => node.type === "task")!;
  return [
    ["深度研究", { ...common, runId: "cap-deep-research", mode: "deep_research", initiativeProfile: "co_guided", prompt: "" }],
    ["风险发现", { ...common, runId: "cap-risk-repair", mode: "risk_repair", initiativeProfile: "autonomous", prompt: "" }],
    ["时效迭代", { ...common, runId: "cap-freshness", mode: "freshness", initiativeProfile: "co_guided", prompt: "", targetAsOf: "2026-09-11" }],
    ["目标增强", { ...common, runId: "cap-goal", mode: "auto", initiativeProfile: "co_guided", prompt: "补齐数据核验相关任务的知识技能与学习定义" }],
    ["自动发现", { ...common, runId: "cap-autonomous", mode: "auto", initiativeProfile: "autonomous", prompt: "" }],
    ["定向研究", { ...common, runId: "cap-directed", mode: "auto", initiativeProfile: "user_directed", prompt: "", targetIds: [firstTask.id] }],
  ];
}

for (const [capability, request] of capabilityRequests(fixture().base)) {
  test(`六能力特征化：${capability} 选中后产生真实研究、证据增量与可读结论`, async () => {
    const { base } = fixture();
    const queries: string[] = [];
    const restore = searchStub(queries);
    try {
      const output = await createSnapshotIterationSkill({
        model: capabilityModel(),
        searchConfig: { provider: "glm", apiKey: "synthetic-test-only" },
      }).invoke({ request, base, candidate: base });
      const result: SnapshotIterationResult = output.result!;
      assert.ok(result.opportunities.length > 0, `${capability}：没有发现任何迭代机会`);
      assert.ok(result.workItems.length > 0, `${capability}：没有生成任何工作项`);
      assert.ok(result.researchPlans.some(plan => plan.queries.length > 0), `${capability}：没有发出任何研究查询`);
      assert.ok(queries.length > 0, `${capability}：配置了搜索供应商却没有真正检索`);
      assert.ok(result.researchReports.some(report => report.selectedSourceCount > 0), `${capability}：检索没有选入任何新来源`);
      assert.ok(result.evaluation.reasons.length > 0, `${capability}：结论必须可读`);
      assert.equal(result.createdSnapshot, true, `${capability}：智能体返回了相关资料却仍被拒绝：${result.summary.join("；")}`);
    } finally { restore(); }
  });
}

/**
 * Agent research is opt-in. Without it every existing capability must behave
 * exactly as before; with it, claims are recorded for audit and must never
 * reach the graph on their own.
 */
function claimCard() {
  return {
    id: "card-1", question: "该岗位需要哪些知识技能", sourceClass: "official_standard" as const,
    why: { findingIds: [], detail: "" }, queriesHint: [], budget: { queries: 4 },
  };
}

function reviewedClaim(id: string, verification: "verified" | "unverified") {
  return {
    claim: {
      id, statement: `断言 ${id}`, kind: "observed" as const,
      evidenceSpans: [{ segmentId: "segment-1", quote: "引用原文。" }],
      falsifier: "权威标准不含该职责", confidence: 0.6, affectedNodeIds: [],
    },
    verification,
    note: verification === "verified" ? "片段直接支持" : "复核不支持：片段未覆盖",
  };
}

test("未注入研究智能体时结果形状与事件序列完全不变", async () => {
  const { base } = fixture();
  const restore = searchStub([]);
  try {
    const request = capabilityRequests(base).find(([name]) => name === "风险发现")![1];
    const output = await createSnapshotIterationSkill({ model: capabilityModel() }).invoke({ request, base, candidate: base });
    assert.equal("researchClaims" in output.result!, false, "未启用时不得新增结果字段");
  } finally { restore(); }
});

test("注入研究智能体时，已复核断言随结果返回，且不被写进候选图", async () => {
  const { base } = fixture();
  const restore = searchStub([]);
  const events: IterationEvent[] = [];
  try {
    const request = capabilityRequests(base).find(([name]) => name === "风险发现")![1];
    const stream = await createSnapshotIterationSkill({
      model: capabilityModel(),
      researchAgent: {
        plan: async () => [claimCard()],
        run: async () => ({
          cardId: "card-1",
          claims: [reviewedClaim("c1", "verified"), reviewedClaim("c2", "unverified")],
          rejectedCount: 1, stopReason: "final" as const, transcript: [], usage: { turns: 1, toolCalls: 0 },
        }),
      },
    }).stream({ request, base, candidate: base }, { configurable: { thread_id: "agent-claims-test" }, streamMode: "custom" });
    for await (const event of stream) events.push(event as IterationEvent);
  } finally { restore(); }

  const reviewed = events.find(event => event.kind === "iteration.claims.reviewed");
  assert.ok(reviewed, "必须留下可审计的复核事件");
  assert.equal(reviewed.payload.claimCount, 2);
  assert.equal(reviewed.payload.verifiedCount, 1);
  assert.equal(reviewed.payload.rejectedCount, 1);
  assert.deepEqual(reviewed.payload.stopReasons, ["final"]);
});

test("研究智能体失败不使整轮失败，并如实记录失败原因", async () => {
  const { base } = fixture();
  const restore = searchStub([]);
  const events: IterationEvent[] = [];
  try {
    const request = capabilityRequests(base).find(([name]) => name === "风险发现")![1];
    const stream = await createSnapshotIterationSkill({
      model: capabilityModel(),
      researchAgent: {
        plan: async () => { throw new Error("planner_down"); },
        run: async () => { throw new Error("unreachable"); },
      },
    }).stream({ request, base, candidate: base }, { configurable: { thread_id: "agent-claims-fail-test" }, streamMode: "custom" });
    for await (const event of stream) events.push(event as IterationEvent);
  } finally { restore(); }

  const reviewed = events.find(event => event.kind === "iteration.claims.reviewed");
  assert.ok(reviewed, "失败也必须留下事件，不能静默吞掉");
  assert.equal(reviewed.payload.claimCount, 0);
  assert.match(String(reviewed.payload.failed), /planner_down/u);
});

/**
 * The ledger is where the agent's own spending is accounted. Wiring it here —
 * and nowhere near the deterministic query path — is what lets a large budget
 * stay accountable without changing any caller that never opted in.
 */
async function runWithLedger(input: {
  ledger?: ReturnType<typeof createBudgetLedger>;
  cards?: ReturnType<typeof claimCard>[];
  seen?: Array<{ id: string; queries: number }>;
}) {
  const { base } = fixture();
  const restore = searchStub([]);
  const events: IterationEvent[] = [];
  try {
    const request = capabilityRequests(base).find(([name]) => name === "风险发现")![1];
    const stream = await createSnapshotIterationSkill({
      model: capabilityModel(),
      researchAgent: {
        plan: async () => input.cards || [claimCard()],
        run: async card => {
          input.seen?.push({ id: card.id, queries: card.budget.queries });
          return {
            cardId: card.id, claims: [], rejectedCount: 0, stopReason: "final" as const,
            transcript: [], usage: { turns: 1, toolCalls: 0 },
          };
        },
        ...(input.ledger ? { budgetLedger: input.ledger } : {}),
      },
    }).stream({ request, base, candidate: base }, { configurable: { thread_id: `ledger-${Math.random()}` }, streamMode: "custom" });
    for await (const event of stream) events.push(event as IterationEvent);
  } finally { restore(); }
  return events.find(event => event.kind === "iteration.claims.reviewed")!;
}

test("研究卡按账本发放额度，发放量小于申请量时按发放量执行", async () => {
  const ledger = createBudgetLedger({
    total: { queries: 10, tokens: 0, turns: 0 },
    reviewReserve: { queries: 4, tokens: 0, turns: 0 },
    perProduct: { general: { queries: 3, tokens: 0, turns: 0 } },
  });
  const seen: Array<{ id: string; queries: number }> = [];
  const reviewed = await runWithLedger({ ledger, cards: [claimCard()], seen });
  // 申请 4，产品额度 3 → 只能拿到 3，且研究池与复核预留都必须原样保留。
  assert.deepEqual(seen, [{ id: "card-1", queries: 3 }]);
  assert.equal(reviewed.payload.fundedCount, 1);
  assert.equal(ledger.snapshot().remainingReserve.queries, 4, "研究绝不能动用复核预留");
});

test("预算耗尽的研究卡被拒并记录原因，不会带账运行", async () => {
  const ledger = createBudgetLedger({
    total: { queries: 5, tokens: 0, turns: 0 },
    reviewReserve: { queries: 5, tokens: 0, turns: 0 },
  });
  const seen: Array<{ id: string; queries: number }> = [];
  const cards = [
    { ...claimCard(), id: "card-1" },
    { ...claimCard(), id: "card-2" },
  ];
  const reviewed = await runWithLedger({ ledger, cards, seen });
  assert.deepEqual(seen, [], "研究池为 0 时任何卡片都不该执行");
  assert.equal(reviewed.payload.fundedCount, 0);
  assert.equal(reviewed.payload.cardCount, 2);
  assert.equal((reviewed.payload.denied as unknown[]).length, 2);
  assert.match(String((reviewed.payload.denied as Array<{ reason: string }>)[0].reason), /预算不足|截断/u);
  assert.equal(ledger.snapshot().remainingReserve.queries, 5);
});

test("不提供账本时研究照旧执行，保持既有行为", async () => {
  const seen: Array<{ id: string; queries: number }> = [];
  const reviewed = await runWithLedger({ cards: [claimCard()], seen });
  assert.deepEqual(seen, [{ id: "card-1", queries: 4 }], "无账本时使用卡片自身预算");
  assert.equal(reviewed.payload.fundedCount, 1);
  assert.deepEqual(reviewed.payload.denied, []);
});
