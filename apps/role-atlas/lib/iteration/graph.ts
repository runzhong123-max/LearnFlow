import { END, getWriter, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod/v4";
import type { ModelInvoker } from "@/lib/agent/model";
import { prepareBuildInput, stableHash } from "@/lib/build/compiler";
import { qualifySources } from "@/lib/build/workflow";
import { refreshRolePackageManifest } from "@/lib/packages/role-package-manifest";
import { createColdStartSkill } from "@/lib/build/graph";
import type { ColdStartBuildResult, ColdStartRequest, SourceInput, WebResearchReport } from "@/lib/build/types";
import { applyGraphPatch, computeSemanticDiff, proposeSafePatch } from "@/lib/risk/patch";
import type { GraphPatch } from "@/lib/risk/types";
import { reconstructSourceInputs } from "@/lib/risk/research";
import { researchRoleSources } from "@/lib/search/web-research";
import type { SearchProviderConfig } from "@/lib/search/providers";
import { applyInspectionToSnapshot, findingIdentity, inspectSnapshot } from "./inspector";
import { preserveIterationGraph } from "./preserve-graph";
import {
  createIterationContract,
  discoverIterationOpportunities,
  evaluateIteration,
  planIterationResearch,
  planIterationWork,
} from "./planner";
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
} from "./types";

const IterationState = new StateSchema({
  request: z.custom<SnapshotIterationRequest>(),
  base: z.custom<ColdStartBuildResult>(),
  candidate: z.custom<ColdStartBuildResult>(),
  round: z.number().int().default(1),
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
  researchedSources: z.custom<SourceInput[]>().default(() => []),
  patches: z.custom<GraphPatch[]>().default(() => []),
  migrations: z.record(z.string(), z.string()).default(() => ({})),
  evaluation: z.custom<ReturnType<typeof evaluateIteration>>().optional(),
  accepted: z.custom<{ candidate: ColdStartBuildResult; inspection: SnapshotInspection; evaluation: ReturnType<typeof evaluateIteration>; migrations: Record<string, string>; patches: GraphPatch[] }>().optional(),
  result: z.custom<SnapshotIterationResult>().optional(),
  resumeFrom: z.enum(["contract", "discovery", "research-plan", "research", "rebuild", "consolidate", "evaluate", "next-round"]).optional(),
});

type IterationStateType = typeof IterationState.State;

export function mergeIterationSources(current: SourceInput[], incoming: SourceInput[], limit = 80) {
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
  }).slice(0, Math.max(4, Math.min(limit, 80)));
}

export function iterationRepairFocus(input: { candidate: ColdStartBuildResult; contract?: IterationContract; workItems: IterationWorkItem[] }) {
  const objects = new Map([...input.candidate.semantic.nodes, ...input.candidate.process.scenarios, ...input.candidate.process.nodes].map(node => [node.id, node]));
  return [input.contract?.objective,
    "本轮只针对下列发现补证、补充具体知识技能及合法关系。保留已有任务 ID 和证据；不能把用户观察、组织事实或无来源推断伪装成已修复。",
    ...input.workItems.filter(item => item.status !== "completed" && item.status !== "skipped").slice(0, 16).map(item => [
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
    runId: `${state.request.runId}:round:${state.round}`.slice(0, 100),
    projectId: state.request.projectId || state.request.snapshotRef.projectId || `snapshot:${stableHash(state.request.snapshotRef.snapshotId)}`,
    roleTitle: state.base.brief.roleTitle,
    roleDescription: [state.base.brief.roleDescription.slice(0, 1_500), iterationRepairFocus(state)]
      .filter(Boolean).join("\n本轮迭代目标：").slice(0, 8_000),
    market: state.base.brief.market,
    audience: state.base.brief.audience,
    snapshotAsOf: state.contract?.targetAsOf || state.base.snapshot.asOf,
    // Existing mature snapshots can legitimately exceed the cold-start UI's
    // 20-source input limit. Internal iteration must not discard that history.
    sources: input.sources.slice(0, 80),
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
}) {
  let seq = input.initialSeq || 0;
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
    });
    const enabled = state.request.webResearch && Boolean(input.searchConfig);
    const previousQueries = new Set(state.researchPlans.flatMap(item => item.queries.map(query => `${query.category}:${query.query}`)));
    const activeResearchPlan = { ...plan, queries: enabled ? plan.queries.filter(query => !previousQueries.has(`${query.category}:${query.query}`)) : [] };
    emit(state, "iteration.research.plan.created", "research", {
      plan: activeResearchPlan,
      skippedReason: enabled ? undefined : input.searchConfig ? "本轮关闭联网研究" : "未配置搜索供应商",
    });
    const update = { activeResearchPlan, researchPlans: [...state.researchPlans, activeResearchPlan] };
    await checkpoint("research-plan", state, update);
    return update;
  };

  const research = async (state: IterationStateType, config: { signal?: AbortSignal }) => {
    const plan = state.activeResearchPlan!;
    const activeIds = new Set(plan.workItemIds);
    const runningItems = state.workItems.map((item) => activeIds.has(item.id) ? { ...item, status: "running" as const } : item);
    for (const item of runningItems.filter((item) => item.status === "running")) emit(state, "iteration.work.item.started", "research", { workItem: item });
    if (!plan.queries.length || !input.searchConfig) {
      // Fetch completion is not defect resolution. Existing sources may still
      // support a focused derivation; evaluation owns the terminal work status.
      const update = { researchedSources: [], workItems: runningItems };
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
      researchReports: [...state.researchReports, researched.report],
      workItems: runningItems,
    };
    await checkpoint("research", state, update);
    return update;
  };

  const rebuild = async (state: IterationStateType, config: { signal?: AbortSignal }) => {
    const incoming = [...state.request.supplementalSources, ...state.researchedSources];
    const hasUsableEvidence = state.candidate.sources.assets.some(asset => asset.kind !== "user_brief"
      && asset.qualification?.status !== "quarantined"
      && state.candidate.sources.segments.some(segment => segment.sourceId === asset.id && segment.text.trim()));
    const activeItems = state.workItems.filter(item => item.status !== "completed" && item.status !== "skipped");
    const reuseEvidence = !incoming.length && state.request.webResearch && hasUsableEvidence && activeItems.some(item => item.requiresResearch);
    if (!incoming.length && !reuseEvidence) {
      const update = { candidate: state.candidate };
      await checkpoint("rebuild", state, update);
      return update;
    }
    const currentSources = reconstructSourceInputs(state.candidate);
    const sources = mergeIterationSources(currentSources, incoming, currentSources.length + incoming.length);
    const request = coldStartRequest({ state, sources });
    const hasTaskRepair = state.contract?.mode === "risk_repair" && activeItems.some(item => item.findingIds.some(id =>
      [...state.inspectionBefore!.findings, ...state.findingHistory].some(finding => finding.id === id && finding.code === "TASK_SKILL_GAP")));
    const anchored = reuseEvidence || hasTaskRepair;
    emit(state, "iteration.candidate.rebuild.started", "rebuild", {
      round: state.round,
      tool: "snapshot.rebuild",
      model: input.modelLabel,
      sourceCount: sources.length,
      incomingSourceCount: incoming.length,
      reusedExistingEvidence: reuseEvidence,
      workItemIds: activeItems.map(item => item.id),
    });
    const skill = createColdStartSkill(input.model, {
      existingResearchReport: state.researchReports.at(-1),
      emitEvents: false,
      execution: anchored ? "enrichment" : "full",
      knowledgeTargetIds: anchored ? activeItems.flatMap(item => item.targetIds).filter(id => state.candidate.semantic.nodes.some(node => node.id === id && node.type === "task")) : undefined,
      iterationObjective: iterationRepairFocus(state),
    });
    const built = await skill.invoke(
      { request, laneFailures: [], ...(anchored ? { baseResult: withIncomingEvidence(state.candidate, request, incoming) } : {}) },
      { configurable: { thread_id: `${state.request.snapshotRef.snapshotId}:${state.request.runId}:iteration:${state.round}` }, signal: config.signal },
    );
    const candidate = built.result ? preserveIterationGraph(state.candidate, built.result, request) : state.candidate;
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

  const consolidate = async (state: IterationStateType) => {
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
      return { inspectionWorking: inspection, patches };
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
    const update = { candidate, inspectionAfter, inspectionWorking: inspectionAfter, evaluation, workItems, accepted };
    await checkpoint("evaluate", state, update);
    return update;
  };

  const routeAfterEvaluation = (state: IterationStateType) => {
    const hasResearchable = state.workItems.some(item => item.requiresResearch && item.status === "known_gap");
    if (!state.evaluation?.coreRegression && hasResearchable && state.activeResearchPlan?.queries.length && state.request.webResearch && input.searchConfig && state.round < state.request.maxRounds) return "retry";
    return "finish";
  };

  const nextRound = async (state: IterationStateType) => {
    const round = state.round + 1;
    const opportunities = discoverIterationOpportunities({ request: state.request, contract: state.contract!, inspection: state.inspectionAfter! });
    const nextItems = planIterationWork({ runId: state.request.runId, opportunities, contract: state.contract! });
    const workItems = [...new Map([...state.workItems, ...nextItems].map(item => [item.id, item])).values()];
    const findingHistory = [...new Map([...state.findingHistory, ...state.inspectionAfter!.findings].map(finding => [finding.id, finding])).values()];
    const update = { round, opportunities, workItems, findingHistory, researchedSources: [] };
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
    const result: SnapshotIterationResult = {
      runId: state.request.runId,
      snapshotRef: state.request.snapshotRef,
      projectId: state.request.projectId || state.request.snapshotRef.projectId,
      baseSnapshotId: state.base.snapshot.id,
      status: createdSnapshot ? "completed" : "no_change",
      contract: state.contract!,
      inspectionBefore: state.inspectionBefore!,
      inspectionAfter: state.inspectionAfter!,
      opportunities: state.opportunities,
      workItems: state.workItems,
      researchPlans: state.researchPlans,
      researchReports: state.researchReports,
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
    .compile({ checkpointer: false });
}
