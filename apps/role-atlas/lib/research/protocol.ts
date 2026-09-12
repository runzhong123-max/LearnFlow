import { z } from "zod/v4";
import type { ChatMessage } from "@/lib/agent/native-model";
import type { BudgetLedgerSnapshot } from "@/lib/iteration/budget-ledger";
import type { Claim } from "@/lib/iteration/evidence-review";

export const RESEARCH_PROTOCOL = "role-research/v2" as const;
export const researchBudgetSchema = z.object({
  tokens: z.number().int().min(1000).max(20_000_000).default(2_000_000),
  queries: z.number().int().min(1).max(20_000).default(512),
  tasks: z.number().int().min(1).max(1000).default(128),
  revisions: z.number().int().min(1).max(400).default(32),
  concurrency: z.number().int().min(1).max(8).default(4),
  turnsPerBatch: z.number().int().min(1).max(128).default(32),
  stagnantRounds: z.number().int().min(1).max(64).default(3),
});
export type ResearchBudgetConfig = z.infer<typeof researchBudgetSchema>;
export const researchOptionsSchema = z.object({
  protocol: z.literal(RESEARCH_PROTOCOL).default(RESEARCH_PROTOCOL),
  objective: z.string().max(8000).optional(),
  targetIds: z.array(z.string().max(240)).max(128).default([]),
  changeScope: z.enum(["selected", "role"]).default("role"),
  adoption: z.enum(["automatic", "review"]).default("automatic"),
  budget: researchBudgetSchema.default(() => researchBudgetSchema.parse({})),
});
export type ResearchOptions = z.infer<typeof researchOptionsSchema>;
export type ResearchIntent = ResearchOptions & { roleBoundary: string; targetAsOf: string; publication: "explicit_user_action" };
export type ResearchTask = { id: string; question: string; reason: string; inputRefs: string[]; targetIds: string[]; status: "queued" | "running" | "completed" | "known_gap" | "failed"; findingRefs: string[]; messages?: ChatMessage[] };
export type ResearchAgenda = { revision: number; tasks: ResearchTask[]; gaps: string[]; findingRefs: string[] };
export type ResearchFinding = { id: string; claim: Claim; axis: "temporal" | "relational"; consequence: string; nextQuestion?: string; review: "supported" | "partially_supported" | "conflicting" | "undetermined"; adoption: "candidate" | "adopted" | "superseded" | "deprecated" };
export type ResearchStopReason = "goal_reached" | "insufficient_material" | "no_progress" | "budget_exhausted" | "cancelled" | "failed";
export type ChangeSet = { id: string; baseSnapshotId: string; baseRootHash: string; motivation: string; targetIds: string[]; findingRefs: string[]; operations: Array<{ kind: "add" | "revise" | "attach_evidence" | "split" | "merge" | "replace" | "deprecate"; targetId: string; replacementIds?: string[]; payload: unknown }>; status: "candidate" | "needs_review" | "adopted" | "rejected"; checks: Array<{ layer: "integrity" | "evidence" | "quality"; passed: boolean; reason: string }> };
export type ResearchRun = { protocol: typeof RESEARCH_PROTOCOL; id: string; intent: ResearchIntent; agenda: ResearchAgenda; agendaHistory?: ResearchAgenda[]; findings: ResearchFinding[]; changeSets: ChangeSet[]; budget?: BudgetLedgerSnapshot; stopReason?: ResearchStopReason };
export function stopResearch(input: { cancelled?: boolean; failed?: boolean; goalReached?: boolean; budgetExhausted?: boolean; materialMissing?: boolean; stagnantRounds: number; limit: number }): ResearchStopReason | undefined {
  if (input.cancelled) return "cancelled";
  if (input.failed) return "failed";
  if (input.goalReached) return "goal_reached";
  if (input.budgetExhausted) return "budget_exhausted";
  if (input.materialMissing) return "insufficient_material";
  if (input.stagnantRounds >= input.limit) return "no_progress";
}
