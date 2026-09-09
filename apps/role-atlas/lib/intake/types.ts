import { z } from "zod/v4";
import { sourceInputSchema, type SourceInput, type WebResearchReport } from "@/lib/build/types";
import type { IntakeHubMatch } from "./hub";

export type { IntakeHubMatch } from "./hub";
export type IntakePhase = "clarifying" | "review" | "confirmed";
export type IntakeHistoryItem = { id: string; role: "user" | "assistant"; text: string; createdAt: string; revisionId?: string };
export type IntakeView = {
  phase: IntakePhase;
  revisionId: string | null;
  contentHash: string | null;
  roleTitle: string;
  market: string;
  goal?: string;
  description: string;
  assistantMessage: string;
  questions: string[];
  /** Suggestions require an explicit user selection before a JD draft is generated. */
  roleCandidates?: Array<{ title: string; reason: string }>;
  sources: SourceInput[];
  hubMatches: IntakeHubMatch[];
  history: IntakeHistoryItem[];
  warnings: string[];
  researchStatus: "not_started" | "complete" | "partial" | "failed";
  buildRunId?: string;
  recovery?: {
    revisionId: string;
    state: "failed" | "interrupted";
    input: Omit<IntakeTurnInput, "providerConfig" | "searchConfig">;
    message: string;
  };
};

const identity = z.string().min(4).max(100);
export const intakeTurnSchema = z.object({
  action: z.enum(["clarify", "draft", "refine"]),
  operationId: identity,
  expectedRevisionId: z.string().min(4).max(160).nullable().optional(),
  message: z.string().max(8_000).default(""),
  roleTitle: z.string().max(120).optional(),
  market: z.string().max(120).optional(),
  goal: z.string().max(8_000).optional(),
  sources: z.array(sourceInputSchema).max(20).optional(),
  providerConfig: z.unknown().optional(),
  searchConfig: z.unknown().optional(),
});
export const intakeConfirmSchema = z.object({
  revisionId: z.string().min(4).max(160),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: identity,
  buildRunId: identity.optional(),
});
export type IntakeTurnInput = z.infer<typeof intakeTurnSchema>;
export type IntakeConfirmInput = z.infer<typeof intakeConfirmSchema>;
export type IntakeScope = { projectId: string; conversationId: string; subjectId: string };
export type IntakeRevisionContent = Omit<IntakeView, "revisionId" | "contentHash" | "history" | "buildRunId" | "phase" | "recovery"> & {
  phase: "clarifying" | "review";
  goal: string;
  researchReport?: WebResearchReport;
  /** Preliminary retrieval originals remain archived even when twenty supplied materials fill the build source limit. */
  researchSources?: SourceInput[];
};
export type ConfirmedIntake = {
  revisionId: string;
  contentHash: string;
  roleTitle: string;
  market: string;
  description: string;
  sources: SourceInput[];
  confirmedAt: string;
  buildRunId: string;
};

export class IntakeError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
