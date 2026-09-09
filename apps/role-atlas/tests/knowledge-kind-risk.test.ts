import assert from "node:assert/strict";
import test from "node:test";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";
import { auditRoleSnapshot } from "@/lib/risk/audit";
import { applyGraphPatch, proposeSafePatch } from "@/lib/risk/patch";
import type { SemanticNode } from "@/lib/build/types";
import type { GraphPatch } from "@/lib/risk/types";

function fixture(leftKind: SemanticNode["learningKind"], rightKind: SemanticNode["learningKind"]) {
  const result = bundledRoleSnapshot();
  const removed = new Set(result.semantic.nodes.filter((node) => node.type === "knowledge_skill").map((node) => node.id));
  result.semantic.nodes = result.semantic.nodes.filter((node) => !removed.has(node.id));
  const points: SemanticNode[] = [leftKind, rightKind].map((learningKind, index) => ({
    id: `test:sql-${index}`, type: "knowledge_skill", label: "SQL 查询", summary: learningKind === "knowledge" ? "查询规则和语义" : "编写并运行查询", learningKind,
    learningDefinition: learningKind === "knowledge" || learningKind === "skill" ? { scopeNote: "关系数据库中的单条查询。", assessmentCriteria: ["根据给定表解释或执行查询"] } : undefined,
    aliases: ["关系查询"], lifecycle: "candidate", confidence: 0.7, evidenceSegmentIds: [], evidenceBindingIds: [], ring: 4,
  }));
  result.semantic.nodes.push(...points);
  const task = result.semantic.nodes.find((node) => node.type === "task")!;
  result.semantic.edges = result.semantic.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target));
  result.semantic.edges.push(...points.map((point) => ({ id: `test:edge:${point.id}`, type: "requires_skill" as const, source: task.id, target: point.id, lifecycle: "candidate" as const, confidence: 0.7, evidenceSegmentIds: [], evidenceBindingIds: [] })));
  result.semantic.claims = result.semantic.claims.filter((claim) => !removed.has(claim.subjectId) && (!claim.objectId || !removed.has(claim.objectId)));
  result.process.bridges = result.process.bridges.filter((bridge) => !removed.has(bridge.semanticNodeId));
  result.snapshot.sections = result.snapshot.sections.map((section) => ({ ...section, itemIds: section.id === "knowledge-skills" ? points.map((point) => point.id) : section.itemIds.filter((id) => !removed.has(id)) }));
  return result;
}

function manualMerge(snapshotId: string): GraphPatch {
  return { id: "test:manual-merge", baseSnapshotId: snapshotId, status: "proposed", iteration: 1,
    operations: [{ op: "merge_semantic_nodes", canonicalId: "test:sql-0", mergedIds: ["test:sql-1"], reason: "名称相同", issueIds: [] }],
    targetIds: ["test:sql-0", "test:sql-1"], issueIds: [], summary: "手工合并", createdAt: "2026-09-07T00:00:00Z" };
}

test("同名知识和技能通过风险审计、提案和执行后仍为两个独立学习对象", () => {
  const result = fixture("knowledge", "skill");
  const audit = auditRoleSnapshot(result);
  assert.equal(audit.issues.some((issue) => ["EXACT_DUPLICATE", "SEMANTIC_OVERLAP"].includes(issue.code) && issue.targetIds.includes("test:sql-0") && issue.targetIds.includes("test:sql-1")), false);
  const proposed = proposeSafePatch({ result, audit, iteration: 1 });
  assert.equal(proposed.operations.some((operation) => operation.op === "merge_semantic_nodes" && operation.mergedIds.some((id) => id.startsWith("test:sql-"))), false);
  const applied = applyGraphPatch(result, proposed);
  assert.deepEqual(applied.result.semantic.nodes.filter((node) => node.type === "knowledge_skill").map((node) => node.learningKind), ["knowledge", "skill"]);
  assert.equal(applied.result.semantic.edges.filter((edge) => edge.target.startsWith("test:sql-")).length, 2);
  assert.equal(applied.referenceMigration["test:sql-1"], undefined);
});

test("过期或错误审计也不能让提案跨学习类型合并", () => {
  const result = fixture("knowledge", "skill");
  const audit = auditRoleSnapshot(result);
  audit.issues.push({ id: "test:stale-duplicate", fingerprint: "stale", profile: "semantic", severity: "error", code: "EXACT_DUPLICATE", title: "同名", detail: "旧审计误判", impact: "", confidence: 1,
    targetIds: ["test:sql-0", "test:sql-1"], evidenceBindingIds: [], sourceIds: [], repairability: "automatic", status: "open", firstSeenAt: audit.generatedAt, lastSeenAt: audit.generatedAt });
  assert.equal(proposeSafePatch({ result, audit, iteration: 1 }).operations.some((operation) => operation.op === "merge_semantic_nodes" && operation.mergedIds.includes("test:sql-1")), false);
});

test("手工跨kind合并在任何删除或引用迁移之前被拒绝", () => {
  for (const kinds of [["knowledge", "skill"], [undefined, "knowledge"], ["hybrid", "skill"]] as const) {
    const result = fixture(kinds[0], kinds[1]);
    const before = JSON.stringify(result);
    assert.throws(() => applyGraphPatch(result, manualMerge(result.snapshot.id)), /SEMANTIC_MERGE_DIMENSION_MISMATCH/u);
    assert.equal(JSON.stringify(result), before);
  }
});

test("同kind同名节点仍能合并并迁移引用；旧缺省kind与hybrid保持兼容", () => {
  for (const kinds of [["knowledge", "knowledge"], ["skill", "skill"], [undefined, "hybrid"]] as const) {
    const result = fixture(kinds[0], kinds[1]);
    const audit = auditRoleSnapshot(result);
    assert.ok(audit.issues.some((issue) => issue.code === "EXACT_DUPLICATE" && issue.targetIds.includes("test:sql-0")));
    const proposed = proposeSafePatch({ result, audit, iteration: 1 });
    const applied = applyGraphPatch(result, proposed);
    assert.equal(applied.result.semantic.nodes.filter((node) => node.type === "knowledge_skill").length, 1);
    assert.equal(applied.referenceMigration["test:sql-1"], "test:sql-0");
    assert.ok(applied.result.semantic.edges.filter((edge) => edge.type === "requires_skill").every((edge) => edge.target !== "test:sql-1"));
    assert.ok(applied.result.snapshot.sections.every((section) => !section.itemIds.includes("test:sql-1")));
  }
});
