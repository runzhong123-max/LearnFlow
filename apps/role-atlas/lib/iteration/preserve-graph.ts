import { compileRolePackage } from "@/lib/build/compiler";
import type { ColdStartBuildResult, ColdStartRequest, EvidenceSpan } from "@/lib/build/types";

/** Re-extraction may add evidence and objects; it cannot silently erase prior facts. */
function retain<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
  return [...new Map([...incoming, ...previous].map(item => [item.id, item])).values()];
}

export function sourceFingerprints(result: ColdStartBuildResult) {
  return new Map(result.sources.assets.map(source => {
    const texts = result.sources.segments.filter(s => s.sourceId === source.id).sort((a, b) => a.ordinal - b.ordinal).map(s => s.text);
    return [source.id, JSON.stringify([source.kind, source.locator || "", texts.length ? texts : source.contentHash])];
  }));
}

function sameStatement(a: { id: string }, b: { id: string }) {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, canonical(value)])) : v;
  const statement = (v: { id: string }) => Object.fromEntries(Object.entries(v).filter(([key]) => !["evidenceBindingIds", "evidenceSegmentIds", "evidenceSpans", "propositionIds", "confidence", "lifecycle", "status", "granularity", "defaultVisibility", "expansion", "facets", "parentKernelId"].includes(key)));
  return JSON.stringify(canonical(statement(a))) === JSON.stringify(canonical(statement(b)));
}

function retainEvidence<T extends { id: string; evidenceBindingIds: string[]; evidenceSegmentIds: string[]; evidenceSpans?: EvidenceSpan[]; propositionIds?: string[] }>(previous: T[], incoming: T[]) {
  const additions = new Map(incoming.map(n => [n.id, n]));
  return retain(previous.map(old => {
    const next = additions.get(old.id);
    if (!next || !sameStatement(old, next)) return old;
    return {
      ...old,
      evidenceBindingIds: [...new Set([...old.evidenceBindingIds, ...next.evidenceBindingIds])],
      evidenceSegmentIds: [...new Set([...old.evidenceSegmentIds, ...next.evidenceSegmentIds])],
      ...(old.evidenceSpans || next.evidenceSpans ? { evidenceSpans: [...new Map([...(old.evidenceSpans || []), ...(next.evidenceSpans || [])].map(span => [JSON.stringify(span), span])).values()] } : {}),
      ...(old.propositionIds || next.propositionIds ? { propositionIds: [...new Set([...(old.propositionIds || []), ...(next.propositionIds || [])])] } : {}),
    };
  }), incoming);
}

export function preserveIterationGraph(base: ColdStartBuildResult, rebuilt: ColdStartBuildResult, request: ColdStartRequest): ColdStartBuildResult {
  const next = structuredClone(rebuilt);
  // Source IDs include their input position. Reordering the same documents must
  // neither fabricate new sources nor break the old immutable evidence spans.
  const oldSources = new Map([...sourceFingerprints(base)].map(([id, key]) => [key, id]));
  const sourceIds = new Map([...sourceFingerprints(next)].map(([id, key]) => [id, oldSources.get(key) || id]));
  next.sources.assets = next.sources.assets.map(s => ({ ...s, id: sourceIds.get(s.id)! }));
  const segmentKey = (s: ColdStartBuildResult["sources"]["segments"][number]) => JSON.stringify([s.sourceId, s.ordinal, s.contentHash]);
  const oldSegments = new Map(base.sources.segments.map(s => [segmentKey(s), s.id]));
  const segmentIds = new Map(next.sources.segments.map(s => [s.id, oldSegments.get(segmentKey({ ...s, sourceId: sourceIds.get(s.sourceId) || s.sourceId })) || s.id]));
  const bindingKey = (b: ColdStartBuildResult["sources"]["evidenceBindings"][number]) => JSON.stringify([b.targetId, b.fieldPath, b.segmentId]);
  const oldBindings = new Map(base.sources.evidenceBindings.map(b => [bindingKey(b), b.id]));
  const bindingIds = new Map(next.sources.evidenceBindings.map(b => [b.id, oldBindings.get(bindingKey({ ...b, segmentId: segmentIds.get(b.segmentId) || b.segmentId })) || b.id]));
  // Only reference fields are remapped. Quoted source text, labels and summaries
  // must never be rewritten by a generic string substitution.
  function remap(value: unknown, field = ""): unknown {
    const map = field === "sourceId" ? sourceIds : field === "segmentId" || field === "sourceSegmentId" || field === "evidenceSegmentIds" ? segmentIds : field === "evidenceBindingIds" ? bindingIds : undefined;
    if (typeof value === "string") return map?.get(value) || value;
    if (Array.isArray(value)) return value.map(item => remap(item, field));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item, key)]));
    return value;
  }
  const mapped = remap(next) as ColdStartBuildResult;
  mapped.sources.segments = mapped.sources.segments.map((s, i) => ({ ...s, id: segmentIds.get(next.sources.segments[i].id)! }));
  mapped.sources.evidenceBindings = mapped.sources.evidenceBindings.map((b, i) => ({ ...b, id: bindingIds.get(next.sources.evidenceBindings[i].id)! }));
  const assets = retain(base.sources.assets, mapped.sources.assets);
  const segments = retain(base.sources.segments, mapped.sources.segments);
  const oldObjects = new Map([...base.semantic.nodes, ...base.semantic.edges, ...base.semantic.claims, ...base.process.scenarios, ...base.process.nodes, ...base.process.edges].map(o => [o.id, o]));
  const changedStatements = new Set([...mapped.semantic.nodes, ...mapped.semantic.edges, ...mapped.semantic.claims, ...mapped.process.scenarios, ...mapped.process.nodes, ...mapped.process.edges].filter(o => oldObjects.has(o.id) && !sameStatement(oldObjects.get(o.id)!, o)).map(o => o.id));
  // Evidence about a rewritten statement is not evidence for the retained one.
  const bindings = retain(base.sources.evidenceBindings, mapped.sources.evidenceBindings.filter(b => !changedStatements.has(b.targetId)));
  const result = compileRolePackage({
    request,
    brief: { ...base.brief, snapshotAsOf: request.snapshotAsOf },
    assets, segments,
    semantic: {
      nodes: retainEvidence(base.semantic.nodes, mapped.semantic.nodes),
      edges: retainEvidence(base.semantic.edges, mapped.semantic.edges),
      claims: retainEvidence(base.semantic.claims, mapped.semantic.claims),
      bindings, tempToId: new Map(),
    },
    process: {
      scenarios: retainEvidence(base.process.scenarios, mapped.process.scenarios),
      nodes: retainEvidence(base.process.nodes, mapped.process.nodes),
      edges: retainEvidence(base.process.edges, mapped.process.edges),
      bridges: retain(base.process.bridges, mapped.process.bridges),
      bindings: [],
    },
    mentions: retain(base.sources.mentions || [], mapped.sources.mentions || []),
    relationPropositions: retain(base.sources.relationPropositions || [], mapped.sources.relationPropositions || []),
    research: mapped.sources.research || base.sources.research,
    workItems: mapped.build?.workItems,
    buildMetrics: mapped.build?.metrics,
    laneFailures: mapped.audit.issues.filter(i => i.code === "LANE_FALLBACK").map(i => i.detail),
  });
  result.process.capsules = retain(base.process.capsules || [], mapped.process.capsules || []);
  if (result.build && mapped.build) result.build = { ...mapped.build, ...result.build, stage: mapped.build.stage, enrichment: mapped.build.enrichment };
  return result;
}

export function learningRegressionReasons(base: ColdStartBuildResult, candidate: ColdStartBuildResult, migrations: Record<string, string> = {}) {
  const nodes = new Map(candidate.semantic.nodes.map(n => [n.id, n]));
  const redirect = (start: string) => {
    let id = start;
    const seen = new Set<string>();
    while (migrations[id] && !seen.has(id)) { seen.add(id); id = migrations[id]; }
    return id;
  };
  const lost = base.semantic.nodes.filter(n => (n.type === "knowledge_skill" || n.type === "task") && n.lifecycle !== "rejected").filter(n => {
    const target = nodes.get(redirect(n.id));
    return !target || target.type !== n.type || target.lifecycle === "rejected" || (n.learningKind && target.learningKind !== n.learningKind);
  });
  const oldNodes = new Map(base.semantic.nodes.map(n => [n.id, n]));
  const links = new Set(candidate.semantic.edges.filter(e => e.lifecycle !== "rejected").map(e => `${e.type}:${e.source}:${e.target}`));
  const lostLinks = base.semantic.edges.filter(e => e.lifecycle !== "rejected" && oldNodes.get(e.source)?.type === "task" && oldNodes.get(e.target)?.type === "knowledge_skill")
    .filter(e => !links.has(`${e.type}:${redirect(e.source)}:${redirect(e.target)}`));
  return [
    lost.length ? `候选丢失或改变 ${lost.length} 个已有任务或知识技能，缺少经过验证的合并迁移：${lost.map(n => n.label).join("、")}` : "",
    lostLinks.length ? `候选丢失 ${lostLinks.length} 条已有任务的知识技能支撑关系` : "",
  ].filter(Boolean);
}
