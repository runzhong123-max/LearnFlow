import type { ModelInvoker } from "@/lib/agent/model";
import type { SearchProviderConfig } from "@/lib/search/providers";
import { createBudgetLedger, defaultReviewReserve, type BudgetLedger } from "./budget-ledger";
import { createReadOnlyToolset, createResearchToolset } from "./research-tools";
import { createResearchSupervisor } from "./supervisor";
import { runResearchWorker, type ResearchTaskCard, type ResearchWorkerResult } from "./worker";
import type { IterationContract, IterationWorkItem } from "./types";
import type { ColdStartBuildResult, ColdStartRequest, SourceAsset, SourceSegment } from "@/lib/build/types";

/**
 * Assemble the research agent from the parts that were built separately.
 *
 * Assembly lives here rather than in the route so the composition itself is
 * testable: the route only decides *whether* to enable it, and the wiring that
 * matters — plan through the supervisor, run through the worker over read-only
 * tools, spending through one ledger — is verifiable without an HTTP request.
 *
 * Default concurrency is deliberately low. Fan-out stays inside one process
 * because the durable job table allows a single active role job per
 * conversation, and each worker holds a model budget of its own.
 */
export const DEFAULT_RESEARCH_CONCURRENCY = 2;

export type ResearchAgentParts = {
  plan: (input: {
    contract: IterationContract;
    workItems: IterationWorkItem[];
    round: number;
    signal?: AbortSignal;
  }) => Promise<ResearchTaskCard[]>;
  run: (card: ResearchTaskCard, input: {
    signal?: AbortSignal;
    request: ColdStartRequest;
    segments: SourceSegment[];
    assets: SourceAsset[];
  }) => Promise<ResearchWorkerResult>;
  concurrency: number;
  budgetLedger: BudgetLedger;
};

export function buildResearchAgent(input: {
  model: ModelInvoker;
  /** Absent means read-only research: the agent may only read what was retrieved. */
  searchConfig?: SearchProviderConfig;
  budgetLedger?: BudgetLedger;
  concurrency?: number;
  onDegrade?: (reason: string) => void;
}): ResearchAgentParts {
  const supervisor = createResearchSupervisor({
    model: input.model,
    ...(input.onDegrade ? { onDegrade: info => input.onDegrade!(info.reason) } : {}),
  });
  return {
    plan: ({ contract, workItems, round, signal }) => supervisor.plan({ contract, workItems, round, signal }),
    run: (card, context) => runResearchWorker({
      model: input.model,
      card,
      tools: input.searchConfig
        ? createResearchToolset({
          request: context.request,
          config: input.searchConfig,
          segments: context.segments,
          assets: context.assets,
        })
        // Without a provider the agent still works, but only over material this
        // round already holds — it cannot quietly reach the network.
        : createReadOnlyToolset({ segments: context.segments, assets: context.assets }),
      signal: context.signal,
    }),
    concurrency: input.concurrency || DEFAULT_RESEARCH_CONCURRENCY,
    budgetLedger: input.budgetLedger || createBudgetLedger({
      total: { queries: 192, tokens: 1_000_000, turns: 64 },
      reviewReserve: defaultReviewReserve({ queries: 192, tokens: 1_000_000, turns: 64 }),
    }),
  };
}

/**
 * Whether agent research is active for this deployment.
 *
 * Opt-in on purpose: turning it on changes what an iteration actually does and
 * spends model budget, so it must be a deliberate operator decision rather than
 * something a code change silently enables. Absent or any value other than "1"
 * keeps the iteration exactly as it was.
 */
export function researchAgentEnabled(env: Record<string, string | undefined> = process.env) {
  return String(env.ROLE_ATLAS_RESEARCH_AGENT || "").trim() === "1";
}

/** Ledger sized from the run's own budget so research cannot outspend the round. */
export function ledgerForRun(input: { queryBudget: number; maxRounds: number }) {
  const total = {
    queries: input.queryBudget,
    tokens: 1_000_000,
    turns: Math.max(1, input.maxRounds) * 4,
  };
  return createBudgetLedger({ total, reviewReserve: defaultReviewReserve(total) });
}

export type { ColdStartBuildResult };
