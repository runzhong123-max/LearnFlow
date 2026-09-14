import { carryDeliveryProgress } from "../lib/research/delivery-progress";
import { compareResearchQuality } from "../lib/research/quality";
import { evaluateIteration, createIterationContract } from "../lib/iteration/planner";
import { inspectSnapshot } from "../lib/iteration/inspector";
import { conversationIterationRequest, defaultIterationDraft } from "../lib/iteration/brief";
import LearningSupportDetail from "../app/components/LearningSupportDetail";
import { resolveSourceSpan } from "../lib/research/source-reference";
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bundledRoleSnapshot } from "../lib/snapshots/bundled-role-adapter";
import { inspectLearningSupport, deriveLearningSupport } from "../lib/research/learning-support";
import { deriveTaskDefinitions, inspectTaskDefinitions, roleDeliveryReadiness, taskFieldUsable } from "../lib/research/task-definition";
import { LearningNodeConnection, LearningNodeSemantics } from "../app/components/LearningPathMapping";
import type { ModelInvoker } from "../lib/agent/model";

function fixture() {
  const result = structuredClone(bundledRoleSnapshot());
  const original = result.semantic.nodes.find(node => node.type === "knowledge_skill")!;
  const segment = result.sources.segments[0];
  const node = (id: string, type: typeof original.type) => ({ ...original, id, label: id, summary: `${id} 的范围`, type, lifecycle: "candidate" as const, granularity: "kernel" as const, evidenceSegmentIds: [segment.id], evidenceBindingIds: [] as string[], learningKind: type === "knowledge_skill" ? "knowledge" as const : undefined });
  const role = node("role", "market_role"), task = node("task", "task"), cap = node("cap", "capability"), unit = node("unit", "capability_unit"), point = node("point", "knowledge_skill");
  point.learningDefinition = { scopeNote: "理解连接语义", assessmentCriteria: ["解释连接依据"] };
  const binding = { ...result.sources.evidenceBindings[0], id: "point-evidence", targetId: point.id, sourceId: segment.sourceId, segmentId: segment.id, assertionType: "cross_source_synthesis" as const, supportRole: "supports" as const };
  point.evidenceBindingIds = [binding.id]; result.sources.evidenceBindings.push(binding);
  result.semantic.nodes = [role, task, cap, unit, point];
  const edge = (source: string, target: string, type: string) => ({ ...result.semantic.edges[0], id: `${source}:${type}:${target}`, source, target, type, lifecycle: "candidate" as const });
  result.semantic.edges = [edge(role.id, task.id, "performs"), edge(task.id, cap.id, "requires_capability"), edge(cap.id, unit.id, "contains"), edge(task.id, point.id, "requires_knowledge")];
  result.semantic.claims = []; result.audit.issues = []; for (const key of ["structural", "semantic", "evidence", "temporal", "process"] as const) result.validation[key].passed = true;
  const field = { text: "任务要求", basis: "synthesis" as const, evidence: [{ segmentId: segment.id, quote: segment.text.slice(0, 60) }], review: { status: "supported" as const, reason: "fixture" } };
  task.taskDefinition = { schemaVersion: "role-task-definition/v1", goal: field, trigger: field, inputs: field, actors: field, activities: field, deliverables: field, qualityCriteria: field, exceptions: field, downstreamNeeds: [] };
  result.process.bridges = [{ ...result.process.bridges[0], semanticNodeId: task.id, type: "realizes_task" }];
  return { result, task, cap, unit, point, edge, segment };
}
test("补齐学习支撑即使任务字段未变，也能由三种迭代保留", () => {
  const { result: base, unit, point, edge } = fixture();
  const candidate = structuredClone(base);
  candidate.semantic.edges.push(edge(unit.id, point.id, "requires_knowledge"));
  const quality = compareResearchQuality(base, candidate);
  assert.equal(quality.before.taskGaps, quality.after.taskGaps);
  assert.equal(quality.conversionImproved, true);
  // Hold unrelated audit axes constant to isolate delivery gaps the older audit misses.
  const before = inspectSnapshot(base);
  assert.equal(before.protocolValid, true);
  for (const mode of ["deep_research", "risk_repair", "freshness"] as const) {
    const request = conversationIterationRequest({ runId: `support-${mode}`,
      context: { projectId: "project", conversationId: "conversation", versionId: "version", snapshotId: base.snapshot.id, roleTitle: base.brief.roleTitle },
      draft: { ...defaultIterationDraft(), mode, targetAsOf: base.snapshot.asOf }, prompt: "", materials: [], webResearch: false });
    const contract = createIterationContract(request, base);
    const evaluation = evaluateIteration({ base, candidate, before, after: before, contract });
    assert.equal(evaluation.meaningful, true, `${mode}: ${evaluation.reasons.join(";")}`);
  }
  assert.equal(compareResearchQuality(candidate, structuredClone(candidate)).conversionImproved, false);
});
test("删除缺口对象不能冒充学习支撑改善", () => {
  const { result: base, point } = fixture();
  const candidate = structuredClone(base);
  candidate.semantic.nodes = candidate.semantic.nodes.filter(node => node.id !== point.id);
  assert.equal(compareResearchQuality(base, candidate).conversionImproved, false);
});
test("任务详情补齐固定协议字段并按复核意见修正，不能静默丢弃全部内容", async () => {
  const { result, task } = fixture();
  const definition = structuredClone(task.taskDefinition!);
  task.taskDefinition = undefined;
  let generations = 0;
  const model: ModelInvoker = async function* () { throw new Error("native only"); };
  model.chat = async request => {
    const input = JSON.parse(String(request.messages[1].content));
    let output: unknown;
    if (input.claims) output = { verdicts: input.claims.map((claim: { claimId: string }) => ({ claimId: claim.claimId, verdict: generations === 1 && claim.claimId.endsWith(":goal") ? "uncertain" : "supported", note: "删除未被原文支持的额外表单要求" })) };
    else {
      assert.equal(request.thinking, "disabled");
      generations += 1;
      if (generations === 2) assert.equal(input.previousDefinition.goal.review.status, "partially_supported");
      const { schemaVersion: _version, ...fields } = definition;
      output = fields;
    }
    return { message: { role: "assistant", content: JSON.stringify(output) }, finishReason: "stop", usage: { inputTokens: 20, outputTokens: 20, estimated: false } };
  };
  await deriveTaskDefinitions(model, result);
  assert.equal(generations, 2);
  assert.equal(result.semantic.nodes.find(node => node.id === task.id)?.taskDefinition?.schemaVersion, "role-task-definition/v1");
  assert.ok(inspectTaskDefinitions(result)[0].ready);
});
test("局部补全保留已经核对的字段，全部完成后不重复调用模型", async () => {
  const { result, task } = fixture();
  task.taskDefinition = structuredClone(task.taskDefinition!);
  const definition = structuredClone(task.taskDefinition);
  task.taskDefinition.goal = { ...task.taskDefinition.goal, text: "", basis: "unknown" };
  let calls = 0;
  const model: ModelInvoker = async function* ({ user }) {
    calls += 1;
    const input = JSON.parse(user);
    if (input.claims) {
      assert.deepEqual(input.claims.map((claim: { claimId: string }) => claim.claimId), ["task:goal", "task:exceptions"]);
      yield { type: "text", delta: JSON.stringify({ verdicts: input.claims.map((claim: { claimId: string }) => ({ claimId: claim.claimId, verdict: "supported", note: "有依据" })) }) };
    } else {
      const proposed = structuredClone(definition);
      proposed.activities = { ...proposed.activities, text: "模型不应替换已有活动", basis: "unknown", evidence: [] };
      yield { type: "text", delta: JSON.stringify(proposed) };
    }
  };
  await deriveTaskDefinitions(model, result);
  assert.equal(task.taskDefinition.activities.text, definition.activities.text);
  assert.ok(inspectTaskDefinitions(result)[0].ready);
  const completedCalls = calls;
  await deriveTaskDefinitions(model, result);
  assert.equal(calls, completedCalls);
});
test("完整任务接口不能掩盖能力单元与知识技能断链，补齐后才内容就绪", () => {
  const { result, unit, point, edge } = fixture();
  assert.ok(inspectTaskDefinitions(result).every(task => task.ready));
  assert.equal(roleDeliveryReadiness(result).ready, false);
  result.semantic.edges.push(edge(unit.id, point.id, "requires_knowledge"));
  assert.deepEqual(inspectLearningSupport(result), []);
  assert.equal(roleDeliveryReadiness(result).ready, true);
  result.semantic.edges.at(-1)!.lifecycle = "rejected";
  assert.equal(roleDeliveryReadiness(result).ready, false);
});
test("悬空、无关关系和知识技能定义缺失均不能算已连接", () => {
  const { result, task, unit, point, edge } = fixture();
  result.semantic.edges.push(edge(unit.id, "missing", "requires_skill"), edge(unit.id, point.id, "related_to"));
  assert.ok(inspectLearningSupport(result).some(gap => gap.nodeId === unit.id));
  result.semantic.edges = result.semantic.edges.filter(edge => edge.source !== task.id || edge.type !== "requires_knowledge");
  result.semantic.edges.push(edge(task.id, "missing", "requires_skill"));
  assert.ok(inspectTaskDefinitions(result)[0].gaps.includes("knowledge_skills"));
  point.learningDefinition = undefined;
  assert.ok(inspectLearningSupport(result).some(gap => gap.reason.includes("学习范围")));
});
for (const supported of [true, false]) test(`连接生成查原文并独立复核，复核支持=${supported}`, async () => {
  const { result, segment } = fixture();
  const model: ModelInvoker = async function* ({ user }) {
    const input = JSON.parse(user);
    if (input.claims) yield { type: "text", delta: JSON.stringify({ verdicts: input.claims.map((claim: { claimId: string }) => ({ claimId: claim.claimId, verdict: supported ? "supported" : "unsupported", note: "fixture" })) }) };
    else yield { type: "text", delta: JSON.stringify({ links: [
      { sourceId: "unit", targetId: "point", evidence: [{ segmentId: "incorrect-id", quote: segment.text.slice(0, 60) }] },
      { sourceId: "unit", targetId: "point", evidence: [{ segmentId: "incorrect-id", quote: segment.text.slice(0, 60) }] },
      { sourceId: "unit", targetId: "invented", evidence: [{ segmentId: segment.id, quote: segment.text.slice(0, 60) }] },
      { sourceId: "cap", targetId: "point", evidence: [{ segmentId: segment.id, quote: "编造的引文" }] },
    ] }) };
  };
  await deriveLearningSupport(model, result);
  assert.equal(result.semantic.edges.some(edge => edge.source === "unit" && edge.target === "point"), supported);
  assert.ok(!result.semantic.edges.some(edge => edge.target === "invented"));
  if (supported) {
    const binding = result.sources.evidenceBindings.find(binding => binding.assertionType === "research_inference")!;
    assert.equal(binding.reviewStatus, "supported"); assert.equal(binding.adoptionStatus, "candidate");
    const count = result.semantic.edges.length;
    await deriveLearningSupport(model, result); assert.equal(result.semantic.edges.length, count);
    assert.equal(roleDeliveryReadiness(result).ready, true);
    const recompiled = structuredClone(result);
    const supportEdge = result.semantic.edges.find(edge => edge.source === "unit" && edge.target === "point")!;
    recompiled.semantic.edges = recompiled.semantic.edges.filter(edge => edge.id !== supportEdge.id);
    recompiled.semantic.claims = [];
    recompiled.sources.evidenceBindings = recompiled.sources.evidenceBindings.filter(binding => binding.targetId !== supportEdge.id);
    carryDeliveryProgress(result, recompiled);
    assert.equal(roleDeliveryReadiness(recompiled).ready, true);
    assert.ok(recompiled.semantic.claims.some(claim => claim.objectId === "point"));
    recompiled.semantic.edges.find(edge => edge.id === supportEdge.id)!.lifecycle = "rejected";
    carryDeliveryProgress(result, recompiled);
    assert.equal(recompiled.semantic.edges.find(edge => edge.id === supportEdge.id)!.lifecycle, "rejected");
  }
});
test("节点详情展示已有路径身份，不呈现第二个挂载工作台", () => {
  const markup = renderToStaticMarkup(createElement(LearningNodeConnection, { nodeIds: ["point"], mount: { id: "mount", projectVersionId: "v", snapshotId: "s", status: "completed", attempt: 1, result: { status: "completed", packageRef: { packageId: "p", packageVersion: "v", snapshotId: "s", rootHash: "a".repeat(64) }, points: [{ roleNodeId: "point", status: "existing", target: { namespace: "learnflow:official", id: "linux", revision: 2 }, course: { title: "Linux", kind: "course" } }], receipts: [], unresolved: [] } } }));
  assert.match(markup, /Linux/); assert.match(markup, /已复用/); assert.match(markup, /v2/);
  assert.doesNotMatch(markup, /挂载|静态匹配|手动预览|准备当前版本/);
});

test("路径节点附带岗位语义与可观察学习要求", () => {
  const { point } = fixture();
  const markup = renderToStaticMarkup(createElement(LearningNodeSemantics, { nodes: [point] }));
  assert.match(markup, /理解连接语义/); assert.match(markup, /解释连接依据/); assert.match(markup, /知识/);
});

test("接口综合保留部分支持的限制，核心职责、冲突和无依据仍阻断", () => {
  const { task } = fixture();
  const field = { ...task.taskDefinition!.inputs, review: { status: "partially_supported" as const, reason: "岗位材料支持工作对象，具体企业表单需下游提供" } };
  assert.equal(taskFieldUsable("inputs", field), true);
  assert.equal(taskFieldUsable("goal", field), false);
  assert.equal(taskFieldUsable("activities", field), false);
  assert.equal(taskFieldUsable("inputs", { ...field, basis: "public_material" }), false);
  assert.equal(taskFieldUsable("inputs", { ...field, review: { status: "conflicting", reason: "原文矛盾" } }), false);
});

test("引文必须逐字匹配，错误片段 ID 仅在唯一原文匹配时修正", () => {
  const segments = [{ id: "first", text: "维护操作系统" }, { id: "second", text: "交付故障处理记录" }];
  assert.deepEqual(resolveSourceSpan({ segmentId: "first", quote: "故障处理记录" }, segments), { segmentId: "second", quote: "故障处理记录" });
  assert.equal(resolveSourceSpan({ segmentId: "first", quote: "故障处置报告" }, segments), undefined);
  assert.equal(resolveSourceSpan({ segmentId: "missing", quote: "记录" }, [...segments, { id: "third", text: "巡检记录" }]), undefined);
  assert.equal(resolveSourceSpan({ segmentId: "first", quote: "" }, segments), undefined);
});

test("补全后同步就绪状态，基础检查失败仍阻止交付", async () => {
  const { result, unit, point, edge } = fixture();
  const model: ModelInvoker = async function* () { throw new Error("已核对字段不应重新生成"); };
  result.validation.publishable = false;
  result.semantic.edges.push(edge(unit.id, point.id, "requires_knowledge"));
  await deriveTaskDefinitions(model, result);
  assert.equal(result.deliveryReadiness?.ready, true);
  assert.equal(result.validation.publishable, true);
  assert.equal(result.snapshot.status, "ready");
  result.validation.evidence.passed = false;
  await deriveTaskDefinitions(model, result);
  assert.equal(result.deliveryReadiness?.ready, false);
  assert.equal(result.validation.publishable, false);
  assert.equal(result.snapshot.status, "candidate");
});

test("部分支持的学习映射仅作为候选建议保存，保留复核限制", async () => {
  const { result, segment } = fixture();
  const model: ModelInvoker = async function* ({ user }) {
    const input = JSON.parse(user);
    if (input.claims) yield { type: "text", delta: JSON.stringify({ verdicts: input.claims.map((claim: { claimId: string }) => ({ claimId: claim.claimId, verdict: "uncertain", note: "材料仅支持任务相关性，具体学习方式需要课程验证" })) }) };
    else yield { type: "text", delta: JSON.stringify({ links: [{ sourceId: "unit", targetId: "point", evidence: [{ segmentId: segment.id, quote: segment.text.slice(0, 60) }] }] }) };
  };
  await deriveLearningSupport(model, result);
  assert.equal(result.semantic.edges.find(edge => edge.source === "unit")?.lifecycle, "candidate");
  const claim = result.semantic.claims.find(claim => claim.subjectId === "unit")!;
  assert.equal(claim.reviewStatus, "partially_supported");
  assert.equal(claim.adoptionStatus, "candidate");
  assert.equal(claim.assertionType, "research_inference");
  assert.ok(claim.limitations?.some(note => note.includes("需要课程验证")));
  const markup = renderToStaticMarkup(createElement(LearningSupportDetail, { result, nodeIds: ["unit"] }));
  assert.match(markup, /候选学习建议 · 部分支持/);
  assert.match(markup, /需要课程验证/);
});

test("重新编译不会丢失未变化任务的完成字段，内容或来源变化则重新核查", () => {
  const { result, task, segment } = fixture();
  const current = structuredClone(result);
  current.semantic.nodes.find(node => node.id === task.id)!.taskDefinition = undefined;
  carryDeliveryProgress(result, current);
  assert.deepEqual(current.semantic.nodes.find(node => node.id === task.id)!.taskDefinition, task.taskDefinition);
  const changed = structuredClone(current);
  const changedTask = changed.semantic.nodes.find(node => node.id === task.id)!;
  changedTask.taskDefinition = undefined; changedTask.summary = "另一个任务范围";
  carryDeliveryProgress(result, changed);
  assert.equal(changedTask.taskDefinition, undefined);
  changedTask.summary = task.summary;
  changed.sources.segments.find(item => item.id === segment.id)!.text += "新的限制";
  carryDeliveryProgress(result, changed);
  assert.equal(changedTask.taskDefinition, undefined);
});
