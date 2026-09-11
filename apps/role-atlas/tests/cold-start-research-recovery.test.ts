import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInvoker } from "@/lib/agent/model";
import { assertTaskKernel } from "@/lib/build/completion";
import { capabilityCoverage } from "@/lib/build/capability-coverage";
import { createColdStartSkill } from "@/lib/build/graph";
import { prepareBuildInput, compileSemanticDraft, compileRolePackage } from "@/lib/build/compiler";
import type { ColdStartRequest, WebResearchReport } from "@/lib/build/types";
import type { SemanticDraft } from "@/lib/build/model";
import { qualifySources, createSourceShards } from "@/lib/build/workflow";
import { createRoleSearchPlan } from "@/lib/search/query-planner";
import { researchRoleTitle } from "@/lib/search/role-query";
import { researchRoleSources } from "@/lib/search/web-research";
import { mergeDerivedSemanticDrafts } from "@/lib/build/workflow-model";

function request(): ColdStartRequest {
  return { runId: "task-recovery-fixture", projectId: "task-recovery-project", roleTitle: "嵌入式软件工程师-岗位资料QA",
    roleDescription: "研究真实交付任务", market: "中国大陆", audience: [], snapshotAsOf: "2026-09-08",
    sources: [{ kind: "public_document", title: "ESP-IDF API Reference", locator: "https://docs.espressif.com/projects/esp-idf/en/stable/api-reference/index.html", sourceTier: "primary", content: "ESP-IDF documentation: JTAG debugging API reference and driver interfaces." }] };
}

test("查询清理仅去项目测试标记，不改实际测试岗位名称", () => {
  assert.equal(researchRoleTitle("数据工程师-岗位资料QA"), "数据工程师");
  assert.equal(researchRoleTitle("嵌入式软件工程师（测试版）"), "嵌入式软件工程师");
  for (const title of ["软件测试工程师", "QA工程师", "嵌入式软件工程师(BSP)"]) assert.equal(researchRoleTitle(title), title);
});

test("合并较大图谱时不截掉既有节点、后来的能力链或知识关系", () => {
  const node = (tempId: string, type: SemanticDraft["nodes"][number]["type"]) => ({ tempId, type, label: tempId, summary: tempId, aliases: [], confidence: 0.7, evidenceSegmentIds: ["e"] });
  const base: SemanticDraft = { roleSummary: "岗位", nodes: [node("task", "task"), ...Array.from({ length: 53 }, (_, i) => node(`old-${i}`, "knowledge_skill"))], edges: [] };
  const knowledge: SemanticDraft = { roleSummary: "", nodes: Array.from({ length: 36 }, (_, i) => node(`new-${i}`, "knowledge_skill")), edges: Array.from({ length: 181 }, (_, i) => ({ type: "related_to", sourceTempId: `old-${i % 53}`, targetTempId: `new-${i % 36}`, evidenceSegmentIds: ["e"], confidence: 0.6 })) };
  const capability: SemanticDraft = { roleSummary: "", nodes: [node("cap", "capability"), node("unit", "capability_unit")], edges: [
    { type: "requires_capability", sourceTempId: "task", targetTempId: "cap", evidenceSegmentIds: ["e"], confidence: 0.7 },
    { type: "contains", sourceTempId: "cap", targetTempId: "unit", evidenceSegmentIds: ["e"], confidence: 0.7 },
  ] };
  const merged = mergeDerivedSemanticDrafts(base, [knowledge, capability]);
  assert.equal(merged.nodes.length, 92);
  assert.equal(merged.edges.length, 183);
  assert.deepEqual(capabilityCoverage(merged).uncoveredTaskIds, []);
  const ids = new Set(merged.nodes.map(node => node.tempId));
  assert.ok(merged.edges.every(edge => ids.has(edge.sourceTempId) && ids.has(edge.targetTempId)));
  assert.equal(base.nodes.length, 54);
});

test("上传的英文技术原文进入知识证据，技术查询搜到的招聘正文进入任务证据", () => {
  const prepared = prepareBuildInput({ ...request(), sources: [...request().sources,
    { kind: "public_document", title: "Embedded Engineer", locator: "https://example.com/jobs/embedded", searchCategories: ["technology"], content: "Job description. Responsibilities: implement firmware drivers, validate hardware interfaces and deliver test reports." }] });
  const assets = qualifySources(prepared.assets, prepared.segments);
  const technical = assets.find(asset => asset.title === "ESP-IDF API Reference")!;
  const job = assets.find(asset => asset.title === "Embedded Engineer")!;
  assert.ok(technical.qualification!.evidenceRoles.includes("technology_primary"));
  assert.ok(!technical.qualification!.evidenceRoles.includes("job_market"));
  assert.ok(job.qualification!.evidenceRoles.includes("job_market"));
  const shards = createSourceShards({ assets, segments: prepared.segments });
  assert.ok(shards.some(shard => shard.sourceId === job.id));
  assert.ok(!shards.some(shard => shard.sourceId === technical.id), "不能把API文档自动升级成岗位职责");
});

test("已有附件仍规划独立检索，材料技术词进入聚焦查询且不替代岗位职责查询", async () => {
  const model: ModelInvoker = async function* ({ user }) {
    const payload = JSON.parse(user);
    assert.equal(payload.roleTitle, "嵌入式软件工程师");
    assert.ok(payload.suppliedMaterials[0].excerpt.includes("JTAG"));
    yield { type: "text", delta: JSON.stringify({ queries: [
      { category: "technology", query: "ESP-IDF JTAG debugging API reference", priority: 10 },
      { category: "technology", query: "Zephyr driver documentation", priority: 9 },
      { category: "job_market", query: "嵌入式软件工程师 驱动开发 招聘", priority: 8 },
      { category: "work_practice", query: "嵌入式软件工程师 调试 项目复盘", priority: 8 },
    ] }) };
  };
  const planned = await createRoleSearchPlan({ request: request(), model });
  assert.equal(planned.strategy, "model_assisted");
  assert.ok(planned.queries.some(query => query.query.includes("ESP-IDF")));
  assert.ok(planned.queries.some(query => query.category === "job_market" && query.query.includes("岗位职责")));
  assert.ok(planned.queries.every(query => !query.query.includes("QA")));
});

test("英文一手技术文档按聚焦技术词进入研究；相邻BIM岗位不能凭工程师后缀进入", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ results: [
    { title: "ESP-IDF JTAG Debugging Reference", url: "https://docs.espressif.com/api/jtag", text: "ESP-IDF JTAG debugging documentation covers debugging interfaces and register inspection. ".repeat(12), score: 0.95 },
    { title: "BIM应用工程师招聘", url: "https://example.com/jobs/bim", text: "BIM应用工程师岗位职责：使用建筑信息模型完成工程项目交付。".repeat(18), score: 0.99 },
  ] });
  try {
    const result = await researchRoleSources({ request: { ...request(), roleTitle: "大模型应用工程师" }, config: { provider: "exa", apiKey: "fixture" }, queries: [{ id: "focused-tech", category: "technology", query: "ESP-IDF JTAG debugging reference", priority: 9 }] });
    assert.ok(result.sources.some(source => source.title.includes("ESP-IDF")));
    assert.ok(!result.sources.some(source => source.title.includes("BIM")));
    assert.equal(result.report.candidates?.find(candidate => candidate.title.includes("BIM"))?.disposition, "foreign_occupation");
  } finally { globalThis.fetch = original; }
});

for (const recovered of [true, false]) test(`仅有技术附件、首次搜索无任务时继续两类补研：${recovered ? "恢复真实任务" : "有限停止且不能宣称生成成功"}`, async () => {
  const original = globalThis.fetch;
  const queries: string[] = [];
  const quote = "嵌入式软件工程师岗位职责：开发设备驱动，验证硬件接口并交付测试报告。";
  globalThis.fetch = async (_url, init) => {
    const query = JSON.parse(String(init?.body)).query || "";
    queries.push(query);
    return Response.json({ results: recovered && query.includes("岗位职责 任职要求") ? [{ title: "嵌入式软件工程师招聘岗位职责", url: "https://example.com/jobs/driver", text: quote.repeat(16), score: 0.98 }] : [] });
  };
  const model: ModelInvoker = async function* ({ system, user }) {
    if (system.includes("岗位证据原子抽取器")) {
      const segment = JSON.parse(user).segments.find((row: { text: string }) => row.text.includes(quote));
      yield { type: "text", delta: JSON.stringify({ mentions: segment ? [{ tempId: "m-driver", kind: "task", label: "开发并验证设备驱动", definitionHint: quote,
        attributes: { actorRelation: "target_role", workObject: "设备驱动与硬件接口", action: "开发并验证", deliverable: "设备驱动和测试报告", acceptance: "接口验证通过" }, sourceSegmentId: segment.id, evidenceSpan: { segmentId: segment.id, quote }, confidence: 0.85 }] : [], propositions: [] }) };
    } else yield { type: "text", delta: "{}" };
  };
  try {
    const previous: WebResearchReport = { provider: "exa", providerName: "fixture", startedAt: "2026-09-07T00:00:00Z", completedAt: "2026-09-07T00:00:01Z", queries: [{ id: "previous-tech", category: "technology", query: "ESP-IDF reference", resultCount: 1 }], candidates: [], candidateCount: 1, selectedSourceCount: 1, deduplicatedCount: 0, failures: [], categoryCoverage: [{ category: "technology", queryCount: 1, candidateCount: 1, selectedSourceCount: 1, status: "covered" }] };
    const input = request(); input.sources[0].queryIds = ["previous-tech"];
    const output = await createColdStartSkill(model, { execution: "kernel", searchConfig: { provider: "exa", apiKey: "synthetic-fixture" }, existingResearchReport: previous }).invoke({ request: input, laneFailures: [] });
    const result = output.result!;
    assert.ok(result.sources.research!.queries.some(query => query.id === "previous-tech"), "复用旧来源时不能丢弃旧检索索引");
    assert.ok(queries.some(query => query.includes("岗位职责 任职要求")), "有附件仍必须补充职责证据");
    assert.ok(queries.every(query => !query.includes("QA")));
    assert.equal(output.taskRecoveryRound, recovered ? 1 : 2);
    assert.equal(result.build!.metrics.targetedResearchQueries, recovered ? 2 : 4);
    if (recovered) {
      assert.doesNotThrow(() => assertTaskKernel(result));
      assert.ok(result.semantic.nodes.some(node => node.type === "task" && node.label.includes("驱动")));
      assert.ok(result.sources.assets.some(asset => asset.title === "ESP-IDF API Reference"), "补研不丢用户原件");
      assert.ok(result.sources.evidenceBindings.some(binding => binding.evidenceSpan?.quote === quote));
    } else {
      assert.equal(result.semantic.nodes.filter(node => node.type === "task").length, 0);
      assert.throws(() => assertTaskKernel(result), /TASK_EVIDENCE_MISSING/);
      assert.equal(result.validation.publishable, false);
    }
  } finally { globalThis.fetch = original; }
});

test("已有一个能力不能跳过其他任务；补齐轮保留任务与可观察单元关系", async () => {
  const input = { ...request(), roleTitle: "软件实施工程师", sources: [{ kind: "private_document" as const, title: "交付记录", content: "工作流程：部署业务系统并验证启动；迁移业务数据并核验结果。两项交付均记录环境、核验步骤与异常处理结果。" }] };
  const prepared = prepareBuildInput(input);
  const segment = prepared.segments.find(row => !row.id.includes("brief") && row.text.includes("工作流程"))!;
  const node = (tempId: string, type: SemanticDraft["nodes"][number]["type"], label: string) => ({ tempId, type, label, summary: segment.text, aliases: [], evidenceSegmentIds: [segment.id], confidence: 0.7 });
  const draft: SemanticDraft = { roleSummary: "实施软件系统", nodes: [node("a", "task", "部署系统"), node("b", "task", "迁移数据"), node("existing", "capability", "交付结果核验")], edges: [{ type: "requires_capability", sourceTempId: "a", targetTempId: "existing", confidence: 0.7, evidenceSegmentIds: [segment.id] }] };
  assert.equal(capabilityCoverage(draft).uncoveredTaskIds.length, 2);
  const semantic = compileSemanticDraft({ request: input, draft, ...prepared });
  const base = compileRolePackage({ request: input, ...prepared, semantic, process: { scenarios: [], nodes: [], edges: [], bridges: [], bindings: [] }, laneFailures: [] });
  let calls = 0;
  const model: ModelInvoker = async function* ({ system, user }) {
    if (!system.includes("跨任务能力归纳器")) { yield { type: "text", delta: "{}" }; return; }
    calls += 1;
    const payload = JSON.parse(user);
    assert.equal(payload.coverage.uncoveredTaskIds.length, 2);
    assert.ok(payload.acceptedCapabilitiesAndUnits.some((item: { label: string }) => item.label === "交付结果核验"));
    yield { type: "text", delta: JSON.stringify({ capabilities: calls === 1 ? [] : [{ tempId: "cap", label: "交付结果核验", summary: "核验部署与迁移结果", situations: "上线交付前", observableBehaviors: ["记录核验条件并复核结果"], taskTempIds: payload.tasks.map((task: { id: string }) => task.id), units: [{ tempId: "unit", label: "可复核核验记录", summary: "记录条件与结果", observableBehavior: "记录核验步骤与输出", practiceSituation: "部署与迁移交付", microPractice: "核验一次结果并记录条件", practiceFrequency: "每周", feedbackSignal: "同伴复核记录", evidenceArtifact: "核验记录", progression: "从示范到独立", independenceCriterion: "独立复核差异" }] }] }) };
  };
  const output = await createColdStartSkill(model, { execution: "enrichment" }).invoke({ request: input, baseResult: base, laneFailures: [] });
  assert.equal(calls, 2);
  assert.ok(output.result!.semantic.nodes.some(node => node.type === "capability_unit"));
  assert.ok(output.result!.build!.workItems.some(item => item.lane === "capability:coverage-repair"));
});
