import type { ColdStartBuildResult, SemanticNode } from "../build/types";
import type { AutomaticMountRecord, AutomaticMountPoint } from "./automatic-contract";
import { courseNameKey, courseTheme } from "./course-organization";
import { projectGraphPayload } from "../projects/presentation";

export function courseGroups(result: ColdStartBuildResult, mount?: AutomaticMountRecord | null) {
  const groups = new Map<string, { id: string; title: string; summary: string; mounted: boolean;
    members: Array<{ node: SemanticNode; mount?: AutomaticMountPoint }> }>();
  const saved = mount?.snapshotId === result.snapshot.id ? mount.result : undefined;
  for (const node of result.semantic.nodes.filter(n => n.type === "knowledge_skill")) {
    const point = saved?.points.find(p => p.roleNodeId === node.id);
    const course = point?.target && point.status !== "needs_research" && point.course?.kind === "course" ? point.course : undefined;
    const theme = courseTheme(node, result.brief.roleTitle);
    const id = course ? `course-view:${point!.target!.namespace}:${point!.target!.id}` : `course-plan:${courseNameKey(theme.title)}`;
    const group = groups.get(id) || { id, title: course?.title || theme.title, summary: theme.scopeNote, mounted: Boolean(course), members: [] };
    group.members.push({ node, mount: point }); groups.set(id, group);
  }
  return [...groups.values()];
}

/** Read-only view: original fact IDs remain the only IDs usable by tools. */
export function courseGraphPayload(result: ColdStartBuildResult, mount?: AutomaticMountRecord | null) {
  const graph = projectGraphPayload(result);
  const memberToCourse = new Map<string, string>();
  const courses = courseGroups(result, mount).filter(group => group.mounted).map(group => {
    for (const { node } of group.members) memberToCourse.set(node.id, group.id);
    const members = group.members.map(({ node }) => graph.nodes.find(n => n.id === node.id)!);
    const sourceRefs = [...new Set(members.flatMap(n => n.evidence_summary.source_refs))];
    const bindingRefs = [...new Set(members.flatMap(n => n.evidence_summary.binding_refs))];
    return { ...members[0], id: group.id, label: group.title,
      summary: `${group.mounted ? "已挂载课程" : "课程组织建议，尚无课程挂载回执"}。${group.summary}`,
      defaultVisibility: true, granularity: "kernel" as const, parentKernelId: undefined,
      assertion_refs: [...new Set(members.flatMap(n => n.assertion_refs))],
      facets: group.members.map(({ node }) => ({ nodeId: node.id, label: node.label, summary: node.summary })),
      evidence_summary: { ...members[0].evidence_summary, source_refs: sourceRefs, binding_refs: bindingRefs,
        max_confidence: Math.max(...members.map(n => n.evidence_summary.max_confidence)) },
      data: { ...members[0].data, courseMemberIds: members.map(n => n.id) },
    };
  });
  const unmounted = new Set(graph.nodes.filter(node => node.type === "knowledge_skill" && !memberToCourse.has(node.id)).map(node => node.id));
  const edges = new Map<string, typeof graph.edges[number]>();
  for (const edge of graph.edges) {
    if (unmounted.has(edge.source) || unmounted.has(edge.target)) continue;
    const source = memberToCourse.get(edge.source) || edge.source, target = memberToCourse.get(edge.target) || edge.target;
    // A relationship between two fine points is not a course prerequisite.
    if (source === target || memberToCourse.has(edge.source) && memberToCourse.has(edge.target)) continue;
    const key = JSON.stringify([source, target, edge.type]);
    if (!edges.has(key)) edges.set(key, { ...edge, source, target });
  }
  return { ...graph, nodes: [...graph.nodes.filter(n => n.type !== "knowledge_skill"), ...courses], edges: [...edges.values()] };
}

export function mountedCourseCounts(mount?: AutomaticMountRecord | null) {
  const statuses = new Map<string, "existing" | "created">();
  for (const point of mount?.result?.points || []) {
    if (!point.target || point.status === "needs_research") continue;
    const key = JSON.stringify([point.target.namespace, point.target.id]);
    // A new course reused in a later batch is still one newly created course.
    if (statuses.get(key) !== "created") statuses.set(key, point.status);
  }
  return { created: [...statuses.values()].filter(s => s === "created").length,
    existing: [...statuses.values()].filter(s => s === "existing").length };
}
