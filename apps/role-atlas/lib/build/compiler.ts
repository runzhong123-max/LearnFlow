import type { ProcessDraft, SemanticDraft } from "./model";
import type {
  AuditIssue,
  BuildWorkItemSummary,
  ColdStartBuildResult,
  ColdStartBuildMetrics,
  ColdStartRequest,
  ConceptMention,
  EvidenceBinding,
  EvidenceSpan,
  ProcessEdge,
  ProcessKnowledgeState,
  ProcessNode,
  ProcessScenario,
  ProjectBrief,
  ResearchTopic,
  RelationProposition,
  SemanticBridge,
  SemanticClaim,
  SemanticEdge,
  SemanticNode,
  SemanticNodeType,
  SnapshotSection,
  SourceAsset,
  SourceSegment,
  ValidationReport,
  WebResearchReport,
} from "./types";
import { createRolePackageManifest } from "@/lib/packages/role-package-manifest";
import { buildRoleLearningProjection } from "@/lib/learning-path/projection";

export function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function normalizeLabel(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .replace(/工程师|岗位|能力|知识点|技能点$/u, "");
}

function normalizeBridgeLabel(value: string) {
  return normalizeLabel(value)
    .replace(/[与及和的性]/gu, "")
    .replace(/^(执行|进行|开展|实施|完成)/u, "")
    .replace(/(操作|作业|工作|流程)$/u, "");
}

function characterBigrams(value: string) {
  const normalized = normalizeBridgeLabel(value);
  if (normalized.length < 2) return normalized ? [normalized] : [];
  return Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2));
}

function bridgeLabelSimilarity(left: string, right: string) {
  const leftKey = normalizeBridgeLabel(left);
  const rightKey = normalizeBridgeLabel(right);
  if (!leftKey || !rightKey) return 0;
  if (leftKey === rightKey) return 1;
  if (leftKey.length >= 3 && rightKey.length >= 3 && (leftKey.includes(rightKey) || rightKey.includes(leftKey))) {
    return 0.7 + 0.3 * Math.min(leftKey.length, rightKey.length) / Math.max(leftKey.length, rightKey.length);
  }
  const leftBigrams = characterBigrams(left);
  const remainingRight = characterBigrams(right);
  let shared = 0;
  for (const bigram of leftBigrams) {
    const match = remainingRight.indexOf(bigram);
    if (match < 0) continue;
    shared += 1;
    remainingRight.splice(match, 1);
  }
  return leftBigrams.length + characterBigrams(right).length > 0
    ? 2 * shared / (leftBigrams.length + characterBigrams(right).length)
    : 0;
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function bounded(value: number) {
  return Math.max(0, Math.min(1, value));
}

const ringByType: Record<SemanticNodeType, number> = {
  market_role: 0,
  industry_chain_node: 1,
  job_family: 1,
  occupation_standard: 1,
  related_role: 1,
  task: 2,
  capability: 3,
  capability_unit: 4,
  knowledge_skill: 4,
};

export function prepareBuildInput(request: ColdStartRequest) {
  const assumptions: string[] = [];
  if (!request.roleDescription.trim()) assumptions.push("尚未提供更具体的岗位范围，暂按岗位名称建立候选边界");
  if (request.sources.length === 0) assumptions.push("尚未提供外部资料或真实工作区，模型扩展内容只能作为待研究候选");
  const brief: ProjectBrief = {
    projectId: request.projectId,
    roleTitle: request.roleTitle.trim(),
    roleDescription: request.roleDescription.trim(),
    market: request.market.trim(),
    audience: request.audience,
    snapshotAsOf: request.snapshotAsOf,
    assumptions,
  };

  const briefText = [
    `目标岗位：${brief.roleTitle}`,
    brief.roleDescription ? `用户描述：${brief.roleDescription}` : "",
    `市场范围：${brief.market}`,
    `主要受众：${brief.audience.join("、")}`,
    `快照时点：${brief.snapshotAsOf}`,
  ].filter(Boolean).join("\n");

  const inputs = [
    { title: "用户项目简报", content: briefText, kind: "user_brief" as const },
    ...request.sources,
  ];
  const assets: SourceAsset[] = inputs.map((source, index) => ({
    id: `src:${stableHash(`${request.projectId}:${index}:${source.title}:${source.content}`)}`,
    title: source.title,
    kind: source.kind,
    locator: source.locator,
    observedAt: source.observedAt,
    publisher: source.publisher,
    domain: source.domain,
    publishedAt: source.publishedAt,
    fetchedAt: source.fetchedAt,
    sourceTier: source.sourceTier,
    queryIds: source.queryIds,
    searchCategories: source.searchCategories,
    retrievalScore: source.retrievalScore,
    provider: source.provider,
    providerRequestIds: source.providerRequestIds,
    extractionMethod: source.extractionMethod,
    workspaceEvidence: source.workspaceEvidence,
    contentHash: stableHash(source.content),
    visibility: source.kind === "public_document" ? "publishable_metadata" : "project_private",
  }));
  const segments: SourceSegment[] = [];
  inputs.forEach((source, sourceIndex) => {
    const paragraphs = source.content.split(/\n\s*\n|(?<=。)\s*(?=\S)/u).map((item) => item.trim()).filter(Boolean);
    const chunks: string[] = [];
    let current = "";
    for (const paragraph of paragraphs.length > 0 ? paragraphs : [source.content]) {
      if (current && current.length + paragraph.length + 1 > 1_800) {
        chunks.push(current);
        current = paragraph;
      } else current = current ? `${current}\n${paragraph}` : paragraph;
    }
    if (current) chunks.push(current);
    chunks.forEach((text, ordinal) => {
      const sourceId = assets[sourceIndex].id;
      segments.push({
        id: `seg:${stableHash(`${sourceId}:${ordinal}:${text}`)}`,
        sourceId,
        ordinal,
        text,
        contentHash: stableHash(text),
      });
    });
  });
  return { brief, assets, segments };
}

function extractionSourcePriority(asset: SourceAsset) {
  const kind = {
    user_brief: 14,
    workspace_observation: 12,
    private_document: 10,
    public_document: 4,
  }[asset.kind];
  const tier = {
    authoritative: 8,
    primary: 6,
    secondary: 3,
    contextual: 2,
  }[asset.sourceTier || "contextual"];
  const category = Math.min(5, (asset.searchCategories?.length || 0) * 0.8);
  return kind + tier + category + (asset.retrievalScore || 0) * 4;
}

function sourceLooksLikeLearningOrRecruiting(asset: SourceAsset, segment: SourceSegment) {
  const text = `${asset.title}\n${segment.text.slice(0, 2_400)}`;
  return /招聘|求职|应聘|面试|面经|简历|学习路径|课程|培训|教程|入门|自学|视频|招生|就业指导/u.test(text);
}

function targetRoleAllowsLearningOrRecruiting(roleTitle: string) {
  return /教师|讲师|培训|招聘|人力资源|职业指导|就业指导/u.test(roleTitle);
}

function purposePriority(asset: SourceAsset, segment: SourceSegment, purpose: "semantic" | "process") {
  if (purpose === "semantic") return 0;
  const categories = new Set(asset.searchCategories || []);
  const usefulCategory = categories.has("work_practice") ? 10
    : categories.has("official_standard") ? 7
      : categories.has("job_market") ? 3
        : 0;
  const workEvidence = asset.kind === "workspace_observation" ? 16
    : asset.kind === "private_document" ? 8
      : 0;
  return usefulCategory + workEvidence;
}

/**
 * Keep the complete source/segment layer for provenance, while giving the two
 * extraction lanes a bounded, coverage-preserving context. The first pass
 * keeps one representative segment per source; the second pass fills the
 * remaining budget by relevance and source quality.
 */
export function selectExtractionSegments(input: {
  request: ColdStartRequest;
  assets: SourceAsset[];
  segments: SourceSegment[];
  maxSegments?: number;
  maxChars?: number;
  purpose?: "semantic" | "process";
}) {
  const maxSegments = Math.max(8, Math.min(input.maxSegments || 96, 160));
  const maxChars = Math.max(12_000, Math.min(input.maxChars || 150_000, 240_000));
  const assetMap = new Map(input.assets.map((asset) => [asset.id, asset]));
  const roleKey = normalizeLabel(input.request.roleTitle);
  const purpose = input.purpose || "semantic";
  const allowLearningOrRecruiting = targetRoleAllowsLearningOrRecruiting(input.request.roleTitle);
  const scored = input.segments.flatMap((segment, ordinal) => {
    const asset = assetMap.get(segment.sourceId)!;
    if (purpose === "process" && asset.kind === "public_document" && !allowLearningOrRecruiting
      && sourceLooksLikeLearningOrRecruiting(asset, segment)
      && !(asset.searchCategories || []).includes("work_practice")) return [];
    const textKey = normalizeLabel(`${asset?.title || ""}${segment.text}`);
    const roleScore = roleKey && textKey.includes(roleKey) ? 12 : 0;
    const firstSegmentScore = segment.ordinal === 0 ? 2 : 0;
    const offScopePenalty = purpose === "process" && !allowLearningOrRecruiting && sourceLooksLikeLearningOrRecruiting(asset, segment) ? 18 : 0;
    return [{ segment, ordinal, score: extractionSourcePriority(asset) + purposePriority(asset, segment, purpose) + roleScore + firstSegmentScore - offScopePenalty }];
  });
  const chosen = new Map<string, { segment: SourceSegment; ordinal: number; score: number }>();
  let characters = 0;
  const add = (candidate: (typeof scored)[number]) => {
    if (chosen.has(candidate.segment.id) || chosen.size >= maxSegments) return false;
    if (characters + candidate.segment.text.length > maxChars) return false;
    chosen.set(candidate.segment.id, candidate);
    characters += candidate.segment.text.length;
    return true;
  };

  const bySource = new Map<string, typeof scored>();
  for (const candidate of scored) bySource.set(candidate.segment.sourceId, [...(bySource.get(candidate.segment.sourceId) || []), candidate]);
  const sourceRepresentatives = [...bySource.entries()]
    .map(([sourceId, candidates]) => ({
      sourceId,
      candidate: [...candidates].sort((left, right) => right.score - left.score || left.ordinal - right.ordinal)[0],
      priority: extractionSourcePriority(assetMap.get(sourceId)!),
    }))
    .sort((left, right) => right.priority - left.priority || left.candidate.ordinal - right.candidate.ordinal);
  for (const representative of sourceRepresentatives) add(representative.candidate);
  for (const candidate of [...scored].sort((left, right) => right.score - left.score || left.ordinal - right.ordinal)) add(candidate);

  return [...chosen.values()].sort((left, right) => left.ordinal - right.ordinal).map((item) => item.segment);
}

function evidenceForTarget(input: {
  targetId: string;
  fieldPath: string;
  segmentIds: string[];
  label: string;
  confidence: number;
  evidenceSpans?: EvidenceSpan[];
  mentionIds?: string[];
  segments: SourceSegment[];
  sourceAssets: SourceAsset[];
}) {
  const segmentMap = new Map(input.segments.map((segment) => [segment.id, segment]));
  // An absent or hallucinated segment id must remain unbound. Falling back to
  // the first segment would silently turn the user brief into evidence for an
  // unrelated model-generated claim.
  const validIds = unique(input.segmentIds).filter((id) => segmentMap.has(id));
  return validIds.map((segmentId): EvidenceBinding => {
    const segment = segmentMap.get(segmentId)!;
    const source = input.sourceAssets.find((asset) => asset.id === segment.sourceId);
    const suppliedSpan = input.evidenceSpans?.find((span) => span.segmentId === segmentId && segment.text.includes(span.quote));
    const direct = Boolean(suppliedSpan) || normalizeLabel(segment.text).includes(normalizeLabel(input.label));
    return {
      id: `ev:${stableHash(`${input.targetId}:${input.fieldPath}:${segmentId}`)}`,
      targetId: input.targetId,
      fieldPath: input.fieldPath,
      sourceId: segment.sourceId,
      segmentId,
      support: direct || source?.kind === "user_brief" && normalizeLabel(input.label) === normalizeLabel(segment.text) ? "direct" : "inferred",
      method: source?.kind === "user_brief" && direct ? "user_assertion" : "model_extraction",
      confidence: bounded(direct ? input.confidence : Math.min(input.confidence, 0.7)),
      evidenceSpan: suppliedSpan,
      mentionIds: input.mentionIds,
    };
  });
}

function sameSemanticConcept(left: SemanticDraft["nodes"][number], right: SemanticDraft["nodes"][number]) {
  if (left.type !== right.type) return false;
  const leftKeys = new Set([left.label, ...left.aliases].map(normalizeLabel));
  return [right.label, ...right.aliases].some((label) => leftKeys.has(normalizeLabel(label)));
}

export function compileSemanticDraft(input: {
  request: ColdStartRequest;
  draft: SemanticDraft;
  segments: SourceSegment[];
  assets: SourceAsset[];
}) {
  const nodes = [...input.draft.nodes];
  const roleTempId = "__role__";
  nodes.unshift({
    tempId: roleTempId,
    type: "market_role",
    label: input.request.roleTitle,
    summary: input.draft.roleSummary || input.request.roleDescription || `关于${input.request.roleTitle}的候选岗位边界。`,
    aliases: [],
    evidenceSegmentIds: input.segments.slice(0, 1).map((segment) => segment.id),
    evidenceSpans: [],
    mentionIds: [],
    confidence: input.request.roleDescription ? 0.9 : 0.72,
  });

  const groups: typeof nodes[] = [];
  for (const node of nodes) {
    const group = groups.find((items) => sameSemanticConcept(items[0], node));
    if (group) group.push(node);
    else groups.push([node]);
  }

  const tempToId = new Map<string, string>();
  const semanticNodes: SemanticNode[] = [];
  const bindings: EvidenceBinding[] = [];
  for (const group of groups) {
    const preferred = [...group].sort((a, b) => b.label.length - a.label.length || b.confidence - a.confidence)[0];
    const id = preferred.type === "market_role"
      ? `role:${stableHash(input.request.roleTitle)}`
      : `${preferred.type}:${stableHash(`${preferred.type}:${normalizeLabel(preferred.label)}`)}`;
    group.forEach((item) => tempToId.set(item.tempId, id));
    const nodeBindings = evidenceForTarget({
      targetId: id,
      fieldPath: "summary",
      segmentIds: unique(group.flatMap((item) => item.evidenceSegmentIds)),
      label: preferred.label,
      confidence: Math.max(...group.map((item) => item.confidence)),
      evidenceSpans: unique(group.flatMap((item) => item.evidenceSpans || []).map((span) => JSON.stringify(span))).map((span) => JSON.parse(span) as EvidenceSpan),
      mentionIds: unique(group.flatMap((item) => item.mentionIds || [])),
      segments: input.segments,
      sourceAssets: input.assets,
    });
    bindings.push(...nodeBindings);
    const hasDirectEvidence = nodeBindings.some((binding) => binding.support === "direct");
    semanticNodes.push({
      id,
      type: preferred.type,
      label: preferred.label,
      summary: preferred.summary,
      aliases: unique(group.flatMap((item) => [item.label, ...item.aliases]).filter((label) => label !== preferred.label)),
      lifecycle: hasDirectEvidence ? "stable" : "candidate",
      confidence: bounded(Math.max(...group.map((item) => item.confidence))),
      evidenceSegmentIds: unique(nodeBindings.map((binding) => binding.segmentId)),
      evidenceBindingIds: nodeBindings.map((binding) => binding.id),
      ring: ringByType[preferred.type],
      learningKind: preferred.type === "knowledge_skill" ? preferred.learningKind || "hybrid" : undefined,
      learningDefinition: preferred.type === "knowledge_skill" && (preferred.learningKind === "knowledge" || preferred.learningKind === "skill") ? preferred.learningDefinition : undefined,
      cultivation: preferred.type === "capability_unit" ? preferred.cultivation : undefined,
    });
  }

  const roleId = tempToId.get(roleTempId)!;
  const rawEdges = [...input.draft.edges];
  for (const node of semanticNodes.filter((item) => item.type === "task")) {
    const represented = rawEdges.some((edge) => tempToId.get(edge.sourceTempId) === roleId && tempToId.get(edge.targetTempId) === node.id);
    if (!represented) rawEdges.push({
      type: "performs",
      sourceTempId: roleTempId,
      targetTempId: [...tempToId.entries()].find(([, id]) => id === node.id)?.[0] || "",
      evidenceSegmentIds: node.evidenceSegmentIds,
      evidenceSpans: [],
      propositionIds: [],
      confidence: Math.min(node.confidence, 0.62),
    });
  }

  const edgeMap = new Map<string, SemanticEdge>();
  for (const edge of rawEdges) {
    const source = tempToId.get(edge.sourceTempId);
    const target = tempToId.get(edge.targetTempId);
    if (!source || !target || source === target) continue;
    const key = `${source}:${edge.type}:${target}`;
    const current = edgeMap.get(key);
    const evidenceSegmentIds = unique([...(current?.evidenceSegmentIds || []), ...edge.evidenceSegmentIds]);
    edgeMap.set(key, {
      id: `edge:${stableHash(key)}`,
      type: edge.type,
      source,
      target,
      lifecycle: "stable",
      confidence: Math.max(current?.confidence || 0, bounded(edge.confidence)),
      evidenceSegmentIds,
      evidenceBindingIds: [],
      evidenceSpans: unique([...(current?.evidenceSpans || []), ...(edge.evidenceSpans || [])].map((span) => JSON.stringify(span))).map((span) => JSON.parse(span) as EvidenceSpan),
      propositionIds: unique([...(current?.propositionIds || []), ...(edge.propositionIds || [])]),
    });
  }

  for (const edge of edgeMap.values()) {
    const edgeBindings = evidenceForTarget({
      targetId: edge.id,
      fieldPath: "relation",
      segmentIds: edge.evidenceSegmentIds,
      label: `${semanticNodes.find((node) => node.id === edge.source)?.label || ""}${semanticNodes.find((node) => node.id === edge.target)?.label || ""}`,
      confidence: edge.confidence,
      evidenceSpans: edge.evidenceSpans,
      mentionIds: [],
      segments: input.segments,
      sourceAssets: input.assets,
    });
    edge.evidenceBindingIds = edgeBindings.map((binding) => binding.id);
    edge.evidenceSegmentIds = unique(edgeBindings.map((binding) => binding.segmentId));
    edge.lifecycle = edgeBindings.some((binding) => binding.support === "direct") ? "stable" : "candidate";
    bindings.push(...edgeBindings);
  }

  const claims: SemanticClaim[] = [...edgeMap.values()].map((edge) => ({
    id: `claim:${stableHash(edge.id)}`,
    subjectId: edge.source,
    predicate: edge.type,
    objectId: edge.target,
    status: "candidate",
    evidenceSegmentIds: edge.evidenceSegmentIds,
    evidenceBindingIds: edge.evidenceBindingIds,
    confidence: edge.confidence,
  }));

  return { nodes: semanticNodes, edges: [...edgeMap.values()], claims, bindings, tempToId };
}

function enforceKnowledgeState(
  requested: ProcessKnowledgeState,
  segmentIds: string[],
  segments: SourceSegment[],
  assets: SourceAsset[],
): ProcessKnowledgeState {
  const sourceAssets = segmentIds.flatMap((segmentId) => {
    const sourceId = segments.find((segment) => segment.id === segmentId)?.sourceId;
    const source = assets.find((asset) => asset.id === sourceId);
    return source ? [source] : [];
  });
  // Knowledge state is a provenance property, not a model preference. Promote
  // evidence-backed process claims even when a conservative model labels every
  // output as inferred; conversely, never accept an unsupported promotion.
  if (sourceAssets.some((source) => source.kind === "workspace_observation")) return "observed_pattern";
  if (sourceAssets.some((source) => source.kind === "private_document"
    || source.kind === "public_document"
      && (source.sourceTier === "authoritative" || source.sourceTier === "primary")
      && (source.qualification?.evidenceRoles.includes("official_standard")
        || source.qualification?.evidenceRoles.includes("work_practice")))) return "documented_norm";
  void requested;
  return "inferred_pattern";
}

function strongerKnowledgeState(left: ProcessKnowledgeState, right: ProcessKnowledgeState): ProcessKnowledgeState {
  const rank: Record<ProcessKnowledgeState, number> = { inferred_pattern: 0, documented_norm: 1, observed_pattern: 2 };
  return rank[right] > rank[left] ? right : left;
}

function longerText(left: string, right: string) {
  return right.trim().length > left.trim().length ? right : left;
}

export function compileProcessDraft(input: {
  draft: ProcessDraft;
  segments: SourceSegment[];
  assets: SourceAsset[];
  semanticNodes: SemanticNode[];
}) {
  const bindings: EvidenceBinding[] = [];
  const scenarioTempToId = new Map<string, string>();
  const scenarios: ProcessScenario[] = input.draft.scenarios.map((scenario) => {
    const id = `scenario:${stableHash(normalizeLabel(scenario.label))}`;
    scenarioTempToId.set(scenario.tempId, id);
    const scenarioBindings = evidenceForTarget({
      targetId: id,
      fieldPath: "summary",
      segmentIds: scenario.evidenceSegmentIds,
      label: scenario.label,
      confidence: 0.62,
      evidenceSpans: scenario.evidenceSpans,
      mentionIds: [],
      segments: input.segments,
      sourceAssets: input.assets,
    });
    bindings.push(...scenarioBindings);
    const stateSegmentIds = scenarioBindings.filter((binding) => binding.support === "direct"
      || input.assets.some((asset) => asset.id === binding.sourceId && asset.workspaceEvidence)).map((binding) => binding.segmentId);
    const knowledgeState = enforceKnowledgeState(scenario.knowledgeState, stateSegmentIds, input.segments, input.assets);
    return {
      id,
      label: scenario.label,
      summary: scenario.summary,
      trigger: scenario.trigger,
      outcome: scenario.outcome,
      knowledgeState,
      lifecycle: scenarioBindings.length > 0 && knowledgeState !== "inferred_pattern" ? "stable" : "candidate",
      evidenceSegmentIds: unique(scenarioBindings.map((binding) => binding.segmentId)),
      evidenceBindingIds: scenarioBindings.map((binding) => binding.id),
    };
  });

  const processTempToId = new Map<string, string>();
  const nodes: ProcessNode[] = input.draft.nodes.flatMap((node) => {
    const scenarioId = scenarioTempToId.get(node.scenarioTempId);
    if (!scenarioId) return [];
    const id = `${node.kind}:${stableHash(`${scenarioId}:${normalizeLabel(node.label)}`)}`;
    processTempToId.set(node.tempId, id);
    const nodeBindings = evidenceForTarget({
      targetId: id,
      fieldPath: "summary",
      segmentIds: node.evidenceSegmentIds,
      label: node.label,
      confidence: 0.6,
      evidenceSpans: node.evidenceSpans,
      mentionIds: [],
      segments: input.segments,
      sourceAssets: input.assets,
    });
    bindings.push(...nodeBindings);
    const stateSegmentIds = nodeBindings.filter((binding) => binding.support === "direct"
      || input.assets.some((asset) => asset.id === binding.sourceId && asset.workspaceEvidence)).map((binding) => binding.segmentId);
    const knowledgeState = enforceKnowledgeState(node.knowledgeState, stateSegmentIds, input.segments, input.assets);
    return [{
      id,
      scenarioId,
      kind: node.kind,
      label: node.label,
      summary: node.summary,
      sequenceHint: node.sequenceHint,
      knowledgeState,
      lifecycle: nodeBindings.length > 0 && knowledgeState !== "inferred_pattern" ? "stable" as const : "candidate" as const,
      evidenceSegmentIds: unique(nodeBindings.map((binding) => binding.segmentId)),
      evidenceBindingIds: nodeBindings.map((binding) => binding.id),
    }];
  });

  const edges: ProcessEdge[] = input.draft.edges.flatMap((edge) => {
    const source = processTempToId.get(edge.sourceTempId);
    const target = processTempToId.get(edge.targetTempId);
    if (!source || !target || source === target) return [];
    const id = `process-edge:${stableHash(`${source}:${edge.type}:${target}`)}`;
    const edgeBindings = evidenceForTarget({
      targetId: id,
      fieldPath: "relation",
      segmentIds: edge.evidenceSegmentIds,
      label: edge.type,
      confidence: 0.56,
      evidenceSpans: edge.evidenceSpans,
      mentionIds: [],
      segments: input.segments,
      sourceAssets: input.assets,
    });
    bindings.push(...edgeBindings);
    return [{ id, type: edge.type, source, target, evidenceSegmentIds: unique(edgeBindings.map((binding) => binding.segmentId)), evidenceBindingIds: edgeBindings.map((binding) => binding.id), evidenceSpans: edge.evidenceSpans }];
  });

  const bridges: SemanticBridge[] = input.draft.bridges.flatMap((bridge) => {
    const processNodeId = processTempToId.get(bridge.processTempId);
    const semanticNode = input.semanticNodes
      .filter((node) => bridge.type === "realizes_task" ? node.type === "task" : bridge.type === "uses_skill" ? node.type === "knowledge_skill" : true)
      .map((node) => ({ node, score: bridgeLabelSimilarity(node.label, bridge.semanticLabel) }))
      .sort((left, right) => right.score - left.score)
      .find((candidate) => candidate.score >= 0.58)?.node;
    if (!processNodeId || !semanticNode) return [];
    return [{
      id: `bridge:${stableHash(`${processNodeId}:${bridge.type}:${semanticNode.id}`)}`,
      processNodeId,
      semanticNodeId: semanticNode.id,
      type: bridge.type,
      confidence: bounded(bridge.confidence),
    }];
  });

  // 语义与事理 Lane 并行时，事理模型无法预知语义 Lane 最终采用的任务名称。
  // 因此在 Barrier 后以标签相似度和共享证据做保守对齐；低分项继续保留为研究缺口。
  const bridgedTaskIds = new Set(bridges.filter((bridge) => bridge.type === "realizes_task").map((bridge) => bridge.semanticNodeId));
  const eventNodes = nodes.filter((node) => node.kind === "event");
  for (const task of input.semanticNodes.filter((node) => node.type === "task" && !bridgedTaskIds.has(node.id))) {
    const candidates = eventNodes.map((event) => {
      const similarity = bridgeLabelSimilarity(task.label, event.label);
      const sharedEvidence = task.evidenceSegmentIds.some((segmentId) => event.evidenceSegmentIds.includes(segmentId));
      return { event, similarity, sharedEvidence };
    }).filter((candidate) => candidate.similarity >= 0.62 && (candidate.sharedEvidence || candidate.similarity >= 0.82))
      .sort((left, right) => right.similarity - left.similarity);
    const best = candidates[0];
    if (!best) continue;
    bridges.push({
      id: `bridge:${stableHash(`${best.event.id}:realizes_task:${task.id}`)}`,
      processNodeId: best.event.id,
      semanticNodeId: task.id,
      type: "realizes_task",
      confidence: bounded(Math.min(0.78, 0.5 + best.similarity * 0.3)),
    });
    bridgedTaskIds.add(task.id);
  }

  // Parallel task groups may independently describe the same scene or event.
  // Stable IDs make those records mergeable; returning duplicate IDs would
  // make traversal counts and snapshot diffs depend on scheduling order.
  const scenarioMap = new Map<string, ProcessScenario>();
  for (const scenario of scenarios) {
    const current = scenarioMap.get(scenario.id);
    if (!current) scenarioMap.set(scenario.id, scenario);
    else scenarioMap.set(scenario.id, {
      ...current,
      summary: longerText(current.summary, scenario.summary),
      trigger: longerText(current.trigger, scenario.trigger),
      outcome: longerText(current.outcome, scenario.outcome),
      knowledgeState: strongerKnowledgeState(current.knowledgeState, scenario.knowledgeState),
      lifecycle: current.lifecycle === "stable" || scenario.lifecycle === "stable" ? "stable" : "candidate",
      evidenceSegmentIds: unique([...current.evidenceSegmentIds, ...scenario.evidenceSegmentIds]),
      evidenceBindingIds: unique([...current.evidenceBindingIds, ...scenario.evidenceBindingIds]),
    });
  }
  const nodeMap = new Map<string, ProcessNode>();
  for (const node of nodes) {
    const current = nodeMap.get(node.id);
    if (!current) nodeMap.set(node.id, node);
    else nodeMap.set(node.id, {
      ...current,
      summary: longerText(current.summary, node.summary),
      sequenceHint: current.sequenceHint ?? node.sequenceHint,
      knowledgeState: strongerKnowledgeState(current.knowledgeState, node.knowledgeState),
      lifecycle: current.lifecycle === "stable" || node.lifecycle === "stable" ? "stable" : "candidate",
      evidenceSegmentIds: unique([...current.evidenceSegmentIds, ...node.evidenceSegmentIds]),
      evidenceBindingIds: unique([...current.evidenceBindingIds, ...node.evidenceBindingIds]),
    });
  }
  const edgeMap = new Map<string, ProcessEdge>();
  for (const edge of edges) {
    const current = edgeMap.get(edge.id);
    edgeMap.set(edge.id, current ? {
      ...current,
      evidenceSegmentIds: unique([...current.evidenceSegmentIds, ...edge.evidenceSegmentIds]),
      evidenceBindingIds: unique([...current.evidenceBindingIds, ...edge.evidenceBindingIds]),
      evidenceSpans: unique([...(current.evidenceSpans || []), ...(edge.evidenceSpans || [])].map((span) => JSON.stringify(span))).map((span) => JSON.parse(span) as EvidenceSpan),
    } : edge);
  }
  const bridgeMap = new Map<string, SemanticBridge>();
  for (const bridge of bridges) {
    const current = bridgeMap.get(bridge.id);
    bridgeMap.set(bridge.id, current ? { ...current, confidence: Math.max(current.confidence, bridge.confidence) } : bridge);
  }
  const bindingMap = new Map<string, EvidenceBinding>();
  for (const binding of bindings) {
    const current = bindingMap.get(binding.id);
    bindingMap.set(binding.id, current ? {
      ...current,
      support: current.support === "direct" || binding.support === "direct" ? "direct" : "inferred",
      confidence: Math.max(current.confidence, binding.confidence),
      evidenceSpan: current.evidenceSpan || binding.evidenceSpan,
      mentionIds: unique([...(current.mentionIds || []), ...(binding.mentionIds || [])]),
    } : binding);
  }

  return {
    scenarios: [...scenarioMap.values()],
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
    bridges: [...bridgeMap.values()],
    bindings: [...bindingMap.values()],
  };
}

function section(id: string, title: string, nodes: SemanticNode[], bindings: EvidenceBinding[], fallback: string): SnapshotSection {
  const itemIds = nodes.map((node) => node.id);
  const evidenceBindingIds = unique(nodes.flatMap((node) => node.evidenceBindingIds));
  return {
    id,
    title,
    status: itemIds.length > 0 && nodes.every((node) => node.evidenceBindingIds.some((bindingId) => bindings.find((binding) => binding.id === bindingId)?.support === "direct")) ? "stable" : "candidate",
    summary: nodes.length > 0 ? nodes.map((node) => `${node.label}：${node.summary}`).join("\n") : fallback,
    itemIds,
    evidenceBindingIds: evidenceBindingIds.filter((bindingId) => bindings.some((binding) => binding.id === bindingId)),
  };
}

export function compileRolePackage(input: {
  request: ColdStartRequest;
  brief: ProjectBrief;
  assets: SourceAsset[];
  segments: SourceSegment[];
  semantic: ReturnType<typeof compileSemanticDraft>;
  process: ReturnType<typeof compileProcessDraft>;
  laneFailures: string[];
  research?: WebResearchReport;
  mentions?: ConceptMention[];
  relationPropositions?: RelationProposition[];
  workItems?: BuildWorkItemSummary[];
  buildMetrics?: ColdStartBuildMetrics;
}): ColdStartBuildResult {
  const bindings = unique([...input.semantic.bindings, ...input.process.bindings].map((binding) => binding.id))
    .map((id) => [...input.semantic.bindings, ...input.process.bindings].find((binding) => binding.id === id)!);
  const role = input.semantic.nodes.find((node) => node.type === "market_role");
  const roleContext = input.semantic.nodes.filter((node) => node.type === "industry_chain_node" || node.type === "job_family" || node.type === "related_role");
  const tasks = input.semantic.nodes.filter((node) => node.type === "task");
  const capabilities = input.semantic.nodes.filter((node) => node.type === "capability" || node.type === "capability_unit");
  const skills = input.semantic.nodes.filter((node) => node.type === "knowledge_skill");
  const externalSources = input.assets.filter((asset) => asset.kind !== "user_brief");
  const evidenceTargets = [
    ...input.semantic.nodes,
    ...input.semantic.edges,
    ...input.process.scenarios,
    ...input.process.nodes,
    ...input.process.edges,
  ];
  const boundTargetIds = new Set(bindings.map((binding) => binding.targetId));
  const directTargetIds = new Set(bindings.filter((binding) => binding.support === "direct").map((binding) => binding.targetId));
  const evidenceCoverage = evidenceTargets.length > 0
    ? evidenceTargets.filter((target) => boundTargetIds.has(target.id)).length / evidenceTargets.length
    : 0;
  const directCoverage = evidenceTargets.length > 0
    ? evidenceTargets.filter((target) => directTargetIds.has(target.id)).length / evidenceTargets.length
    : 0;
  const taskWithScenario = new Set(input.process.bridges.filter((bridge) => bridge.type === "realizes_task").map((bridge) => bridge.semanticNodeId));
  const processCoverage = tasks.length > 0 ? tasks.filter((task) => taskWithScenario.has(task.id)).length / tasks.length : 0;
  const issues: AuditIssue[] = [];

  const addIssue = (issue: Omit<AuditIssue, "id">) => issues.push({ ...issue, id: `issue:${stableHash(`${issue.code}:${issue.targetIds.join(":")}:${issue.detail}`)}` });
  if (externalSources.length === 0) addIssue({ code: "NO_EXTERNAL_EVIDENCE", severity: "error", title: "缺少外部岗位证据", detail: "当前只有用户项目简报，模型扩展内容不能作为已验证岗位事实。", targetIds: role ? [role.id] : [], repair: "research" });
  if (tasks.length === 0) addIssue({ code: "NO_TASKS", severity: "error", title: "没有形成可验收任务", detail: "任务层为空，不能继续发布岗位包。", targetIds: role ? [role.id] : [], repair: "research" });
  const unsupportedTargetIds = evidenceTargets.filter((target) => !boundTargetIds.has(target.id)).map((target) => target.id);
  if (unsupportedTargetIds.length > 0) addIssue({
    code: "UNSUPPORTED_TARGETS",
    severity: "error",
    title: `存在 ${unsupportedTargetIds.length} 个未绑定来源的对象或关系`,
    detail: "模型没有提供有效的来源片段 ID；这些候选内容继续保留用于研究，但不能进入可发布快照。",
    targetIds: unsupportedTargetIds,
    repair: "research",
  });
  for (const task of tasks.filter((item) => !taskWithScenario.has(item.id))) addIssue({ code: "TASK_PROCESS_GAP", severity: "warning", title: `任务缺少工作场景：${task.label}`, detail: "尚无事理事件或场景能够说明该任务在工作中如何发生。", targetIds: [task.id], repair: "research" });
  if (!input.assets.some((asset) => asset.kind === "workspace_observation")) addIssue({ code: "NO_OBSERVED_EPISODE", severity: "warning", title: "没有真实工作事件样本", detail: "事理森林只能标记为 documented_norm 或 inferred_pattern。", targetIds: input.process.scenarios.map((scenario) => scenario.id), repair: "user" });
  for (const failure of input.laneFailures) addIssue({ code: "LANE_FALLBACK", severity: "warning", title: "构建分支使用了保守降级", detail: failure, targetIds: role ? [role.id] : [], repair: "automatic" });

  const researchTopics: ResearchTopic[] = issues.filter((issue) => issue.repair === "research").map((issue) => ({
    id: `research:${stableHash(issue.id)}`,
    title: issue.title,
    question: `需要补充哪些可靠资料才能解决“${issue.title}”？`,
    reason: issue.detail,
    targetIds: issue.targetIds,
  }));
  const implicitTasks = tasks.filter((task) => !directTargetIds.has(task.id));
  const sections: SnapshotSection[] = [
    section("overview", "岗位定义与边界", role ? [role] : [], bindings, "岗位边界仍需进一步确认。"),
    section("role-context", "产业位置、岗位群与相邻岗位", roleContext, bindings, "尚未形成可靠的产业链、岗位群或相邻岗位关系。"),
    section("tasks", "典型工作任务", tasks, bindings, "尚未形成可验收的典型工作任务。"),
    section("implicit-responsibilities", "JD 未明写但工作可能承担的职责", implicitTasks, bindings, "尚无充分资料区分招聘明示职责与真实工作中的隐含职责。"),
    section("capabilities", "能力与能力单元", capabilities, bindings, "尚未形成跨场景能力结构。"),
    section("knowledge-skills", "知识技能", skills, bindings, "尚未形成可学习和测评的知识技能结构。"),
    {
      id: "work-process",
      title: "工作场景与事理模式",
      status: input.process.scenarios.length > 0 && input.process.scenarios.every((scenario) => scenario.lifecycle === "stable") ? "stable" : "candidate",
      summary: input.process.scenarios.length > 0
        ? input.process.scenarios.map((scenario) => `${scenario.label}（${scenario.knowledgeState}）：${scenario.summary}`).join("\n")
        : "尚未形成工作场景模板。",
      itemIds: input.process.scenarios.map((scenario) => scenario.id),
      evidenceBindingIds: unique(input.process.scenarios.flatMap((scenario) => scenario.evidenceBindingIds)),
    },
    {
      id: "evidence-risks",
      title: "证据边界、风险与研究议程",
      status: "candidate",
      summary: issues.length > 0 ? issues.map((issue) => `${issue.title}：${issue.detail}`).join("\n") : "本轮未发现阻塞性问题。",
      itemIds: unique(issues.flatMap((issue) => issue.targetIds)),
      evidenceBindingIds: [],
    },
  ];
  const structuralIssues = [!role ? "缺少岗位根节点" : "", tasks.length === 0 ? "缺少任务层" : ""].filter(Boolean);
  const semanticIssues = input.semantic.nodes.some((node) => !node.label.trim()) ? ["存在空标签节点"] : [];
  const evidenceIssues = [
    externalSources.length === 0 ? "缺少独立外部来源" : "",
    evidenceCoverage < 0.85 ? "来源绑定覆盖率过低" : "",
    directCoverage < 0.45 ? "直接证据覆盖率过低" : "",
  ].filter(Boolean);
  const processIssues = [
    input.process.scenarios.length === 0 ? "缺少事理场景" : "",
    processCoverage < 0.5 ? "任务—场景覆盖不足" : "",
    input.process.scenarios.length > 0 && input.process.scenarios.every((scenario) => scenario.knowledgeState === "inferred_pattern") ? "事理场景全部来自推断模式" : "",
  ].filter(Boolean);
  const validation: ValidationReport = {
    publishable: false,
    structural: { passed: structuralIssues.length === 0, issues: structuralIssues },
    semantic: { passed: semanticIssues.length === 0, issues: semanticIssues },
    evidence: { passed: evidenceIssues.length === 0, coverage: evidenceCoverage, issues: evidenceIssues },
    temporal: { passed: Boolean(input.request.snapshotAsOf), issues: input.request.snapshotAsOf ? [] : ["缺少快照时间"] },
    process: { passed: processIssues.length === 0, coverage: processCoverage, issues: processIssues },
  };
  validation.publishable = validation.structural.passed && validation.semantic.passed && validation.evidence.passed && validation.temporal.passed && validation.process.passed && issues.every((issue) => issue.severity !== "error");

  const status = validation.publishable ? "ready" as const : "candidate" as const;
  const roleSlug = stableHash(input.request.roleTitle);
  const revision = stableHash(input.request.runId);
  const packageVersion = `0.1.0-${status}.${revision}`;
  // Every compiled state is an immutable exact snapshot. The as-of date still
  // answers "when", while the revision distinguishes same-day refinements.
  const snapshotId = `snapshot:${roleSlug}@${input.request.snapshotAsOf}:${revision}`;
  const rolePackageId = `role-package:${roleSlug}`;
  const result: ColdStartBuildResult = {
    runId: input.request.runId,
    projectId: input.request.projectId,
    brief: input.brief,
    sources: {
      assets: input.assets,
      segments: input.segments,
      evidenceBindings: bindings,
      mentions: input.mentions,
      relationPropositions: input.relationPropositions,
      research: input.research,
    },
    semantic: {
      nodes: input.semantic.nodes,
      edges: input.semantic.edges,
      claims: input.semantic.claims,
      learningPathProjection: buildRoleLearningProjection({
        graph: input.request.learningPathGraph,
        snapshotId,
        semanticNodes: input.semantic.nodes,
        assets: input.assets,
        evidenceBindings: bindings,
      }),
    },
    process: { scenarios: input.process.scenarios, nodes: input.process.nodes, edges: input.process.edges, bridges: input.process.bridges },
    snapshot: { id: snapshotId, asOf: input.request.snapshotAsOf, status, sections },
    audit: { issues, researchTopics },
    packages: { rolePackage: undefined as never },
    validation,
    build: input.workItems ? {
      workflowVersion: "4.2",
      workItems: input.workItems,
      metrics: input.buildMetrics || {
        estimatedInputTokens: input.workItems.reduce((sum, item) => sum + item.estimatedInputTokens, 0),
        maxOutputTokens: input.workItems.reduce((sum, item) => sum + item.maxOutputTokens, 0),
        cacheHits: input.workItems.filter((item) => item.cacheHit).length,
        failedWorkItems: input.workItems.filter((item) => item.status === "failed").length,
        targetedResearchQueries: 0,
      },
    } : undefined,
  };
  result.packages.rolePackage = createRolePackageManifest({ result, packageId: rolePackageId, packageVersion, status });
  return result;
}
