import type { ColdStartBuildResult, SemanticNode } from "@/lib/build/types";

/** Carry annotations across a recompile only while their subjects and source text stay unchanged. */
export function carryDeliveryProgress(previous: ColdStartBuildResult, current: ColdStartBuildResult) {
  const oldNodes = new Map(previous.semantic.nodes.map(node => [node.id, node]));
  const meaning = (node: SemanticNode) => JSON.stringify([node.type, node.label, node.summary, node.learningDefinition, node.cultivation]);
  const unchanged = new Set(current.semantic.nodes.filter(node => node.lifecycle !== "rejected" && oldNodes.get(node.id)?.lifecycle !== "rejected" && oldNodes.has(node.id) && meaning(node) === meaning(oldNodes.get(node.id)!)).map(node => node.id));
  const oldSegments = new Map(previous.sources.segments.map(segment => [segment.id, segment]));
  const segments = new Map(current.sources.segments.map(segment => [segment.id, segment]));
  const bindings = new Map(previous.sources.evidenceBindings.map(binding => [binding.id, binding]));
  const valid = (id: string) => {
    const binding = bindings.get(id), segment = binding && segments.get(binding.segmentId);
    return Boolean(binding && segment && segment.sourceId === binding.sourceId && segment.text === oldSegments.get(segment.id)?.text && binding.evidenceSpan && segment.text.includes(binding.evidenceSpan.quote));
  };
  const attach = (ids: string[]) => {
    for (const id of ids) if (!current.sources.evidenceBindings.some(binding => binding.id === id)) current.sources.evidenceBindings.push(structuredClone(bindings.get(id)!));
  };
  for (const node of current.semantic.nodes) {
    const old = oldNodes.get(node.id);
    if (!unchanged.has(node.id) || node.taskDefinition || !old?.taskDefinition) continue;
    const spans = Object.values(old.taskDefinition).flatMap(field => field && typeof field === "object" && "evidence" in field ? field.evidence : []);
    if (!spans.every(span => segments.get(span.segmentId)?.text === oldSegments.get(span.segmentId)?.text && segments.get(span.segmentId)?.text.includes(span.quote))) continue;
    const ids = old.evidenceBindingIds.filter(id => bindings.get(id)?.fieldPath.startsWith("taskDefinition."));
    if (!ids.every(valid)) continue;
    attach(ids);
    node.taskDefinition = structuredClone(old.taskDefinition);
    node.evidenceBindingIds = [...new Set([...node.evidenceBindingIds, ...ids])];
  }
  for (const edge of previous.semantic.edges) {
    if (edge.lifecycle === "rejected" || !["requires_skill", "requires_knowledge"].includes(edge.type) || !unchanged.has(edge.source) || !unchanged.has(edge.target)) continue;
    const claims = previous.semantic.claims.filter(claim => claim.subjectId === edge.source && claim.objectId === edge.target && claim.predicate === edge.type && claim.assertionType === "research_inference" && claim.status !== "rejected");
    if (!claims.length || !edge.evidenceBindingIds.length || !edge.evidenceBindingIds.every(valid) || claims.some(claim => !claim.evidenceBindingIds.every(valid))) continue;
    // A new or explicitly rejected relation takes precedence over old annotations.
    if (current.semantic.edges.some(item => item.id === edge.id || item.source === edge.source && item.target === edge.target && item.type === edge.type)) continue;
    attach([...edge.evidenceBindingIds, ...claims.flatMap(claim => claim.evidenceBindingIds)]);
    current.semantic.edges.push(structuredClone(edge));
    for (const claim of claims) if (!current.semantic.claims.some(item => item.id === claim.id)) current.semantic.claims.push(structuredClone(claim));
  }
}
