import type { SemanticDraft } from "./model";

/** Evaluate the same exact identities that semantic materialization will merge. */
export function capabilityCoverage(draft: SemanticDraft) {
  const groups = new Map<string, SemanticDraft["nodes"]>();
  const canonical = new Map<string, string>();
  for (const node of draft.nodes) {
    const key = `${node.type}:${node.label.normalize("NFKC").toLowerCase().replace(/\s+/gu, "")}`;
    const group = groups.get(key) || [];
    canonical.set(node.tempId, group[0]?.tempId || node.tempId);
    groups.set(key, [...group, node]);
  }
  const units = new Set([...groups.values()].filter(group => group[0].type === "capability_unit").map(group => group[0].tempId));
  const capabilities = new Set([...groups.values()].filter(group => group[0].type === "capability").map(group => group[0].tempId));
  const withUnits = new Set(draft.edges.filter(edge => edge.type === "contains" && capabilities.has(canonical.get(edge.sourceTempId)!) && units.has(canonical.get(edge.targetTempId)!)).map(edge => canonical.get(edge.sourceTempId)!));
  const covered = new Set(draft.edges.filter(edge => edge.type === "requires_capability" && withUnits.has(canonical.get(edge.targetTempId)!)).map(edge => canonical.get(edge.sourceTempId)!));
  const unitsWithoutCultivation = [...groups.values()].filter(group => group[0].type === "capability_unit"
    && !group.some(node => node.cultivation && Object.values(node.cultivation).every(value => value.trim()))).map(group => group[0].tempId);
  const taskIds = new Set(draft.nodes.filter(node => node.type === "task").map(node => canonical.get(node.tempId)!));
  const capabilitiesWithoutTransfer = taskIds.size > 1 ? [...capabilities].filter(id => new Set(draft.edges.filter(edge => edge.type === "requires_capability" && canonical.get(edge.targetTempId) === id && taskIds.has(canonical.get(edge.sourceTempId)!)).map(edge => canonical.get(edge.sourceTempId)!)).size < 2) : [];
  return {
    capabilitiesWithoutTransfer,
    unitsWithoutCultivation,
    uncoveredTaskIds: draft.nodes.filter(node => node.type === "task" && !covered.has(canonical.get(node.tempId)!)).map(node => node.tempId),
    capabilitiesWithoutUnits: [...capabilities].filter(id => !withUnits.has(id)),
  };
}
