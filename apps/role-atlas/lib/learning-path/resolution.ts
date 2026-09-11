import type { CoursePlanner } from "./course-planner";
import { courseTheme, courseMatchScore, courseNameKey } from "./course-organization";
import type { ColdStartBuildResult, SemanticNode } from "@/lib/build/types";
import { canonicalStringify, sha256Hex } from "@/lib/versioning/canonical";
import {
  GRAPH_EXTENSION_PROPOSAL_V2, ROLE_LEARNING_ALIGNMENT_V2, pathNodeKey,
  validateGraphExtensionProposalV2, validateLearningPathGraphV2, validateRoleLearningAlignmentV2,
  type GraphExtensionProposalV2, type LearningPathGraphV2, type PathNodeV2,
  type RoleAlignmentSource, type RoleLearningAlignmentV2, type RolePackageRef,
} from "./contract";

export type RoleLearningResolution = {
  protocol: "role-learning-resolution/v2";
  packageRef: RolePackageRef;
  graphRef: { graphId: string; revision: string };
  namespace: string;
  alignment: RoleLearningAlignmentV2;
  pendingBindings: RoleLearningAlignmentV2["bindings"];
  courseTargets?: Array<{ roleNodeId: string; target: { namespace: string; id: string; revision: number }; title: string; kind: "course" }>;
  extensionProposal?: GraphExtensionProposalV2;
  /** Set when the model course planner failed and the bounded deterministic
   * theme grouping (still capped by MAX_NEW_COURSES_PER_RESOLUTION) was used.
   * The mount stays useful during provider outages instead of failing closed. */
  coursePlannerDegraded?: { reason: string };
  unresolved: Array<{ roleNodeId: string; reason: "needs_decomposition" | "needs_definition" | "needs_evidence" | "ambiguous_definition" | "needs_anchor" | "needs_consolidation"; candidates: Array<{ namespace: string; id: string; revision: number; title: string; kind: string }> }>;
};

/**
 * A single mount may only add a few coarse-grained courses. Without the cap a
 * fine-grained knowledge/skill list becomes one new course per action and the
 * learner's radar fills with noise. Overflow points stay unresolved with
 * `needs_consolidation` so the next resolution can place them once the earlier
 * courses exist in the graph.
 */
export const MAX_NEW_COURSES_PER_RESOLUTION = 6;

const normalize = (s: string) => s.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
const key = (n: PathNodeV2) => ({ namespace: n.namespace, id: n.id, revision: n.revision });
const nodeRef = (n: PathNodeV2) => ({ ...key(n), title: n.title, kind: n.kind });
const lexical = (s: string) => normalize(s).replace(/[\s\p{P}]+/gu, "");
function overlap(a: string, b: string) {
  a = lexical(a); b = lexical(b);
  if (!a || !b) return 0;
  if (a.includes(b) && b.length >= 3) return 1;
  const grams = (s: string) => new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const left = grams(a), right = grams(b);
  return [...right].filter(g => left.has(g)).length / Math.max(1, right.size);
}
function signature(node: Pick<SemanticNode, "summary" | "learningDefinition">) {
  // Preserve mathematical punctuation: x>=0 and x>0 are different definitions.
  // The explicit atomic contract is stable across explanatory-summary rewrites.
  return canonicalStringify({ scopeNote: normalize(node.learningDefinition!.scopeNote),
    assessmentCriteria: node.learningDefinition!.assessmentCriteria.map(normalize).sort() });
}

const hashLengths = [24, 32, 40, 48, 56, 64] as const;
const stableCompare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const pointHash = (kind: string, label: string, definition: Pick<SemanticNode, "summary" | "learningDefinition">) =>
  sha256Hex(`${kind}:${lexical(label)}:${signature(definition)}`);
function contentAddressedPoint(id: string, hash: string): boolean {
  return hashLengths.some(length => id === `point:${hash.slice(0, length)}`)
    || id.startsWith(`point:${hash}:`) && /^[1-9][0-9]*$/u.test(id.slice(`point:${hash}:`.length));
}
async function automaticCanonical(equivalents: PathNodeV2[], existing: PathNodeV2[], namespace: string): Promise<PathNodeV2 | undefined> {
  const ranked = await Promise.all(equivalents.map(async node => ({ node,
    rank: existing.includes(node) && node.namespace === namespace
      && contentAddressedPoint(node.id, await pointHash(node.kind, node.title, { summary: node.summary, learningDefinition: node.atomic }))
      ? 0 : node.ownership.catalog === "official" ? 1 : 2,
  })));
  return ranked.sort((a, b) => a.rank - b.rank || stableCompare(a.node.namespace, b.node.namespace) || stableCompare(a.node.id, b.node.id))[0]?.node;
}
function availablePointId(hash: string, occupied: Set<string>, automatic: boolean): string | undefined {
  for (const length of automatic ? hashLengths : [24]) {
    const id = `point:${hash.slice(0, length)}`;
    if (!occupied.has(id)) return id;
  }
  if (!automatic) return undefined;
  // Even deliberately occupied full digests must not overwrite another statement.
  // Distinct numeric suffixes guarantee an available ID after finitely many occupied keys.
  for (let suffix = 1; ; suffix++) {
    const id = `point:${hash}:${suffix}`;
    if (!occupied.has(id)) return id;
  }
}

/** The caller must first verify bundle hashes and actor visibility. IDs come only from that bundle. */
export function packageLearningSource(result: ColdStartBuildResult, packageRef: RolePackageRef): RoleAlignmentSource {
  const sources = new Set(result.sources.assets.map(s => s.id));
  const segments = new Map(result.sources.segments.map(s => [s.id, s.sourceId]));
  return {
    packageRef,
    nodes: result.semantic.nodes.flatMap(n => n.type === "knowledge_skill" && (n.learningKind === "knowledge" || n.learningKind === "skill")
      ? [{ id: n.id, kind: n.learningKind }] : []),
    evidenceIds: result.sources.evidenceBindings.filter(b => sources.has(b.sourceId) && segments.get(b.segmentId) === b.sourceId
      && b.supportRole !== "contradicts" && b.assertionType !== "disputed").map(b => b.id),
  };
}

export async function resolveRoleLearningPoints(input: {
  result: ColdStartBuildResult; packageRef: RolePackageRef; graph: LearningPathGraphV2;
  namespace: string; targetIds?: string[];
  allowStandaloneRoots?: boolean;
  groupByCourse?: boolean;
  planCourses?: CoursePlanner;
}): Promise<RoleLearningResolution> {
  const checked = validateLearningPathGraphV2(input.graph);
  if (!checked.valid) throw new Error(`PATH_CONTRACT_INVALID:${JSON.stringify(checked.issues)}`);
  if (!/^learnflow:extension:[a-z0-9][a-z0-9._-]*$/u.test(input.namespace)) throw new Error("PATH_NAMESPACE_INVALID");
  const graph = checked.value, source = packageLearningSource(input.result, input.packageRef);
  const selected = new Set(input.targetIds || []);
  if ([...selected].some(id => !input.result.semantic.nodes.some(n => n.id === id))) throw new Error("ROLE_NODE_NOT_FOUND");
  // Follow the declared role -> task -> capability -> unit -> knowledge chain,
  // never similarity, prerequisite or arbitrary adjacency as a requirement.
  let frontier = [...selected];
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const parents = new Set(frontier); frontier = [];
    for (const edge of input.result.semantic.edges) if (parents.has(edge.source) && edge.lifecycle !== "rejected"
      && ["performs", "requires_capability", "has_unit", "requires_skill", "requires_knowledge"].includes(edge.type) && !selected.has(edge.target)) {
      selected.add(edge.target); frontier.push(edge.target);
    }
  }
  const points = input.result.semantic.nodes.filter(n => n.type === "knowledge_skill" && (!input.targetIds?.length || selected.has(n.id)));
  if (points.length > 160) throw new Error("SELECT_FEWER_ROLE_POINTS");
  const resolution: RoleLearningResolution = {
    protocol: "role-learning-resolution/v2", packageRef: input.packageRef,
    graphRef: { graphId: graph.graphId, revision: graph.revision }, namespace: input.namespace,
    alignment: { protocolVersion: ROLE_LEARNING_ALIGNMENT_V2, packageRef: input.packageRef,
      graphRef: { graphId: graph.graphId, revision: graph.revision }, bindings: [] }, pendingBindings: [], unresolved: [],
  };
  if (!points.length) resolution.unresolved.push(...(input.targetIds || []).map(roleNodeId => ({ roleNodeId, reason: "needs_decomposition" as const, candidates: [] })));
  const newNodes: PathNodeV2[] = [], newEdges: GraphExtensionProposalV2["edges"] = [];
  const standaloneRoots: NonNullable<GraphExtensionProposalV2["standaloneRoots"]> = [];
  const packageSourceId = `role-evidence:${input.packageRef.rootHash}`;
  const evidenceIds = new Set(source.evidenceIds);
  const coursePlannerInput = input.result.semantic.nodes.filter(point => point.type === "knowledge_skill" && (point.learningKind === "knowledge" || point.learningKind === "skill")
    && point.learningDefinition?.scopeNote.trim() && point.learningDefinition.assessmentCriteria.length
    && point.learningDefinition.assessmentCriteria.every(text => text.trim())
    && input.result.sources.evidenceBindings.some(binding => binding.targetId === point.id && point.evidenceBindingIds.includes(binding.id) && evidenceIds.has(binding.id)));
  let coursePlan: Awaited<ReturnType<CoursePlanner>> | undefined;
  if (input.groupByCourse && input.planCourses && coursePlannerInput.length) {
    try {
      coursePlan = await input.planCourses(coursePlannerInput, graph, input.result.brief.roleTitle);
    } catch (error) {
      // Degrade to the deterministic theme grouping below, which is still
      // bounded by MAX_NEW_COURSES_PER_RESOLUTION and never creates per-action
      // atomic nodes. Failing the whole mount during a provider outage made
      // automatic mounting unusable; the degradation is surfaced for audit.
      resolution.coursePlannerDegraded = { reason: (error instanceof Error ? error.message : "course_planner_failed").slice(0, 200) };
    }
  }
  for (const point of points) {
    const anchors = graph.nodes.filter(n => n.kind === "course" || n.kind === "skill_domain")
      .map(n => ({ n, score: Math.max(...[n.title, ...n.aliases].map(name => Math.max(overlap(point.label, name), overlap(input.result.brief.roleTitle, name) * 0.9))) }))
      .filter(row => row.score >= 0.35).sort((a, b) => b.score - a.score || pathNodeKey(a.n).localeCompare(pathNodeKey(b.n)));
    const candidates = anchors.slice(0, 4).map(row => nodeRef(row.n));
    const fail = (reason: RoleLearningResolution["unresolved"][number]["reason"], list = candidates) => resolution.unresolved.push({ roleNodeId: point.id, reason, candidates: list });
    if (point.learningKind !== "knowledge" && point.learningKind !== "skill") { fail("needs_decomposition"); continue; }
    if (!point.learningDefinition?.scopeNote.trim() || !point.learningDefinition.assessmentCriteria.length
      || point.learningDefinition.assessmentCriteria.some(s => !s.trim())) { fail("needs_definition"); continue; }
    const evidence = input.result.sources.evidenceBindings.filter(b => b.targetId === point.id && point.evidenceBindingIds.includes(b.id) && evidenceIds.has(b.id)).map(b => b.id);
    if (!evidence.length) { fail("needs_evidence"); continue; }
    if (input.groupByCourse) {
      const planned = coursePlan?.get(point.id);
      if (coursePlan && !planned) { fail("needs_anchor"); continue; }
      const theme = planned?.theme || courseTheme(point, input.result.brief.roleTitle);
      const matches = [...graph.nodes, ...newNodes].filter(n => n.kind === "course")
        .map(n => ({ n, score: courseMatchScore(theme, point, [n.title, ...n.aliases]) }))
        .filter(row => row.score > 0).sort((a, b) => b.score - a.score
          || Number(b.n.ownership.catalog === "official") - Number(a.n.ownership.catalog === "official")
          || stableCompare(pathNodeKey(a.n), pathNodeKey(b.n)));
      // Equal names from different catalogs are safe organizational targets;
      // competing subject names need disambiguation instead of arbitrary reuse.
      if (!planned && matches[1] && matches[0].score === matches[1].score
        && courseNameKey(matches[0].n.title) !== courseNameKey(matches[1].n.title)) {
        fail("ambiguous_definition", matches.slice(0, 4).map(row => nodeRef(row.n))); continue;
      }
      let course = planned ? planned.existing || newNodes.find(node => courseNameKey(node.title) === courseNameKey(theme.title)) : matches[0]?.n;
      if (!course) {
        if (!input.allowStandaloneRoots) { fail("needs_anchor"); continue; }
        if (newNodes.filter(node => node.kind === "course").length >= MAX_NEW_COURSES_PER_RESOLUTION) { fail("needs_consolidation"); continue; }
        const id = `course:${(await sha256Hex(courseNameKey(theme.title))).slice(0, 40)}`;
        if ([...graph.nodes, ...newNodes].some(n => n.namespace === input.namespace && n.id === id)) {
          fail("ambiguous_definition"); continue;
        }
        course = { id, namespace: input.namespace, revision: 1, kind: "course", title: theme.title, summary: theme.scopeNote,
          aliases: [], domains: ["岗位学习"], audiences: ["self_directed"], stage: "domain", order: 0,
          ownership: { system: "learnflow", catalog: "graph_extension" },
          provenance: { method: "role_package_proposal", sourceRefs: [packageSourceId], packageRef: input.packageRef, evidenceRefs: [...evidence] } };
        newNodes.push(course); standaloneRoots.push({ namespace: course.namespace, id: course.id });
      }
      const pending = newNodes.includes(course);
      if (pending) course.provenance.evidenceRefs = [...new Set([...(course.provenance.evidenceRefs || []), ...evidence])];
      const binding: RoleLearningAlignmentV2["bindings"][number] = {
        id: `alignment:${(await sha256Hex(`${point.id}:${pathNodeKey(course)}`)).slice(0, 24)}`,
        roleNodeId: point.id, roleNodeKind: point.learningKind, target: key(course), relation: "narrower_than",
        requiredLevel: point.learningKind === "skill" ? "apply" : "understand",
        context: `${input.result.brief.roleTitle}：${point.label}。${point.applicability || ""} 范围：${point.learningDefinition.scopeNote.trim()}`,
        rationale: `${planned?.rationale ? planned.rationale + "。" : ""}作为“${course.title}”的岗位应用展开；验收：${point.learningDefinition.assessmentCriteria.join("；")}。课程归属不表示已掌握。`,
        evidenceRefs: evidence,
      };
      (pending ? resolution.pendingBindings : resolution.alignment.bindings).push(binding);
      (resolution.courseTargets ||= []).push({ roleNodeId: point.id, target: key(course), title: course.title, kind: "course" });
      continue;
    }
    const compatible = [...graph.nodes, ...newNodes].filter(n => n.kind === point.learningKind && n.atomic);
    const sameName = compatible.filter(n => [n.title, ...n.aliases].some(name => [point.label, ...point.aliases].some(label => lexical(name) === lexical(label))));
    const equivalents = sameName.filter(n => signature({ summary: n.summary, learningDefinition: n.atomic }) === signature(point));
    if (!input.allowStandaloneRoots && (equivalents.length > 1 || sameName.length && !equivalents.length)) { fail("ambiguous_definition", sameName.slice(0, 4).map(nodeRef)); continue; }
    let canonical = input.allowStandaloneRoots ? await automaticCanonical(equivalents, graph.nodes, input.namespace) : equivalents[0];
    let pending = canonical ? newNodes.includes(canonical) : false;
    if (!canonical) {
      const occupied = new Set([...graph.nodes, ...newNodes].filter(n => n.namespace === input.namespace).map(n => n.id));
      const id = availablePointId(await pointHash(point.learningKind, point.label, point), occupied, Boolean(input.allowStandaloneRoots));
      if (!id) { fail("ambiguous_definition"); continue; }
      const best = anchors[0];
      let parent = best && best.score >= 0.65 && (!anchors[1] || best.score - anchors[1].score >= 0.12) ? best.n : undefined;
      if (!parent && !input.allowStandaloneRoots) { fail("needs_anchor"); continue; }
      if (!parent) {
        const domainId = `role-domain:${(await sha256Hex(input.packageRef.packageId)).slice(0, 24)}`;
        parent = [...graph.nodes, ...newNodes].find(n => n.namespace === input.namespace && n.id === domainId && n.kind === "skill_domain");
        if (!parent) {
          parent = { id: domainId, namespace: input.namespace, revision: 1, kind: "skill_domain", title: `${input.result.brief.roleTitle} · 岗位学习域`,
            summary: `此学习域收纳“${input.result.brief.roleTitle}”有证据与明确验收边界的岗位知识技能；尚未声明其与官方课程的归属或先修关系。`,
            aliases: [], domains: ["岗位学习"], audiences: ["self_directed"], stage: "domain", order: 0,
            ownership: { system: "learnflow", catalog: "graph_extension" },
            provenance: { method: "role_package_proposal", sourceRefs: [packageSourceId], packageRef: input.packageRef, evidenceRefs: evidence } };
          newNodes.push(parent); standaloneRoots.push({ namespace: parent.namespace, id: parent.id });
        }
      }
      const provenance = { method: "role_package_proposal" as const, sourceRefs: [packageSourceId], packageRef: input.packageRef, evidenceRefs: evidence };
      canonical = {
        id, namespace: input.namespace, revision: 1, title: point.label.trim(), summary: point.summary.trim(), aliases: [...new Set(point.aliases.map(s => s.trim()).filter(Boolean))],
        kind: point.learningKind, atomic: { scopeNote: point.learningDefinition.scopeNote.trim(), assessmentCriteria: [...new Set(point.learningDefinition.assessmentCriteria.map(s => s.trim()))] },
        domains: [...parent.domains], audiences: [...parent.audiences], stage: parent.stage, order: parent.order,
        ownership: { system: "learnflow", catalog: "graph_extension" }, provenance,
      };
      newNodes.push(canonical); pending = true;
      newEdges.push({ id: `contains:${input.namespace}:${id}`, from: { namespace: parent.namespace, id: parent.id },
        to: { namespace: input.namespace, id }, kind: "contains", rationale: `岗位知识技能属于“${parent.title}”的具体学习内容；此关系不表示先修或掌握。`, provenance });
    }
    const binding: RoleLearningAlignmentV2["bindings"][number] = {
      id: `alignment:${(await sha256Hex(`${point.id}:${pathNodeKey(canonical)}`)).slice(0, 24)}`, roleNodeId: point.id, roleNodeKind: point.learningKind,
      target: key(canonical), relation: "equivalent", requiredLevel: point.learningKind === "skill" ? "apply" : "understand",
      context: point.applicability?.trim() || input.result.brief.roleTitle,
      rationale: pending ? "将该岗位点的显式定义与考核边界提议为规范节点，入库后才生效。" : "名称或别名、节点类型、范围和考核条件逐项一致；讲解摘要变化不创建重复节点。",
      evidenceRefs: evidence,
    };
    (pending ? resolution.pendingBindings : resolution.alignment.bindings).push(binding);
  }
  if (newNodes.length) {
    const proposal: GraphExtensionProposalV2 = {
      protocolVersion: GRAPH_EXTENSION_PROPOSAL_V2, idempotencyKey: `extend:${(await sha256Hex(canonicalStringify({ package: input.packageRef, graph: resolution.graphRef, namespace: input.namespace, nodes: newNodes.map(n => n.id) }))).slice(0, 40)}`,
      baseGraphRef: resolution.graphRef, packageRef: input.packageRef, namespace: input.namespace,
      sources: graph.sources.some(s => s.id === packageSourceId) ? [] : [{ id: packageSourceId, title: `${input.result.brief.roleTitle}岗位包证据索引`, kind: "package_evidence", packageRef: input.packageRef, evidenceRefs: source.evidenceIds }],
      nodes: newNodes, edges: newEdges,
      ...(standaloneRoots.length ? { standaloneRoots } : {}),
    };
    const valid = validateGraphExtensionProposalV2(proposal, graph, source);
    if (!valid.valid) throw new Error(`PATH_PROPOSAL_INVALID:${JSON.stringify(valid.issues)}`);
    resolution.extensionProposal = valid.value;
  }
  const valid = validateRoleLearningAlignmentV2(resolution.alignment, graph, source);
  if (!valid.valid) throw new Error(`PATH_ALIGNMENT_INVALID:${JSON.stringify(valid.issues)}`);
  const merged = resolution.extensionProposal ? { ...graph, nodes: [...graph.nodes, ...newNodes], edges: [...graph.edges, ...newEdges], sources: [...graph.sources, ...resolution.extensionProposal.sources] } : graph;
  const pending = validateRoleLearningAlignmentV2({ ...resolution.alignment, bindings: [...resolution.alignment.bindings, ...resolution.pendingBindings] }, merged, source);
  if (!pending.valid) throw new Error(`PATH_PENDING_ALIGNMENT_INVALID:${JSON.stringify(pending.issues)}`);
  return resolution;
}
