import type { SemanticDraft } from "./model";

/** Coverage needs a task relationship and at least one observable unit. */
export function capabilityCoverage(draft: SemanticDraft) {
  const units = new Set(draft.nodes.filter(node => node.type === "capability_unit").map(node => node.tempId));
  const capabilities = new Set(draft.nodes.filter(node => node.type === "capability").map(node => node.tempId));
  const withUnits = new Set(draft.edges.filter(edge => edge.type === "contains" && capabilities.has(edge.sourceTempId) && units.has(edge.targetTempId)).map(edge => edge.sourceTempId));
  const covered = new Set(draft.edges.filter(edge => edge.type === "requires_capability" && withUnits.has(edge.targetTempId)).map(edge => edge.sourceTempId));
  return {
    uncoveredTaskIds: draft.nodes.filter(node => node.type === "task" && !covered.has(node.tempId)).map(node => node.tempId),
    capabilitiesWithoutUnits: [...capabilities].filter(id => !withUnits.has(id)),
  };
}
