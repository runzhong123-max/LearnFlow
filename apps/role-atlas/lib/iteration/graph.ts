import { compileResearchChanges } from "@/lib/research/semantic-changes";
import { describeChangeSet, linkResearchFindings } from "@/lib/research/change-set";
import { compareResearchQuality, reviewedFindingKeys } from "@/lib/research/quality";
import { stopResearch, type ResearchRun, type ResearchStopReason } from "@/lib/research/protocol";
import type { ResearchAgentCheckpoint } from "./research-agent";
import { END, getWriter, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod/v4";
import type { ModelInvoker } from "@/lib/agent/model";
import { prepareBuildInput, stableHash } from "@/lib/build/compiler";
import { qualifySources } from "@/lib/build/workflow";
import { refreshRolePackageManifest } from "@/lib/packages/role-package-manifest";
import { createColdStartSkill, mergeResearchReports } from "@/lib/build/graph";
import type { ColdStartBuildResult, ColdStartRequest, SourceAsset, SourceInput, SourceSegment, WebResearchReport } from "@/lib/build/types";
import { applyGraphPatch, computeSemanticDiff, proposeSafePatch } from "@/lib/risk/patch";
import type { GraphPatch } from "@/lib/risk/types";
import type { AugmentationProposal } from "./augmentation";
import { reconstructSourceInputs } from "@/lib/risk/research";
import { researchRoleSources } from "@/lib/search/web-research";
import { createBoundaryVerifier } from "@/lib/search/boundary-verdicts";
import type { SearchProviderConfig } from "@/lib/search/providers";
import { applyInspectionToSnapshot, findingIdentity, inspectSnapshot } from "./inspector";
import { preserveIterationGraph } from "./preserve-graph";
import { runResearchWorkers, type ResearchTaskCard, type ResearchWorkerResult, type ReviewedClaim } from "./worker";
import {
  createIterationContract,
  discoverIterationOpportunities,
  evaluateIteration,
  planIterationResearch,
  planIterationWork,
} from "./planner";
import { DEFAULT_ITERATION_BUDGET } from "./types";
import type { BudgetLedger } from "./budget-ledger";
import { rankRadarItems } from "./products";
import { applyAugmentation } from "./augmentation-splice";
import type {
  IterationContract,
  IterationEvent,
  IterationEventKind,
  IterationFinding,
  IterationOpportunity,
  IterationResearchPlan,
  IterationWorkItem,
  SnapshotInspection,
  SnapshotIterationRequest,
  SnapshotIterationResult,
  IterationProducts,
  IterationProductProposal,
} from "./types";

const IterationState = new StateSchema({
  researchCheckpoint: z.custom<ResearchAgentCheckpoint>().optional(),
  request: z.custom<SnapshotIterationRequest>(),
  base: z.custom<ColdStartBuildResult>(),
  candidate: z.custom<ColdStartBuildResult>(),
  round: z.number().int().default(1),
  stagnantRounds: z.number().int().default(0),
  roundBefore: z.custom<SnapshotInspection>().optional(),
  collectedSources: z.custom<SourceInput[]>().default(() => []),
  contract: z.custom<IterationContract>().optional(),
  inspectionBefore: z.custom<SnapshotInspection>().optional(),
  inspectionWorking: z.custom<SnapshotInspection>().optional(),
  inspectionAfter: z.custom<SnapshotInspection>().optional(),
  opportunities: z.custom<IterationOpportunity[]>().default(() => []),
  workItems: z.custom<IterationWorkItem[]>().default(() => []),
  findingHistory: z.custom<IterationFinding[]>().default(() => []),
  activeResearchPlan: z.custom<IterationResearchPlan>().optional(),
  researchPlans: z.custom<IterationResearchPlan[]>().default(() => []),
  researchReports: z.custom<WebResearchReport[]>().default(() => []),
  /**
   * Claims produced by agent research this round, each carrying an
   * evidence-review verdict. Round-scoped like activeResearchPlan: reset on the
   * next round so a stale claim can never be attributed to new work.
   */
  reviewedFindingKeys: z.array(z.string()).default([]),
  researchClaims: z.custom<ReviewedClaim[]>().default(() => []),
  researchedSources: z.custom<SourceInput[]>().default(() => []),
  patches: z.custom<GraphPatch[]>().default(() => []),
  migrations: z.record(z.string(), z.string()).default(() => ({})),
  evaluation: z.custom<ReturnType<typeof evaluateIteration>>().optional(),
  accepted: z.custom<{ candidate: ColdStartBuildResult; inspection: SnapshotInspection; evaluation: ReturnType<typeof evaluateIteration>; migrations: Record<string, string>; patches: GraphPatch[] }>().optional(),
  result: z.custom<SnapshotIterationResult>().optional(),
  resumeFrom: z.enum(["contract", "discovery", "research-plan", "research", "rebuild", "consolidate", "evaluate", "next-round"]).optional(),
});

type IterationStateType = typeof IterationState.State;

export function currentIterationResearchReport(plan: IterationResearchPlan | undefined, reports: WebResearchReport[]) {
  if (!plan?.queries.length) return undefined;
  const queryIds = new Set(plan.queries.map(query => query.id));
  // Query IDs include the round. Old checkpoints have reports but no separate
  // current-report field; never interpret the previous round as new work.
  return reports.findLast(report => report.queries.length > 0
    && report.queries.every(query => queryIds.has(query.id)));
}

export function mergeIterationSources(current: SourceInput[], incoming: SourceInput[], limit = 320) {
  const seen = new Set<string>();
  const ordered = [
    ...incoming.filter((source) => source.kind === "workspace_observation" || source.kind === "private_document"),
    ...incoming,
    ...current.filter((source) => source.kind === "workspace_observation" || source.kind === "private_document"),
    ...current.filter((source) => source.sourceTier === "authoritative" || source.sourceTier === "primary"),
    ...current,
  ];
  return ordered.filter((source) => {
    const key = source.locator ? `url:${source.locator}` : `content:${stableHash(`${source.title}:${source.content}`)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, Math.max(4, Math.min(limit, 320)));
}

export function iterationRepairFocus(input: { candidate: ColdStartBuildResult; contract?: IterationContract; workItems: IterationWorkItem[] }) {
  const objects = new Map([...input.candidate.semantic.nodes, ...input.candidate.process.scenarios, ...input.candidate.process.nodes].map(node => [node.id, node]));
  return [input.contract?.objective,
    "本轮只针对下列发现补证、补充具体知识技能及合法关系。保留已有任务 ID 和证据；不能把用户观察、组织事实或无来源推断伪装成已修复。",
    ...input.workItems.filter(item => item.status !== "completed" && item.status !== "skipped").slice(0, 32).map(item => [
      `${item.kind}：${item.title}。${item.detail.slice(0, 300)}`,
      ...item.targetIds.slice(0, 4).map(id => { const node = objects.get(id); return node ? `${id} | ${node.label} | ${node.summary.slice(0, 350)}` : id; }),
    ].join("\n")),
  ].filter(Boolean).join("\n").slice(0, 6_000);
}

function coldStartRequest(input: {
  state: IterationStateType;
  sources: SourceInput[];
}): ColdStartRequest {
  const { state } = input;
  return {
    research: state.request.research,
    runId: `${state.request.runId}:round:${state.round}`.slice(0, 100),
    projectId: state.request.projectId || state.request.snapshotRef.projectId || `snapshot:${stableHash(state.request.snapshotRef.snapshotId)}`,
    roleTitle: state.base.brief.roleTitle,
    roleDescription: state.base.brief.roleDescription.slice(0, 8_000),
    market: state.base.brief.market,
    audience: state.base.brief.audience,
    snapshotAsOf: state.contract?.targetAsOf || state.base.snapshot.asOf,
    // Existing mature snapshots can legitimately exceed the cold-start UI's
    // source input limit. Internal iteration must not discard that history.
    sources: input.sources.slice(0, 320),
    learningPathGraph: state.request.learningPathGraph,
  };
}

/** Attach fresh evidence without regenerating existing task identities. */
function withIncomingEvidence(base: ColdStartBuildResult, request: ColdStartRequest, incoming: SourceInput[]) {
  const raw = prepareBuildInput({ ...request, sources: incoming });
  const sourceKey = (source: ColdStartBuildResult["sources"]["assets"][number]) => JSON.stringify([source.kind, source.locator, source.contentHash]);
  const existing = new Set(base.sources.assets.map(sourceKey));
  const added = qualifySources(raw.assets, raw.segments).filter(asset => asset.kind !== "user_brief" && !existing.has(sourceKey(asset)));
  const addedIds = new Set(added.map(asset => asset.id));
  return { ...base, sources: { ...base.sources, assets: [...base.sources.assets, ...added],
    segments: [...base.sources.segments, ...raw.segments.filter(segment => addedIds.has(segment.sourceId))] } };
}

/** Evaluate the requested date before committing it; changing a date is not evidence gain. */
function snapshotAtTargetDate(candidate: ColdStartBuildResult, targetAsOf: string) {
  return { ...candidate, snapshot: { ...candidate.snapshot, asOf: targetAsOf } };
}

function evaluatedWorkItems(items: IterationWorkItem[], history: IterationFinding[], inspection: SnapshotInspection, accepted: boolean) {
  const remainingKeys = new Set(inspection.findings.map(findingIdentity));
  const originals = new Map(history.map(finding => [finding.id, finding]));
  return items.map(item => {
    const resolved = item.findingIds.length ? item.findingIds.every(id => {
      const original = originals.get(id);
      return original && !remainingKeys.has(findingIdentity(original));
    }) : accepted;
    return { ...item, status: resolved && accepted ? "completed" as const : "known_gap" as const };
  });
}

function stampSnapshot(candidate: ColdStartBuildResult, request: SnapshotIterationRequest, baseAsOf: string, asOf: string) {
  const result = structuredClone(candidate);
  const revision = stableHash(`${request.runId}:${JSON.stringify(result.semantic.nodes)}:${JSON.stringify(result.process.scenarios)}:${JSON.stringify(result.sources.assets.map((source) => source.contentHash))}`);
  const roleSlug = stableHash(result.brief.roleTitle);
  const snapshotId = `snapshot:${roleSlug}@${asOf}:${revision}`;
  const current = result.packages.rolePackage.packageVersion.match(/^(\d+)\.(\d+)\.(\d+)/u)?.slice(1).map(Number) || [0, 1, 0];
  const [major, minor, patch] = current;
  const changedTime = asOf !== baseAsOf;
  const version = changedTime ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
  const packageVersion = `${version}-candidate.${revision}`;
  result.runId = request.runId;
  result.brief = { ...result.brief, snapshotAsOf: asOf };
  result.snapshot = { ...result.snapshot, id: snapshotId, asOf, status: "candidate" };
  if (result.semantic.learningPathProjection) {
    result.semantic.learningPathProjection.generatedFromSnapshotId = snapshotId;
    result.semantic.learningPathProjection.proposals.forEach(proposal => { proposal.generatedFromSnapshotId = snapshotId; });
  }
  return refreshRolePackageManifest(result, { packageVersion, status: "candidate" });
}

export function createSnapshotIterationSkill(input: {
  model: ModelInvoker;
  modelLabel?: string;
  initialSeq?: number;
  searchConfig?: SearchProviderConfig;
  onCheckpoint?: (phase: string, state: Record<string, unknown>) => Promise<void>;
  /**
   * Optional agent research. When omitted the iteration runs exactly as before,
   * so this stays an opt-in capability rather than a behaviour change.
   *
   * The agent never writes to the graph. It returns claims that already carry an
   * evidence-review verdict, the iteration records them as a zero-target event,
   * and the deterministic rebuild/evaluate path remains the only writer.
   */
  researchAgent?: {
    reviewModel?: ModelInvoker;
    collectedSources?: () => SourceInput[];
    record?: () => ResearchRun | undefined;
    updateRecord?: (value: ResearchRun) => Promise<void>;
    finish?: (reason: ResearchStopReason) => Promise<void>;
    snapshot?: () => ResearchAgentCheckpoint;
    restore?: (value: ResearchAgentCheckpoint) => void;
    plan: (input: {
      contract: IterationContract;
      workItems: IterationWorkItem[];
      round: number;
      context?: unknown;
      graph?: ColdStartBuildResult;
      base?: ColdStartBuildResult;
      signal?: AbortSignal;
    }) => Promise<ResearchTaskCard[] | undefined>;
    /**
     * `run` receives the round's current request plus the candidate's own
     * segments/assets, so a caller can build read-only tools over exactly the
     * material this round has — not over whatever happens to be on disk.
     */
    run: (card: ResearchTaskCard, input: {
      signal?: AbortSignal;
      request: ColdStartRequest;
      segments: SourceSegment[];
      assets: SourceAsset[];
      graph?: ColdStartBuildResult;
    }) => Promise<ResearchWorkerResult>;
    concurrency?: number;
    /**
     * Caller-owned ledger. When present, agent research is charged through it so
     * a large budget stays accountable and the review reserve stays untouchable.
     * Absent means agent research runs unfunded, exactly as before.
     */
    budgetLedger?: BudgetLedger;
  };
  /**
   * Optional product planning at finalization. The planner proposes; code ranks
   * radar items, splices augmentation through the compiler, and decides what the
   * result may carry. Absent means the result shape is exactly as before.
   */
  productPlanner?: (input: {
    contract: IterationContract;
    base: ColdStartBuildResult;
    candidate: ColdStartBuildResult;
    claims: ReviewedClaim[];
    round: number;
    signal?: AbortSignal;
  }) => Promise<IterationProductProposal | undefined>;
}) {
  let seq = input.initialSeq || 0;
  const boundaryVerifier = createBoundaryVerifier(input.model);
  const budgetLedger = input.researchAgent?.budgetLedger;
  const emit = (state: Pick<IterationStateType, "request">, kind: IterationEventKind, phase: IterationEvent["phase"], payload: Record<string, unknown>) => {
    const event: IterationEvent = {
      version: "1.0",
      runId: state.request.runId,
      snapshotId: state.request.snapshotRef.snapshotId,
      projectId: state.request.projectId || state.request.snapshotRef.projectId,
      seq: seq += 1,
      time: new Date().toISOString(),
      kind,
      phase,
      payload,
    };
    getWriter()?.(event);
  };
  const checkpoint = async (phase: string, state: IterationStateType, update: Record<string, unknown>) => {
    await input.onCheckpoint?.(phase, {
      phase,
      round: state.round,
      stagnantRounds: state.stagnantRounds,
      roundBefore: state.roundBefore,
      researchCheckpoint: input.researchAgent?.snapshot?.() || state.researchCheckpoint,
      collectedSources: state.collectedSources,
      reviewedFindingKeys: state.reviewedFindingKeys,
      contract: state.contract,
      candidate: state.candidate,
      activeResearchPlan: state.activeResearchPlan,
      researchedSources: state.researchedSources,
      inspectionWorking: state.inspectionWorking,
      migrations: state.migrations,
      evaluation: state.evaluation,
      accepted: state.accepted,
      inspectionBefore: state.inspectionBefore,
      inspectionAfter: state.inspectionAfter,
      opportunities: state.opportunities,
      workItems: state.workItems,
      findingHistory: state.findingHistory,
      researchPlans: state.researchPlans,
      researchReports: state.researchReports,
      patches: state.patches,
      ...update,
    });
  };

  const establishContract = async (state: IterationStateType) => {
    emit(state, "iteration.run.started", "system", {
      initiativeProfile: state.request.initiativeProfile,
      maxRounds: state.request.maxRounds,
      model: input.modelLabel,
      searchProvider: input.searchConfig?.provider,
    });
    emit(state, "iteration.snapshot.resolved", "contract", {
      snapshotId: state.base.snapshot.id,
      asOf: state.base.snapshot.asOf,
      version: state.base.packages.rolePackage.packageVersion,
    });
    const contract = createIterationContract(state.request, state.base);
    emit(state, "iteration.contract.created", "contract", { contract });
    await checkpoint("contract", state, { contract });
    return { contract };
  };

  const inspectAndDiscover = async (state: IterationStateType) => {
    emit(state, "iteration.inspection.started", "inspect", { targetIds: state.contract!.targetIds, scope: state.contract!.budgets.graphRadius });
    const inspection = inspectSnapshot(snapshotAtTargetDate(state.candidate, state.contract!.targetAsOf), { targetIds: state.contract!.initiativeProfile === "autonomous" ? [] : state.contract!.targetIds });
    for (const finding of inspection.findings) emit(state, "iteration.finding.discovered", "inspect", { finding });
    emit(state, "iteration.inspection.completed", "inspect", {
      protocolValid: inspection.protocolValid,
      axes: inspection.axes,
      coverage: inspection.coverage,
      findingCount: inspection.findings.length,
      hardBlockerCount: inspection.hardBlockers.length,
      agentProbes: inspection.agentProbes,
    });
    const opportunities = discoverIterationOpportunities({ request: state.request, contract: state.contract!, inspection });
    emit(state, "iteration.opportunities.created", "plan", { opportunities });
    const workItems = planIterationWork({ runId: state.request.runId, opportunities, contract: state.contract! });
    emit(state, "iteration.work.plan.created", "plan", { workItems, budget: state.contract!.budgets });
    const update = {
      inspectionBefore: state.inspectionBefore || inspection,
      inspectionWorking: inspection,
      opportunities,
      workItems,
      findingHistory: inspection.findings,
    };
    await checkpoint("discovery", state, update);
    return update;
  };

  const planResearch = async (state: IterationStateType) => {
    const plan = planIterationResearch({
      runId: state.request.runId,
      round: state.round,
      result: state.candidate,
      request: state.request,
      contract: state.contract!,
      workItems: state.workItems,
      previousPlans: state.researchPlans,
    });
    const enabled = state.request.webResearch && Boolean(input.searchConfig);
    const previousQueries = new Set(state.researchPlans.flatMap(item => item.queries.map(query => `${query.category}:${query.query}`)));
    const queryBudget = state.request.queryBudget ?? DEFAULT_ITERATION_BUDGET.queryBudget;
    const remainingQueryBudget = Math.max(0, queryBudget - state.researchPlans.reduce((sum, item) => sum + item.queries.length, 0));
    const activeResearchPlan = { ...plan, queries: enabled ? plan.queries.filter(query => !previousQueries.has(`${query.category}:${query.query}`)).slice(0, remainingQueryBudget) : [] };
    emit(state, "iteration.research.plan.created", "research", {
      plan: activeResearchPlan,
      skippedReason: enabled ? undefined : input.searchConfig ? "本轮关闭联网研究" : "未配置搜索供应商",
    });
    const update = { roundBefore: state.inspectionWorking || state.inspectionBefore, activeResearchPlan, researchPlans: [...state.researchPlans, activeResearchPlan] };
    await checkpoint("research-plan", state, update);
    return update;
  };

  /**
   * Assemble the round's products. The planner only proposes: ranking, splicing
   * and what may be attached are decided here, and a planner failure leaves the
   * result shape untouched rather than failing the round.
   */
  const assembleProducts = async (state: IterationStateType): Promise<IterationProducts | undefined> => {
    if (!input.productPlanner) return undefined;
    let proposed: IterationProductProposal | undefined;
    try {
      proposed = await input.productPlanner({
        contract: state.contract!,
        base: state.base,
        candidate: state.candidate,
        claims: state.researchClaims,
        round: state.round,
      });
    } catch (error) {
      emit(state, "iteration.claims.reviewed", "research", {
        round: state.round, cardCount: 0, claimCount: 0, verifiedCount: 0, rejectedCount: 0,
        productsFailed: error instanceof Error ? error.message.slice(0, 300) : "product_planner_failed",
      });
      return undefined;
    }
    if (!proposed) return undefined;

    const nodeIds = new Set(state.candidate.semantic.nodes.map(node => node.id));
    const severity = new Map<string, "info" | "warning" | "error">();
    for (const issue of state.inspectionAfter?.audit?.issues || state.inspectionBefore?.audit?.issues || []) {
      for (const id of issue.targetIds) severity.set(id, issue.severity);
    }
    const radar = proposed.radarItems?.length
      ? rankRadarItems({
        items: proposed.radarItems,
        knownNodeIds: nodeIds,
        nodeSeverity: severity,
        objective: state.contract?.objective,
      })
      : undefined;

    // Only an augmentation that survives the four gates AND leaves the audit
    // without new errors may be attached; anything else is reported, not merged.
    const augmentations: AugmentationProposal[] = [];
    const augmentationRejections: string[] = [];
    for (const proposal of proposed.augmentations || []) {
      const spliced = applyAugmentation({ base: state.candidate, proposal });
      if (spliced.auditClean && (spliced.report.acceptedNodes.length || spliced.report.acceptedEdges.length)) {
        augmentations.push(proposal);
        continue;
      }
      augmentationRejections.push(...spliced.report.rejections.map(item => `${item.ref}: ${item.reason}`));
      augmentationRejections.push(...spliced.newErrors);
    }

    const products: IterationProducts = {
      ...(proposed.riskPackage ? { riskPackage: proposed.riskPackage } : {}),
      ...(radar ? { radarItems: radar.ranked } : {}),
      ...(augmentations.length ? { augmentations } : {}),
    };
    if (radar?.rejections.length || augmentationRejections.length) {
      emit(state, "iteration.claims.reviewed", "research", {
        round: state.round, cardCount: 0, claimCount: 0, verifiedCount: 0, rejectedCount: 0,
        radarRejections: radar?.rejections || [], augmentationRejections,
      });
    }
    return Object.keys(products).length ? products : undefined;
  };

  const research = async (state: IterationStateType, config: { signal?: AbortSignal }) => {
    const plan = state.activeResearchPlan!;
    const activeIds = new Set(plan.workItemIds);
    const runningItems = state.workItems.map((item) => activeIds.has(item.id) ? { ...item, status: "running" as const } : item);
    for (const item of runningItems.filter((item) => item.status === "running")) emit(state, "iteration.work.item.started", "research", { workItem: item });
    if (state.request.research && input.researchAgent) {
      const claims = await runAgentResearch(state, runningItems, config.signal);
      const sources = input.researchAgent.collectedSources?.() || [];
      const update = { researchedSources: sources, collectedSources: mergeIterationSources(state.collectedSources, sources, state.collectedSources.length + sources.length), workItems: runningItems, researchClaims: claims, researchCheckpoint: input.researchAgent.snapshot?.() };
      await checkpoint("research", state, update);
      return update;
    }
    if (!plan.queries.length || !input.searchConfig) {
      // Fetch completion is not defect resolution. Existing sources may still
      // support a focused derivation; evaluation owns the terminal work status.
      // Agent research carries its own tools, so it is not gated on the
      // deterministic retrieval config being present.
      const update = { researchedSources: [], workItems: runningItems, researchClaims: await runAgentResearch(state, runningItems, config.signal) };
      await checkpoint("research", state, update);
      return update;
    }
    const request = coldStartRequest({ state, sources: [] });
    const researched = await researchRoleSources({
      request,
      config: input.searchConfig,
      queries: plan.queries,
      planStrategy: "deterministic",
      sourceLimit: state.request.sourceLimit,
      verifyBoundaries: boundaryVerifier,
      signal: config.signal,
      onProgress: (progress) => {
        if (progress.kind === "search-started") emit(state, "iteration.search.started", "research", progress.payload);
        if (progress.kind === "search-completed") emit(state, "iteration.search.completed", "research", progress.payload);
        if (progress.kind === "search-failed") emit(state, "iteration.search.failed", "research", progress.payload);
      },
    });
    emit(state, "iteration.research.completed", "research", {
      round: state.round,
      selectedSourceCount: researched.sources.length,
      candidateCount: researched.report.candidateCount,
      failures: researched.report.failures,
      categoryCoverage: researched.report.categoryCoverage,
    });
    const update = {
      researchedSources: researched.sources,
      collectedSources: mergeIterationSources(state.collectedSources || [], researched.sources, 80),
      researchReports: [...state.researchReports, researched.report],
      workItems: runningItems,
      // Round-scoped: a fresh research step replaces this round's claims.
      researchClaims: state.researchClaims,
    };
    const agentClaims = await runAgentResearch(state, runningItems, config.signal);
    update.researchClaims = agentClaims;
    await checkpoint("research", state, update);
    return update;
  };

  /**
   * Optional agent research on top of the deterministic retrieval above.
   *
   * Claims are recorded for later rounds and for audit; they are never written
   * into the candidate graph here. A planner or worker failure leaves the round
   * exactly as the deterministic path left it.
   */
  const runAgentResearch = async (state: IterationStateType, items: IterationWorkItem[], signal?: AbortSignal): Promise<ReviewedClaim[]> => {
    if (!input.researchAgent) return [];
    try {
      const cards = await input.researchAgent.plan({
        contract: state.contract!,
        workItems: items.filter(item => item.requiresResearch),
        round: state.round,
        graph: state.candidate, base: state.base,
        context: { role: state.candidate.brief, nodes: state.candidate.semantic.nodes.map(node => ({ id: node.id, type: node.type, label: node.label, summary: node.summary })), quality: state.candidate.deliveryReadiness, findings: state.inspectionWorking?.findings },
        signal,
      });
      if (!cards?.length) return [];
      /**
       * Agent research is where new spending happens, so it is where the ledger
       * binds. The deterministic query path above keeps its own historical
       * budget untouched, which is why wiring the ledger here changes nothing
       * for a caller that never opted into a research agent.
       *
       * A card that cannot be funded is dropped with its reason rather than run
       * on credit, and the review reserve is never reachable from this side.
       */
      const funded: typeof cards = [];
      const denied: Array<{ cardId: string; reason: string }> = [];
      for (const card of cards) {
        if (!budgetLedger || state.request.research) { funded.push(card); continue; }
        const grant = budgetLedger.charge("general", { queries: card.budget.queries });
        if (grant.granted.queries <= 0) {
          denied.push({ cardId: card.id, reason: grant.reason || "预算不足" });
          continue;
        }
        funded.push({ ...card, budget: { ...card.budget, queries: grant.granted.queries } });
      }
      if (!funded.length) {
        emit(state, "iteration.claims.reviewed", "research", {
          round: state.round, cardCount: cards.length, fundedCount: 0,
          claimCount: 0, verifiedCount: 0, rejectedCount: 0, denied,
        });
        return [];
      }
      const workerContext = {
        request: coldStartRequest({ state, sources: reconstructSourceInputs(state.candidate) }),
        segments: state.candidate.sources.segments,
        assets: state.candidate.sources.assets, graph: state.candidate,
      };
      const results = await runResearchWorkers({
        cards: funded,
        concurrency: input.researchAgent.concurrency,
        runOne: card => input.researchAgent!.run(card, { signal, ...workerContext }),
      });
      const claims = results.flatMap(result => result.claims);
      emit(state, "iteration.claims.reviewed", "research", {
        round: state.round,
        cardCount: cards.length,
        fundedCount: funded.length,
        denied,
        claimCount: claims.length,
        verifiedCount: claims.filter(item => item.verification === "verified").length,
        rejectedCount: claims.filter(item => item.verification === "unverified").length,
        stopReasons: results.map(result => result.stopReason),
      });
      return claims;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (state.request.research) await input.researchAgent.finish?.(error instanceof Error && error.message.includes("BUDGET") ? "budget_exhausted" : "failed");
      // Agent research is an enhancement; its failure must not fail the round.
      emit(state, "iteration.claims.reviewed", "research", {
        round: state.round,
        cardCount: 0,
        claimCount: 0,
        verifiedCount: 0,
        rejectedCount: 0,
        failed: error instanceof Error ? error.message.slice(0, 300) : "agent_research_failed",
      });
      return [];
    }
  };

  const rebuild = async (state: IterationStateType, config: { signal?: AbortSignal }) => {
    const incoming = mergeIterationSources(state.collectedSources || [], [...state.request.supplementalSources, ...state.researchedSources], state.request.research ? state.collectedSources.length + state.request.supplementalSources.length + state.researchedSources.length : 80);
    const hasUsableEvidence = state.candidate.sources.assets.some(asset => asset.kind !== "user_brief"
      && asset.qualification?.status !== "quarantined"
      && state.candidate.sources.segments.some(segment => segment.sourceId === asset.id && segment.text.trim()));
    const activeItems = state.workItems.filter(item => item.status !== "completed" && item.status !== "skipped");
    const reuseEvidence = !incoming.length && state.contract?.mode !== "freshness" && hasUsableEvidence && activeItems.some(item => item.requiresResearch);
    if (!incoming.length && !reuseEvidence) {
      const update = { candidate: state.candidate };
      await checkpoint("rebuild", state, update);
      return update;
    }
    const currentSources = reconstructSourceInputs(state.candidate);
    const sources = mergeIterationSources(currentSources, incoming, currentSources.length + incoming.length);
    const request = coldStartRequest({ state, sources });
    const hasTaskRepair = state.contract?.mode === "risk_repair" && activeItems.some(item => item.findingIds.some(id =>
      [...state.inspectionBefore!.findings, ...state.findingHistory].some(finding => finding.id === id && ["TASK_SKILL_GAP", "TASK_LEARNING_KIND_GAP", "TASK_CAPABILITY_GAP", "TASK_CAPABILITY_UNIT_GAP", "TASK_PROCESS_GAP", "TASK_PROCESS_INCOMPLETE", "CAPABILITY_UNIT_CULTIVATION_GAP", "CAPABILITY_NOT_CROSS_TASK"].includes(finding.code))));
    const hasExistingTasks = state.candidate.semantic.nodes.some(node => node.type === "task" && node.lifecycle !== "rejected");
    // Enrichment hydrates tasks from the base and cannot invent that missing
    // layer. A role-only legacy snapshot must re-run source/task extraction.
    const mountRepair = Boolean(state.contract?.learningMountFeedback?.length);
    // Directed research names existing nodes as its scope. Regenerating the
    // whole graph both discards the base's original evidence (sources whose
    // qualified evidence roles are empty never reach extraction shards) and
    // invites out-of-scope additions; anchor the rebuild on the base instead.
    const directedAtExisting = state.contract?.initiativeProfile === "user_directed"
      && Boolean(state.contract.targetIds.length);
    const anchored = hasExistingTasks && (Boolean(state.request.research) || reuseEvidence || hasTaskRepair || mountRepair || directedAtExisting);
    // Directed research derives within the declared selection; other modes
    // follow the active work items. Seeding from every work item's targets
    // would let an aggregate finding (e.g. process gaps listing all tasks)
    // silently widen a user-declared scope.
    const taskTargets = new Set(directedAtExisting ? state.contract!.targetIds : activeItems.flatMap(item => item.targetIds));
    // A knowledge-point selection must reach its task context without changing
    // the user's declared scope or interpreting a role hub as every task.
    for (let depth = 0; depth < 3; depth++) for (const edge of state.candidate.semantic.edges) {
      if (edge.lifecycle !== "rejected" && taskTargets.has(edge.target) && ["requires_skill", "requires_capability", "contains"].includes(edge.type)) taskTargets.add(edge.source);
    }
    emit(state, "iteration.candidate.rebuild.started", "rebuild", {
      round: state.round,
      tool: "snapshot.rebuild",
      model: input.modelLabel,
      sourceCount: sources.length,
      incomingSourceCount: incoming.length,
      reusedExistingEvidence: reuseEvidence,
      execution: anchored ? "enrichment" : "full",
      researchPerformed: true,
      workItemIds: activeItems.map(item => item.id),
    });
    const currentReport = currentIterationResearchReport(state.activeResearchPlan, state.researchReports);
    const existingResearchReport = anchored ? currentReport : currentReport
      ? mergeResearchReports(state.candidate.sources.research, currentReport)
      : state.candidate.sources.research;
    const skill = createColdStartSkill(input.model, {
      existingResearchReport,
      emitEvents: false,
      // The outer iteration owns fresh-query budgets and changes strategy each round.
      qualityRepairRounds: 0,
      learningDefinitionTargetIds: state.contract?.learningMountFeedback?.map(item => item.roleNodeId),
      execution: anchored ? "enrichment" : "full",
      researchPerformed: true,
      knowledgeTargetIds: anchored ? [...taskTargets].filter(id => state.candidate.semantic.nodes.some(node => node.id === id && node.type === "task")) : undefined,
      iterationObjective: iterationRepairFocus(state),
    });
    const built = await skill.invoke(
      { request, laneFailures: [], ...(anchored ? { baseResult: withIncomingEvidence(state.candidate, request, incoming) } : {}) },
      { configurable: { thread_id: `${state.request.snapshotRef.snapshotId}:${state.request.runId}:iteration:${state.round}` }, signal: config.signal },
    );
    const candidate = built.result ? preserveIterationGraph(state.candidate, built.result, request, { learningDefinitionTargetIds: state.contract?.learningMountFeedback?.map(item => item.roleNodeId) }) : state.candidate;
    emit(state, "iteration.candidate.rebuilt", "rebuild", {
      round: state.round,
      nodes: candidate.semantic.nodes.length,
      edges: candidate.semantic.edges.length,
      scenarios: candidate.process.scenarios.length,
      sources: candidate.sources.assets.length,
    });
    await checkpoint("rebuild", state, { candidate });
    return { candidate };
  };

  const consolidate = async (state: IterationStateType, config: { signal?: AbortSignal }) => {
    const run = input.researchAgent?.record?.();
    if (state.request.research && run?.changeSets.some(change => change.status === "candidate" && !change.checks.length)) {
      const applied = await compileResearchChanges({ base: state.base, candidate: state.candidate, request: coldStartRequest({ state, sources: reconstructSourceInputs(state.candidate) }), run, reviewModel: input.researchAgent?.reviewModel, signal: config.signal });
      state = { ...state, candidate: applied.candidate, migrations: { ...state.migrations, ...applied.migrations } };
      await input.researchAgent?.updateRecord?.(run);
    }
    emit(state, "iteration.consolidation.started", "consolidate", {
      round: state.round,
      nodeCount: state.candidate.semantic.nodes.length,
      edgeCount: state.candidate.semantic.edges.length,
    });
    const inspection = inspectSnapshot(snapshotAtTargetDate(state.candidate, state.contract!.targetAsOf), { targetIds: state.contract!.initiativeProfile === "autonomous" ? [] : state.contract!.targetIds });
    const proposed = proposeSafePatch({ result: state.candidate, audit: inspection.audit, iteration: state.round });
    emit(state, "iteration.patch.proposed", "consolidate", { patch: proposed });
    if (!proposed.operations.length) {
      const patches = [...state.patches, proposed];
      await checkpoint("consolidate", state, { inspectionWorking: inspection, patches });
      return { candidate: state.candidate, migrations: state.migrations, inspectionWorking: inspection, patches };
    }
    const applied = applyGraphPatch(state.candidate, proposed);
    emit(state, "iteration.patch.applied", "consolidate", { patch: applied.patch, referenceMigration: applied.referenceMigration });
    const migrations = { ...state.migrations, ...applied.referenceMigration };
    const patches = [...state.patches, applied.patch];
    await checkpoint("consolidate", state, { candidate: applied.result, patches, migrations });
    return { candidate: applied.result, patches, migrations };
  };

  const evaluate = async (state: IterationStateType) => {
    emit(state, "iteration.evaluation.started", "evaluate", {
      round: state.round,
      baseSnapshotId: state.base.snapshot.id,
      candidateNodeCount: state.candidate.semantic.nodes.length,
    });
    const inspectionAfter = inspectSnapshot(snapshotAtTargetDate(state.candidate, state.contract!.targetAsOf), { targetIds: state.contract!.initiativeProfile === "autonomous" ? [] : state.contract!.targetIds });
    const candidate = applyInspectionToSnapshot(state.candidate, inspectionAfter);
    const record = input.researchAgent?.record?.();
    if (state.request.research && record) linkResearchFindings(candidate, record);
    const evaluation = evaluateIteration({
      base: state.base,
      candidate,
      before: state.inspectionBefore!,
      after: inspectionAfter,
      contract: state.contract!,
      migrations: state.migrations,
      workItems: state.workItems,
      previousAccepted: state.accepted,
    });
    const workItems = evaluatedWorkItems(state.workItems, [...state.inspectionBefore!.findings, ...state.findingHistory], inspectionAfter, evaluation.meaningful);
    for (const item of workItems) emit(state, "iteration.work.item.completed", "evaluate", { workItem: item, resolution: item.status === "completed" ? "candidate-evaluation" : "unresolved" });
    emit(state, "iteration.evaluation.completed", "evaluate", {
      evaluation,
      before: state.inspectionBefore!.axes,
      after: inspectionAfter.axes,
      coverageBefore: state.inspectionBefore!.coverage,
      coverageAfter: inspectionAfter.coverage,
    });
    emit(state, "iteration.round.completed", "evaluate", { round: state.round, meaningful: evaluation.meaningful });
    const accepted = evaluation.meaningful ? { candidate, inspection: inspectionAfter, evaluation, migrations: state.migrations, patches: state.patches } : state.accepted;
    const roundBefore = state.roundBefore || state.inspectionBefore!;
    const remaining = new Set(inspectionAfter.findings.map(findingIdentity));
    const productQuality = compareResearchQuality(state.accepted?.candidate || state.base, candidate);
    const currentFindingKeys = reviewedFindingKeys(record);
    const researchProgress = Boolean(state.request.research && (productQuality.conversionImproved || productQuality.expressionImproved || currentFindingKeys.some(key => !state.reviewedFindingKeys.includes(key))));
    const actualProgress = !evaluation.coreRegression && (researchProgress || roundBefore.findings.some(finding => !remaining.has(findingIdentity(finding)))
      || inspectionAfter.coverage.tasksWithoutSkills < roundBefore.coverage.tasksWithoutSkills
      || inspectionAfter.coverage.tasksWithoutProcess < roundBefore.coverage.tasksWithoutProcess);
    const stagnantRounds = actualProgress ? 0 : (state.stagnantRounds || 0) + 1;
    const update = { candidate, inspectionAfter, inspectionWorking: inspectionAfter, evaluation, workItems, accepted, stagnantRounds, reviewedFindingKeys: currentFindingKeys };
    await checkpoint("evaluate", state, update);
    return update;
  };

  const routeAfterEvaluation = (state: IterationStateType) => {
    if (state.request.research) {
      const record = input.researchAgent?.record?.(), remaining = input.researchAgent?.budgetLedger?.snapshot().remainingResearch;
      if (record?.stopReason || state.round >= state.request.research.budget.revisions || !remaining || remaining.tokens < 1000 || remaining.turns < 1 || (state.stagnantRounds || 0) >= state.request.research.budget.stagnantRounds) return "finish";
      return "retry";
    }
    if (state.round >= state.request.maxRounds) return "finish";
    const baseline = state.evaluation?.coreRegression ? state.accepted?.inspection || state.inspectionBefore! : state.inspectionAfter!;
    const opportunities = discoverIterationOpportunities({ request: state.request, contract: state.contract!, inspection: baseline });
    const researchable = opportunities.some(item => item.requiresResearch && item.findingIds.length > 0)
      || state.workItems.some(item => item.requiresResearch && item.status === "known_gap");
    const canUseEvidence = state.candidate.sources.assets.some(asset => asset.kind !== "user_brief" && asset.qualification?.status !== "quarantined")
      || state.request.supplementalSources.length > 0 || state.collectedSources?.length > 0;
    // Rounds 1..n share one query budget; a quarter of it is the point at which
    // continuing to search stops being worthwhile (48 of the default 192).
    const searchBudgetFloor = Math.ceil((state.request.queryBudget ?? DEFAULT_ITERATION_BUDGET.queryBudget) / 4);
    const hasSearchBudget = state.request.webResearch && Boolean(input.searchConfig)
      && state.researchPlans.reduce((sum, plan) => sum + plan.queries.length, 0) < searchBudgetFloor;
    const attempted = new Set(state.researchPlans.flatMap(plan => plan.workItemIds));
    const unattempted = state.workItems.some(item => item.requiresResearch && item.status !== "completed" && !attempted.has(item.id));
    return researchable && (hasSearchBudget || canUseEvidence) && ((state.stagnantRounds || 0) < (state.request.stagnantRoundLimit ?? DEFAULT_ITERATION_BUDGET.stagnantRoundLimit) || unattempted) ? "retry" : "finish";
  };

  const nextRound = async (state: IterationStateType) => {
    const round = state.round + 1;
    // A rejected attempt is diagnostic material, never the foundation of the
    // next attempt. Keep its retrieved documents independently for re-use.
    const candidate = state.evaluation?.meaningful ? state.candidate : state.accepted?.candidate || state.base;
    const inspection = inspectSnapshot(snapshotAtTargetDate(candidate, state.contract!.targetAsOf), { targetIds: state.contract!.initiativeProfile === "autonomous" ? [] : state.contract!.targetIds });
    const opportunities = discoverIterationOpportunities({ request: state.request, contract: state.contract!, inspection });
    const nextItems = planIterationWork({ runId: state.request.runId, opportunities, contract: state.contract! });
    const live = new Set(inspection.findings.map(finding => finding.id));
    const previous = state.workItems.map(item => ({ ...item, status: item.findingIds.length && item.findingIds.every(id => !live.has(id)) ? "completed" as const : item.status }));
    const workItems = [...new Map([...previous, ...nextItems.map(item => {
      const old = previous.find(previous => previous.id === item.id);
      return old?.status === "completed" ? old : item;
    })].map(item => [item.id, item])).values()];
    const findingHistory = [...new Map([...state.findingHistory, ...inspection.findings].map(finding => [finding.id, finding])).values()];
    const update = { round, candidate, inspectionWorking: inspection, opportunities, workItems, findingHistory, researchedSources: [],
      // Claims belong to the round that produced them; carrying them forward
      // would let an earlier round's reviewed claim be read as current evidence.
      researchClaims: [],
      migrations: state.evaluation?.meaningful ? state.migrations : state.accepted?.migrations || {},
      patches: state.evaluation?.meaningful ? state.patches : state.accepted?.patches || [] };
    await checkpoint("next-round", state, update);
    return update;
  };

  const finalize = async (state: IterationStateType) => {
    const followupRejected = !state.evaluation?.meaningful && Boolean(state.accepted);
    // A follow-up is allowed to fail without discarding an already accepted
    // first-round improvement. Persist this checkpoint for async recovery too.
    if (!state.evaluation?.meaningful && state.accepted) {
      const accepted = state.accepted;
      state = { ...state, candidate: accepted.candidate, inspectionAfter: accepted.inspection,
        evaluation: accepted.evaluation, migrations: accepted.migrations, patches: accepted.patches,
        workItems: evaluatedWorkItems(state.workItems, [...state.inspectionBefore!.findings, ...state.findingHistory], accepted.inspection, true) };
    }
    const createdSnapshot = Boolean(state.evaluation?.meaningful);
    // A rejected candidate must never leak into callers that use result.candidate
    // as the base of an automatic follow-up or display it as the current version.
    const candidate = createdSnapshot ? stampSnapshot(state.candidate, state.request, state.base.snapshot.asOf, state.contract!.targetAsOf) : state.base;
    const diff = computeSemanticDiff({
      base: state.base,
      candidate,
      patches: createdSnapshot ? state.patches : [],
      auditBefore: state.inspectionBefore!.audit,
      auditAfter: createdSnapshot ? state.inspectionAfter!.audit : state.inspectionBefore!.audit,
      migrations: createdSnapshot ? state.migrations : {},
    });
    const summary = [
      createdSnapshot ? "本轮产生了可保留的新静态快照。" : "本轮保留诊断与研究记录，当前静态快照保持不变。",
      ...state.evaluation!.reasons,
      ...(followupRejected ? ["后续研究候选未通过验收，保留前一轮已验证的改进；失败原因保存在执行记录中。"] : []),
      ...(!createdSnapshot ? ["以下指标用于诊断未采用的候选，不表示当前岗位包已发生变化。"] : []),
      `结构有效性 ${state.inspectionBefore!.axes.structuralValidity.toFixed(0)} → ${state.inspectionAfter!.axes.structuralValidity.toFixed(0)}`,
      `证据准备度 ${state.inspectionBefore!.axes.evidenceReadiness.toFixed(0)} → ${state.inspectionAfter!.axes.evidenceReadiness.toFixed(0)}`,
      `任务无技能覆盖 ${state.inspectionBefore!.coverage.tasksWithoutSkills} → ${state.inspectionAfter!.coverage.tasksWithoutSkills}`,
    ];
    const products = state.request.research ? undefined : await assembleProducts(state);
    let researchRun = input.researchAgent?.record?.();
    if (state.request.research && researchRun) {
      const remaining = input.researchAgent?.budgetLedger?.snapshot().remainingResearch;
      const reason = researchRun.stopReason || stopResearch({ goalReached: createdSnapshot && !state.inspectionAfter?.findings.some(finding => finding.severity === "error"), budgetExhausted: !remaining || remaining.tokens < 1000 || remaining.turns < 1, stagnantRounds: state.stagnantRounds || 0, limit: state.request.research.budget.stagnantRounds }) || "insufficient_material";
      await input.researchAgent?.finish?.(reason);
      researchRun = input.researchAgent?.record?.() || researchRun;
      researchRun.changeSets.push(await describeChangeSet({ base: state.base, candidate: state.candidate, run: researchRun, passed: createdSnapshot, reasons: state.evaluation!.reasons, migrations: state.migrations }));
      await input.researchAgent?.updateRecord?.(researchRun);
      if (createdSnapshot) candidate.researchRun = researchRun;
    }
    const result: SnapshotIterationResult = {
      runId: state.request.runId,
      snapshotRef: state.request.snapshotRef,
      projectId: state.request.projectId || state.request.snapshotRef.projectId,
      baseSnapshotId: state.base.snapshot.id,
      status: createdSnapshot ? researchRun?.changeSets.some(change => change.status === "needs_review") ? "waiting_user" : "completed" : "no_change",
      contract: state.contract!,
      ...(researchRun ? { researchRun } : {}),
      inspectionBefore: state.inspectionBefore!,
      inspectionAfter: state.inspectionAfter!,
      opportunities: state.opportunities,
      workItems: state.workItems,
      researchPlans: state.researchPlans,
      researchReports: state.researchReports,
      // Only present when a research agent ran, so existing stored results and
      // consumers keep their exact shape.
      ...(input.researchAgent ? { researchClaims: state.researchClaims } : {}),
      ...(products ? { products } : {}),
      patches: state.patches,
      diff,
      evaluation: state.evaluation!,
      candidate,
      createdSnapshot,
      summary,
      knownGaps: (createdSnapshot ? state.inspectionAfter! : state.inspectionBefore!).findings.filter((finding) => finding.classification === "research" || finding.suggestedAction === "user" || finding.suggestedAction === "organization_specific"),
    };
    emit(state, "iteration.run.completed", "system", { result, createdSnapshot, diff });
    await checkpoint("completed", state, { result });
    return { result, candidate };
  };

  const routeFromCheckpoint = (state: IterationStateType) => {
    switch (state.resumeFrom) {
      case "contract": return "inspect_and_discover";
      case "discovery": return "plan_research";
      case "research-plan": return "targeted_research";
      case "research": return "rebuild_candidate";
      case "rebuild": return "consolidate_candidate";
      case "consolidate": return "evaluate_candidate";
      case "evaluate": return routeAfterEvaluation(state) === "retry" ? "next_round" : "finalize";
      case "next-round": return "plan_research";
      default: return "establish_contract";
    }
  };

  return new StateGraph(IterationState)
    .addNode("establish_contract", establishContract)
    .addNode("inspect_and_discover", inspectAndDiscover)
    .addNode("plan_research", planResearch)
    .addNode("targeted_research", research, { retryPolicy: { maxAttempts: 2, initialInterval: 1 } })
    .addNode("rebuild_candidate", rebuild)
    .addNode("consolidate_candidate", consolidate)
    .addNode("evaluate_candidate", evaluate)
    .addNode("next_round", nextRound)
    .addNode("finalize", finalize)
    .addConditionalEdges(START, routeFromCheckpoint, {
      establish_contract: "establish_contract",
      inspect_and_discover: "inspect_and_discover",
      plan_research: "plan_research",
      targeted_research: "targeted_research",
      rebuild_candidate: "rebuild_candidate",
      consolidate_candidate: "consolidate_candidate",
      evaluate_candidate: "evaluate_candidate",
      next_round: "next_round",
      finalize: "finalize",
    })
    .addEdge("establish_contract", "inspect_and_discover")
    .addEdge("inspect_and_discover", "plan_research")
    .addEdge("plan_research", "targeted_research")
    .addEdge("targeted_research", "rebuild_candidate")
    .addEdge("rebuild_candidate", "consolidate_candidate")
    .addEdge("consolidate_candidate", "evaluate_candidate")
    .addConditionalEdges("evaluate_candidate", routeAfterEvaluation, { retry: "next_round", finish: "finalize" })
    .addEdge("next_round", "plan_research")
    .addEdge("finalize", END)
    .compile({ checkpointer: false }).withConfig({ recursionLimit: 80 });
}
