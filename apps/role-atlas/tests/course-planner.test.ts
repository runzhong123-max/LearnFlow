import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCoursePlanner } from "../lib/learning-path/course-planner";
import { resolveRoleLearningPoints } from "../lib/learning-path/resolution";
import { bundledRoleSnapshot } from "../lib/snapshots/bundled-role-adapter";
import type { LearningPathGraphV2 } from "../lib/learning-path/contract";
import type { ModelInvoker } from "../lib/agent/model";
function fixture() {
  const result = structuredClone(bundledRoleSnapshot());
  const point = result.semantic.nodes.find(node => node.type === "knowledge_skill")!;
  point.label = "定位磁盘满导致的服务异常"; point.learningKind = "skill";
  point.learningDefinition = { scopeNote: "服务器日常排障", assessmentCriteria: ["定位磁盘占用并验证服务恢复"] };
  const evidence = result.sources.evidenceBindings.find(binding => binding.targetId === point.id)!;
  evidence.supportRole = "supports"; evidence.assertionType = "direct_fact"; point.evidenceBindingIds = [evidence.id];
  const second = { ...structuredClone(point), id: "skill:second", label: "配置系统服务自动启动", evidenceBindingIds: ["evidence:second"] };
  result.sources.evidenceBindings.push({ ...evidence, id: "evidence:second", targetId: second.id });
  result.semantic.nodes = [point, second];
  const graph = JSON.parse(readFileSync(new URL("../public/data/learnflow-learning-path.v2.json", import.meta.url), "utf8")) as LearningPathGraphV2;
  const course = graph.nodes.find(node => node.kind === "course")!; course.title = "Linux 操作系统"; course.aliases = []; graph.nodes = [course]; graph.edges = [];
  return { result, graph, points: [point, second], packageRef: { packageId: "test", packageVersion: "1", snapshotId: result.snapshot.id, rootHash: "a".repeat(64) }, namespace: "learnflow:extension:test", groupByCourse: true, allowStandaloneRoots: true };
}
function model(value: unknown): ModelInvoker { return async function* () { yield { type: "text", delta: JSON.stringify(value) }; }; }
const group = (ids: string[], existingCourse: number | null, title = "Linux系统管理") => ({ pointIds: ids, existingCourse, title, scopeNote: "服务器原理与运维", rationale: existingCourse === null ? "现有课程未覆盖服务器管理，合并运维要求" : "两项要求分别属于系统存储与服务管理" });
test("semantic retrieval reuses differently-worded course and preserves both requirements", async () => {
  const f = fixture(); let called = false;
  const invoke: ModelInvoker = async function* (input) {
    called = true; const payload = JSON.parse(input.user); assert.equal(payload.catalog[0].title, "Linux 操作系统"); assert.equal(payload.requirements.length, 2);
    yield { type: "text", delta: JSON.stringify({ groups: [group(f.points.map(point => point.id), 0)] }) };
  };
  const resolved = await resolveRoleLearningPoints({ ...f, planCourses: createCoursePlanner(invoke) });
  assert.ok(called); assert.equal(resolved.extensionProposal, undefined); assert.equal(resolved.alignment.bindings.length, 2);
  assert.ok(resolved.alignment.bindings.every(binding => binding.target.id === f.graph.nodes[0].id && binding.relation === "narrower_than"));
});
test("uncovered operational details become one validated course, never atomic nodes", async () => {
  const f = fixture(); f.graph.nodes[0].title = "离散数学";
  const resolved = await resolveRoleLearningPoints({ ...f, planCourses: createCoursePlanner(model({ groups: [group(f.points.map(point => point.id), null)] })) });
  assert.equal(resolved.extensionProposal?.nodes.length, 1); assert.equal(resolved.extensionProposal?.nodes[0].kind, "course");
  assert.equal(resolved.pendingBindings.length, 2); assert.equal(resolved.unresolved.length, 0);
});
test("hallucinated references, omitted members, duplicate members and operational courses fail before writing", async () => {
  const f = fixture(), ids = f.points.map(point => point.id);
  for (const groups of [[group(ids, 99)], [group([ids[0]], 0)], [group(ids, 0), group([ids[0]], 0)], [group([...ids, "foreign-point"], 0)], [group(ids, null, "执行磁盘清理")]]) {
    await assert.rejects(resolveRoleLearningPoints({ ...f, planCourses: createCoursePlanner(model({ groups })) }), /COURSE_PLAN_/);
  }
});
test("model failure never falls back to speculative course creation", async () => {
  const f = fixture(); f.graph.nodes[0].title = "离散数学";
  await assert.rejects(resolveRoleLearningPoints({ ...f, planCourses: createCoursePlanner(async function* () { throw new Error("network timeout"); }) }), /network timeout/);
});
test("missing evidence remains in research and never enters the model's mount plan", async () => {
  const f = fixture(); f.points[1].evidenceBindingIds = [];
  const resolved = await resolveRoleLearningPoints({ ...f, planCourses: createCoursePlanner(model({ groups: [group([f.points[0].id], 0)] })) });
  assert.equal(resolved.alignment.bindings.length, 1); assert.equal(resolved.unresolved[0].reason, "needs_evidence");
});
