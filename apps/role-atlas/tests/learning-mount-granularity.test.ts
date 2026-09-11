import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { MAX_NEW_COURSES_PER_RESOLUTION, resolveRoleLearningPoints } from "../lib/learning-path/resolution";
import { mountReason } from "../lib/learning-path/automatic-contract";
import { bundledRoleSnapshot } from "../lib/snapshots/bundled-role-adapter";
import type { LearningPathGraphV2 } from "../lib/learning-path/contract";

const packageRef = { packageId: "role:test", packageVersion: "1.0.0", snapshotId: "snapshot:test", rootHash: "a".repeat(64) };

/**
 * Eight requirements that each want their own brand-new course. Without the
 * consolidation cap every fine-grained action would become a separate course
 * node and the learner radar would fill with noise.
 */
function fixture(count: number) {
  const result = structuredClone(bundledRoleSnapshot());
  const base = result.semantic.nodes.find(n => n.type === "knowledge_skill")!;
  const binding = result.sources.evidenceBindings.find(b => b.targetId === base.id)!;
  binding.supportRole = "supports"; binding.assertionType = "direct_fact";
  const points = Array.from({ length: count }, (_, index) => ({
    ...structuredClone(base),
    id: `skill:granularity-${index}`,
    label: `岗位专项操作${index}`,
    learningKind: "skill" as const,
    learningDefinition: { scopeNote: `岗位专项操作${index}的适用范围。`, assessmentCriteria: [`按标准完成岗位专项操作${index}。`] },
    learningCourse: { title: `岗位专项课程${index}`, scopeNote: `岗位专项课程${index}的范围说明。` },
    evidenceBindingIds: [`evidence:granularity-${index}`],
  }));
  result.semantic.nodes = points;
  result.sources.evidenceBindings = points.map((point, index) => ({ ...structuredClone(binding), id: `evidence:granularity-${index}`, targetId: point.id }));
  const graph = JSON.parse(readFileSync(new URL("../public/data/learnflow-learning-path.v2.json", import.meta.url), "utf8")) as LearningPathGraphV2;
  const anchor = graph.nodes.find(n => n.kind === "course")!;
  anchor.title = "数据库"; anchor.aliases = []; graph.nodes = [anchor]; graph.edges = [];
  return { result, graph, points };
}

test("a single resolution adds at most a few coarse courses; overflow waits for consolidation", async () => {
  const { result, graph, points } = fixture(MAX_NEW_COURSES_PER_RESOLUTION + 2);
  const input = { result, graph, packageRef, namespace: "learnflow:extension:test", groupByCourse: true, allowStandaloneRoots: true };
  const first = await resolveRoleLearningPoints(input);
  const created = first.extensionProposal?.nodes || [];
  assert.equal(created.length, MAX_NEW_COURSES_PER_RESOLUTION);
  assert.ok(created.every(node => node.kind === "course"));
  assert.equal(first.unresolved.length, 2);
  assert.ok(first.unresolved.every(point => point.reason === "needs_consolidation"));
  // The overflow points are exactly the ones whose courses were not created.
  assert.deepEqual(first.unresolved.map(point => point.roleNodeId), points.slice(-2).map(point => point.id));

  // Once the first batch exists in the graph, the remainder resolves without
  // hitting the cap again — convergence, not a permanent failure.
  const merged = { ...graph, nodes: [...graph.nodes, ...created], edges: [...graph.edges, ...(first.extensionProposal?.edges || [])], sources: [...graph.sources, ...(first.extensionProposal?.sources || [])] };
  const second = await resolveRoleLearningPoints({ ...input, graph: merged });
  assert.equal(second.unresolved.length, 0);
  assert.equal(second.extensionProposal?.nodes.length, 2);
  assert.equal(second.alignment.bindings.length, MAX_NEW_COURSES_PER_RESOLUTION);
  assert.equal(second.pendingBindings.length, 2);
});

test("requirements that share an existing course never count against the new-course budget", async () => {
  const { result, graph, points } = fixture(MAX_NEW_COURSES_PER_RESOLUTION + 2);
  for (const point of points) point.learningCourse = { title: "云平台运维", scopeNote: "围绕云平台运维组织原理、方法与实践。" };
  const resolved = await resolveRoleLearningPoints({ result, graph, packageRef, namespace: "learnflow:extension:test", groupByCourse: true, allowStandaloneRoots: true });
  assert.equal(resolved.unresolved.length, 0);
  assert.equal(resolved.extensionProposal?.nodes.length, 1, "同一课程主题只新增一门课程");
});

test("the consolidation reason has operator-facing copy", () => {
  assert.match(mountReason("needs_consolidation"), /归并/);
});
