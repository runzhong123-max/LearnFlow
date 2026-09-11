import { z } from "zod";
import type { ColdStartBuildResult, SemanticNode } from "@/lib/build/types";
import { normalizeConcept } from "@/lib/build/workflow";
import { courseNameKey } from "@/lib/learning-path/course-organization";

/**
 * Incremental addition to an existing snapshot.
 *
 * Today the only way to add a node is a full rebuild, because
 * `GraphPatchOperation` has no add variant and `applyGraphPatch` only ever
 * filters and maps. A rebuild is a large, baseline-shifting operation for what
 * is often a one-node change; this module defines the delta that a later
 * compiler-backed splice will consume.
 *
 * What this module decides is deliberately narrow and fully deterministic: it
 * **validates** a proposed delta and reports why each piece was rejected. It
 * does not compile, splice, or write anything. Compilation stays with the
 * compiler, because a raw inserted node cannot satisfy the evidence and section
 * invariants that the audit enforces (`UNSUPPORTED_TARGET`,
 * `MISSING_SNAPSHOT_SECTION`) — which is exactly why additions must go through
 * the compiler rather than into an array.
 *
 * Four gates run in order, and every rejection is reported with its reason.
 * Nothing is dropped silently.
 */

export const augmentationNodeSchema = z.object({
  type: z.enum(["knowledge_skill", "capability", "capability_unit", "task", "market_role"]),
  label: z.string().trim().min(2).max(120),
  summary: z.string().trim().min(1).max(1_000),
  aliases: z.array(z.string().trim().min(1).max(120)).max(8).default([]),
  /** Segment ids from the base snapshot. Code checks they exist. */
  evidenceSegmentIds: z.array(z.string().min(1).max(160)).max(12).default([]),
  learningKind: z.enum(["knowledge", "skill", "hybrid"]).optional(),
  learningDefinition: z.object({
    scopeNote: z.string().trim().min(1).max(500),
    assessmentCriteria: z.array(z.string().trim().min(1).max(400)).min(1).max(12),
  }).optional(),
  confidence: z.number().min(0).max(1).default(0.6),
});
export type AugmentationNode = z.infer<typeof augmentationNodeSchema>;

export const augmentationEdgeSchema = z.object({
  from: z.string().min(1).max(220),
  to: z.string().min(1).max(220),
  type: z.enum(["requires_skill", "requires_capability", "requires_knowledge", "has_unit", "performs", "contains"]),
  evidenceSegmentIds: z.array(z.string().min(1).max(160)).max(12).default([]),
  confidence: z.number().min(0).max(1).default(0.6),
});
export type AugmentationEdge = z.infer<typeof augmentationEdgeSchema>;

export const augmentationProposalSchema = z.object({
  baseSnapshotId: z.string().min(1).max(220),
  motivation: z.string().trim().min(1).max(1_000),
  /** Temporary ids local to this proposal; they are not stable node ids. */
  nodes: z.array(augmentationNodeSchema.extend({ tempId: z.string().min(1).max(120) })).max(40).default([]),
  edges: z.array(augmentationEdgeSchema).max(80).default([]),
  /** Existing base node ids that the new edges may attach to. */
  attachedTo: z.array(z.string().min(1).max(220)).max(40).default([]),
});
export type AugmentationProposal = z.infer<typeof augmentationProposalSchema>;

export type AugmentationRejection = {
  scope: "node" | "edge" | "proposal";
  ref: string;
  gate: "schema" | "granularity" | "evidence" | "structure";
  reason: string;
};

export type AugmentationReport = {
  /** Proposal-local temp ids are retained so a splice can map them to compiled ids. */
  acceptedNodes: Array<AugmentationNode & { tempId: string }>;
  acceptedEdges: AugmentationEdge[];
  rejections: AugmentationRejection[];
  /** True only when every proposed piece survived all four gates. */
  complete: boolean;
};

/** Learning points must carry an assessable definition; coarse layers must not. */
function definitionIssue(node: AugmentationNode) {
  const atomic = node.type === "knowledge_skill";
  if (!atomic) {
    return node.learningKind || node.learningDefinition
      ? "只有 knowledge_skill 才能携带学习定义；粗粒度节点不得冒充原子点"
      : "";
  }
  if (!node.learningKind) return "knowledge_skill 必须声明 learningKind";
  if (node.learningKind === "hybrid") return "混合类型需先判定为 knowledge 或 skill，不能原样入库";
  if (!node.learningDefinition) return "knowledge_skill 必须提供 learningDefinition";
  if (!node.learningDefinition.assessmentCriteria.length) return "assessmentCriteria 不能为空";
  return "";
}

/**
 * A knowledge point may not be a course title in disguise.
 *
 * The signal is deliberately narrow: the label must not collide with a course
 * title the base already uses for organisation. `isCourseTitle()` is NOT used
 * here — it is a heuristic for "legacy operational statement with no course
 * hint", and it returns true for perfectly good atoms such as 「等价类划分原则」,
 * so reusing it would reject the very points this gate exists to admit.
 *
 * Detecting "too fine" granularity is not deterministically decidable; that
 * judgement stays with the proposal side and with the required
 * `assessmentCriteria`, not with a regex here.
 */
function granularityIssue(node: AugmentationNode, base: ColdStartBuildResult) {
  if (node.type !== "knowledge_skill") return "";
  const label = courseNameKey(node.label);
  const courseTitles = new Set(base.semantic.nodes
    .map(item => item.learningCourse?.title)
    .filter((title): title is string => Boolean(title))
    .map(courseNameKey));
  if (!courseTitles.has(label)) return "";
  return `“${node.label}”是基线中已有的课程名，不能当作原子知识点入库；请改为具体概念名或技能点`;
}

function detectCycle(edges: AugmentationEdge[]) {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) || []), edge.to]);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const walk = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (done.has(node)) return false;
    visiting.add(node);
    for (const next of adjacency.get(node) || []) if (walk(next)) return true;
    visiting.delete(node);
    done.add(node);
    return false;
  };
  return [...adjacency.keys()].some(walk);
}

/**
 * Validate a proposed delta against a base snapshot.
 *
 * Gates run in order so a later gate never has to reason about input an earlier
 * one already rejected: schema → granularity → evidence → structure.
 */
export function validateAugmentation(input: {
  base: ColdStartBuildResult;
  proposal: AugmentationProposal;
}): AugmentationReport {
  const rejections: AugmentationRejection[] = [];
  const base = input.base;

  // Gate 0: the proposal must target the snapshot it was built against. A delta
  // against the wrong base would attach evidence to nodes that do not exist.
  if (input.proposal.baseSnapshotId !== base.snapshot.id) {
    return {
      acceptedNodes: [],
      acceptedEdges: [],
      rejections: [{
        scope: "proposal",
        ref: input.proposal.baseSnapshotId,
        gate: "structure",
        reason: `提案基线 ${input.proposal.baseSnapshotId} 与当前快照 ${base.snapshot.id} 不一致，必须基于当前基线重新生成`,
      }],
      complete: false,
    };
  }

  const segmentIds = new Set(base.sources.segments.map(segment => segment.id));
  const existingIds = new Set(base.semantic.nodes.map(node => node.id));
  const existingLabels = new Map(base.semantic.nodes.map(node => [normalizeConcept(node.label), node.id]));

  // Gate 1 + 2: schema/definition then granularity.
  const schemaAccepted: Array<AugmentationNode & { tempId: string }> = [];
  for (const node of input.proposal.nodes) {
    const definition = definitionIssue(node);
    if (definition) {
      rejections.push({ scope: "node", ref: node.tempId, gate: "schema", reason: definition });
      continue;
    }
    const granularity = granularityIssue(node, base);
    if (granularity) {
      rejections.push({ scope: "node", ref: node.tempId, gate: "granularity", reason: granularity });
      continue;
    }
    schemaAccepted.push(node);
  }

  // Gate 3: evidence must resolve to segments that actually exist in the base.
  const evidenceAccepted: Array<AugmentationNode & { tempId: string }> = [];
  for (const node of schemaAccepted) {
    const missing = node.evidenceSegmentIds.filter(id => !segmentIds.has(id));
    if (!node.evidenceSegmentIds.length) {
      rejections.push({ scope: "node", ref: node.tempId, gate: "evidence", reason: "新增节点必须至少引用一条基线原文片段" });
      continue;
    }
    if (missing.length) {
      rejections.push({ scope: "node", ref: node.tempId, gate: "evidence", reason: `引用了基线中不存在的片段：${missing.join("、")}` });
      continue;
    }
    evidenceAccepted.push(node);
  }

  // Gate 4: duplicate labels and unresolvable edge endpoints are structural.
  const acceptedNodes: Array<AugmentationNode & { tempId: string }> = [];
  const acceptedTempIds = new Set<string>();
  const labelOwner = new Map(existingLabels);
  for (const node of evidenceAccepted) {
    const concept = normalizeConcept(node.label);
    const duplicateOf = labelOwner.get(concept);
    if (duplicateOf) {
      rejections.push({ scope: "node", ref: node.tempId, gate: "structure", reason: `与已存在节点语义重复（${node.label} ↔ ${duplicateOf}），应改为补充证据而非新增` });
      continue;
    }
    labelOwner.set(concept, node.tempId);
    acceptedTempIds.add(node.tempId);
    acceptedNodes.push(node);
  }

  const attachment = new Set([...existingIds, ...input.proposal.attachedTo]);
  const acceptedEdges: AugmentationEdge[] = [];
  for (const edge of input.proposal.edges) {
    const resolves = (ref: string) => acceptedTempIds.has(ref) || attachment.has(ref);
    if (!resolves(edge.from) || !resolves(edge.to)) {
      const missing = [!resolves(edge.from) ? edge.from : "", !resolves(edge.to) ? edge.to : ""].filter(Boolean);
      rejections.push({ scope: "edge", ref: `${edge.from}→${edge.to}`, gate: "structure", reason: `端点无法解析到基线节点或本批新增节点：${missing.join("、")}` });
      continue;
    }
    const missingSegments = edge.evidenceSegmentIds.filter(id => !segmentIds.has(id));
    if (missingSegments.length) {
      rejections.push({ scope: "edge", ref: `${edge.from}→${edge.to}`, gate: "evidence", reason: `引用了基线中不存在的片段：${missingSegments.join("、")}` });
      continue;
    }
    acceptedEdges.push(edge);
  }

  // Only cycles introduced by this batch matter: the base graph is already
  // validated as acyclic, so a cycle must involve at least one new edge.
  if (acceptedEdges.length && detectCycle(acceptedEdges)) {
    return {
      acceptedNodes,
      acceptedEdges: [],
      rejections: [...rejections, { scope: "proposal", ref: input.proposal.motivation.slice(0, 60), gate: "structure", reason: "本批新增关系自身成环，整批关系被拒绝" }],
      complete: false,
    };
  }

  return {
    acceptedNodes,
    acceptedEdges,
    rejections,
    complete: rejections.length === 0,
  };
}

/** Existing node ids a delta may legally attach to, for proposal-time hints. */
export function augmentationAttachmentCandidates(base: ColdStartBuildResult, limit = 40) {
  return base.semantic.nodes.filter(node => node.lifecycle !== "rejected").slice(0, limit).map(node => node.id);
}

export function augmentationEvidenceCandidates(base: ColdStartBuildResult, limit = 40) {
  return base.sources.segments.slice(0, limit).map(segment => ({ segmentId: segment.id, excerpt: segment.text.slice(0, 160) }));
}

export type { SemanticNode };
