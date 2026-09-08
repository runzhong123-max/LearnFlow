import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInvoker } from "@/lib/agent/model";
import { prepareBuildInput, compileSemanticDraft, compileRolePackage } from "@/lib/build/compiler";
import type { ColdStartRequest } from "@/lib/build/types";
import type { SemanticDraft } from "@/lib/build/model";
import { applyInspectionToSnapshot, findingIdentity, inspectSnapshot } from "@/lib/iteration/inspector";
import { createSnapshotIterationSkill, iterationRepairFocus } from "@/lib/iteration/graph";
import { createColdStartSkill } from "@/lib/build/graph";
import type { WebResearchReport } from "@/lib/build/types";
import { createIterationContract, discoverIterationOpportunities, evaluateIteration, planIterationResearch, planIterationWork } from "@/lib/iteration/planner";
import type { SnapshotIterationRequest } from "@/lib/iteration/types";

// Synthetic software implementation evidence. Never includes tester uploads.
const tasks = [
  { label: "部署客户系统", quote: "配置 JAVA_HOME 环境变量后启动 Tomcat，通过启动日志验证环境配置。", knowledge: "JAVA_HOME 环境变量的解析规则", skill: "配置环境变量并验证启动日志" },
  { label: "核验迁移后的业务数据", quote: "编写 SQL 多表关联查询，按主键核验迁移前后数据的一致性。", knowledge: "主键与多表关联查询规则", skill: "编写关联查询核验迁移数据" },
  { label: "交付用户操作手册", quote: "操作手册按用户角色组织步骤，写明每个步骤的前置条件与预期结果。", knowledge: "角色化操作说明的前置与结果规范", skill: "按角色编写带预期结果的步骤" },
  { label: "指导用户现场练习", quote: "先演示标准流程，再观察用户独立操作，对照操作检查表记录偏差并反馈。", knowledge: "操作检查表的偏差判定规则", skill: "观察独立操作并记录反馈偏差" },
];

function fixture() {
  const request: ColdStartRequest = { runId: "sparse-implementation", projectId: "repair-fixture", roleTitle: "软件实施工程师",
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
  return { base, request };
}

function iteration(base = fixture().base): SnapshotIterationRequest {
  return { runId: "repair-autonomous", snapshotRef: { snapshotId: base.snapshot.id }, projectId: base.brief.projectId,
    mode: "risk_repair", initiativeProfile: "autonomous", prompt: "", targetIds: [], supplementalSources: [],
    webResearch: true, maxRounds: 2, sourceLimit: 12, maxWorkItems: 10 };
}

test("风险修复自动发现：四个任务缺口分别进入计划，知识查询包含技术上下文，第二轮更换资料类别", () => {
  const { base } = fixture();
  const request = iteration(base);
  const inspection = inspectSnapshot(base);
  const contract = createIterationContract(request, base);
  const opportunities = discoverIterationOpportunities({ request, contract, inspection });
  const workItems = planIterationWork({ runId: request.runId, opportunities, contract });
  const gaps = inspection.findings.filter(f => f.code === "TASK_SKILL_GAP");
  assert.equal(gaps.length, 4);
  for (const gap of gaps) {
    const item = workItems.find(item => item.findingIds.includes(gap.id));
    assert.ok(item, gap.title);
    assert.equal(item.kind, "repair");
    assert.equal(item.requiresResearch, true);
    assert.equal(item.targetIds.length, 1);
  }
  const first = planIterationResearch({ runId: request.runId, round: 1, result: base, request, contract, workItems });
  const second = planIterationResearch({ runId: request.runId, round: 2, result: base, request, contract, workItems });
  assert.ok(first.queries.some(query => query.category === "technology" && query.query.includes("JAVA_HOME")));
  assert.ok(first.queries.some(query => query.category === "technology" && query.query.includes("SQL")));
  assert.ok(first.queries.length <= 12);
  assert.ok(second.queries.every(query => !first.queries.some(prior => prior.query === query.query)));
  const prompt = iterationRepairFocus({ candidate: base, contract: createIterationContract({ ...request, prompt: "优先补齐数据库校验" }, base), workItems });
  assert.match(prompt, /优先补齐数据库校验/);
  for (const gap of gaps) assert.ok(prompt.includes(gap.targetIds[0]));
  assert.ok(!workItems.some(item => item.findingIds.some(id => inspection.findings.some(f => f.id === id && ["user", "organization_specific"].includes(f.suggestedAction)))));
});

test("检查投影重复读取幂等，已修复缺口和结构错误不从历史告警复活", () => {
  const { base } = fixture();
  const before = inspectSnapshot(base);
  const saved = applyInspectionToSnapshot(base, before);
  const repeated = inspectSnapshot(saved);
  assert.deepEqual(repeated.findings.map(findingIdentity).sort(), before.findings.map(findingIdentity).sort());
  assert.deepEqual(repeated.axes, before.axes);
  const task = saved.semantic.nodes.find(node => node.type === "task")!;
  const point = { ...task, id: "knowledge:valid", type: "knowledge_skill" as const, label: "系统环境变量的解析规则" };
  saved.semantic.nodes.push(point);
  saved.semantic.edges.push({ id: "edge:fixed", type: "requires_skill", source: task.id, target: point.id,
    confidence: 0.7, lifecycle: "candidate", evidenceBindingIds: [], evidenceSegmentIds: [] });
  const fixed = inspectSnapshot(saved);
  assert.ok(!fixed.findings.some(f => f.code === "TASK_SKILL_GAP" && f.targetIds.includes(task.id)));
  const applied = applyInspectionToSnapshot(saved, fixed);
  assert.ok(!applied.validation.semantic.issues.some(message => message === before.findings.find(f => f.code === "TASK_SKILL_GAP" && f.targetIds.includes(task.id))!.title));
  assert.equal(applied.validation.publishable, false, "其他证据和过程问题仍须校验");
});

test("没有修复目标进展时，增加来源或只改告警标题不能制造修复成功", () => {
  const { base } = fixture();
  const before = inspectSnapshot(base);
  const request = iteration(base);
  const contract = createIterationContract(request, base);
  const candidate = structuredClone(base);
  candidate.sources.assets.push({ ...base.sources.assets[1], id: "source:unrelated", contentHash: "unrelated", locator: "https://example.com/unrelated" });
  const after = { ...before, findings: before.findings.map(f => ({ ...f, id: `${f.id}-renamed`, title: f.targetIds.length ? `${f.title} 新标题` : f.title })) };
  const evaluation = evaluateIteration({ base, candidate, before, after, contract });
  assert.equal(evaluation.informationGain.newSources, 1);
  assert.equal(evaluation.informationGain.resolvedFindings, 0);
  assert.equal(evaluation.meaningful, false);
  assert.match(evaluation.reasons.join(" "), /选中的修复问题尚未改善/);
});

test("第二轮即使优于最初，也不能覆盖更好的第一轮成果", () => {
  const { base } = fixture();
  const inspected = inspectSnapshot(base);
  const before = { ...inspected, core: { ...inspected.core, errorCount: 3 } };
  const first = { ...inspected, findings: inspected.findings.filter(f => f.code !== "TASK_SKILL_GAP"), core: { ...inspected.core, errorCount: 1 } };
  const second = { ...first, core: { ...first.core, errorCount: 2 } };
  const contract = createIterationContract(iteration(base), base);
  const evaluation = evaluateIteration({ base, candidate: base, before, after: second, contract,
    previousAccepted: { candidate: base, inspection: first } });
  assert.equal(evaluation.meaningful, false);
  assert.equal(evaluation.coreRegression, true);
  assert.match(evaluation.reasons.join(" "), /相对本轮已验证成果发生回退/);
});

test("固定任务补证合并本轮研究报告，保留历史已覆盖类别", async () => {
  const { base, request } = fixture();
  const report: WebResearchReport = { provider: "fixture", providerName: "fixture", startedAt: "2026-09-08T00:00:00Z", completedAt: "2026-09-08T00:00:01Z", queries: [], candidates: [], candidateCount: 1, selectedSourceCount: 1, deduplicatedCount: 0, failures: [],
    categoryCoverage: [{ category: "job_market", queryCount: 1, candidateCount: 1, selectedSourceCount: 1, status: "covered" }, { category: "technology", queryCount: 0, candidateCount: 0, selectedSourceCount: 0, status: "missing" }] };
  base.sources.research = report;
  const next = { ...report, categoryCoverage: [{ category: "technology" as const, queryCount: 1, candidateCount: 1, selectedSourceCount: 1, status: "covered" as const }] };
  const model: ModelInvoker = async function* () { yield { type: "text", delta: "{}" }; };
  const output = await createColdStartSkill(model, { execution: "enrichment", existingResearchReport: next }).invoke({ request, baseResult: base, laneFailures: [] });
  const coverage = output.result!.sources.research!.categoryCoverage;
  assert.equal(coverage.find(row => row.category === "job_market")!.status, "covered");
  assert.equal(coverage.find(row => row.category === "technology")!.status, "covered");
});

for (const freshEvidence of [false, true]) test(`使用${freshEvidence ? "本轮新增资料" : "已存原文"}补齐已有任务，知识技能保留可核对引用和原任务关系`, async () => {
  const { base } = fixture();
  const original = structuredClone(base);
  const taskIds = base.semantic.nodes.filter(node => node.type === "task").map(node => node.id);
  const calls: string[] = [];
  const model: ModelInvoker = async function* ({ system, user }) {
    let response: unknown = {};
    if (system.includes("任务导向的知识技能规范化器")) {
      const input = JSON.parse(user);
      assert.match(input.iterationObjective, /任务缺少可学习知识技能/);
      if (freshEvidence) assert.ok(input.evidenceSegments.some((row: { text: string }) => row.text.includes("本轮新资料验收编号")), "新资料必须进入固定任务的知识派生上下文");
      response = { skills: input.tasks.flatMap((task: { id: string; label: string }) => {
        assert.ok(taskIds.includes(task.id), "复用现有任务 ID，不能重新猜任务再丢失旧节点的支撑关系");
        calls.push(task.id);
        const spec = tasks.find(row => row.label === task.label)!;
        const segment = input.evidenceSegments.find((row: { text: string }) => row.text.includes(spec.quote));
        assert.ok(segment);
        return (["knowledge", "skill"] as const).map(kind => ({ tempId: `${task.id}:${kind}`, label: spec[kind], summary: spec.quote,
          learningKind: kind, learningDefinition: { scopeNote: `限于${task.label}的场景`, assessmentCriteria: [kind === "knowledge" ? "解释案例中的判断依据" : "完成操作并提供可复核记录"] },
          taskTempIds: [task.id], mentionIds: [], evidenceSpans: [{ segmentId: segment.id, quote: spec.quote }], confidence: 0.7 }));
      }) };
    }
    yield { type: "text", delta: JSON.stringify(response) };
  };
  const graph = createSnapshotIterationSkill({ model }); // No search provider / no new results.
  const output = await graph.invoke({ request: { ...iteration(base), supplementalSources: freshEvidence ? [{ kind: "public_document", title: "本轮实施验收资料", sourceTier: "primary", locator: "https://example.com/current-acceptance", content: `本轮新资料验收编号。${tasks.map(task => task.quote).join("\n\n")}` }] : [] }, base, candidate: base });
  const result = output.result!;
  assert.equal(new Set(calls).size, 4);
  assert.equal(result.createdSnapshot, true, result.summary.join("\n"));
  assert.equal(result.inspectionAfter.coverage.tasksWithoutSkills, 0);
  assert.equal(result.researchPlans.length, 1, "没有可改变的搜索策略时不重复空跑第二轮");
  for (const taskId of taskIds) {
    const points = result.candidate.semantic.edges.filter(edge => edge.source === taskId && edge.type === "requires_skill")
      .map(edge => result.candidate.semantic.nodes.find(node => node.id === edge.target)!);
    assert.deepEqual(new Set(points.map(point => point.learningKind)), new Set(["knowledge", "skill"]));
    for (const point of points) for (const binding of result.candidate.sources.evidenceBindings.filter(b => point.evidenceBindingIds.includes(b.id))) {
      if (binding.evidenceSpan) assert.ok(result.candidate.sources.segments.some(s => s.id === binding.evidenceSpan!.segmentId && s.text.includes(binding.evidenceSpan!.quote)));
    }
  }
  const originalGaps = result.inspectionBefore.findings.filter(f => f.code === "TASK_SKILL_GAP");
  assert.ok(result.workItems.filter(item => item.findingIds.some(id => originalGaps.some(f => f.id === id))).every(item => item.status === "completed"));
  assert.ok(result.workItems.some(item => item.status === "known_gap"), "未解决的过程问题不能随知识补齐一起宣称完成");
  assert.deepEqual(base, original, "原始快照保持不变");
});

test("第一轮部分修复后继续研究剩余任务，空搜索仍在两轮预算内停止", async () => {
  const { base } = fixture();
  const previousFetch = globalThis.fetch;
  const fetched: string[] = [];
  const phases: Array<{ phase: string; round: unknown }> = [];
  try {
    globalThis.fetch = async (_url, init) => {
      fetched.push(JSON.parse(String(init?.body)).search_query);
      return Response.json({ search_result: [] });
    };
    const model: ModelInvoker = async function* ({ system, user }) {
      let response: unknown = {};
      if (system.includes("任务导向的知识技能规范化器")) {
        const input = JSON.parse(user);
        response = { skills: input.tasks.filter((task: { label: string }) => task.label === tasks[0].label).flatMap((task: { id: string }) => {
          const segment = input.evidenceSegments.find((row: { text: string }) => row.text.includes(tasks[0].quote));
          return (["knowledge", "skill"] as const).map(kind => ({ tempId: kind, label: tasks[0][kind], summary: tasks[0].quote,
            learningKind: kind, learningDefinition: { scopeNote: "限于客户系统环境配置", assessmentCriteria: ["依据日志检查配置"] },
            taskTempIds: [task.id], mentionIds: [], evidenceSpans: [{ segmentId: segment.id, quote: tasks[0].quote }], confidence: 0.7 }));
        }) };
      }
      yield { type: "text", delta: JSON.stringify(response) };
    };
    const graph = createSnapshotIterationSkill({ model, searchConfig: { provider: "glm", apiKey: "synthetic-test-only" },
      onCheckpoint: async (phase, state) => { phases.push({ phase, round: state.round }); } });
    const output = await graph.invoke({ request: iteration(base), base, candidate: base });
    const result = output.result!;
    assert.equal(result.createdSnapshot, true);
    assert.equal(result.inspectionAfter.coverage.tasksWithoutSkills, 3);
    assert.equal(result.researchPlans.length, 2, "部分进展不能让尚未修复的已选任务提前结束");
    assert.ok(fetched.length > 0 && fetched.length <= 24);
    assert.equal(phases.filter(item => item.phase === "evaluate").length, 2);
    assert.ok(result.workItems.some(item => item.status === "completed"));
    assert.ok(result.workItems.some(item => item.status === "known_gap"));
    const fixedTask = base.semantic.nodes.find(node => node.label === tasks[0].label)!;
    const secondQueries = result.researchPlans[1].queries;
    assert.ok(!secondQueries.some(query => query.category === "technology" && query.query.includes(fixedTask.label)));
  } finally { globalThis.fetch = previousFetch; }
});

test("模型没有补出有依据的知识时工作项仍为缺口；关闭联网且无附件不调用模型", async () => {
  const { base } = fixture();
  for (const webResearch of [true, false]) {
    let calls = 0;
    const model: ModelInvoker = async function* () { calls++; yield { type: "text", delta: "{}" }; };
    const output = await createSnapshotIterationSkill({ model }).invoke({ request: { ...iteration(base), webResearch }, base, candidate: base });
    assert.equal(calls > 0, webResearch);
    assert.equal(output.result!.createdSnapshot, false);
    assert.equal(output.result!.workItems.some(item => item.status === "completed"), false);
    assert.equal(output.result!.candidate.snapshot.id, base.snapshot.id);
  }
});
