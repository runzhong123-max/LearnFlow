import { z } from "zod";
import type { ModelInvoker } from "@/lib/agent/model";
import { runResearchLoop, type ResearchBudget, type ResearchLoopEvent, type ResearchStopReason, type ResearchTool } from "@/lib/agent/research-loop";
import {
  applyEvidenceReview,
  claimSchema,
  createEvidenceReviewer,
  type Claim,
  type ClaimVerification,
} from "@/lib/iteration/evidence-review";

/**
 * One research worker: a bounded tool loop that returns claims which have
 * already been through independent evidence review.
 *
 * This is the join between the two primitives that previously stood alone —
 * `runResearchLoop` (can investigate, cannot judge) and `createEvidenceReviewer`
 * (can judge, cannot investigate). Keeping them composed here rather than
 * letting the loop return directly means a worker can never hand back an
 * unreviewed assertion: what comes out is either `verified`, or explicitly
 * `unverified`/`uncertain` with the reason attached.
 *
 * The worker never writes to the graph. It returns data the deterministic
 * rebuild path may consume, which is what keeps model research from becoming a
 * direct graph mutation.
 */

export const researchTaskCardSchema = z.object({
  id: z.string().min(1).max(200),
  question: z.string().min(1).max(600),
  /** What evidence class this line of work must draw on. Drives tool choice. */
  sourceClass: z.enum(["official_standard", "job_market", "primary_docs", "incident", "academic"]),
  why: z.object({
    findingIds: z.array(z.string().max(220)).max(40).default([]),
    detail: z.string().max(600).default(""),
  }).default({ findingIds: [], detail: "" }),
  queriesHint: z.array(z.string().max(300)).max(12).default([]),
  budget: z.object({
    queries: z.number().int().min(1).max(64).default(8),
  }).default({ queries: 8 }),
});
export type ResearchTaskCard = z.infer<typeof researchTaskCardSchema>;

export const workerBudgetSchema = z.object({
  maxTurns: z.number().int().min(1).max(32).default(6),
  maxToolCalls: z.number().int().min(1).max(64).default(10),
  maxTranscriptChars: z.number().int().min(1_000).max(64_000).default(20_000),
});
export type WorkerBudget = z.infer<typeof workerBudgetSchema>;

export type ReviewedClaim = {
  claim: Claim;
  verification: ClaimVerification;
  note: string;
};

export type ResearchWorkerResult = {
  cardId: string;
  claims: ReviewedClaim[];
  /** Claims the reviewer could not support, kept rather than discarded. */
  rejectedCount: number;
  stopReason: ResearchStopReason;
  stopDetail?: string
  transcript: ResearchLoopEvent[];
  usage: { turns: number; toolCalls: number };
};

const claimsPayloadSchema = z.object({
  claims: z.array(claimSchema).max(24),
  gaps: z.array(z.string().max(500)).max(12).default([]),
});

export function workerFinalShape() {
  return '{"claims":[{"id":"c1","statement":"...","kind":"observed|inferred|absence","evidenceSpans":[{"segmentId":"...","quote":"..."}],"falsifier":"...","confidence":0.0}],"gaps":["仍然缺失的证据"]}';
}

export function workerSystemPrompt(input: { persona: string; tools: ResearchTool[]; card: ResearchTaskCard }) {
  return [
    input.persona,
    "",
    `本轮研究任务（${input.card.sourceClass}）：${input.card.question}`,
    input.card.why.detail ? `任务动因：${input.card.why.detail}` : "",
    input.card.queriesHint.length ? `参考检索方向：${input.card.queriesHint.join("；")}` : "",
    "",
    "产出要求：",
    "- 每条 claim 必须自洽：kind=observed 时必须附至少一条原文片段（segmentId 与 quote 逐字来自工具返回），否则该条会被直接丢弃。",
    "- falsifier 写明“什么证据出现会推翻这条断言”，这是必填项。",
    "- 只写观察与推断得出的内容；不要用常识补齐工具没有返回的部分。",
    "- 证据不足时把它写进 gaps，不要用措辞掩盖缺口。",
    "",
    `最终只输出一个 JSON 对象，形状为：${workerFinalShape()}`,
  ].filter(Boolean).join("\n");
}

/**
 * Run one research card and return claims already carrying a review verdict.
 *
 * A claim that fails review is downgraded, never removed: it stays in the
 * result with the reviewer's reason so a later round or a human can revisit it.
 */
export async function runResearchWorker(input: {
  model: ModelInvoker
  card: ResearchTaskCard
  tools: ResearchTool[]
  persona?: string
  budget?: Partial<WorkerBudget>
  signal?: AbortSignal
  onEvent?: (event: ResearchLoopEvent) => void
}): Promise<ResearchWorkerResult> {
  const card = researchTaskCardSchema.parse(input.card);
  const budget = workerBudgetSchema.parse(input.budget || {});
  const loopBudget: ResearchBudget = {
    maxTurns: budget.maxTurns,
    maxToolCalls: budget.maxToolCalls,
    maxTranscriptChars: budget.maxTranscriptChars,
  };

  const loop = await runResearchLoop<{ claims: Claim[]; gaps: string[] }>({
    model: input.model,
    system: workerSystemPrompt({
      persona: input.persona || "你是一名岗位研究员：围绕一个问题收集可追溯的证据，只报告证据支持的结论。",
      tools: input.tools,
      card,
    }),
    task: card.question,
    tools: input.tools,
    budget: loopBudget,
    signal: input.signal,
    onEvent: input.onEvent,
    // A malformed claim is a reason to stop, not a reason to keep the rest:
    // silently dropping entries would misreport the study as thinner than it is.
    validateFinal: (value) => {
      const parsed = claimsPayloadSchema.parse(value);
      const seen = new Set<string>();
      for (const claim of parsed.claims) {
        if (seen.has(claim.id)) throw new Error(`claim id 重复：${claim.id}`);
        seen.add(claim.id);
      }
      return { claims: parsed.claims, gaps: parsed.gaps };
    },
  });

  const claims = loop.final?.claims || [];
  const review = claims.length
    ? await createEvidenceReviewer(input.model)({ claims, signal: input.signal })
    : undefined;
  const applied = applyEvidenceReview(claims, review);

  return {
    cardId: card.id,
    claims: applied,
    rejectedCount: applied.filter(item => item.verification === "unverified").length,
    stopReason: loop.stopReason,
    ...(loop.stopDetail ? { stopDetail: loop.stopDetail } : {}),
    transcript: loop.transcript,
    usage: loop.usage,
  };
}

/** Only claims the reviewer supported may feed a graph write. */
export function verifiedClaims(result: ResearchWorkerResult) {
  return result.claims.filter(item => item.verification === "verified").map(item => item.claim);
}

/**
 * Run several cards with bounded in-process concurrency.
 *
 * Fan-out stays inside one process on purpose: the durable job table allows a
 * single active role job per conversation, so spawning a job per card would
 * collide with that constraint rather than scale.
 */
export async function runResearchWorkers(input: {
  cards: ResearchTaskCard[]
  concurrency?: number
  runOne: (card: ResearchTaskCard) => Promise<ResearchWorkerResult>
  onResult?: (result: ResearchWorkerResult) => void
}): Promise<ResearchWorkerResult[]> {
  const concurrency = Math.max(1, Math.min(input.concurrency || 2, 8));
  const results: ResearchWorkerResult[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, input.cards.length) }, async () => {
    while (cursor < input.cards.length) {
      const card = input.cards[cursor];
      cursor += 1;
      const result = await input.runOne(card);
      results.push(result);
      input.onResult?.(result);
    }
  });
  await Promise.all(workers);
  return results;
}
