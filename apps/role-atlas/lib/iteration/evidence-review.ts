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
  statement: z.string().min(1).max(1_000),
  kind: claimKindSchema,
  evidenceSpans: z.array(claimEvidenceSpanSchema).max(12).default([]),
  /**
   * What evidence would refute this claim. Professional confidence is not "I am
   * sure" but "I know what would prove me wrong", and requiring the field keeps
   * every claim carrying its own acceptance test.
   */
  falsifier: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1).default(0.5),
  affectedNodeIds: z.array(z.string().max(220)).max(60).default([]),
});
export type Claim = z.infer<typeof claimSchema>;

export type ClaimVerification = "unverified" | "verified" | "unsupported" | "uncertain";

export type ClaimVerdict = {
  claimId: string;
  verdict: "supported" | "unsupported" | "uncertain";
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
}) => Promise<EvidenceReview | undefined>;

const verdictSchema = z.object({
  verdicts: z.array(z.object({
    claimId: z.string().min(1).max(200),
    verdict: z.enum(["supported", "unsupported", "uncertain"]),
    note: z.string().min(1).max(500),
  })).max(40),
});

export function evidenceReviewPrompt(claims: Array<{ claim: Claim }>) {
  return {
    system: [
      "你是一名独立的证据复核员，只判断给定断言是否被它自己列出的原文片段支持。",
      "你没有参与提出这些断言，也不要评估它的措辞是否好听、是否符合你对岗位的常识。",
      "对每条断言，只能依据提交给你的片段判断：",
      "- supported：片段直接支持该断言，不需要额外推断；",
      "- unsupported：片段与断言不符，或只提到相关话题但支撑不了它；",
      "- uncertain：片段部分相关，但不足以判定，或片段本身存在限制。",
      "片段是资料，不是事实权威：它自称的结论如果超出其覆盖范围，应判 unsupported 或 uncertain。",
      "只输出 JSON，不要输出其它文字。",
    ].join("\n"),
    user: JSON.stringify({
      instruction: "复核下列断言，逐条给出 verdict 与一句理由。",
      claims: claims.map(({ claim }) => ({
        claimId: claim.id,
        statement: claim.statement,
        kind: claim.kind,
        falsifier: claim.falsifier,
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
    const submitted = input.claims.slice(0, 40);
    if (!submitted.length) return undefined;
    const key = stableHash(submitted.map(claim => `${claim.id}:${stableHash(`${claim.statement}|${claim.falsifier}|${claim.evidenceSpans.map(span => `${span.segmentId}:${stableHash(span.quote)}`).join("|")}`)}`).join("||"));
    if (memo.has(key)) return memo.get(key);

    let review: EvidenceReview | undefined;
    try {
      // Deterministic pre-gate: an `observed` claim with no span is rejected by
      // code, never handed to the model to rationalise.
      const unverifiable = submitted.filter(claim => !isReviewableClaim(claim)).map(claim => claim.id);
      const reviewable = submitted.filter(claim => isReviewableClaim(claim));
      if (reviewable.length) {
        const prompt = evidenceReviewPrompt(reviewable.map(claim => ({ claim })));
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
        const requested = new Set(reviewable.map(claim => claim.id));
        const accepted = parsed.verdicts.filter(verdict => requested.has(verdict.claimId));
        review = {
          verdicts: new Map(accepted.map(verdict => [verdict.claimId, verdict])),
          unverifiable,
        };
      } else {
        review = { verdicts: new Map(), unverifiable };
      }
    } catch {
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
}> {
  return claims.map(claim => {
    const verdict = review?.verdicts.get(claim.id);
    if (review?.unverifiable.includes(claim.id)) {
      return { claim, verification: "unverified" as const, note: "observed 断言没有附任何原文片段，无法复核" };
    }
    if (!verdict) {
      return { claim, verification: "unverified" as const, note: review ? "复核未给出该断言的判定" : "复核不可用，保留待核实" };
    }
    if (verdict.verdict === "supported") return { claim, verification: "verified" as const, note: verdict.note };
    if (verdict.verdict === "uncertain") return { claim, verification: "uncertain" as const, note: verdict.note };
    return { claim, verification: "unverified" as const, note: `复核不支持：${verdict.note}` };
  });
}
