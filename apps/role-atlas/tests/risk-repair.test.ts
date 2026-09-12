import assert from "node:assert/strict";
import test from "node:test";
import type { ColdStartBuildResult } from "@/lib/build/types";
import { auditRoleSnapshot, isAuditImproved } from "@/lib/risk/audit";
import { applyGraphPatch, computeSemanticDiff, proposeSafePatch } from "@/lib/risk/patch";
import { createRolePackageManifest } from "@/lib/packages/role-package-manifest";

function fixture(): ColdStartBuildResult {
  const result: ColdStartBuildResult = {
    runId: "build-risk-fixture",
    projectId: "project-risk-fixture",
    brief: { projectId: "project-risk-fixture", roleTitle: "大模型应用工程师", roleDescription: "", market: "中国大陆", audience: ["高职学生"], snapshotAsOf: "2026-08-22", assumptions: [] },
    sources: {
      assets: [{ id: "src:1", title: "岗位说明", kind: "public_document", domain: "example.cn", sourceTier: "primary", contentHash: "h", visibility: "publishable_metadata" }],
      segments: [{ id: "seg:1", sourceId: "src:1", ordinal: 0, text: "负责构建并评测检索增强生成系统，交付可部署服务。", contentHash: "s" }],
      evidenceBindings: [
        { id: "bind:role", targetId: "role:1", fieldPath: "summary", sourceId: "src:1", segmentId: "seg:1", support: "direct", method: "model_extraction", confidence: 0.9 },
        { id: "bind:t1", targetId: "task:rag", fieldPath: "summary", sourceId: "src:1", segmentId: "seg:1", support: "direct", method: "model_extraction", confidence: 0.9 },
        { id: "bind:k1", targetId: "skill:eval-a", fieldPath: "summary", sourceId: "src:1", segmentId: "seg:1", support: "direct", method: "model_extraction", confidence: 0.9 },
      ],
    },
    semantic: {
      nodes: [
        { id: "role:1", type: "market_role", label: "大模型应用工程师", summary: "把大模型能力集成为可运行、可评测的业务应用。", aliases: [], lifecycle: "stable", confidence: 0.9, evidenceSegmentIds: ["seg:1"], evidenceBindingIds: ["bind:role"], ring: 0 },
        { id: "task:rag", type: "task", label: "构建并评测 RAG 系统", summary: "交付具有检索与生成质量报告的可部署服务。", aliases: [], lifecycle: "stable", confidence: 0.9, evidenceSegmentIds: ["seg:1"], evidenceBindingIds: ["bind:t1"], ring: 2 },
        { id: "skill:eval-a", type: "knowledge_skill", label: "检索质量评测", summary: "使用数据集和指标诊断召回与排序质量。", aliases: ["检索评测"], lifecycle: "stable", confidence: 0.9, evidenceSegmentIds: ["seg:1"], evidenceBindingIds: ["bind:k1"], ring: 4 },
        { id: "skill:eval-b", type: "knowledge_skill", label: "检索评测", summary: "检查检索质量并定位失败样本。", aliases: ["检索质量评测"], lifecycle: "candidate", confidence: 0.7, evidenceSegmentIds: [], evidenceBindingIds: [], ring: 4 },
      ],
      edges: [
        { id: "edge:role-task", type: "performs", source: "role:1", target: "task:rag", lifecycle: "stable", confidence: 0.9, evidenceSegmentIds: ["seg:1"], evidenceBindingIds: [] },
        { id: "edge:task-skill-a", type: "requires_skill", source: "task:rag", target: "skill:eval-a", lifecycle: "stable", confidence: 0.8, evidenceSegmentIds: ["seg:1"], evidenceBindingIds: [] },
        { id: "edge:task-skill-b", type: "requires_skill", source: "task:rag", target: "skill:eval-b", lifecycle: "candidate", confidence: 0.7, evidenceSegmentIds: [], evidenceBindingIds: [] },
        { id: "edge:dangling", type: "requires_skill", source: "task:rag", target: "skill:missing", lifecycle: "candidate", confidence: 0.5, evidenceSegmentIds: [], evidenceBindingIds: [] },
      ],
      claims: [{ id: "claim:1", subjectId: "task:rag", predicate: "requires_skill", objectId: "skill:eval-b", status: "candidate", evidenceSegmentIds: [], evidenceBindingIds: [], confidence: 0.7 }],
    },
    process: {
      scenarios: [{ id: "scenario:rag", label: "交付 RAG 服务", summary: "从需求到部署和评测。", trigger: "业务需求", outcome: "可部署服务", knowledgeState: "documented_norm", lifecycle: "stable", evidenceSegmentIds: ["seg:1"], evidenceBindingIds: [] }],
      nodes: [
        { id: "event:build", scenarioId: "scenario:rag", kind: "event", label: "构建检索链路", summary: "实现检索和生成链路。", sequenceHint: 1, knowledgeState: "documented_norm", lifecycle: "stable", evidenceSegmentIds: ["seg:1"], evidenceBindingIds: [] },
        { id: "artifact:service", scenarioId: "scenario:rag", kind: "artifact", label: "RAG 服务", summary: "可部署并具有评测结果的服务。", sequenceHint: 2, knowledgeState: "documented_norm", lifecycle: "stable", evidenceSegmentIds: ["seg:1"], evidenceBindingIds: [] },
      ],
      edges: [{ id: "process:produces", type: "produces", source: "event:build", target: "artifact:service", evidenceSegmentIds: ["seg:1"], evidenceBindingIds: [] }],
      bridges: [
        { id: "bridge:task", processNodeId: "event:build", semanticNodeId: "task:rag", type: "realizes_task", confidence: 0.9 },
        { id: "bridge:skill", processNodeId: "event:build", semanticNodeId: "skill:eval-b", type: "uses_skill", confidence: 0.7 },
      ],
    },
    snapshot: { id: "snapshot:role@2026-08-22", asOf: "2026-08-22", status: "candidate", sections: [
      { id: "overview", title: "岗位概览", status: "candidate", summary: "岗位总体说明与主要边界信息。", itemIds: ["role:1"], evidenceBindingIds: ["bind:role"] },
      { id: "tasks", title: "任务", status: "candidate", summary: "典型任务与可验收交付物说明。", itemIds: ["task:rag"], evidenceBindingIds: ["bind:t1"] },
      { id: "capabilities", title: "能力", status: "candidate", summary: "跨情境能力与表现要求尚待补充。", itemIds: [], evidenceBindingIds: [] },
      { id: "knowledge-skills", title: "知识技能", status: "candidate", summary: "可学习知识技能和实践入口。", itemIds: ["skill:eval-a", "skill:eval-b"], evidenceBindingIds: ["bind:k1"] },
      { id: "work-process", title: "事理", status: "candidate", summary: "真实工作过程的事件与交付物流。", itemIds: ["scenario:rag"], evidenceBindingIds: [] },
      { id: "evidence-risks", title: "证据风险", status: "candidate", summary: "来源覆盖、推断边界与待研究风险。", itemIds: [], evidenceBindingIds: [] },
    ] },
    audit: { issues: [], researchTopics: [] },
    packages: {
      rolePackage: undefined as never,
    },
    validation: { publishable: false, structural: { passed: false, issues: [] }, semantic: { passed: false, issues: [] }, evidence: { passed: false, coverage: 0.5, issues: [] }, temporal: { passed: true, issues: [] }, process: { passed: true, coverage: 1, issues: [] } },
  };
  result.packages.rolePackage = createRolePackageManifest({
    result,
    packageId: "role-package:role",
    packageVersion: "0.1.0-candidate.base",
    status: "candidate",
  });
  return result;
}

test("风险审计聚合同义重复与悬空关系，安全补丁迁移所有引用", () => {
  const base = fixture();
  const before = auditRoleSnapshot(base);
  assert.ok(before.issues.some((issue) => issue.code === "EXACT_DUPLICATE"));
  assert.ok(before.issues.some((issue) => issue.code === "DANGLING_SEMANTIC_EDGE"));
  const proposed = proposeSafePatch({ result: base, audit: before, iteration: 1 });
  assert.ok(proposed.operations.some((operation) => operation.op === "merge_semantic_nodes"));
  assert.ok(proposed.operations.some((operation) => operation.op === "remove_semantic_edge"));
  const applied = applyGraphPatch(base, proposed);
  assert.equal(applied.result.semantic.nodes.some((node) => node.id === "skill:eval-b"), false);
  assert.ok(applied.result.semantic.claims.every((claim) => claim.objectId !== "skill:eval-b"));
  assert.ok(applied.result.process.bridges.every((bridge) => bridge.semanticNodeId !== "skill:eval-b"));
  assert.ok(applied.result.snapshot.sections.every((section) => !section.itemIds.includes("skill:eval-b")));
  assert.equal(applied.result.semantic.edges.some((edge) => edge.target === "skill:missing"), false);
  const after = auditRoleSnapshot(applied.result);
  assert.equal(after.issues.some((issue) => issue.code === "EXACT_DUPLICATE"), false);
  assert.equal(after.issues.some((issue) => issue.code === "DANGLING_SEMANTIC_EDGE"), false);
  assert.equal(isAuditImproved(before, after), true);
  const diff = computeSemanticDiff({ base, candidate: applied.result, patches: [applied.patch], auditBefore: before, auditAfter: after, migrations: applied.referenceMigration });
  assert.equal(diff.referenceMigration["skill:eval-b"], "skill:eval-a");
  assert.ok(diff.nodes.merged.some((merge) => merge.from.includes("skill:eval-b") && merge.to === "skill:eval-a"));
});

test("日期型快照允许同日抓取，未来来源仅在不孤立事实时自动剔除", () => {
  const sameDay = fixture();
  sameDay.sources.assets[0].observedAt = "2026-08-22T20:30:00.000Z";
  sameDay.sources.assets[0].fetchedAt = "2026-08-22T20:30:00.000Z";
  assert.equal(auditRoleSnapshot(sameDay, { profiles: ["temporal"] }).issues.some((issue) => issue.code === "FUTURE_SOURCE"), false);

  const future = fixture();
  future.sources.assets[0].publishedAt = "2026-08-23T00:00:00.000Z";
  const audit = auditRoleSnapshot(future, { profiles: ["temporal"] });
  assert.ok(audit.issues.some((issue) => issue.code === "FUTURE_SOURCE"));
  const unsafePatch = proposeSafePatch({ result: future, audit, iteration: 1 });
  assert.equal(unsafePatch.operations.some((operation) => operation.op === "remove_source"), false, "唯一证据不能被自动删除");

  future.sources.assets.push({ ...future.sources.assets[0], id: "src:2", title: "同日独立岗位说明", publishedAt: "2026-08-22", contentHash: "h2" });
  future.sources.segments.push({ ...future.sources.segments[0], id: "seg:2", sourceId: "src:2", contentHash: "s2" });
  future.sources.evidenceBindings.push(...future.sources.evidenceBindings.map((binding) => ({ ...binding, id: `${binding.id}:alternative`, sourceId: "src:2", segmentId: "seg:2" })));
  const patch = proposeSafePatch({ result: future, audit: auditRoleSnapshot(future, { profiles: ["temporal"] }), iteration: 1 });
  assert.ok(patch.operations.some((operation) => operation.op === "remove_source" && operation.sourceId === "src:1"));
  const applied = applyGraphPatch(future, patch).result;
  assert.deepEqual(applied.sources.assets.map((source) => source.id), ["src:2"]);
  assert.deepEqual(applied.sources.segments.map((segment) => segment.id), ["seg:2"]);
  assert.ok(applied.sources.evidenceBindings.every((binding) => binding.sourceId === "src:2"));
  assert.equal(auditRoleSnapshot(applied, { profiles: ["temporal"] }).issues.some((issue) => issue.code === "FUTURE_SOURCE"), false);
});
