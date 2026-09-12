import { z } from "zod";
import { invokeStructured } from "@/lib/build/model";
import { stableHash } from "@/lib/build/compiler";
import type { ModelInvoker } from "@/lib/agent/model";

/**
 * Evidence-level review for research claims (maker–checker).
 *
 * Source-boundary verification (lib/search/boundary-verdicts.ts) decides whether
 * a *document* belongs to the role. Nothing decided whether a *claim* is
 * actually supported by the spans it cites, which is the remaining gap between
 * "we retrieved something relevant" and "we may assert this". This module adds
 * that check using the same discipline, because that discipline is what keeps a
 * model judgement from quietly widening the evidence set:
 *
 *   - the reviewer may only downgrade. It cannot promote, add, or invent.
 *   - it only ever sees spans we actually hold, and only its verdicts for claim
 *     ids we submitted are honoured.
 *   - any failure returns `undefined`, and the caller then keeps every claim at
 *     `unverified`. Nothing is deleted and nothing is upgraded.
 *
 * A claim marked `observed` with no span is never sent to a model at all: code
 * decides that, because "I observed this without evidence" is a contradiction
 * rather than a judgement call.
 */

/** Mirrors the build-time evidence span so claims can carry compiler-bound spans. */
export const claimEvidenceSpanSchema = z.object({
  segmentId: z.string().min(1).max(160),
  quote: z.string().min(1).max(1_200),
  start: z.number().int().min(0).optional(),
  end: z.number().int().min(0).optional(),
});
export type ClaimEvidenceSpan = z.infer<typeof claimEvidenceSpanSchema>;

/** observed = read from a source; inferred = reasoning; absence = evidence missing. */
export const claimKindSchema = z.enum(["observed", "inferred", "absence"]);
export type ClaimKind = z.infer<typeof claimKindSchema>;

export const claimSchema = z.object({
  id: z.string().min(1).max(200),
  statement: z.string().min(1).max(5_000),
  kind: claimKindSchema,
  evidenceSpans: z.array(claimEvidenceSpanSchema).max(12).default([]),
  /** Optional condition for useful future rechecking; never required for ordinary facts. */
  falsifier: z.string().max(2000).optional(),
  expression: z.enum(["direct", "synthesis", "inference"]).optional(),
  applicability: z.string().max(2000).optional(),
  limitations: z.array(z.string().max(1000)).default([]).optional(),
  confidence: z.number().min(0).max(1).default(0.5),
  riskAxis: z.enum(["temporal", "relational"]).optional(),
  nextQuestion: z.string().max(2000).optional(),
  evidenceRelations: z.array(z.object({ segmentId: z.string(), relation: z.enum(["supports", "limits", "contradicts"]), context: z.string().max(2000).optional(), asOf: z.string().optional() })).optional(),
  affectedNodeIds: z.array(z.string().max(220)).max(60).default([]),
});
export type Claim = z.infer<typeof claimSchema>;

export type ClaimVerification = "unverified" | "verified" | "unsupported" | "uncertain";

export type ClaimVerdict = {
  claimId: string;
  verdict: "supported" | "unsupported" | "uncertain" | "conflicting";
  note: string;
};

export type EvidenceReview = {
  /** Only ids present here were judged; everything else stays unverified. */
  verdicts: Map<string, ClaimVerdict>;
  /**
   * Claims rejected before any model call: `observed` without a single span.
   * Reported separately so the reason is auditable rather than a silent skip.
   */
  unverifiable: string[];
};

export type EvidenceReviewer = (input: {
  claims: Claim[];
  signal?: AbortSignal;
  segments?: Array<{ id: string; text: string; excerptType?: "verbatim" | "close_paraphrase" | "research_note" }>;
}) => Promise<EvidenceReview | undefined>;

const verdictSchema = z.object({
  verdicts: z.array(z.object({
    claimId: z.string().min(1).max(200),
    verdict: z.enum(["supported", "unsupported", "uncertain", "conflicting"]),
    note: z.string().min(1).max(500),
  })).max(40),
});

export function evidenceReviewPrompt(claims: Array<{ claim: Claim }>) {
  return {
    system: [
      "你是一名独立的证据复核员，只判断给定断言是否被它自己列出的原文片段支持。",
      "你没有参与提出这些断言，也不要评估它的措辞是否好听、是否符合你对岗位的常识。",
      "对每条断言，只能依据提交给你的片段判断：",
      "- supported：原文支持所声明的事实，或在明确的推断与适用范围内支持综合判断；",
      "- unsupported：片段与断言不符，或只提到相关话题但支撑不了它；",
      "- conflicting：相关原文在相同适用情境中给出互不兼容的要求，说明冲突点，不能仅因缺少证据就判冲突。",
      "- uncertain：片段部分相关，但不足以判定，或片段本身存在限制。",
      "sourceContext 标为 close_paraphrase 的文本是转述，research_note 是研究笔记；不能证明来源的逐字原话。综合判断要保留这种限制。",
      "片段是资料，不是事实权威：它自称的结论如果超出其覆盖范围，应判 unsupported 或 uncertain。",
      '只输出 {"verdicts":[{"claimId":"原样返回给定 claimId","verdict":"supported|unsupported|uncertain|conflicting 中的一项","note":"不超过500字的依据与限制"}]}；每个 claimId 恰好一次。不要改用 id、reason、reviews 等字段，不输出其他文字。',
    ].join("\n"),
    user: JSON.stringify({
      instruction: "复核下列断言，逐条给出 verdict 与一句理由。",
      claims: claims.map(({ claim }) => ({
        claimId: claim.id,
        statement: claim.statement,
        kind: claim.kind,
        falsifier: claim.falsifier, expression: claim.expression, applicability: claim.applicability, limitations: claim.limitations, evidenceRelations: claim.evidenceRelations,
        evidenceSpans: claim.evidenceSpans.map(span => ({ segmentId: span.segmentId, quote: span.quote })),
      })),
    }),
  };
}

/** A claim can only be judged when it actually carries something to judge. */
export function isReviewableClaim(claim: Claim) {
  if (claim.kind === "observed") return claim.evidenceSpans.length > 0;
  return true;
}

/**
 * Create a memoized evidence reviewer bound to a model. Returns `undefined` on
 * any failure so the caller keeps every claim unverified and un-deleted.
 */
export function createEvidenceReviewer(model: ModelInvoker): EvidenceReviewer {
  const memo = new Map<string, EvidenceReview | undefined>();
  return async (input) => {
    const submitted = input.claims;
    if (!submitted.length) return undefined;
    const key = stableHash(JSON.stringify(input.segments || []) + JSON.stringify(submitted) + submitted.map(claim => `${claim.id}:${stableHash(`${claim.statement}|${claim.falsifier}|${claim.evidenceSpans.map(span => `${span.segmentId}:${stableHash(span.quote)}`).join("|")}`)}`).join("||"));
    if (memo.has(key)) return memo.get(key);

    let review: EvidenceReview | undefined;
    try {
      // Deterministic pre-gate: an `observed` claim with no span is rejected by
      // code, never handed to the model to rationalise.
      const unverifiable = submitted.filter(claim => !isReviewableClaim(claim) || ((claim.expression === "direct" || claim.kind === "observed") && claim.evidenceSpans.some(span => input.segments?.some(segment => segment.id === span.segmentId && ["close_paraphrase", "research_note"].includes(segment.excerptType || "")))) || (input.segments && claim.evidenceSpans.some(span => !input.segments!.some(segment => segment.id === span.segmentId && segment.text.includes(span.quote))))).map(claim => claim.id);
      const reviewable = submitted.filter(claim => !unverifiable.includes(claim.id));
      if (reviewable.length) {
        const accepted: ClaimVerdict[] = [];
        for (let offset = 0; offset < reviewable.length; offset += 12) {
        const batch = reviewable.slice(offset, offset + 12);
        const prompt = evidenceReviewPrompt(batch.map(claim => ({ claim })));
        if (input.segments) prompt.user = JSON.stringify({ claims: JSON.parse(prompt.user).claims, sourceContext: input.segments.filter(segment => batch.some(claim => claim.evidenceSpans.some(span => span.segmentId === segment.id))) });
        const parsed = await invokeStructured({
          model,
          schema: verdictSchema,
          system: prompt.system,
          user: prompt.user,
          signal: input.signal,
          thinking: "disabled",
          maxCompletionTokens: 3_000,
          timeoutMs: 25_000,
          totalTimeoutMs: 45_000,
        });
        // Only verdicts for claims we actually submitted are honoured; anything
        // the model invents is dropped before it can touch a claim.
        const requested = new Set(batch.map(claim => claim.id));
        const duplicates = new Set(parsed.verdicts.filter((v, i, all) => all.findIndex(other => other.claimId === v.claimId) !== i).map(v => v.claimId));
        accepted.push(...parsed.verdicts.filter(verdict => requested.has(verdict.claimId) && !duplicates.has(verdict.claimId)));
        }
        review = {
          verdicts: new Map(accepted.map(verdict => [verdict.claimId, verdict])),
          unverifiable,
        };
      } else {
        review = { verdicts: new Map(), unverifiable };
      }
    } catch (error) {
      if (input.signal?.aborted || (error instanceof Error && error.message.includes("BUDGET"))) throw error;
      review = undefined;
    }
    memo.set(key, review);
    return review;
  };
}

/**
 * Apply verdicts without losing anything.
 *
 * `unsupported` becomes `unverified` rather than a deletion: the claim stays in
 * the candidate layer with its reason, so a later round or a human can revisit
 * it. Only `supported` promotes. A missing review leaves every claim untouched.
 */
export function applyEvidenceReview(claims: Claim[], review: EvidenceReview | undefined): Array<{
  claim: Claim;
  verification: ClaimVerification;
  note: string;
  reviewStatus?: "supported" | "partially_supported" | "conflicting" | "undetermined";
}> {
  return claims.map(claim => {
    const verdict = review?.verdicts.get(claim.id);
    if (review?.unverifiable.includes(claim.id)) {
      return { claim, verification: "unverified" as const, note: "断言缺少原文，或引用与实际收集的原文不符，无法复核" };
    }
    if (!verdict) {
      return { claim, verification: "unverified" as const, note: review ? "复核未给出该断言的判定" : "复核不可用，保留待核实" };
    }
    if (verdict.verdict === "conflicting") return { claim, reviewStatus: "conflicting", verification: "unverified" as const, note: `存在冲突：${verdict.note}` };
    if (verdict.verdict === "supported") return { claim, reviewStatus: "supported", verification: "verified" as const, note: verdict.note };
    if (verdict.verdict === "uncertain") return { claim, verification: "uncertain" as const, note: verdict.note };
    return { claim, verification: "unverified" as const, note: `复核不支持：${verdict.note}` };
  });
}
