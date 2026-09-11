import type { IterationProducts } from "./types";
import type { RankedRadarItem } from "./products";

/**
 * Presentation model for the round's research products.
 *
 * Kept as a pure function for two reasons. First, what the panel shows must be
 * testable without a browser, because the thing most likely to go wrong is not
 * the markup but the *claim*: a panel that showed only what was accepted would
 * misrepresent the round as cleaner than it was. Second, ranking and gating
 * happen in code already, so the view has nothing to decide — it formats.
 *
 * Withheld items are part of the model on purpose. A round where three
 * augmentations were refused is a different fact from a round where none were
 * proposed, and the operator needs to be able to tell them apart.
 */

export type RadarPresentation = {
  rank: number;
  axis: string;
  direction: string;
  gapSignal: string;
  /** Code-recomputed gain, not the model's own score. */
  gain: string;
  cost: string;
  requiredEvidence: string;
  affectedNodeIds: string[];
};

export type RiskPresentation = {
  deterministicCount: number;
  evidencedHypothesisCount: number;
  bareHypothesisCount: number;
  domains: Array<{ domain: string; claims: number; bare: number }>;
};

export type AugmentationPresentation = {
  motivation: string;
  nodeCount: number;
  edgeCount: number;
  nodeLabels: string[];
  /** Every added node must cite base evidence; a zero here means it cannot. */
  evidenceSegmentCount: number;
};

export type ProductPresentation = {
  radar: RadarPresentation[];
  risk?: RiskPresentation;
  augmentations: AugmentationPresentation[];
  /** Plain-language notes about what was withheld, for honest reporting. */
  withheld: string[];
  isEmpty: boolean;
};

const AXIS_LABELS: Record<string, string> = {
  task_coverage: "任务覆盖",
  knowledge_novelty: "知识新颖度",
  process_completeness: "事理完整度",
  capability_transfer: "能力迁移",
  freshness_signal: "时效信号",
  boundary_drift: "边界漂移",
};

export function radarAxisLabel(axis: string) {
  return AXIS_LABELS[axis] || axis;
}

function presentRadarItem(item: RankedRadarItem): RadarPresentation {
  return {
    rank: item.rank,
    axis: radarAxisLabel(item.axis),
    direction: item.direction,
    gapSignal: item.gapSignal,
    gain: item.recomputedGain.toFixed(1),
    cost: `约 ${item.costEstimate.queries} 次检索`,
    requiredEvidence: item.requiredEvidence,
    affectedNodeIds: [...item.affectedNodeIds],
  };
}

export function presentIterationProducts(input: {
  products?: IterationProducts;
  /** Reasons collected from the gates and the audit during assembly. */
  withheld?: string[];
}): ProductPresentation {
  const products = input.products;
  const withheld = [...(input.withheld || [])];
  if (!products) {
    return { radar: [], augmentations: [], withheld, isEmpty: true };
  }

  const radar = (products.radarItems || []).map(presentRadarItem);

  const risk: RiskPresentation | undefined = products.riskPackage
    ? {
      deterministicCount: products.riskPackage.deterministicIssues.length,
      evidencedHypothesisCount: products.riskPackage.domains.reduce((sum, domain) => sum + domain.claims.length, 0),
      bareHypothesisCount: products.riskPackage.domains
        .flatMap(domain => domain.claims)
        .filter(claim => claim.kind === "observed" && claim.evidenceSpans.length === 0).length,
      domains: products.riskPackage.domains.map(domain => ({
        domain: domain.domain,
        claims: domain.claims.length,
        bare: domain.claims.filter(claim => claim.kind === "observed" && claim.evidenceSpans.length === 0).length,
      })),
    }
    : undefined;

  const augmentations = (products.augmentations || []).map(proposal => ({
    motivation: proposal.motivation,
    nodeCount: proposal.nodes.length,
    edgeCount: proposal.edges.length,
    nodeLabels: proposal.nodes.map(node => node.label),
    evidenceSegmentCount: proposal.nodes.reduce((sum, node) => sum + node.evidenceSegmentIds.length, 0),
  }));

  return {
    radar,
    ...(risk ? { risk } : {}),
    augmentations,
    withheld,
    isEmpty: !radar.length && !risk && !augmentations.length,
  };
}
