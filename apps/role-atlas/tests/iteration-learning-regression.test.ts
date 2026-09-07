import assert from "node:assert/strict";
import test from "node:test";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";
import { preserveIterationGraph, sourceFingerprints, learningRegressionReasons } from "@/lib/iteration/preserve-graph";
import { prepareBuildInput } from "@/lib/build/compiler";
import { reconstructSourceInputs } from "@/lib/risk/research";
import { evaluateIteration, createIterationContract } from "@/lib/iteration/planner";
import { inspectSnapshot, applyInspectionToSnapshot } from "@/lib/iteration/inspector";
import { snapshotQualitySummary } from "@/lib/iteration/learning-health";
import { createSnapshotIterationSkill } from "@/lib/iteration/graph";
import type { SnapshotIterationRequest } from "@/lib/iteration/types";
import type { ColdStartRequest } from "@/lib/build/types";

function request(base = bundledRoleSnapshot()): SnapshotIterationRequest {
  return { runId: "learning-regression", snapshotRef: { snapshotId: base.snapshot.id }, initiativeProfile: "autonomous", mode: "deep_research", prompt: "补充知识技能", targetIds: [], supplementalSources: [], webResearch: false, maxRounds: 1, sourceLimit: 12, maxWorkItems: 5 };
}

test("重建遗漏已有知识技能时保留完整节点、任务关系和证据，章节随合并重编译", () => {
  const base = bundledRoleSnapshot();
  const original = structuredClone(base);
  const rebuilt = structuredClone(base);
  const skills = base.semantic.nodes.filter(n => n.type === "knowledge_skill");
  assert.ok(skills.length > 1);
  const removed = new Set(skills.slice(1).map(n => n.id));
  rebuilt.semantic.nodes = rebuilt.semantic.nodes.filter(n => !removed.has(n.id));
  rebuilt.semantic.edges = rebuilt.semantic.edges.filter(e => !removed.has(e.source) && !removed.has(e.target));
  rebuilt.semantic.claims = rebuilt.semantic.claims.filter(c => !removed.has(c.subjectId) && !removed.has(c.objectId || ""));
  rebuilt.sources.evidenceBindings = rebuilt.sources.evidenceBindings.filter(b => !removed.has(b.targetId));
  const build: ColdStartRequest = { ...base.brief, sources: [], runId: "rebuild-preserve" };
  const merged = preserveIterationGraph(base, rebuilt, build);
  for (const skill of skills) assert.deepEqual(merged.semantic.nodes.find(n => n.id === skill.id), skill);
  for (const edge of base.semantic.edges) assert.deepEqual(merged.semantic.edges.find(e => e.id === edge.id), edge);
  for (const binding of base.sources.evidenceBindings) assert.deepEqual(merged.sources.evidenceBindings.find(b => b.id === binding.id), binding);
  assert.equal(merged.snapshot.sections.find(s => s.id === "knowledge-skills")!.itemIds.length, skills.length);
  assert.deepEqual(base, original, "合并不能修改原快照");
  assert.ok(inspectSnapshot(merged).agentProbes.find(p => p.id === "probe:evidence-resolution")?.status === "passed");
});

test("来源重排不能伪造增量，重映射后的所有证据保持可解析", () => {
  const base = bundledRoleSnapshot();
  const rebuilt = structuredClone(base);
  // Simulate compiler IDs changing with a different input order.
  rebuilt.sources.assets.forEach(s => { s.id += ":reordered"; });
  rebuilt.sources.segments.forEach(s => { s.id += ":reordered"; s.sourceId += ":reordered"; });
  rebuilt.sources.evidenceBindings.forEach(b => { b.id += ":reordered"; b.sourceId += ":reordered"; b.segmentId += ":reordered"; if (b.evidenceSpan) b.evidenceSpan.segmentId += ":reordered"; });
  const merged = preserveIterationGraph(base, rebuilt, { ...base.brief, sources: [], runId: "reordered-sources" });
  assert.equal(merged.sources.assets.length, base.sources.assets.length);
  assert.equal(merged.sources.segments.length, base.sources.segments.length);
  assert.equal(merged.sources.evidenceBindings.length, base.sources.evidenceBindings.length);
  assert.equal(inspectSnapshot(merged).agentProbes.find(p => p.id === "probe:evidence-resolution")?.status, "passed");
});

test("来源增益和整体结构改善不能抵消知识技能丢失或任务覆盖退步", () => {
  const base = bundledRoleSnapshot();
  const before = inspectSnapshot(base);
  const candidate = structuredClone(base);
  candidate.semantic.nodes = candidate.semantic.nodes.filter(n => n.type !== "knowledge_skill");
  candidate.sources.assets.push(...base.sources.assets.slice(0, 12).map(s => ({ ...s, id: `${s.id}:new` })));
  // Keep other axes apparently healthy, reproducing the former acceptance hole.
  const after = { ...before, findings: [], core: { ...before.core, errorCount: 0 } };
  const contract = createIterationContract(request(base), base);
  const rejected = evaluateIteration({ base, candidate, before, after, contract });
  assert.equal(rejected.coreRegression, true);
  assert.equal(rejected.meaningful, false);
  assert.match(rejected.reasons.join(" "), /丢失/);
  const coverageRegression = evaluateIteration({ base, candidate: base, before, after: { ...after, coverage: { ...before.coverage, tasksWithoutSkills: before.coverage.tasksWithoutSkills + 2 } }, contract });
  assert.equal(coverageRegression.meaningful, false);
  assert.match(coverageRegression.reasons.join(" "), /覆盖/);
});

test("真实来源重构的外层 hash 变化不算新增，用户简报也不是研究增益", () => {
  const base = bundledRoleSnapshot();
  const build: ColdStartRequest = { ...base.brief, runId: "source-round-trip", sources: [{ title: "实施说明", kind: "public_document", content: "安装数据库。验证连接。\n\n部署服务。检查日志。" }] };
  const first = prepareBuildInput(build);
  base.sources.assets = first.assets; base.sources.segments = first.segments;
  const second = prepareBuildInput({ ...build, roleDescription: "增加了研究目标", sources: reconstructSourceInputs(base) });
  const candidate = structuredClone(base);
  candidate.sources.assets = second.assets; candidate.sources.segments = second.segments;
  assert.notEqual(first.assets[1].contentHash, second.assets[1].contentHash);
  assert.equal(sourceFingerprints(base).get(first.assets[1].id), sourceFingerprints(candidate).get(second.assets[1].id));
  const before = inspectSnapshot(base);
  const evaluation = evaluateIteration({ base, candidate, before, after: before, contract: createIterationContract(request(base), base) });
  assert.equal(evaluation.informationGain.newSources, 0);
  // Normalizing quote whitespace could collapse incompatible segment offsets.
  const variant = structuredClone(candidate);
  variant.sources.segments.find(s => s.sourceId === second.assets[1].id)!.text += "\r\n";
  assert.notEqual(sourceFingerprints(candidate).get(second.assets[1].id), sourceFingerprints(variant).get(second.assets[1].id));
});

test("仅相同陈述合并新证据引用，改写陈述的证据不能挂到旧事实", () => {
  const base = bundledRoleSnapshot();
  const node = base.semantic.nodes.find(n => n.type === "knowledge_skill" && n.evidenceBindingIds.length)!;
  const originalBinding = base.sources.evidenceBindings.find(b => node.evidenceBindingIds.includes(b.id))!;
  const source = base.sources.assets.find(s => s.id === originalBinding.sourceId)!;
  const segment = base.sources.segments.find(s => s.id === originalBinding.segmentId)!;
  const extraSource = { ...source, id: `${source.id}:extra`, locator: "https://example.com/independent-evidence" };
  const extraSegment = { ...segment, id: `${segment.id}:extra`, sourceId: extraSource.id };
  const addedBinding = { ...originalBinding, id: `${originalBinding.id}:extra`, sourceId: extraSource.id, segmentId: extraSegment.id, ...(originalBinding.evidenceSpan ? { evidenceSpan: { ...originalBinding.evidenceSpan, segmentId: extraSegment.id } } : {}) };
  const rebuilt = structuredClone(base);
  rebuilt.sources.assets.push(extraSource);
  rebuilt.sources.segments.push(extraSegment);
  rebuilt.sources.evidenceBindings.push(addedBinding);
  rebuilt.semantic.nodes.find(n => n.id === node.id)!.evidenceBindingIds.push(addedBinding.id);
  rebuilt.semantic.nodes.find(n => n.id === node.id)!.evidenceSegmentIds.push(extraSegment.id);
  const build = { ...base.brief, runId: "evidence-preserve", sources: [] };
  const merged = preserveIterationGraph(base, rebuilt, build);
  assert.ok(merged.sources.evidenceBindings.some(b => b.id === addedBinding.id));
  assert.ok(merged.semantic.nodes.find(n => n.id === node.id)!.evidenceBindingIds.includes(addedBinding.id));
  assert.ok(merged.semantic.nodes.find(n => n.id === node.id)!.evidenceSegmentIds.includes(extraSegment.id));
  rebuilt.semantic.nodes.find(n => n.id === node.id)!.summary = "改写成未经确认的另一个陈述";
  const retained = preserveIterationGraph(base, rebuilt, build);
  assert.equal(retained.semantic.nodes.find(n => n.id === node.id)!.summary, node.summary);
  assert.deepEqual(retained.semantic.nodes.find(n => n.id === node.id)!.evidenceBindingIds, node.evidenceBindingIds);
  assert.ok(!retained.sources.evidenceBindings.some(b => b.id === addedBinding.id));
});

test("即使总覆盖数字相同也必须保护已有任务技能关系", () => {
  const base = bundledRoleSnapshot();
  const nodes = new Map(base.semantic.nodes.map(n => [n.id, n]));
  const edge = base.semantic.edges.find(e => nodes.get(e.source)?.type === "task" && nodes.get(e.target)?.type === "knowledge_skill")!;
  const candidate = structuredClone(base);
  candidate.semantic.edges = candidate.semantic.edges.filter(e => e.id !== edge.id);
  assert.match(learningRegressionReasons(base, candidate).join(" "), /支撑关系/);
});

test("同一关系新增原文引用时保留新证据，不误判为关系正文改变", () => {
  const base = bundledRoleSnapshot();
  const edge = base.semantic.edges.find(e => e.evidenceBindingIds.length)!;
  const binding = base.sources.evidenceBindings.find(b => edge.evidenceBindingIds.includes(b.id))!;
  const segment = base.sources.segments.find(s => s.id === binding.segmentId)!;
  const rebuilt = structuredClone(base);
  const updated = rebuilt.semantic.edges.find(e => e.id === edge.id)!;
  const span = { segmentId: segment.id, quote: segment.text.slice(0, 20) };
  const addedBinding = { ...binding, id: `${binding.id}:relation-quote`, fieldPath: "evidenceSpans", evidenceSpan: span };
  updated.evidenceSpans = [...(updated.evidenceSpans || []), span];
  updated.evidenceBindingIds.push(addedBinding.id);
  rebuilt.sources.evidenceBindings.push(addedBinding);
  const merged = preserveIterationGraph(base, rebuilt, { ...base.brief, runId: "relation-evidence", sources: [] });
  const retained = merged.semantic.edges.find(e => e.id === edge.id)!;
  assert.ok(retained.evidenceSpans?.some(s => s.quote === span.quote && s.segmentId === span.segmentId));
  assert.ok(retained.evidenceBindingIds.includes(addedBinding.id));
  assert.ok(merged.sources.evidenceBindings.some(b => b.id === addedBinding.id));
});

test("无变化或被拒绝的重建不会泄漏到后续任务的基线", async () => {
  const base = bundledRoleSnapshot();
  const candidate = structuredClone(base);
  candidate.semantic.nodes = candidate.semantic.nodes.filter(n => n.type !== "knowledge_skill");
  const req = request(base);
  const before = inspectSnapshot(base), after = inspectSnapshot(candidate);
  const contract = createIterationContract(req, base);
  const graph = createSnapshotIterationSkill({ model: async function* () { throw new Error("恢复到评估后不应调用模型"); } });
  const state = await graph.invoke({ request: req, base, candidate, contract, inspectionBefore: before, inspectionAfter: after, migrations: { "rejected-old": "rejected-new" }, evaluation: evaluateIteration({ base, candidate, before, after, contract }), resumeFrom: "evaluate" });
  assert.equal(state.result?.createdSnapshot, false);
  assert.deepEqual(state.result?.candidate, base);
  assert.deepEqual(state.result?.diff.referenceMigration, {});
  assert.deepEqual(state.result?.diff.issues.resolved, []);
  assert.match(state.result!.summary.join(" "), /未采用/);
});

test("任务知识缺口保留为待研究，不能通过语义发布门或显示全部完成", () => {
  const base = bundledRoleSnapshot();
  const skills = new Set(base.semantic.nodes.filter(n => n.type === "knowledge_skill").map(n => n.id));
  base.semantic.edges = base.semantic.edges.filter(e => !skills.has(e.target));
  base.validation.publishable = true;
  const result = applyInspectionToSnapshot(base, inspectSnapshot(base));
  assert.equal(result.validation.semantic.passed, false);
  assert.equal(result.validation.publishable, false);
  const summary = snapshotQualitySummary(result);
  assert.ok(summary.tasksWithoutSkills > 0);
  assert.equal(summary.needsResearch, true);
  assert.match(summary.label, /仍缺少知识技能/);
});
