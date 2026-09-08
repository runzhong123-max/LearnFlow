import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInvoker } from "@/lib/agent/model";
import { compileRolePackage, compileSemanticDraft, prepareBuildInput } from "@/lib/build/compiler";
import type { ColdStartRequest } from "@/lib/build/types";
import { createSnapshotIterationSkill } from "@/lib/iteration/graph";
import { inspectSnapshot } from "@/lib/iteration/inspector";
import { createIterationContract, discoverIterationOpportunities, planIterationResearch, planIterationWork, evaluateIteration } from "@/lib/iteration/planner";
import type { SnapshotIterationRequest } from "@/lib/iteration/types";

const quote = "实施工程师配置 JAVA_HOME 环境变量后启动 Tomcat，通过启动日志验证环境配置，并交付服务启动验收记录。";
function emptyFixture() {
  const request: ColdStartRequest = { runId: "legacy-empty-build", projectId: "project:empty-recovery", roleTitle: "软件实施工程师-岗位资料QA", roleDescription: "恢复任务与知识技能", market: "中国大陆", audience: [], snapshotAsOf: "2026-09-08",
    sources: [{ kind: "public_document", title: "软件实施工程师岗位职责和交付规范", content: quote, sourceTier: "primary", locator: "https://example.com/implementation-duty", searchCategories: ["job_market", "work_practice"] }] };
  const prepared = prepareBuildInput(request);
  const semantic = compileSemanticDraft({ request, draft: { roleSummary: "软件实施岗位", nodes: [], edges: [] }, assets: prepared.assets, segments: prepared.segments });
  return compileRolePackage({ request, ...prepared, semantic, process: { scenarios: [], nodes: [], edges: [], bridges: [], bindings: [] }, laneFailures: [] });
}
function iteration(base = emptyFixture()): SnapshotIterationRequest {
  return { runId: "recover-empty-iteration", projectId: base.brief.projectId, snapshotRef: { snapshotId: base.snapshot.id }, mode: "risk_repair", initiativeProfile: "autonomous", prompt: "", targetIds: [], supplementalSources: [], webResearch: true, maxRounds: 2, maxWorkItems: 10, sourceLimit: 12 };
}

test("三种功能和三种发起方式都能发现空任务层，并检索真实职责而非测试项目后缀", () => {
  const base = emptyFixture();
  for (const mode of ["risk_repair", "deep_research", "freshness"] as const) {
    for (const initiativeProfile of ["autonomous", "co_guided", "user_directed"] as const) {
      const request = { ...iteration(base), mode, initiativeProfile, prompt: initiativeProfile === "user_directed" ? "补回任务层" : "" };
      const inspection = inspectSnapshot(base);
      const contract = createIterationContract(request, base);
      const opportunities = discoverIterationOpportunities({ request, contract, inspection });
      const missing = inspection.findings.find(item => item.code === "MISSING_TASK_LAYER")!;
      const workItems = planIterationWork({ runId: request.runId, opportunities, contract });
      assert.ok(workItems.some(item => item.findingIds.includes(missing.id)), `${mode}/${initiativeProfile}`);
      const plan = planIterationResearch({ runId: request.runId, round: 1, result: base, request, contract, workItems });
      assert.ok(plan.queries.some(query => query.category === "job_market" && query.query.includes("职责")));
      assert.ok(plan.queries.every(query => !query.query.includes("岗位资料QA")));
      assert.ok(plan.queries.length <= 12);
    }
  }
});

test("有用户资料且联网开启时仍请求外部检索；空搜索后从原文重新提取缺失任务", async () => {
  const base = emptyFixture();
  const original = structuredClone(base);
  const previousFetch = globalThis.fetch;
  const queries: string[] = [];
  let extractionCalls = 0;
  const model: ModelInvoker = async function* ({ system, user }) {
    const payload = JSON.parse(user);
    let response: unknown = {};
    if (system.includes("岗位证据原子抽取器")) {
      extractionCalls++;
      const segment = payload.segments.find((item: { text: string }) => item.text.includes(quote));
      response = { mentions: segment ? [{ tempId: "task-evidence", kind: "task", label: "部署并验证服务启动", definitionHint: quote, attributes: { workObject: "客户系统服务", action: "部署并验证启动", deliverable: "启动验收记录", acceptance: "日志显示启动成功" }, sourceSegmentId: segment.id, evidenceSpan: { segmentId: segment.id, quote }, confidence: 0.8 }] : [], propositions: [] };
    } else if (system.includes("典型工作任务规范化器") || system.includes("典型工作任务全局归并器")) {
      const mentionIds = payload.mentions?.map((mention: { id: string }) => mention.id) || payload.candidates.flatMap((candidate: { tasks: { mentionIds: string[] }[] }) => candidate.tasks.flatMap(task => task.mentionIds));
      response = { roleSummary: "部署服务并提供可复核验收记录", tasks: [{ tempId: "task-deploy", label: "部署并验证服务启动", summary: quote, workObject: "客户系统服务", action: "配置并验证启动", deliverable: "启动验收记录", acceptance: "日志显示服务启动成功", aliases: [], mentionIds, confidence: 0.8 }], roleContexts: [] };
    } else if (system.includes("任务导向的知识技能规范化器")) {
      const segment = payload.evidenceSegments.find((item: { text: string }) => item.text.includes(quote));
      response = { skills: segment ? payload.tasks.flatMap((task: { id: string }) => (["knowledge", "skill"] as const).map(kind => ({ tempId: `${task.id}:${kind}`, label: kind === "knowledge" ? "JAVA_HOME 环境变量解析规则" : "配置环境变量并验证服务日志", summary: quote, learningKind: kind, learningDefinition: { scopeNote: "限于服务启动环境与验收日志", assessmentCriteria: ["在服务启动案例中解释配置依据并核对日志"] }, taskTempIds: [task.id], mentionIds: [], evidenceSpans: [{ segmentId: segment.id, quote }], confidence: 0.75 }))) : [] };
    }
    yield { type: "text", delta: JSON.stringify(response) };
  };
  try {
    globalThis.fetch = async (_url, init) => { queries.push(JSON.parse(String(init?.body)).search_query); return Response.json({ search_result: [] }); };
    const output = await createSnapshotIterationSkill({ model, searchConfig: { provider: "glm", apiKey: "synthetic-test-only" } }).invoke({ request: iteration(base), base, candidate: base });
    const result = output.result!;
    assert.ok(queries.length > 0, "已有用户资料不得关闭联网研究");
    assert.ok(extractionCalls > 0, "空包必须重新运行原子/任务提取，不能 hydrate 空任务列表");
    assert.equal(result.createdSnapshot, true, result.summary.join("\n"));
    assert.ok(result.candidate.semantic.nodes.some(node => node.type === "task"));
    assert.ok(result.candidate.semantic.nodes.some(node => node.type === "knowledge_skill"));
    assert.equal(result.inspectionAfter.coverage.tasksWithoutSkills, 0);
    assert.ok(result.candidate.sources.segments.some(segment => segment.text.includes(quote)));
    assert.deepEqual(base, original, "空包历史保留原版本");
  } finally { globalThis.fetch = previousFetch; }
});

test("空任务层恢复可保留有技能支撑的部分进展，但完全没有知识技能仍拒绝", () => {
  const base = emptyFixture();
  const before = inspectSnapshot(base);
  const contract = createIterationContract(iteration(base), base);
  const after = { ...before, findings: before.findings.filter(item => item.code !== "MISSING_TASK_LAYER"), core: { ...before.core, errorCount: Math.max(0, before.core.errorCount - 1) }, coverage: { ...before.coverage, tasks: 3, knowledgeSkills: 4, tasksWithoutSkills: 1 } };
  assert.equal(evaluateIteration({ base, candidate: base, before, after, contract }).meaningful, true);
  const emptyKnowledge = { ...after, coverage: { ...after.coverage, knowledgeSkills: 0, tasksWithoutSkills: 3 } };
  assert.equal(evaluateIteration({ base, candidate: base, before, after: emptyKnowledge, contract }).meaningful, false);
});

test("只有新增资料的运行也进行交叉核验，关闭联网才跳过查询执行", () => {
  const base = emptyFixture();
  for (const webResearch of [true, false]) {
    const request = { ...iteration(base), webResearch, supplementalSources: [{ title: "用户提供的手册", kind: "private_document" as const, content: "敏感机构内部资料，不应进入公开查询" }] };
    const contract = createIterationContract(request, base);
    const opportunities = discoverIterationOpportunities({ request, contract, inspection: { ...inspectSnapshot(base), findings: [] } });
    const workItems = planIterationWork({ runId: request.runId, opportunities, contract });
    const sourceWork = workItems.find(item => item.origin === "workspace")!;
    assert.equal(sourceWork.requiresResearch, webResearch);
    const plan = planIterationResearch({ runId: request.runId, round: 1, result: base, request, contract, workItems });
    assert.equal(plan.queries.length > 0, webResearch);
    assert.ok(plan.queries.every(query => !query.query.includes("敏感机构")));
  }
});
