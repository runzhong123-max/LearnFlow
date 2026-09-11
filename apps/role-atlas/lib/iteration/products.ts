import { z } from "zod";
import type { RiskHealthMetrics, RiskIssue, RiskSeverity } from "@/lib/risk/types";
import { claimSchema, type Claim } from "@/lib/iteration/evidence-review";
import { researchTaskCardSchema, type ResearchTaskCard, type ReviewedClaim } from "@/lib/iteration/worker";

/**
 * Unified protocol for the four research products.
 *
 * The governing rule is that freedom lives in the exploration space and
 * credibility lives in the assertion space:
 *
 *   free    — hypotheses, scan axes, wording, how much reasoning to show
 *   locked  — evidence binding, ranking arithmetic, acceptance, rollback
 *
 * Two consequences shape this module. First, a product never ranks itself: the
 * model may propose a gain score, but ordering is recomputed in code from data
 * the caller can verify. Second, a product never approves itself: `acceptance`
 * is decided by code from the initiative profile plus audit and review state,
 * so "the model said it is done" can never become "it is done".
 */

export const radarAxisSchema = z.enum([
  "task_coverage",
  "knowledge_novelty",
  "process_completeness",
  "capability_transfer",
  "freshness_signal",
  "boundary_drift",
]);
export type RadarAxis = z.infer<typeof radarAxisSchema>;

export const radarItemSchema = z.object({
  id: z.string().min(1).max(200),
  axis: radarAxisSchema,
  direction: z.string().trim().min(2).max(400),
  /**
   * The concrete signal that exposed the gap, e.g. "6/12 份 JD 提到 X，图谱无对应
   * 节点". A vague signal ("感觉可以深化") is rejected by the signal gate rather
   * than presented to the user as an opportunity.
   */
  gapSignal: z.string().trim().min(1).max(600),
  affectedNodeIds: z.array(z.string().min(1).max(220)).min(1).max(40),
  /** Proposed by the model; ordering uses the recomputed score instead. */
  expectedGain: z.object({
    score: z.number().min(0).max(100),
    basis: z.string().trim().min(1).max(400),
  }),
  costEstimate: z.object({
    queries: z.number().int().min(0).max(64).default(4),
    tokens: z.number().int().min(0).max(200_000).default(4_000),
  }).default({ queries: 4, tokens: 4_000 }),
  /** What evidence would confirm or refute this direction. */
  requiredEvidence: z.string().trim().min(1).max(400),
});
export type RadarItem = z.infer<typeof radarItemSchema>;

export type RankedRadarItem = RadarItem & { rank: number; recomputedGain: number };

export type RadarRejection = { id: string; gate: "signal" | "dedupe"; reason: string };

export type RadarResult = {
  ranked: RankedRadarItem[];
  rejections: RadarRejection[];
};

export const RADAR_SEVERITY_WEIGHT: Record<"info" | "warning" | "error", number> = { info: 1, warning: 2, error: 3 };

/**
 * Rank radar candidates with three deterministic gates.
 *
 * 1. signal — the item must name affected nodes that exist in the snapshot, so
 *    an opportunity always points at something real.
 * 2. gain   — ordering comes from `affected nodes × node severity × objective
 *    relevance`; the model's own score is kept for transparency but never used
 *    to sort.
 * 3. dedupe — directions already decided (accepted, rejected or completed) are
 *    dropped, so the radar stops re-proposing what the user already answered.
 */
export function rankRadarItems(input: {
  items: RadarItem[];
  knownNodeIds: ReadonlySet<string>;
  /** Node id → severity, used to weight how much a gap matters. */
  nodeSeverity?: ReadonlyMap<string, "info" | "warning" | "error">;
  objective?: string;
  /** Normalized directions that must not be proposed again. */
  decidedDirections?: ReadonlySet<string>;
}): RadarResult {
  const ranked: RankedRadarItem[] = [];
  const rejections: RadarRejection[] = [];
  const seen = new Set<string>();

  for (const item of input.items) {
    if (!item.gapSignal.trim()) {
      rejections.push({ id: item.id, gate: "signal", reason: "没有给出具体缺口信号，不允许上雷达" });
      continue;
    }
    const unknown = item.affectedNodeIds.filter(id => !input.knownNodeIds.has(id));
    if (unknown.length) {
      rejections.push({ id: item.id, gate: "signal", reason: `影响的节点在当前快照中不存在：${unknown.join("、")}` });
      continue;
    }
    const direction = normalizeDirection(item.direction);
    if (input.decidedDirections?.has(direction) || seen.has(direction)) {
      rejections.push({ id: item.id, gate: "dedupe", reason: "该方向已被决定或已在本次雷达中提出，不再重复推荐" });
      continue;
    }
    seen.add(direction);

    const severity = item.affectedNodeIds.reduce((total, id) => total + RADAR_SEVERITY_WEIGHT[input.nodeSeverity?.get(id) || "warning"], 0);
    const relevance = objectiveRelevance(item, input.objective);
    ranked.push({ ...item, recomputedGain: Math.round(severity * relevance * 10) / 10, rank: 0 });
  }

  ranked.sort((left, right) => right.recomputedGain - left.recomputedGain
    || left.costEstimate.queries - right.costEstimate.queries
    || left.id.localeCompare(right.id));
  ranked.forEach((item, index) => { item.rank = index + 1; });
  return { ranked, rejections };
}

function normalizeDirection(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** Token overlap against the contract objective; neutral when no objective is set. */
function objectiveRelevance(item: RadarItem, objective?: string) {
  const target = normalizeDirection(objective || "");
  if (!target) return 1;
  const haystack = normalizeDirection(`${item.direction}${item.gapSignal}`);
  const tokens = [...new Set((objective || "").split(/[^\p{L}\p{N}]+/u).filter(token => token.length >= 2).map(normalizeDirection))];
  if (!tokens.length) return 1;
  const hits = tokens.filter(token => haystack.includes(token)).length;
  return 0.5 + (hits / tokens.length) * 0.5;
}

/** Confidence tiers: code-computed findings outrank anything a model proposes. */
export const riskClaimTierSchema = z.enum(["deterministic", "evidenced_hypothesis", "bare_hypothesis"]);
export type RiskClaimTier = z.infer<typeof riskClaimTierSchema>;

export const riskDomainSchema = z.object({
  domain: z.string().trim().min(2).max(120),
  claims: z.array(claimSchema).max(20).default([]),
});
export type RiskDomain = z.infer<typeof riskDomainSchema>;

export const riskPackageSchema = z.object({
  packageProtocol: z.literal("learnflow.risk-package.v1"),
  baseSnapshotId: z.string().min(1).max(220),
  generatedAt: z.string().min(1).max(40),
  domains: z.array(riskDomainSchema).max(12).default([]),
  /** Code-computed audit findings; these are trusted without review. */
  deterministicIssues: z.array(z.unknown()).max(400).default([]),
  metrics: z.unknown().optional(),
  /** The package is fuel for the next round, not a report that ends work. */
  researchAgenda: z.array(researchTaskCardSchema).max(40).default([]),
});
export type RiskPackage = z.infer<typeof riskPackageSchema>;

export type RiskPackageInput = {
  baseSnapshotId: string;
  generatedAt: string;
  issues: RiskIssue[];
  metrics?: RiskHealthMetrics;
  domains?: RiskDomain[];
  researchAgenda?: ResearchTaskCard[];
};

export function riskClaimTier(claim: Claim): RiskClaimTier {
  if (claim.kind === "observed" && claim.evidenceSpans.length > 0) return "evidenced_hypothesis";
  return claim.kind === "observed" ? "bare_hypothesis" : "evidenced_hypothesis";
}

/**
 * Assemble a risk package without ever upgrading a hypothesis into a finding.
 *
 * A deterministic issue carries the weight of code that recomputed it; a
 * hypothesised risk stays a hypothesis and is labelled as such, including
 * `severityBasis` so the reason for a severity is readable rather than a bare
 * adjective. Nothing is dropped for being unproven — an unproven risk is still
 * worth surfacing, it just must not read as established.
 */
export function buildRiskPackage(input: RiskPackageInput) {
  const domains = (input.domains || []).map(domain => ({
    domain: domain.domain,
    claims: domain.claims.map(claim => ({ claim, tier: riskClaimTier(claim) })),
  }));
  const counts = {
    deterministic: input.issues.length,
    evidencedHypothesis: domains.flatMap(domain => domain.claims).filter(item => item.tier === "evidenced_hypothesis").length,
    bareHypothesis: domains.flatMap(domain => domain.claims).filter(item => item.tier === "bare_hypothesis").length,
  };
  const packageValue: RiskPackage = riskPackageSchema.parse({
    packageProtocol: "learnflow.risk-package.v1",
    baseSnapshotId: input.baseSnapshotId,
    generatedAt: input.generatedAt,
    domains: input.domains || [],
    deterministicIssues: input.issues,
    metrics: input.metrics,
    researchAgenda: input.researchAgenda || [],
  });
  return { package: packageValue, domains, counts };
}

/** Severity must be argued, not asserted: an unexplained severity is rejected. */
export function severityBasis(issue: Pick<RiskIssue, "severity" | "impact" | "detail">) {
  const basis = (issue.impact || issue.detail || "").trim();
  if (!basis) throw new Error("severity 必须给出依据：缺少 impact 与 detail");
  return { severity: issue.severity, basis };
}

export const proposalKindSchema = z.enum(["risk_repair", "radar_item", "augmentation", "learning_mount"]);
export type ProposalKind = z.infer<typeof proposalKindSchema>;

export const proposalSchema = z.object({
  kind: proposalKindSchema,
  motivation: z.string().trim().min(1).max(1_000),
  claims: z.array(claimSchema).max(40).default([]),
  /** Deterministic execution boundary; never taken from free text. */
  scope: z.object({
    targetIds: z.array(z.string().min(1).max(220)).max(60).default([]),
    radius: z.number().int().min(0).max(3).default(0),
  }),
  plan: z.array(researchTaskCardSchema).max(40).default([]),
  acceptance: z.enum(["auto", "needs_user"]),
  rollbackNote: z.string().trim().min(1).max(600),
});
export type Proposal = z.infer<typeof proposalSchema>;

/**
 * Who may approve: code decides, the model only proposes.
 *
 * `autonomous` is not a licence to self-approve. Even there a proposal may only
 * auto-apply when the audit introduced no new error and every measured claim
 * passed review; anything unproven, or any other profile, waits for the user.
 */
export function decideAcceptance(input: {
  initiativeProfile: "autonomous" | "co_guided" | "user_directed";
  auditClean: boolean;
  claims: Array<{ verification: string }>;
}): { acceptance: "auto" | "needs_user"; reason: string } {
  if (input.initiativeProfile !== "autonomous") {
    return { acceptance: "needs_user", reason: `${input.initiativeProfile} 模式下的变更始终需要用户确认` };
  }
  if (!input.auditClean) {
    return { acceptance: "needs_user", reason: "审计出现新错误，不能自动接受" };
  }
  const unverified = input.claims.filter(claim => claim.verification !== "verified").length;
  if (unverified) {
    return { acceptance: "needs_user", reason: `有 ${unverified} 条断言未通过复核，不能自动接受` };
  }
  return { acceptance: "auto", reason: "autonomous 模式且审计无新错误、断言全部通过复核" };
}

export function buildProposal(input: {
  kind: ProposalKind;
  motivation: string;
  /** Claims arrive with their review verdict; an unreviewed claim cannot approve a proposal. */
  claims: ReviewedClaim[];
  scope: Proposal["scope"];
  plan: ResearchTaskCard[];
  rollbackNote: string;
  initiativeProfile: "autonomous" | "co_guided" | "user_directed";
  auditClean: boolean;
}): { proposal: Proposal; decision: { acceptance: "auto" | "needs_user"; reason: string } } {
  const decision = decideAcceptance({
    initiativeProfile: input.initiativeProfile,
    auditClean: input.auditClean,
    claims: input.claims,
  });
  return {
    proposal: proposalSchema.parse({
      kind: input.kind,
      motivation: input.motivation,
      claims: input.claims.map(item => item.claim),
      scope: input.scope,
      plan: input.plan,
      acceptance: decision.acceptance,
      rollbackNote: input.rollbackNote,
    }),
    decision,
  };
}
