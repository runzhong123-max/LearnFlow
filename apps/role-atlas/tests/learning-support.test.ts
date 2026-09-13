import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bundledRoleSnapshot } from "../lib/snapshots/bundled-role-adapter";
import { inspectLearningSupport, deriveLearningSupport } from "../lib/research/learning-support";
import { inspectTaskDefinitions, roleDeliveryReadiness } from "../lib/research/task-definition";
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
  result.semantic.claims = []; result.audit.issues = []; result.validation.structural.passed = true;
  const field = { text: "任务要求", basis: "synthesis" as const, evidence: [{ segmentId: segment.id, quote: segment.text.slice(0, 60) }], review: { status: "supported" as const, reason: "fixture" } };
  task.taskDefinition = { schemaVersion: "role-task-definition/v1", goal: field, trigger: field, inputs: field, actors: field, activities: field, deliverables: field, qualityCriteria: field, exceptions: field, downstreamNeeds: [] };
  result.process.bridges = [{ ...result.process.bridges[0], semanticNodeId: task.id, type: "realizes_task" }];
  return { result, task, cap, unit, point, edge, segment };
}
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
      { sourceId: "unit", targetId: "point", evidence: [{ segmentId: segment.id, quote: segment.text.slice(0, 60) }] },
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
