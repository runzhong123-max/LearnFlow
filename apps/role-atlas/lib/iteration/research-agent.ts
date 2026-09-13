import type { ModelInvoker } from "@/lib/agent/model";
import type { ResearchLoopCheckpoint } from "@/lib/agent/research-loop";
import type { SearchProviderConfig } from "@/lib/search/providers";
import { createBudgetLedger, defaultReviewReserve, type BudgetLedger, type BudgetLedgerSnapshot } from "./budget-ledger";
import { createReadOnlyToolset, createResearchToolset } from "./research-tools";
import { createResearchSupervisor } from "./supervisor";
import { runResearchWorker, type ResearchTaskCard, type ResearchWorkerResult } from "./worker";
import type { IterationContract, IterationWorkItem } from "./types";
import type { ColdStartRequest, ColdStartBuildResult, SourceAsset, SourceSegment, SourceInput } from "@/lib/build/types";
import { ResearchSourceStore } from "@/lib/research/source-store";
import { meteredModel } from "@/lib/research/metered-model";
import { researchBudgetSchema, researchOptionsSchema, RESEARCH_PROTOCOL, type ResearchRun, type ResearchBudgetConfig, type ResearchStopReason } from "@/lib/research/protocol";

import { changeProposalTool } from "@/lib/research/semantic-changes";
import { researchRecordTools } from "@/lib/research/record-tools";
import { stableHash } from "@/lib/build/compiler";

export const DEFAULT_RESEARCH_CONCURRENCY = 4;
export type ResearchAgentCheckpoint = { protocol: "role-research/v2"; budget: BudgetLedgerSnapshot; assets: SourceAsset[]; segments: SourceSegment[]; collected: SourceInput[]; sessions: Record<string, ResearchLoopCheckpoint>; results: ResearchWorkerResult[]; cards?: ResearchTaskCard[]; planning?: boolean; run?: ResearchRun };
export type ResearchAgentParts = {
  plan: (input: { contract: IterationContract; workItems: IterationWorkItem[]; round: number; context?: unknown; graph?: ColdStartBuildResult; base?: ColdStartBuildResult; sources?: { assets: SourceAsset[]; segments: SourceSegment[] }; signal?: AbortSignal }) => Promise<ResearchTaskCard[]>;
  run: (card: ResearchTaskCard, input: { signal?: AbortSignal; request: ColdStartRequest; segments: SourceSegment[]; assets: SourceAsset[]; graph?: ColdStartBuildResult }) => Promise<ResearchWorkerResult>;
  concurrency: number; budgetLedger: BudgetLedger; model: ModelInvoker; reviewModel: ModelInvoker;
  collectedSources: () => SourceInput[];
  record: () => ResearchRun | undefined;
  updateRecord: (value: ResearchRun) => Promise<void>;
  finish: (reason: ResearchStopReason) => Promise<void>;
  snapshot: () => ResearchAgentCheckpoint;
  restore: (checkpoint: ResearchAgentCheckpoint) => void;
};
export function buildResearchAgent(input: {
  model: ModelInvoker; searchConfig?: SearchProviderConfig; budgetLedger?: BudgetLedger; concurrency?: number;
  budget?: Partial<ResearchBudgetConfig>; onDegrade?: (reason: string) => void;
  onCheckpoint?: (checkpoint: ResearchAgentCheckpoint) => Promise<void>;
}): ResearchAgentParts {
  const config = researchBudgetSchema.parse(input.budget || {});
  const ledger = input.budgetLedger || ledgerForRun({ queryBudget: config.queries, maxRounds: config.revisions, tokens: config.tokens });
  let store = new ResearchSourceStore(), sessions: Record<string, ResearchLoopCheckpoint> = {}, results: ResearchWorkerResult[] = [];
  let run: ResearchRun | undefined, pendingCards: ResearchTaskCard[] = [];
  let planning = false;
  const snapshot = (): ResearchAgentCheckpoint => ({ protocol: "role-research/v2", budget: ledger.snapshot(), assets: structuredClone(store.assets), segments: structuredClone(store.segments), collected: structuredClone(store.collected), sessions: structuredClone(sessions), results: structuredClone(results), run: structuredClone(run), cards: structuredClone(pendingCards), planning });
  // Serialize durable writes from parallel workers, preserving the latest complete state.
  let saving = Promise.resolve();
  const save = () => { saving = saving.then(() => input.onCheckpoint?.(snapshot())); return saving; };
  const model = meteredModel(input.model, ledger, "general", save), reviewModel = meteredModel(input.model, ledger, "evidence_review", save);
  const supervisor = createResearchSupervisor({ model, onDegrade: info => input.onDegrade?.(info.reason) });
  return {
    model, reviewModel, budgetLedger: ledger, concurrency: input.concurrency ?? config.concurrency, snapshot,
    record: () => run ? structuredClone({ ...run, budget: ledger.snapshot() }) : undefined,
    updateRecord: async value => { if (run && value.id !== run.id) throw new Error("RESEARCH_RUN_ID_MISMATCH"); run = structuredClone(value); await save(); },
    finish: async reason => { if (run) run.stopReason = reason; await save(); },
    restore: value => {
      if (value.protocol !== "role-research/v2") throw new Error("Incompatible research protocol");
      ledger.restore(value.budget); store = new ResearchSourceStore(value.assets, value.segments);
      store.collected.push(...value.collected); sessions = structuredClone(value.sessions); results = structuredClone(value.results); run = structuredClone(value.run); pendingCards = structuredClone(value.cards || []); planning = Boolean(value.planning);
    },
    collectedSources: () => structuredClone(store.collected),
    plan: async ({ contract, workItems, round, signal, context, graph, base, sources }) => {
      if (!run) run = { protocol: RESEARCH_PROTOCOL, id: contract.id, intent: { ...researchOptionsSchema.parse(contract.research || {}), objective: contract.objective, roleBoundary: graph?.brief.roleDescription || (context && typeof context === "object" && "boundary" in context ? String(context.boundary) : contract.objective), targetAsOf: contract.targetAsOf, publication: "explicit_user_action" }, agenda: { revision: 0, tasks: [], gaps: [], findingRefs: [] }, findings: [], changeSets: [] };
      const pending = pendingCards.filter(card => run!.agenda.tasks.some(task => task.id === card.id && ["queued", "running"].includes(task.status)));
      if (pending.length) return pending;
      const material = sources || graph?.sources;
      if (material) {
        for (const asset of material.assets) if (!store.assets.some(item => item.id === asset.id)) store.assets.push(structuredClone(asset));
        for (const segment of material.segments) if (!store.segments.some(item => item.id === segment.id)) store.segments.push(structuredClone(segment));
      }
      if (!planning && run.agenda.revision >= config.revisions) return [];
      if (!planning) { (run.agendaHistory ||= []).push(structuredClone(run.agenda)); run.agenda.revision += 1; }
      planning = true;
      await save();
      const supervisorKey = `supervisor:${run.agenda.revision}`;
      const cards = await supervisor.plan({ contract, workItems, round, signal, checkpoint: sessions[supervisorKey], onCheckpoint: async value => { sessions[supervisorKey] = value; await save(); }, tools: [...createReadOnlyToolset(store), ...researchRecordTools({ run, store, graph, save }), ...(graph ? [changeProposalTool({ base: base || graph, run, save })] : [])], context: { graph: context, sourceIndex: store.assets.slice(0, 20).map(asset => ({ id: asset.id, title: asset.title, segments: store.segments.filter(segment => segment.sourceId === asset.id).slice(0, 6).map(segment => segment.id) })), agenda: { revision: run.agenda.revision, tasks: run.agenda.tasks.map(task => ({ id: task.id, question: task.question.slice(0, 300), status: task.status })), gaps: run.agenda.gaps.slice(-12) }, findings: run.findings.slice(-24).map(item => ({ id: item.id, statement: item.claim.statement.slice(0, 500), review: item.review, nextQuestion: item.nextQuestion })), budget: ledger.snapshot() } });
      const remaining = Math.max(0, config.tasks - run.agenda.tasks.length);
      const distinct = [...new Map(cards.map(card => [card.id, card])).values()];
      const selected: ResearchTaskCard[] = [];
      let newTasks = 0;
      for (const card of distinct) {
        const old = run.agenda.tasks.find(task => task.id === card.id);
        if (old && old.question === card.question && old.status === "completed") continue;
        if (!old && newTasks++ >= remaining) continue;
        const task = { id: card.id, question: card.question, reason: card.why.detail, inputRefs: card.inputRefs || [], targetIds: contract.research?.targetIds || contract.targetIds, status: "queued" as const, findingRefs: [] };
        if (old) { Object.assign(old, task); delete sessions[card.id]; } else run.agenda.tasks.push(task);
        selected.push({ ...card, targetIds: task.targetIds });
      }
      pendingCards = selected; planning = false;
      await save();
      return selected;
    },
    run: async (card, context) => {
      for (const asset of context.assets) if (!store.assets.some(item => item.id === asset.id)) store.assets.push(structuredClone(asset));
      for (const segment of context.segments) if (!store.segments.some(item => item.id === segment.id)) store.segments.push(structuredClone(segment));
      const tools = input.searchConfig
        ? createResearchToolset({ request: context.request, config: input.searchConfig, segments: store.segments, assets: store.assets, store, ledger, onBudget: save })
        : createReadOnlyToolset({ segments: store.segments, assets: store.assets });
      if (run) tools.push(...researchRecordTools({ run, store, graph: context.graph, save }));
      const task = run?.agenda.tasks.find(item => item.id === card.id);
      if (task) task.status = "running";
      await save();
      let result: ResearchWorkerResult;
      do {
      result = await runResearchWorker({ model, reviewModel, card, tools, segments: store.segments, context: { objective: run?.intent.objective, roleBoundary: run?.intent.roleBoundary, changeScope: run?.intent.changeScope, sourceIndex: store.assets.slice(0, 20).map(asset => ({ id: asset.id, title: asset.title, locator: asset.locator, segments: store.segments.filter(segment => segment.sourceId === asset.id).slice(0, 6).map(segment => segment.id) })), selectedObjects: context.graph?.semantic.nodes.filter(node => card.targetIds?.includes(node.id)).slice(0, 6), budget: ledger.snapshot() }, signal: context.signal,
        budget: { maxTurns: config.turnsPerBatch, maxToolCalls: (sessions[card.id]?.toolCalls || 0) + config.turnsPerBatch * 8, maxTranscriptChars: 64_000 },
        checkpoint: sessions[card.id], onCheckpoint: async state => { sessions[card.id] = state; await save(); },
      });
      } while (result.stopReason === "max_turns" && ledger.snapshot().remainingResearch.tokens > 1000 && ledger.snapshot().remainingResearch.turns > 0 && !context.signal?.aborted);
      if (run) {
        for (const item of result.claims) {
          const existing = run.findings.find(finding => finding.claim.statement === item.claim.statement && JSON.stringify(finding.claim.evidenceSpans) === JSON.stringify(item.claim.evidenceSpans));
          const id = existing?.id || `finding:${stableHash(`${card.id}:${item.claim.id}:${item.claim.statement}`)}`;
          const review = item.reviewStatus || (item.verification === "verified" ? "supported" as const : item.verification === "uncertain" ? "partially_supported" as const : "undetermined" as const);
          if (existing) { existing.claim = item.claim; existing.review = review; }
          if (!run.findings.some(finding => finding.id === id)) run.findings.push({ id, claim: item.claim, axis: item.claim.riskAxis || "relational", consequence: card.why.detail || card.question, nextQuestion: item.claim.nextQuestion, review, adoption: "candidate" });
          if (task && !task.findingRefs.includes(id)) task.findingRefs.push(id);
        }
        run.agenda.findingRefs = run.findings.map(finding => finding.id);
        run.agenda.gaps = [...new Set([...run.agenda.gaps, ...(result.gaps || []), ...(result.stopReason !== "final" ? [`${card.question}：${result.stopDetail || result.stopReason}`] : [])])];
        if (task) task.status = result.stopReason === "final" ? result.gaps?.length ? "known_gap" : "completed" : result.stopReason === "model_error" ? "failed" : "known_gap";
      }
      results = [...results.filter(old => old.cardId !== result.cardId), result]; await save(); return result;
    },
  };
}
export function researchAgentEnabled(env: Record<string, string | undefined> = process.env) { return String(env.ROLE_ATLAS_RESEARCH_AGENT ?? "1").trim() !== "0"; }
export function ledgerForRun(input: { queryBudget: number; maxRounds: number; tokens?: number }) {
  const total = { queries: input.queryBudget, tokens: input.tokens ?? 2_000_000, turns: 1_000_000 };
  return createBudgetLedger({ total, reviewReserve: defaultReviewReserve(total) });
}
export type { ColdStartBuildResult } from "@/lib/build/types";
