import { stableHash } from "@/lib/build/compiler";
import type { ColdStartBuildResult, SemanticNode } from "@/lib/build/types";
import type { GraphPatch, GraphPatchOperation, RiskAuditReport, SemanticDiff } from "./types";
import { sameSemanticMergeDimension } from "./audit";

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function cloneResult(result: ColdStartBuildResult) {
  return structuredClone(result);
}

function evidenceWeight(node: SemanticNode) {
  return node.evidenceBindingIds.length * 4
    + node.evidenceSegmentIds.length * 2
    + (node.lifecycle === "stable" ? 3 : 0)
    + node.confidence;
}

/** Only deterministic, reference-preserving repairs are proposed automatically. */
export function proposeSafePatch(input: {
  result: ColdStartBuildResult;
  audit: RiskAuditReport;
  iteration: number;
}): GraphPatch {
  const operations: GraphPatchOperation[] = [];
  const semanticEdges = new Set(input.result.semantic.edges.map((edge) => edge.id));
  const processEdges = new Set(input.result.process.edges.map((edge) => edge.id));
  const semanticNodes = new Map(input.result.semantic.nodes.map((node) => [node.id, node]));
  const sourceIds = new Set(input.result.sources.assets.map((source) => source.id));
  for (const issue of input.audit.issues.filter((item) => item.repairability === "automatic")) {
    if (issue.code === "DANGLING_SEMANTIC_EDGE") {
      const edgeId = issue.targetIds.find((id) => semanticEdges.has(id));
      if (edgeId && !operations.some((operation) => operation.op === "remove_semantic_edge" && operation.edgeId === edgeId)) {
        operations.push({ op: "remove_semantic_edge", edgeId, reason: issue.detail, issueIds: [issue.id] });
      }
    }
    if (issue.code === "DANGLING_PROCESS_EDGE") {
      const edgeId = issue.targetIds.find((id) => processEdges.has(id));
      if (edgeId && !operations.some((operation) => operation.op === "remove_process_edge" && operation.edgeId === edgeId)) {
        operations.push({ op: "remove_process_edge", edgeId, reason: issue.detail, issueIds: [issue.id] });
      }
    }
    if (issue.code === "FUTURE_SOURCE") {
      const sourceId = issue.sourceIds.find((id) => sourceIds.has(id));
      const affectedTargetIds = sourceId
        ? unique(input.result.sources.evidenceBindings.filter((binding) => binding.sourceId === sourceId).map((binding) => binding.targetId))
        : [];
      const everyTargetHasAlternative = affectedTargetIds.every((targetId) => input.result.sources.evidenceBindings.some(
        (binding) => binding.targetId === targetId && binding.sourceId !== sourceId,
      ));
      if (sourceId && everyTargetHasAlternative && !operations.some((operation) => operation.op === "remove_source" && operation.sourceId === sourceId)) {
        operations.push({ op: "remove_source", sourceId, reason: issue.detail, issueIds: [issue.id] });
      }
    }
    if (issue.code === "EXACT_DUPLICATE") {
      const nodes = issue.targetIds.map((id) => semanticNodes.get(id)).filter(Boolean) as SemanticNode[];
      if (nodes.length < 2 || nodes.some((node) => !sameSemanticMergeDimension(nodes[0], node))) continue;
      const sorted = [...nodes].sort((left, right) => evidenceWeight(right) - evidenceWeight(left) || left.id.localeCompare(right.id));
      const canonical = sorted[0];
      const mergedIds = sorted.slice(1).map((node) => node.id).filter((id) => id !== canonical.id);
      if (!mergedIds.length || operations.some((operation) => operation.op === "merge_semantic_nodes" && operation.mergedIds.some((id) => mergedIds.includes(id)))) continue;
      operations.push({
        op: "merge_semantic_nodes",
        canonicalId: canonical.id,
        mergedIds,
        reason: `同类型、同语义节点确定性合并；保留证据和连接更完整的 ${canonical.label}`,
        issueIds: [issue.id],
      });
    }
  }
  const issueIds = unique(operations.flatMap((operation) => operation.issueIds));
  const targetIds = unique(operations.flatMap((operation) => {
    if (operation.op === "merge_semantic_nodes") return [operation.canonicalId, ...operation.mergedIds];
    if (operation.op === "update_semantic_node") return [operation.nodeId];
    if (operation.op === "remove_source") return [operation.sourceId];
    return [operation.edgeId];
  }));
  return {
    id: `risk-patch:${stableHash(`${input.result.snapshot.id}:${input.iteration}:${JSON.stringify(operations)}`)}`,
    baseSnapshotId: input.result.snapshot.id,
    status: "proposed",
    iteration: input.iteration,
    operations,
    targetIds,
    issueIds,
    summary: operations.length
      ? `提出 ${operations.length} 个可逆的确定性图谱修复操作。`
      : "本轮没有可安全自动执行的结构修复；其余问题保留为研究或人工判断。",
    createdAt: new Date().toISOString(),
  };
}

function redirect(id: string, migrations: Map<string, string>) {
  let current = id;
  const visited = new Set<string>();
  while (migrations.has(current) && !visited.has(current)) {
    visited.add(current);
    current = migrations.get(current)!;
  }
  return current;
}

function dedupeById<T extends { id: string }>(values: T[]) {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

export function applyGraphPatch(result: ColdStartBuildResult, patch: GraphPatch) {
  // Validate before building migrations: skipping an invalid merge later would
  // still delete its source node and redirect references through that map.
  const originalNodes = new Map(result.semantic.nodes.map((node) => [node.id, node]));
  for (const operation of patch.operations) {
    if (operation.op !== "merge_semantic_nodes") continue;
    const target = originalNodes.get(operation.canonicalId);
    if (!target) throw new Error("SEMANTIC_MERGE_TARGET_NOT_FOUND");
    for (const id of operation.mergedIds) {
      const source = originalNodes.get(id);
      if (!source) throw new Error("SEMANTIC_MERGE_SOURCE_NOT_FOUND");
      if (!sameSemanticMergeDimension(source, target)) throw new Error("SEMANTIC_MERGE_DIMENSION_MISMATCH");
    }
  }
  const candidate = cloneResult(result);
  const migrations = new Map<string, string>();
  const referenceMigrations = new Map<string, string>();
  const removeSemanticEdges = new Set<string>();
  const removeProcessEdges = new Set<string>();
  const removeSources = new Set<string>();
  const updates = new Map<string, Record<string, unknown>>();
  for (const operation of patch.operations) {
    if (operation.op === "remove_semantic_edge") removeSemanticEdges.add(operation.edgeId);
    if (operation.op === "remove_process_edge") removeProcessEdges.add(operation.edgeId);
    if (operation.op === "remove_source") removeSources.add(operation.sourceId);
    if (operation.op === "merge_semantic_nodes") operation.mergedIds.forEach((id) => {
      migrations.set(id, operation.canonicalId);
      referenceMigrations.set(id, operation.canonicalId);
    });
    if (operation.op === "update_semantic_node") updates.set(operation.nodeId, operation.changes);
  }
  const nodeMap = new Map(candidate.semantic.nodes.map((node) => [node.id, node]));
  for (const [from, to] of migrations) {
    const source = nodeMap.get(from);
    const target = nodeMap.get(to);
    if (!source || !target || !sameSemanticMergeDimension(source, target)) throw new Error("SEMANTIC_MERGE_DIMENSION_MISMATCH");
    target.aliases = unique([...target.aliases, source.label, ...source.aliases]).filter((alias) => alias !== target.label);
    target.summary = target.summary.length >= source.summary.length ? target.summary : source.summary;
    target.evidenceSegmentIds = unique([...target.evidenceSegmentIds, ...source.evidenceSegmentIds]);
    target.evidenceBindingIds = unique([...target.evidenceBindingIds, ...source.evidenceBindingIds]);
    target.confidence = Math.max(target.confidence, source.confidence);
    if (source.lifecycle === "stable") target.lifecycle = "stable";
  }
  candidate.semantic.nodes = candidate.semantic.nodes
    .filter((node) => !migrations.has(node.id))
    .map((node) => updates.has(node.id) ? { ...node, ...updates.get(node.id) } as SemanticNode : node);
  const removedSegmentIds = new Set(candidate.sources.segments.filter((segment) => removeSources.has(segment.sourceId)).map((segment) => segment.id));
  const removedBindingIds = new Set(candidate.sources.evidenceBindings.filter((binding) => removeSources.has(binding.sourceId)).map((binding) => binding.id));
  candidate.sources.assets = candidate.sources.assets.filter((source) => !removeSources.has(source.id));
  candidate.sources.segments = candidate.sources.segments.filter((segment) => !removeSources.has(segment.sourceId));
  candidate.sources.evidenceBindings = candidate.sources.evidenceBindings.filter((binding) => !removeSources.has(binding.sourceId));
  const evidenceRefs = <T extends { evidenceSegmentIds: string[]; evidenceBindingIds: string[] }>(value: T): T => ({
    ...value,
    evidenceSegmentIds: value.evidenceSegmentIds.filter((id) => !removedSegmentIds.has(id)),
    evidenceBindingIds: value.evidenceBindingIds.filter((id) => !removedBindingIds.has(id)),
  });
  candidate.semantic.nodes = candidate.semantic.nodes.map(evidenceRefs);
  candidate.semantic.edges = dedupeById(candidate.semantic.edges
    .filter((edge) => !removeSemanticEdges.has(edge.id))
    .map((edge) => {
      const source = redirect(edge.source, migrations);
      const target = redirect(edge.target, migrations);
      if (source === edge.source && target === edge.target) return evidenceRefs({ ...edge, source, target });
      const id = `edge:${stableHash(`${edge.type}:${source}:${target}`)}`;
      referenceMigrations.set(edge.id, id);
      return evidenceRefs({ ...edge, source, target, id });
    })
    .filter((edge) => edge.source !== edge.target));
  candidate.semantic.claims = dedupeById(candidate.semantic.claims.map((claim) => evidenceRefs({
    ...claim,
    subjectId: redirect(claim.subjectId, migrations),
    objectId: claim.objectId ? redirect(claim.objectId, migrations) : undefined,
  })));
  candidate.process.scenarios = candidate.process.scenarios.map(evidenceRefs);
  candidate.process.nodes = candidate.process.nodes.map(evidenceRefs);
  candidate.process.edges = candidate.process.edges.filter((edge) => !removeProcessEdges.has(edge.id)).map(evidenceRefs);
  candidate.process.bridges = dedupeById(candidate.process.bridges.map((bridge) => ({
    ...bridge,
    semanticNodeId: redirect(bridge.semanticNodeId, migrations),
  })));
  candidate.sources.evidenceBindings = dedupeById(candidate.sources.evidenceBindings.map((binding) => ({
    ...binding,
    targetId: redirect(binding.targetId, referenceMigrations),
  })));
  candidate.snapshot.sections = candidate.snapshot.sections.map((section) => ({
    ...section,
    itemIds: unique(section.itemIds.map((id) => redirect(id, referenceMigrations))),
    evidenceBindingIds: section.evidenceBindingIds.filter((id) => !removedBindingIds.has(id)),
  }));
  candidate.audit.issues = candidate.audit.issues.filter((issue) => !patch.issueIds.includes(issue.id));
  return {
    result: candidate,
    patch: { ...patch, status: "applied" as const },
    referenceMigration: Object.fromEntries(referenceMigrations),
  };
}

function valueHashes<T extends { id: string }>(values: T[]) {
  return new Map(values.map((value) => [value.id, stableHash(JSON.stringify(value))]));
}

function changes<T extends { id: string }>(before: T[], after: T[]) {
  const beforeHashes = valueHashes(before);
  const afterHashes = valueHashes(after);
  return {
    added: [...afterHashes.keys()].filter((id) => !beforeHashes.has(id)),
    removed: [...beforeHashes.keys()].filter((id) => !afterHashes.has(id)),
    updated: [...afterHashes.keys()].filter((id) => beforeHashes.has(id) && beforeHashes.get(id) !== afterHashes.get(id)),
  };
}

export function computeSemanticDiff(input: {
  base: ColdStartBuildResult;
  candidate: ColdStartBuildResult;
  patches: GraphPatch[];
  auditBefore: RiskAuditReport;
  auditAfter: RiskAuditReport;
  migrations?: Record<string, string>;
}): SemanticDiff {
  const nodes = changes(input.base.semantic.nodes, input.candidate.semantic.nodes);
  const edges = changes(input.base.semantic.edges, input.candidate.semantic.edges);
  const scenarios = changes(input.base.process.scenarios, input.candidate.process.scenarios);
  const processNodes = changes(input.base.process.nodes, input.candidate.process.nodes);
  const sources = changes(input.base.sources.assets, input.candidate.sources.assets);
  const beforeIssues = new Set(input.auditBefore.issues.map((issue) => issue.fingerprint));
  const afterIssues = new Set(input.auditAfter.issues.map((issue) => issue.fingerprint));
  const merged = input.patches.flatMap((patch) => patch.operations
    .filter((operation): operation is Extract<GraphPatchOperation, { op: "merge_semantic_nodes" }> => operation.op === "merge_semantic_nodes")
    .map((operation) => ({ from: operation.mergedIds, to: operation.canonicalId })));
  const changedCount = nodes.added.length + nodes.removed.length + nodes.updated.length
    + edges.added.length + edges.removed.length + edges.updated.length
    + scenarios.added.length + scenarios.removed.length + processNodes.added.length + processNodes.removed.length;
  const temporal = input.base.snapshot.asOf !== input.candidate.snapshot.asOf;
  return {
    baseSnapshotId: input.base.snapshot.id,
    candidateSnapshotId: input.candidate.snapshot.id,
    summary: `新增 ${nodes.added.length}、移除 ${nodes.removed.length}、更新 ${nodes.updated.length} 个语义节点；解决 ${[...beforeIssues].filter((id) => !afterIssues.has(id)).length} 项风险。`,
    versionBump: temporal ? "minor" : changedCount > 20 ? "minor" : "patch",
    nodes: { ...nodes, merged },
    edges,
    process: {
      scenariosAdded: scenarios.added,
      scenariosRemoved: scenarios.removed,
      nodesAdded: processNodes.added,
      nodesRemoved: processNodes.removed,
    },
    sources: { added: sources.added, removed: sources.removed },
    issues: {
      resolved: [...beforeIssues].filter((id) => !afterIssues.has(id)),
      introduced: [...afterIssues].filter((id) => !beforeIssues.has(id)),
      remaining: [...afterIssues].filter((id) => beforeIssues.has(id)),
    },
    referenceMigration: input.migrations || Object.fromEntries(merged.flatMap((item) => item.from.map((from) => [from, item.to]))),
  };
}
