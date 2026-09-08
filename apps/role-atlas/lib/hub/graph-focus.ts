/** Hover-only one-hop focus; selection alone never dims other elements; relation direction is never rewritten. */
export function graphFocusStates(nodes: Array<{ id: string }>, edges: Array<{ id: string; source: string; target: string }>, focusId: string, selectedId = "") {
  const active = nodes.some(node => node.id === focusId);
  const neighbors = new Set([focusId]);
  const incident = new Set<string>();
  if (active) for (const edge of edges) if (edge.source === focusId || edge.target === focusId) {
    incident.add(edge.id); neighbors.add(edge.source); neighbors.add(edge.target);
  }
  return Object.fromEntries([
    ...nodes.map(node => [node.id, !active ? (node.id === selectedId ? ["selected"] : []) : node.id === focusId ? ["selected"] : neighbors.has(node.id) ? ["related"] : ["inactive"]]),
    ...edges.map(edge => [edge.id, !active ? [] : incident.has(edge.id) ? ["related"] : ["inactive"]]),
  ]) as Record<string, string[]>;
}
