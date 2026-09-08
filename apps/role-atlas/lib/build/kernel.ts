import type { SemanticDraft } from "./model";
import { stableHash } from "./compiler";
import type {
  ColdStartBuildResult,
  ConceptMention,
  ProcessCapsule,
  SemanticNode,
} from "./types";

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(value: string) {
  const text = normalize(value);
  if (text.length < 2) return text ? [text] : [];
  return Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2));
}

function similarity(left: string, right: string) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.length || !b.length) return 0;
  const remaining = [...b];
  let shared = 0;
  for (const item of a) {
    const index = remaining.indexOf(item);
    if (index < 0) continue;
    shared += 1;
    remaining.splice(index, 1);
  }
  return 2 * shared / (a.length + b.length);
}

const projectionAnchorStopWords = new Set([
  "api", "app", "devops", "platform", "system", "service", "tool", "using",
]);

function projectionAnchors(value: string) {
  return new Set(
    value.normalize("NFKC").toLocaleLowerCase()
      .match(/[a-z][a-z0-9+#./-]{2,}/g)
      ?.map((token) => token.replace(/[./-]+/g, ""))
      .filter((token) => token.length >= 3 && !projectionAnchorStopWords.has(token)) || [],
  );
}

/**
 * The overview projection treats two learning nodes built around the same
 * named technology as one visual cluster. The fact layer is not merged: the
 * more specific candidate remains addressable below its representative.
 */
function projectionSimilarity(left: string, right: string) {
  const lexical = similarity(left, right);
  const leftAnchors = projectionAnchors(left);
  const rightAnchors = projectionAnchors(right);
  const sharedAnchors = [...leftAnchors].filter((anchor) => rightAnchors.has(anchor));
  const anchorAffinity = sharedAnchors.length >= 2 ? 0.94 : sharedAnchors.length === 1 ? 0.82 : 0;
  return Math.max(lexical, anchorAffinity);
}

type TaskNode = SemanticDraft["nodes"][number];

export type KernelTaskProjection = {
  visibleTempIds: Set<string>;
  parentByTempId: Map<string, string>;
  facetsByTempId: Map<string, TaskNode[]>;
};

/**
 * Farthest-first representative selection keeps the first view diverse while
 * every residual task remains in the immutable semantic layer as a facet.
 */
export function buildKernelTaskProjection(draft: SemanticDraft, maxVisible = 8): KernelTaskProjection {
  const tasks = draft.nodes.filter((node) => node.type === "task");
  const target = Math.min(maxVisible, tasks.length, Math.max(Math.min(5, tasks.length), Math.ceil(tasks.length * 0.65)));
  const ranked = [...tasks].sort((left, right) =>
    right.confidence - left.confidence
    || right.evidenceSegmentIds.length - left.evidenceSegmentIds.length
    || left.label.localeCompare(right.label, "zh-CN"));
  const selected: TaskNode[] = ranked.length ? [ranked[0]] : [];
  while (selected.length < target) {
    const candidates = ranked.filter((task) => !selected.includes(task));
    const next = candidates.sort((left, right) => {
      const leftDistance = 1 - Math.max(...selected.map((item) => projectionSimilarity(`${left.label}${left.summary}`, `${item.label}${item.summary}`)));
      const rightDistance = 1 - Math.max(...selected.map((item) => projectionSimilarity(`${right.label}${right.summary}`, `${item.label}${item.summary}`)));
      return rightDistance - leftDistance || right.confidence - left.confidence;
    })[0];
    if (!next) break;
    selected.push(next);
  }
  const visibleTempIds = new Set(selected.map((task) => task.tempId));
  const parentByTempId = new Map<string, string>();
  const facetsByTempId = new Map<string, TaskNode[]>();
  for (const task of tasks) {
    if (visibleTempIds.has(task.tempId)) {
      parentByTempId.set(task.tempId, task.tempId);
      continue;
    }
    const parent = [...selected].sort((left, right) =>
      projectionSimilarity(`${task.label}${task.summary}`, `${right.label}${right.summary}`)
      - projectionSimilarity(`${task.label}${task.summary}`, `${left.label}${left.summary}`))[0];
    if (!parent) continue;
    parentByTempId.set(task.tempId, parent.tempId);
    facetsByTempId.set(parent.tempId, [...(facetsByTempId.get(parent.tempId) || []), task]);
  }
  return { visibleTempIds, parentByTempId, facetsByTempId };
}

export function visibleKernelTaskDraft(draft: SemanticDraft, projection: KernelTaskProjection): SemanticDraft["nodes"] {
  return draft.nodes.filter((node) => node.type === "task" && projection.visibleTempIds.has(node.tempId));
}

export function annotateKernelNodes(input: {
  nodes: SemanticNode[];
  tempToId: Map<string, string>;
  projection: KernelTaskProjection;
}) {
  const idToTemp = new Map([...input.tempToId.entries()].map(([tempId, id]) => [id, tempId]));
  return input.nodes.map((node): SemanticNode => {
    const tempId = idToTemp.get(node.id);
    if (node.type === "market_role") return { ...node, granularity: "kernel", defaultVisibility: true };
    if (node.type === "task" && tempId) {
      const parentTempId = input.projection.parentByTempId.get(tempId) || tempId;
      const parentId = input.tempToId.get(parentTempId);
      const visible = input.projection.visibleTempIds.has(tempId);
      return {
        ...node,
        granularity: visible ? "kernel" : "detail",
        defaultVisibility: visible,
        parentKernelId: visible ? undefined : parentId,
        facets: visible ? (input.projection.facetsByTempId.get(tempId) || []).map((facet) => ({
          label: facet.label,
          nodeId: input.tempToId.get(facet.tempId),
          summary: facet.summary,
        })) : undefined,
        expansion: {
          status: "queued",
          kinds: ["task_process", "evidence_deepening"],
          handle: `expand:${node.id}`,
        },
      };
    }
    if (node.type === "capability_unit") {
      return { ...node, granularity: "detail", defaultVisibility: false };
    }
    if (node.type === "knowledge_skill") {
      return {
        ...node,
        granularity: "kernel",
        defaultVisibility: true,
        expansion: {
          status: "queued",
          kinds: ["skill_dependencies", "prerequisite_graph", "evidence_deepening"],
          handle: `expand:${node.id}`,
        },
      };
    }
    return { ...node, granularity: "kernel", defaultVisibility: true };
  });
}

function extractSummaryField(summary: string, label: string) {
  const match = summary.match(new RegExp(`${label}：([^；）]+)`, "u"));
  return match?.[1]?.trim();
}

export function createProcessCapsules(nodes: SemanticNode[], mentions: ConceptMention[]): ProcessCapsule[] {
  return nodes.filter((node) => node.type === "task" && node.defaultVisibility !== false).map((task) => {
    const segmentIds = new Set(task.evidenceSegmentIds);
    const events = mentions.filter((mention) => mention.kind === "work_event" && segmentIds.has(mention.sourceSegmentId));
    const decisionsAndRisks = mentions.filter((mention) => (mention.kind === "decision" || mention.kind === "risk") && segmentIds.has(mention.sourceSegmentId));
    return {
      id: `capsule:${stableHash(task.id)}`,
      taskId: task.id,
      actionPattern: task.label,
      trigger: extractSummaryField(task.summary, "对象"),
      deliverable: extractSummaryField(task.summary, "交付"),
      decisionOrRisk: decisionsAndRisks.slice(0, 3).map((mention) => mention.surfaceForm).join("、") || undefined,
      evidenceSegmentIds: task.evidenceSegmentIds,
      eventMentionIds: events.slice(0, 8).map((mention) => mention.id),
      expansionStatus: "queued",
      scenarioIds: [],
    };
  });
}

export function semanticDraftFromKernel(result: ColdStartBuildResult): SemanticDraft {
  const role = result.semantic.nodes.find((node) => node.type === "market_role");
  const nodes: SemanticDraft["nodes"] = result.semantic.nodes.filter((node) => node.type !== "market_role").map((node) => ({
    tempId: node.id,
    type: node.type,
    label: node.label,
    summary: node.summary,
    aliases: node.aliases,
    evidenceSegmentIds: node.evidenceSegmentIds,
    evidenceSpans: result.sources.evidenceBindings.filter(binding => node.evidenceBindingIds.includes(binding.id))
      .flatMap(binding => binding.evidenceSpan ? [binding.evidenceSpan] : []),
    learningKind: node.learningKind,
    learningDefinition: node.learningDefinition,
    mentionIds: result.sources.mentions?.filter((mention) => node.evidenceSegmentIds.includes(mention.sourceSegmentId)).map((mention) => mention.id).slice(0, 40) || [],
    confidence: node.confidence,
  }));
  const nodeIds = new Set(nodes.map((node) => node.tempId));
  const edges: SemanticDraft["edges"] = result.semantic.edges.flatMap((edge) => {
    const source = edge.source === role?.id ? null : edge.source;
    const target = edge.target === role?.id ? null : edge.target;
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) return [];
    return [{
      type: edge.type,
      sourceTempId: source,
      targetTempId: target,
      evidenceSegmentIds: edge.evidenceSegmentIds,
      evidenceSpans: edge.evidenceSpans || [],
      propositionIds: edge.propositionIds || [],
      confidence: edge.confidence,
    }];
  });
  return { roleSummary: role?.summary || "", nodes, edges };
}

export function carryKernelPresentation(nodes: SemanticNode[], base: ColdStartBuildResult, stage: "semantic" | "full") {
  const previous = new Map(base.semantic.nodes.map((node) => [node.id, node]));
  const newSkills = nodes.filter((node) => node.type === "knowledge_skill" && !previous.has(node.id));
  const newCapabilities = nodes.filter((node) => node.type === "capability" && !previous.has(node.id));
  const representativeIds = (candidates: SemanticNode[], maximum: number, minimum: number, ratio: number) => {
    const target = Math.min(maximum, candidates.length, Math.max(Math.min(minimum, candidates.length), Math.ceil(candidates.length * ratio)));
    const ranked = [...candidates].sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label, "zh-CN"));
    const selected: SemanticNode[] = ranked.length ? [ranked[0]] : [];
    while (selected.length < target) {
      const next = ranked
        .filter((candidate) => !selected.includes(candidate))
        .filter((candidate) => selected.every((item) => projectionSimilarity(`${candidate.label}${candidate.summary}`, `${item.label}${item.summary}`) < 0.78))
        .sort((left, right) => {
          const leftDistance = 1 - Math.max(...selected.map((item) => projectionSimilarity(`${left.label}${left.summary}`, `${item.label}${item.summary}`)));
          const rightDistance = 1 - Math.max(...selected.map((item) => projectionSimilarity(`${right.label}${right.summary}`, `${item.label}${item.summary}`)));
          return rightDistance - leftDistance || right.confidence - left.confidence;
        })[0];
      if (!next) break;
      selected.push(next);
    }
    return new Set(selected.map((node) => node.id));
  };
  // Five skill entry points are usually enough for a first radar view. The
  // remaining information is preserved as facets and can grow on demand.
  const visibleNewSkills = representativeIds(newSkills, 5, 4, 0.4);
  const visibleNewCapabilities = representativeIds(newCapabilities, 3, 2, 0.35);
  const carried = nodes.map((node): SemanticNode => {
    const before = previous.get(node.id);
    if (before) {
      const available = stage === "full" || node.type === "knowledge_skill" && stage === "semantic";
      return {
        ...node,
        granularity: before.granularity,
        defaultVisibility: before.defaultVisibility,
        parentKernelId: before.parentKernelId,
        facets: before.facets,
        expansion: before.expansion ? { ...before.expansion, status: available ? "available" : "running" } : undefined,
      };
    }
    const promoted = node.type === "knowledge_skill" && visibleNewSkills.has(node.id)
      || node.type === "capability" && visibleNewCapabilities.has(node.id);
    return {
      ...node,
      granularity: promoted ? "kernel" : "detail",
      defaultVisibility: promoted,
      expansion: node.type === "knowledge_skill" ? {
        status: "available",
        kinds: ["skill_dependencies", "prerequisite_graph", "evidence_deepening"],
        handle: `expand:${node.id}`,
      } : undefined,
    };
  });
  const kernelSkills = carried.filter((node) => node.type === "knowledge_skill" && node.defaultVisibility !== false);
  const detailByParent = new Map<string, SemanticNode[]>();
  for (const node of carried) {
    if (node.type !== "knowledge_skill" || previous.has(node.id) || node.defaultVisibility !== false) continue;
    const best = kernelSkills.map((candidate) => ({
      candidate,
      score: projectionSimilarity(`${node.label}${node.summary}`, `${candidate.label}${candidate.summary}`),
    })).sort((left, right) => right.score - left.score)[0];
    if (!best) continue;
    node.parentKernelId = best.candidate.id;
    detailByParent.set(best.candidate.id, [...(detailByParent.get(best.candidate.id) || []), node]);
  }
  return carried.map((node) => {
    const details = detailByParent.get(node.id);
    if (!details?.length) return node;
    const facets = new Map((node.facets || []).map((facet) => [facet.nodeId || facet.label, facet]));
    for (const detail of details) facets.set(detail.id, { nodeId: detail.id, label: detail.label, summary: detail.summary });
    return { ...node, facets: [...facets.values()] };
  });
}

export function completeProcessCapsules(capsules: ProcessCapsule[], result: ColdStartBuildResult): ProcessCapsule[] {
  return capsules.map((capsule) => {
    const processNodeIds = result.process.bridges.filter((bridge) => bridge.type === "realizes_task" && bridge.semanticNodeId === capsule.taskId).map((bridge) => bridge.processNodeId);
    const scenarioIds = [...new Set(processNodeIds.flatMap((id) => result.process.nodes.find((node) => node.id === id)?.scenarioId || []))];
    return {
      ...capsule,
      expansionStatus: scenarioIds.length ? "complete" : "degraded",
      scenarioIds,
    };
  });
}
