import type { ColdStartBuildResult } from "@/lib/build/types";
import type { IterationContract } from "./types";

function objects(result: ColdStartBuildResult) {
  return [...result.semantic.nodes, ...result.process.scenarios, ...result.process.nodes];
}
function links(result: ColdStartBuildResult): Array<[string, string]> {
  return [
    ...result.semantic.edges.filter(edge => edge.lifecycle !== "rejected").map(edge => [edge.source, edge.target] as [string, string]),
    ...result.process.edges.map(edge => [edge.source, edge.target] as [string, string]),
    ...result.process.bridges.map(bridge => [bridge.semanticNodeId, bridge.processNodeId] as [string, string]),
    ...result.process.nodes.map(node => [node.id, node.scenarioId] as [string, string]),
  ];
}
function neighbors(edges: Array<[string, string]>) {
  const map = new Map<string, Set<string>>();
  for (const [a, b] of edges) {
    if (!a || !b) continue;
    map.set(a, (map.get(a) || new Set()).add(b));
    map.set(b, (map.get(b) || new Set()).add(a));
  }
  return map;
}

/** Reject an out-of-scope candidate as a whole; never cut away its evidence. */
export function reviewIterationScope(base: ColdStartBuildResult, candidate: ColdStartBuildResult, contract: IterationContract) {
  if (contract.initiativeProfile !== "user_directed" || !contract.targetIds.length) return { reasons: [] as string[], targetedChange: true };
  const selected = new Set(contract.targetIds);
  const baseObjects = new Map(objects(base).map(object => [object.id, object]));
  const baseLinks = neighbors(links(base));
  const hubs = new Set(base.semantic.nodes.filter(node => ["market_role", "industry_chain_node", "job_family", "occupation_standard", "related_role"].includes(node.type)).map(node => node.id));
  const anchors = new Set(contract.targetIds);
  let frontier = [...anchors];
  const radius = typeof contract.budgets.graphRadius === "number" ? contract.budgets.graphRadius : 1;
  for (let depth = 0; depth < radius; depth++) {
    const next: string[] = [];
    for (const id of frontier) for (const neighbor of baseLinks.get(id) || []) {
      // A task's common role root is not a license to expand every sibling.
      if (anchors.has(neighbor) || (hubs.has(neighbor) && !selected.has(neighbor))) continue;
      anchors.add(neighbor); next.push(neighbor);
    }
    frontier = next;
  }
  const incoming = objects(candidate).filter(object => !baseObjects.has(object.id));
  const incomingIds = new Set(incoming.map(object => object.id));
  const qualifiedSources = new Set(candidate.sources.assets.filter(source => source.kind !== "user_brief" && source.qualification?.status !== "quarantined").map(source => source.id));
  const segments = new Set(candidate.sources.segments.filter(segment => qualifiedSources.has(segment.sourceId) && segment.text.trim()).map(segment => segment.id));
  const supportedTargets = new Set(candidate.sources.evidenceBindings.filter(binding => segments.has(binding.segmentId)).map(binding => binding.targetId));
  const supported = new Set(incoming.filter(object => supportedTargets.has(object.id) || object.evidenceSegmentIds.some(id => segments.has(id))).map(object => object.id));
  const candidateLinks = neighbors(links(candidate));
  const reachable = new Set(anchors);
  frontier = [...anchors];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) for (const neighbor of candidateLinks.get(id) || []) {
      if (reachable.has(neighbor) || !incomingIds.has(neighbor) || !supported.has(neighbor)) continue;
      reachable.add(neighbor); next.push(neighbor);
    }
    frontier = next;
  }
  const outside = incoming.filter(object => !reachable.has(object.id));
  const oldBindingIds = new Set(base.sources.evidenceBindings.map(binding => binding.id));
  const targetedEvidence = candidate.sources.evidenceBindings.some(binding => !oldBindingIds.has(binding.id) && reachable.has(binding.targetId) && segments.has(binding.segmentId));
  const oldEdges = new Set(links(base).map(pair => JSON.stringify(pair)));
  const newLinks = links(candidate).filter(pair => !oldEdges.has(JSON.stringify(pair)));
  const outsideLinks = newLinks.filter(pair => pair.every(id => !reachable.has(id)));
  const targetedLink = newLinks.some(pair => pair.every(id => reachable.has(id)));
  const oldClaims = new Set(base.semantic.claims.map(claim => claim.id));
  const newClaims = candidate.semantic.claims.filter(claim => claim.status !== "rejected" && !oldClaims.has(claim.id));
  const claimInScope = (claim: typeof newClaims[number]) => reachable.has(claim.subjectId) || Boolean(claim.objectId && reachable.has(claim.objectId));
  const outsideClaims = newClaims.filter(claim => !claimInScope(claim));
  return {
    reasons: [
      outside.length ? `定向研究候选包含 ${outside.length} 个未通过可追溯关系连接到选中范围的新增对象：${outside.slice(0, 6).map(object => object.label).join("、")}。本轮不覆盖原版本，请缩小研究目标或选择自动发现。` : "",
      outsideLinks.length ? `定向研究候选包含 ${outsideLinks.length} 条未连接到选中范围的新增关系，未采用该候选。` : "",
      outsideClaims.length ? `定向研究候选包含 ${outsideClaims.length} 条选中范围外的新增断言，未采用该候选。` : "",
    ].filter(Boolean),
    targetedChange: incoming.some(object => reachable.has(object.id)) || targetedEvidence || targetedLink
      || newClaims.some(claim => claimInScope(claim) && (supportedTargets.has(claim.id) || claim.evidenceSegmentIds.some(id => segments.has(id)))),
  };
}
