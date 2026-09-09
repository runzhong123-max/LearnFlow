import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInvoker } from "@/lib/agent/model";
import { compileRolePackage, compileSemanticDraft, prepareBuildInput } from "@/lib/build/compiler";
import { createColdStartSkill } from "@/lib/build/graph";
import type { SemanticDraft } from "@/lib/build/model";
import type { ColdStartRequest, ColdStartBuildResult } from "@/lib/build/types";
import type { BuildEvent } from "@/lib/build/events";
import { inspectSnapshot } from "@/lib/iteration/inspector";
import { learningCoverage, processCoverage } from "@/lib/iteration/learning-health";
import { createSnapshotIterationSkill } from "@/lib/iteration/graph";
import { createIterationContract, discoverIterationOpportunities, planIterationWork, planIterationResearch } from "@/lib/iteration/planner";
import { snapshotIterationRequestSchema, type SnapshotIterationRequest } from "@/lib/iteration/types";

const taskLabel = "恢复数据库备份";
const boundary = "初级系统运维工程师，负责既有 MySQL 数据库恢复及验证，不承担数据库架构设计。";
const principle = "数据库备份恢复需保持事务一致性，并按主键检查记录完整性。";
const operation = "实践补充：先在隔离环境导入备份，再按主键比对数据，记录异常并提交可复核的恢复校验报告。";
const cultivation = { observableBehavior: "记录恢复核验条件及结果", practiceSituation: "隔离数据库恢复演练", microPractice: "完成一次恢复后记录差异", practiceFrequency: "每周一次", feedbackSignal: "复核记录完整性", evidenceArtifact: "恢复校验报告", progression: "从示范到独立检查", independenceCriterion: "独立发现并解释差异" };
function fixture(taskCount = 1) {
  const request: ColdStartRequest = { runId: "quality-feedback", projectId: "quality-project", roleTitle: "系统运维工程师", roleDescription: boundary,
    audience: [], market: "中国大陆", snapshotAsOf: "2026-09-09", sources: [{ kind: "public_document", title: "数据库恢复职责及原理", content: `${taskLabel}。${principle}`, locator: "https://example.com/original", sourceTier: "primary" }] };
  const prepared = prepareBuildInput(request);
  const segment = prepared.segments.find(segment => segment.text.includes(principle) && !segment.id.includes("brief"))!;
  const draft: SemanticDraft = { roleSummary: boundary, nodes: Array.from({ length: taskCount }, (_, i) => ({ tempId: `restore-task-${i}`, type: "task", label: i ? "复核恢复差异" : taskLabel, summary: `${principle}交付恢复校验报告。`, aliases: [], confidence: .8, evidenceSegmentIds: [segment.id], evidenceSpans: [{ segmentId: segment.id, quote: principle }] })), edges: [] };
  const semantic = compileSemanticDraft({ request, draft, ...prepared });
  const base = compileRolePackage({ request, ...prepared, semantic, process: { scenarios: [], nodes: [], edges: [], bridges: [], bindings: [] }, laneFailures: [] });
  return { request, base };
}
function iteration(base: ColdStartBuildResult, extra: Partial<SnapshotIterationRequest> = {}): SnapshotIterationRequest {
  return snapshotIterationRequestSchema.parse({ runId: "quality-iteration", projectId: base.brief.projectId, snapshotRef: { snapshotId: base.snapshot.id }, mode: "risk_repair", initiativeProfile: "autonomous", maxWorkItems: 16, ...extra });
}
function qualityModel(calls: { knowledge: number; capabilityFresh: boolean; processFresh: boolean }): ModelInvoker {
  return async function* ({ system, user }) {
    const input = JSON.parse(user);
    let output: unknown = {};
    if (/任务导向的知识技能规范化器|跨任务能力归纳器|任务锚定的岗位事理抽取器/u.test(system)) assert.equal(input.confirmedRoleBoundary, boundary);
    if (system.includes("任务导向的知识技能规范化器")) {
      calls.knowledge++;
      const first = input.evidenceSegments.find((segment: { text: string }) => segment.text.includes(principle));
      const fresh = input.evidenceSegments.find((segment: { text: string }) => segment.text.includes(operation));
      output = { skills: input.tasks.flatMap((task: { id: string }) => (["knowledge", ...(fresh ? ["skill"] : [])] as string[]).map(kind => ({ tempId: kind,
        label: kind === "knowledge" ? "备份恢复的事务一致性规则" : "导入备份并比对主键记录", summary: kind === "knowledge" ? principle : operation,
        learningKind: kind, learningDefinition: { scopeNote: "限于已有数据库恢复后的校验", assessmentCriteria: [kind === "knowledge" ? "解释一致性判断条件" : "交付可复核的数据比对报告"] },
        taskTempIds: [task.id], evidenceSpans: [{ segmentId: (kind === "knowledge" ? first : fresh).id, quote: kind === "knowledge" ? principle : operation }], confidence: .7 }))) };
    } else if (system.includes("跨任务能力归纳器")) {
      calls.capabilityFresh ||= input.evidenceSegments.some((segment: { text: string }) => segment.text.includes(operation));
      output = { capabilities: calls.capabilityFresh ? [{ tempId: "cap", label: "恢复结果核验与异常研判", summary: "在恢复后核验条件与结果", situations: "恢复演练", observableBehaviors: ["比对关键记录并记录异常"], qualityStandard: "结果可复核", taskTempIds: input.tasks.map((task: { id: string }) => task.id), units: [{ tempId: "unit", label: "恢复差异记录", summary: "形成可复核的差异记录", ...cultivation }], confidence: .65 }] : [] };
    } else if (system.includes("任务锚定的岗位事理抽取器")) {
      const fresh = input.segments.find((segment: { text: string }) => segment.text.includes(operation));
      calls.processFresh ||= Boolean(fresh);
      if (fresh) output = { scenarios: [{ tempId: "scene", label: "数据库恢复与校验", summary: operation, trigger: "恢复演练开始", outcome: "完成报告", evidenceSegmentIds: [fresh.id] }],
        nodes: [{ tempId: "a", kind: "event", label: "导入备份" }, { tempId: "b", kind: "event", label: "比对主键数据" }, { tempId: "c", kind: "artifact", label: "恢复校验报告" }].map(node => ({ ...node, scenarioTempId: "scene", summary: operation, evidenceSegmentIds: [fresh.id] })),
        edges: [{ type: "directly_follows", sourceTempId: "a", targetTempId: "b", evidenceSegmentIds: [fresh.id] }, { type: "produces", sourceTempId: "b", targetTempId: "c", evidenceSegmentIds: [fresh.id] }],
        bridges: [{ processTempId: "a", semanticLabel: input.tasks[0].label, type: "realizes_task" }] };
    }
    yield { type: "text", delta: JSON.stringify(output) };
  };
}

test("冷启动质量反馈真正补研，新增实践资料同时进入知识、单任务能力与事理 Lane，完成事件仅一次", async () => {
  const { request, base } = fixture();
  const original = structuredClone(base);
  const calls = { knowledge: 0, capabilityFresh: false, processFresh: false };
  const previous = globalThis.fetch;
  const searches: string[] = [];
  try {
    globalThis.fetch = async (_url, init) => {
      const query = JSON.parse(String(init?.body)).search_query;
      searches.push(query);
      const fresh = /项目实践|操作流程|实训项目/u.test(query);
      const text = `系统运维工程师的${taskLabel}岗位工作流程与技能要求。 ${principle} ${fresh ? operation : "原理资料没有操作与验收过程。"}`;
      return Response.json({ request_id: `call-${searches.length}`, search_result: [{ title: fresh ? "数据库恢复实践与验收" : "数据库恢复原理", link: `https://example.com/${fresh ? "practice" : "theory"}`, content: text.repeat(5), publish_date: "2026-09-08" }] });
    };
    const events: BuildEvent[] = [];
    for await (const event of await createColdStartSkill(qualityModel(calls), { execution: "enrichment", searchConfig: { provider: "glm", apiKey: "synthetic" } }).stream({ request, baseResult: base, laneFailures: [] }, { streamMode: "custom" })) events.push(event as BuildEvent);
    const completions = events.filter(event => event.kind === "build.run.completed");
    assert.equal(completions.length, 1);
    assert.equal(events.filter(event => event.kind === "build.enrichment.semantic.completed").length, 1);
    assert.ok(events.some(event => event.kind === "build.targeted_research.started" && event.payload.reason === "quality_feedback"));
    const result = completions[0].payload.result as ColdStartBuildResult;
    assert.equal(learningCoverage(result).tasksWithoutSkills.length, 0, JSON.stringify({ searches, calls, findings: result.audit.issues, points: result.semantic.nodes.filter(node => node.type === "knowledge_skill"), sources: result.sources.assets.map(asset => ({title:asset.title,qualification:asset.qualification})), queries: result.sources.research?.queries }));
    assert.ok(processCoverage(result).every(item => item.complete));
    assert.ok(!inspectSnapshot(result).findings.some(finding => ["TASK_CAPABILITY_GAP", "TASK_CAPABILITY_UNIT_GAP", "CAPABILITY_UNIT_CULTIVATION_GAP"].includes(finding.code)));
    assert.ok(calls.capabilityFresh && calls.processFresh, "补研不能只供给知识分支");
    assert.ok(searches.length >= 2 && searches.length <= 12);
    assert.ok(searches.some(query => /项目实践|操作流程/u.test(query)));
    assert.ok(result.sources.assets.some(asset => asset.locator === "https://example.com/practice"));
    assert.deepEqual(base, original);
  } finally { globalThis.fetch = previous; }
});

test("知识已有挂载但缺技能/评价时仍进入真实修复；仅桥接到一个行动也不算过程闭合", () => {
  const { base } = fixture();
  const task = base.semantic.nodes.find(node => node.type === "task")!;
  base.semantic.nodes.push({ ...task, id: "one-knowledge", type: "knowledge_skill", label: "事务一致性规则", learningKind: "knowledge", learningDefinition: { scopeNote: "数据库恢复", assessmentCriteria: ["解释一致性"] } });
  base.semantic.edges.push({ id: "requires-one", source: task.id, target: "one-knowledge", type: "requires_skill", confidence: .7, lifecycle: "candidate", evidenceSegmentIds: task.evidenceSegmentIds, evidenceBindingIds: [] });
  base.sources.evidenceBindings.push({ ...base.sources.evidenceBindings.find(binding => binding.targetId === task.id)!, id: "knowledge-binding", targetId: "one-knowledge" });
  base.process.scenarios.push({ id: "incomplete", label: "恢复演练", summary: "尚未完成", trigger: "演练开始", outcome: "待核验", knowledgeState: "inferred_pattern", lifecycle: "candidate", evidenceBindingIds: [], evidenceSegmentIds: task.evidenceSegmentIds });
  base.process.nodes.push({ id: "only-action", scenarioId: "incomplete", kind: "event", label: "导入备份", summary: "执行导入", knowledgeState: "inferred_pattern", lifecycle: "candidate", evidenceBindingIds: [], evidenceSegmentIds: task.evidenceSegmentIds });
  base.process.bridges.push({ id: "incomplete-bridge", processNodeId: "only-action", semanticNodeId: task.id, type: "realizes_task", confidence: .7 });
  const findings = inspectSnapshot(base).findings;
  assert.ok(findings.some(finding => finding.code === "TASK_PROCESS_INCOMPLETE"));
  assert.deepEqual(learningCoverage(base).taskCoverage[0].missingKinds, ["skill"]);
  const finding = findings.find(finding => finding.code === "TASK_LEARNING_KIND_GAP");
  assert.ok(finding);
  assert.equal(learningCoverage(base).tasksWithoutSkills.length, 1);
});

test("文字定向风险修复能补齐目标，资料内研究不需要联网开关，但不伪造搜索记录", async () => {
  const { base } = fixture();
  const source = base.sources.assets.find(asset => asset.kind !== "user_brief")!;
  base.sources.segments.find(segment => segment.sourceId === source.id)!.text += operation;
  const calls = { knowledge: 0, capabilityFresh: false, processFresh: false };
  const output = await createSnapshotIterationSkill({ model: qualityModel(calls) }).invoke({ base, candidate: base, request: iteration(base, { initiativeProfile: "user_directed", prompt: "补齐知识和技能", webResearch: false, maxRounds: 2 }) });
  assert.ok(calls.knowledge > 0);
  assert.equal(output.result!.createdSnapshot, true, output.result!.summary.join("\n"));
  assert.equal(output.result!.inspectionAfter.coverage.tasksWithoutSkills, 0);
  assert.ok(output.result!.researchPlans.every(plan => !plan.queries.length));
});

test("挂载反馈按节点范围形成模型研究工作，跨任务反馈不会混入定向请求", () => {
  const { base } = fixture();
  const task = base.semantic.nodes.find(node => node.type === "task")!;
  base.semantic.nodes.push({ ...task, id: "point", type: "knowledge_skill" }, { ...task, id: "outside", type: "knowledge_skill" });
  base.semantic.edges.push({ id: "edge", source: task.id, target: "point", type: "requires_skill", confidence: .7, lifecycle: "candidate", evidenceSegmentIds: [], evidenceBindingIds: [] });
  const request = iteration(base, { initiativeProfile: "user_directed", targetIds: [task.id], learningMountFeedback: [
    { roleNodeId: "point", reason: "定义过宽无法匹配", researchGoal: "明确恢复一致性判断条件" },
    { roleNodeId: "outside", reason: "无关反馈", researchGoal: "研究无关知识" },
  ] });
  const contract = createIterationContract(request, base);
  assert.deepEqual(contract.learningMountFeedback?.map(item => item.roleNodeId), ["point"]);
  const opportunities = discoverIterationOpportunities({ request, contract, inspection: inspectSnapshot(base) });
  const items = planIterationWork({ runId: request.runId, contract, opportunities });
  assert.ok(items.some(item => item.detail.includes("明确恢复一致性判断条件") && item.requiresResearch));
  const plan = planIterationResearch({ runId: request.runId, round: 1, result: base, request, contract, workItems: items });
  assert.ok(plan.queries.length);
});

test("四轮依次修复任务A、任务B、能力单元和工作过程，真实进展会继续而不会因首次完成提前停止", async () => {
  const { base } = fixture(2);
  const source = base.sources.assets.find(asset => asset.kind !== "user_brief")!;
  base.sources.segments.find(segment => segment.sourceId === source.id)!.text += operation;
  const calls = { knowledge: 0, capabilityFresh: false, processFresh: false };
  const delegate = qualityModel(calls);
  let round = 1;
  const rounds: number[] = [];
  const model: ModelInvoker = async function* (input) {
    const payload = JSON.parse(input.user);
    if (input.system.includes("任务导向的知识技能规范化器")) {
      payload.tasks = payload.tasks.filter((task: { label: string }) => round === 1 ? task.label === taskLabel : task.label !== taskLabel);
      if (!payload.tasks.length) { yield { type: "text", delta: "{}" }; return; }
      yield* delegate({ ...input, user: JSON.stringify(payload) });
    } else if (input.system.includes("跨任务能力归纳器")) {
      if (round < 3) { yield { type: "text", delta: "{}" }; return; }
      yield* delegate(input);
    } else if (input.system.includes("任务锚定的岗位事理抽取器")) {
      if (round < 4) { yield { type: "text", delta: "{}" }; return; }
      // Each task gets its own connected process.
      const pieces: Array<Record<string, unknown[]>> = [];
      for (const task of payload.tasks) {
        let text = "";
        for await (const chunk of delegate({ ...input, user: JSON.stringify({ ...payload, tasks: [task] }) })) if (chunk.type === "text") text += chunk.delta;
        const draft = JSON.parse(text);
        const prefix = `${pieces.length}:`;
        for (const scenario of draft.scenarios) { scenario.tempId = prefix + scenario.tempId; scenario.label += ` ${task.label}`; }
        for (const node of draft.nodes) { node.tempId = prefix + node.tempId; node.scenarioTempId = prefix + node.scenarioTempId; }
        for (const edge of draft.edges) { edge.sourceTempId = prefix + edge.sourceTempId; edge.targetTempId = prefix + edge.targetTempId; }
        for (const bridge of draft.bridges) bridge.processTempId = prefix + bridge.processTempId;
        pieces.push(draft);
      }
      yield { type: "text", delta: JSON.stringify(Object.fromEntries(["scenarios", "nodes", "edges", "bridges"].map(key => [key, pieces.flatMap(piece => piece[key])]))) };
    } else yield* delegate(input);
  };
  const output = await createSnapshotIterationSkill({ model, onCheckpoint: async (phase, state) => {
    if (phase === "research-plan") round = Number(state.round);
    if (phase === "evaluate") rounds.push(Number(state.round));
  } }).invoke({ base, candidate: base, request: iteration(base, { webResearch: false, maxRounds: 4 }) });
  assert.deepEqual(rounds, [1, 2, 3, 4]);
  assert.equal(output.result!.createdSnapshot, true, output.result!.summary.join("\n"));
  assert.equal(output.result!.inspectionAfter.coverage.tasksWithoutSkills, 0);
  assert.equal(output.result!.inspectionAfter.coverage.tasksWithoutProcess, 0);
  assert.ok(!output.result!.inspectionAfter.findings.some(finding => /TASK_CAPABILITY|CULTIVATION/u.test(finding.code)));
});

test("深研按任务排队，后续计划优先未尝试任务并换证据角度", () => {
  const { base } = fixture();
  const request = iteration(base, { mode: "deep_research", maxWorkItems: 16 });
  const contract = createIterationContract(request, base);
  const inspection = inspectSnapshot(base);
  const gap = inspection.findings.find(finding => finding.code === "TASK_SKILL_GAP")!;
  const findings = Array.from({ length: 14 }, (_, i) => ({ ...gap, id: `gap-${i}`, targetIds: [`task-${i}`], title: `任务${i}缺少知识技能` }));
  const opportunities = discoverIterationOpportunities({ request, contract, inspection: { ...inspection, findings } });
  const workItems = planIterationWork({ runId: request.runId, contract, opportunities });
  assert.equal(workItems.length, 14);
  const first = planIterationResearch({ runId: request.runId, round: 1, result: base, request, contract, workItems });
  const second = planIterationResearch({ runId: request.runId, round: 2, result: base, request, contract, workItems, previousPlans: [first] });
  assert.equal(new Set([...first.workItemIds, ...second.workItemIds]).size, 14);
  for (const item of workItems.filter(item => first.workItemIds.includes(item.id) && second.workItemIds.includes(item.id))) {
    assert.ok(second.queries.filter(query => query.query.includes(item.title)).every(query => !first.queries.some(old => old.query === query.query)));
  }
});

test("挂载反馈的定义修正穿过不可变合并，绑定到学习规格字段且保留原摘要", async () => {
  const { request, base } = fixture();
  const source = base.sources.assets.find(asset => asset.kind !== "user_brief")!;
  base.sources.segments.find(segment => segment.sourceId === source.id)!.text += operation;
  const calls = { knowledge: 0, capabilityFresh: false, processFresh: false };
  const initial = await createColdStartSkill(qualityModel(calls), { execution: "enrichment" }).invoke({ request, baseResult: base, laneFailures: [] });
  const before = structuredClone(initial.result!);
  const point = before.semantic.nodes.find(node => node.type === "knowledge_skill" && node.learningKind === "knowledge")!;
  point.learningDefinition = { scopeNote: "所有数据库技术", assessmentCriteria: ["了解数据库"] };
  const summary = point.summary;
  const output = await createSnapshotIterationSkill({ model: qualityModel(calls) }).invoke({ base: before, candidate: before, request: iteration(before, {
    webResearch: false, maxRounds: 1, initiativeProfile: "user_directed", targetIds: [point.id], learningMountFeedback: [{ roleNodeId: point.id, reason: "定义超出岗位恢复职责，无法挂载", researchGoal: "依据原文限定恢复一致性规则和评价条件" }],
  }) });
  assert.ok(output.result!.createdSnapshot, output.result!.summary.join("\n"));
  const repaired = output.result!.candidate.semantic.nodes.find(node => node.id === point.id)!;
  assert.equal(repaired.learningDefinition?.scopeNote, "限于已有数据库恢复后的校验");
  assert.equal(repaired.summary, summary);
  assert.equal(point.learningDefinition.scopeNote, "所有数据库技术", "旧快照不能被就地修改");
  assert.ok(output.result!.candidate.sources.evidenceBindings.some(binding => binding.targetId === point.id && binding.fieldPath === "learningDefinition" && binding.support === "inferred" && binding.evidenceSpan));
});
