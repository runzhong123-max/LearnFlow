import assert from "node:assert/strict";
import test from "node:test";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";
import { reviewIterationScope } from "@/lib/iteration/scope";
import { createIterationContract, evaluateIteration } from "@/lib/iteration/planner";
import { inspectSnapshot } from "@/lib/iteration/inspector";
import type { ColdStartBuildResult } from "@/lib/build/types";

function fixture() {
  const base = bundledRoleSnapshot();
  const task = base.semantic.nodes.find(node => node.type === "task")!;
  const contract = createIterationContract({ runId: "directed-scope", snapshotRef: { snapshotId: base.snapshot.id }, mode: "deep_research", initiativeProfile: "user_directed", prompt: "补充指定任务的知识技能与工作过程", targetIds: [task.id], supplementalSources: [], webResearch: true, maxRounds: 1, sourceLimit: 8, maxWorkItems: 10 }, base);
  return { base, task, contract };
}
function point(candidate: ColdStartBuildResult, id: string, label: string) {
  const template = candidate.semantic.nodes.find(node => node.type === "knowledge_skill")!;
  const binding = candidate.sources.evidenceBindings.find(item => candidate.sources.assets.find(source => source.id === item.sourceId)?.kind !== "user_brief")!;
  const added = { ...template, id, label, evidenceBindingIds: [`binding:${id}`], evidenceSegmentIds: [binding.segmentId] };
  candidate.semantic.nodes.push(added);
  candidate.sources.evidenceBindings.push({ ...binding, id: `binding:${id}`, targetId: id });
  return added;
}
function connect(candidate: ColdStartBuildResult, source: string, target: string) {
  candidate.semantic.edges.push({ id: `edge:${source}:${target}`, type: "requires_skill", source, target, confidence: 0.8, lifecycle: "candidate", evidenceBindingIds: [], evidenceSegmentIds: [] });
}

test("定向候选允许从目标关系闭包展开的新知识点，原图保持完整", () => {
  const { base, task, contract } = fixture();
  const candidate = structuredClone(base);
  const first = point(candidate, "knowledge:targeted-new", "有证据的任务补充知识");
  const second = point(candidate, "knowledge:targeted-dependent", "任务补充知识的前置概念");
  connect(candidate, task.id, first.id);
  connect(candidate, first.id, second.id);
  const checked = reviewIterationScope(base, candidate, contract);
  assert.deepEqual(checked.reasons, []);
  assert.equal(checked.targetedChange, true);
  assert.equal(candidate.semantic.nodes.length, base.semantic.nodes.length + 2);
});

test("不能借共同岗位根节点把无关新增带入定向研究，也不静默裁剪候选", () => {
  const { base, contract } = fixture();
  const candidate = structuredClone(base);
  const unrelated = point(candidate, "knowledge:unrelated", "与目标无关的营销概念");
  const role = base.semantic.nodes.find(node => node.type === "market_role")!;
  connect(candidate, role.id, unrelated.id);
  const original = structuredClone(candidate);
  const checked = reviewIterationScope(base, candidate, contract);
  assert.match(checked.reasons.join(" "), /定向研究候选包含 1 个/);
  assert.equal(checked.targetedChange, false);
  assert.deepEqual(candidate, original, "范围检查只验收，不删除节点或证据");
  const evaluation = evaluateIteration({ base, candidate, contract, before: inspectSnapshot(base), after: inspectSnapshot(candidate) });
  assert.equal(evaluation.meaningful, false);
  assert.match(evaluation.reasons.join(" "), /定向研究候选/);
});

test("伪造关联但没有可追溯来源的新增节点不能通过范围闭包", () => {
  const { base, task, contract } = fixture();
  const candidate = structuredClone(base);
  const unsupported = { ...task, type: "knowledge_skill" as const, id: "knowledge:unsupported", label: "未证实知识", evidenceBindingIds: [], evidenceSegmentIds: [] };
  candidate.semantic.nodes.push(unsupported);
  connect(candidate, task.id, unsupported.id);
  assert.ok(reviewIterationScope(base, candidate, contract).reasons.length > 0);
});

test("只有额外来源尚未绑定到选中对象，不作为定向研究完成", () => {
  const { base, contract } = fixture();
  const candidate = structuredClone(base);
  candidate.sources.assets.push({ ...candidate.sources.assets.at(-1)!, id: "source:unbound", contentHash: "new-source", locator: "https://example.com/unbound" });
  const checked = reviewIterationScope(base, candidate, contract);
  assert.deepEqual(checked.reasons, []);
  assert.equal(checked.targetedChange, false);
  const evaluation = evaluateIteration({ base, candidate, contract, before: inspectSnapshot(base), after: inspectSnapshot(base) });
  assert.equal(evaluation.meaningful, false);
  assert.match(evaluation.reasons.join(" "), /新增来源本身不等于定向研究完成/);
});

test("定向进展不能夹带无关旧节点之间的新关系", () => {
  const { base, task, contract } = fixture();
  const candidate = structuredClone(base);
  const added = point(candidate, "knowledge:targeted", "目标学习内容");
  connect(candidate, task.id, added.id);
  const unrelated = base.semantic.nodes.filter(node => node.type === "task" && node.id !== task.id).slice(-2);
  assert.equal(unrelated.length, 2);
  connect(candidate, unrelated[0].id, unrelated[1].id);
  assert.match(reviewIterationScope(base, candidate, contract).reasons.join(" "), /未连接到选中范围的新增关系/);
});

test("自动发现可扩展全图，显式选择岗位根节点可研究岗位整体", () => {
  const { base, contract } = fixture();
  const candidate = structuredClone(base);
  const node = point(candidate, "knowledge:role-wide", "岗位整体补充知识");
  const role = base.semantic.nodes.find(item => item.type === "market_role")!;
  connect(candidate, role.id, node.id);
  assert.deepEqual(reviewIterationScope(base, candidate, { ...contract, initiativeProfile: "autonomous" }).reasons, []);
  assert.deepEqual(reviewIterationScope(base, candidate, { ...contract, targetIds: [role.id] }).reasons, []);
});

test("定向更新不得夹带选中范围外的事实断言", () => {
  const { base, contract } = fixture();
  const candidate = structuredClone(base);
  const unrelated = base.semantic.nodes.find(node => node.type === "related_role")!;
  assert.ok(unrelated);
  candidate.semantic.claims.push({ id: "claim:unrelated-new", subjectId: unrelated.id, predicate: "new_requirement", value: "新增无关要求", status: "candidate", confidence: 0.8, evidenceSegmentIds: [], evidenceBindingIds: [] });
  assert.match(reviewIterationScope(base, candidate, contract).reasons.join(" "), /选中范围外的新增断言/);
});
