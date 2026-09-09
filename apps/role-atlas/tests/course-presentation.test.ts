import test from "node:test";
import assert from "node:assert/strict";
import { bundledRoleSnapshot } from "../lib/snapshots/bundled-role-adapter";
import { courseGraphPayload, courseGroups, mountedCourseCounts } from "../lib/learning-path/course-presentation";
import { courseTheme, courseMatchScore } from "../lib/learning-path/course-organization";
import type { AutomaticMountRecord } from "../lib/learning-path/automatic-contract";

function fixture() {
  const result = structuredClone(bundledRoleSnapshot());
  const original = result.semantic.nodes.find(n => n.type === "knowledge_skill")!;
  const task = result.semantic.nodes.find(n => n.type === "task")!;
  const points = ["云平台巡检", "云平台告警处理", "云平台故障定位"].map((label, i) => ({ ...original, id: `point-${i}`, label }));
  result.semantic.nodes = [task, ...points];
  result.semantic.edges = points.map((point, i) => ({ ...result.semantic.edges[0], id: `edge-${i}`, source: task.id, target: point.id }));
  const target = { id: "course-cloud", namespace: "learnflow:extension:1", revision: 1 };
  const mount: AutomaticMountRecord = { id: "mount", projectVersionId: "version", snapshotId: result.snapshot.id, status: "completed", attempt: 1,
    result: { status: "completed", packageRef: { packageId: "pkg", packageVersion: "1", snapshotId: result.snapshot.id, rootHash: "a".repeat(64) }, receipts: [], unresolved: [],
      points: points.map((point, i) => ({ roleNodeId: point.id, status: i === 0 ? "created" : "existing", target, course: { title: "云平台架构与运维", kind: "course" } })) } };
  return { result, mount, points };
}
test("radar uses real course title; every detailed reference and edge survives grouping", () => {
  const { result, mount, points } = fixture(); const before = JSON.stringify(result);
  const view = courseGraphPayload(result, mount);
  const course = view.nodes.find(n => n.type === "knowledge_skill")!;
  assert.equal(view.nodes.length, 2);
  assert.equal(course.label, "云平台架构与运维");
  assert.deepEqual(course.facets?.map(f => f.nodeId), points.map(p => p.id));
  assert.equal(view.edges.length, 1); assert.equal(view.edges[0].target, course.id);
  assert.equal(course.defaultVisibility, true);
  assert.equal(JSON.stringify(result), before);
  assert.deepEqual(mountedCourseCounts(mount), { created: 1, existing: 0 });
});
test("legacy receipts are retained and never misrepresented as committed courses", () => {
  const { result, mount } = fixture(); for (const point of mount.result!.points) delete point.course;
  assert.equal(courseGroups(result, mount).length, 1);
  assert.ok(courseGroups(result, mount).every(group => !group.mounted));
  assert.equal(courseGraphPayload(result, mount).nodes.filter(node => node.type === "knowledge_skill").length, 0);
  assert.equal(courseGraphPayload(result, mount).edges.length, 0);
  mount.snapshotId = "other-snapshot";
  assert.ok(courseGroups(result, mount).every(group => !group.mounted));
});
test("operation-like course suggestions are not made into individual course nodes", () => {
  const { result, points } = fixture();
  points[0].learningCourse = { title: "执行云平台巡检并编写报告", scopeNote: "巡检操作" };
  assert.equal(courseTheme(points[0], result.brief.roleTitle).title, "云平台运维");
  assert.ok(courseMatchScore({ title: "Linux系统管理", scopeNote: "操作系统管理" }, points[0], ["Linux 基础"]) > 0);
  assert.equal(courseMatchScore({ title: "云平台运维", scopeNote: "云平台" }, points[0], ["大模型应用工程师"]), 0);
});

test("fine-point relations never become prerequisites between whole courses", () => {
  const { result, mount, points } = fixture();
  mount.result!.points[2].target!.id = "second-course";
  // Give it a distinct object; fixture targets intentionally exercise shared identity.
  mount.result!.points[2].target = { ...mount.result!.points[2].target!, id: "distinct" };
  result.semantic.edges.push({ ...result.semantic.edges[0], id: "fine-prereq", source: points[0].id, target: points[2].id, type: "prerequisite" });
  assert.ok(!courseGraphPayload(result, mount).edges.some(edge => edge.id === "fine-prereq"));
  assert.ok(result.semantic.edges.some(edge => edge.id === "fine-prereq"));
});
