import { linkResearchFindings } from "@/lib/research/change-set";
import { researchQuality } from "@/lib/research/quality";
import { buildResearchAgent, type ResearchAgentParts, type ResearchAgentCheckpoint } from "@/lib/iteration/research-agent";
import { runResearchWorkers } from "@/lib/iteration/worker";
import { deriveTaskDefinitions } from "@/lib/research/task-definition";
import type { IterationContract } from "@/lib/iteration/types";
import { END, getWriter, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod/v4";
import type { ModelInvoker } from "@/lib/agent/model";
import { learningCoverage, processCoverage } from "@/lib/iteration/learning-health";
import { inspectSnapshot, inspectionToBuildAudit } from "@/lib/iteration/inspector";
import { refreshRolePackageManifest } from "@/lib/packages/role-package-manifest";
import { createRoleSearchPlan } from "@/lib/search/query-planner";
import type { SearchProviderConfig } from "@/lib/search/providers";
import { createBoundaryVerifier } from "@/lib/search/boundary-verdicts";
import { researchRoleSources, type PlannedQuery } from "@/lib/search/web-research";
import { researchRoleTitle } from "@/lib/search/role-query";
import { compileProcessDraft, compileRolePackage, compileSemanticDraft, prepareBuildInput, stableHash } from "./compiler";
import { inspectKnowledgeDerivation, mergeKnowledgeDerivations } from "./knowledge-quality";
import { selectKnowledgeContext } from "./knowledge-context";
import { capabilityCoverage } from "./capability-coverage";
import type { BuildEvent, BuildEventKind } from "./events";
import { invokeStructured, normalizeProcessDraft, processDraftSchema, type ProcessDraft, type SemanticDraft } from "./model";
import type {
  BuildWorkItemSummary,
  ColdStartBuildMetrics,
  ColdStartBuildResult,
  ColdStartRequest,
  ConceptMention,
  RelationProposition,
  SourceAsset,
  SourceSegment,
  WebResearchReport,
} from "./types";
import {
  capabilityDerivationPrompt,
  capabilityDerivationSchema,
  capabilityToSemanticDraft,
  emptyProcessDraft,
  fallbackTaskBarrier,
  knowledgeDerivationPrompt,
  knowledgeDerivationSchema,
  knowledgeToSemanticDraft,
  materializeMentionDraft,
  materializeRelationPropositions,
  mentionExtractionPrompt,
  mentionExtractionSchema,
  mergeDerivedSemanticDrafts,
  normalizeMentionExtraction,
  normalizeTaskBarrier,
  taskBarrierPrompt,
  taskBarrierSchema,
  taskBarrierToSemanticDraft,
  taskConsolidationPrompt,
  taskProcessPrompt,
  skillDependencyDerivationPrompt,
  skillDependencyDerivationSchema,
  skillDependenciesToSemanticDraft,
  type TaskEvidenceContext,
  type TaskBarrierDraft,
} from "./workflow-model";
import {
  annotateKernelNodes,
  buildKernelTaskProjection,
  carryKernelPresentation,
  completeProcessCapsules,
  createProcessCapsules,
  semanticDraftFromKernel,
  visibleKernelTaskDraft,
} from "./kernel";
import {
  COLD_START_WORKFLOW_VERSION,
  createSourceShards,
  createWorkItem,
  estimateTokens,
  groupTasks,
  mentionsForSegments,
  qualifySources,
  selectKernelSourceShards,
  selectSegmentsForTaskGroup,
  taskGroupNeedsKnowledgeResearch,
  type SourceShard,
  type TaskGroup,
} from "./workflow";

type PreparedBuild = ReturnType<typeof prepareBuildInput>;
type SemanticMaterialization = ReturnType<typeof compileSemanticDraft>;
type ProcessMaterialization = ReturnType<typeof compileProcessDraft>;

const BuildState = new StateSchema({
  request: z.custom<ColdStartRequest>(),
  baseResult: z.custom<ColdStartBuildResult>().optional(),
  activeRequest: z.custom<ColdStartRequest>().optional(),
  runStartedAt: z.number().optional(),
  researchReport: z.custom<WebResearchReport>().optional(),
  prepared: z.custom<PreparedBuild>().optional(),
  shards: z.array(z.custom<SourceShard>()).default(() => []),
  mentions: z.array(z.custom<ConceptMention>()).default(() => []),
  relationPropositions: z.array(z.custom<RelationProposition>()).default(() => []),
  taskDraft: z.custom<SemanticDraft>().optional(),
  taskGroups: z.array(z.custom<TaskGroup>()).default(() => []),
  firstTaskSkeletonMs: z.number().optional(),
  kernelResult: z.custom<ColdStartBuildResult>().optional(),
  semanticDraft: z.custom<SemanticDraft>().optional(),
  processDraft: z.custom<ProcessDraft>().optional(),
  semantic: z.custom<SemanticMaterialization>().optional(),
  process: z.custom<ProcessMaterialization>().optional(),
  workItems: z.array(z.custom<BuildWorkItemSummary>()).default(() => []),
  targetedResearchQueries: z.number().default(0),
  taskRecoveryRound: z.number().default(0),
  qualityRepairRound: z.number().default(0),
  qualityTaskIds: z.array(z.string()).default(() => []),
  qualityKnowledgeTaskIds: z.array(z.string()).default(() => []),
  qualityProcessTaskIds: z.array(z.string()).default(() => []),
  bestResult: z.custom<ColdStartBuildResult>().optional(),
  bestQualityScore: z.number().optional(),
  laneFailures: z.array(z.string()).default(() => []),
  result: z.custom<ColdStartBuildResult>().optional(),
  researchContinue: z.boolean().default(false),
  researchStagnant: z.number().default(0),
  researchSignature: z.string().optional(),
});

type SkillOptions = {
  researchAgent?: ResearchAgentParts;
  researchCheckpoint?: ResearchAgentCheckpoint;
  onResearchCheckpoint?: (state: ResearchAgentCheckpoint) => Promise<void>;
  researchPerformed?: boolean;
  initialSeq?: number;
  searchConfig?: SearchProviderConfig;
  sourceLimit?: number;
  existingResearchReport?: WebResearchReport;
  emitEvents?: boolean;
  cache?: Map<string, unknown>;
  execution?: "full" | "kernel" | "enrichment";
  /** Existing immutable task IDs, used only when enriching an iteration base. */
  knowledgeTargetIds?: string[];
  learningDefinitionTargetIds?: string[];
  iterationObjective?: string;
  /** Outer iteration owns fresh-query attempts; standalone builds repair twice. */
  qualityRepairRounds?: number;
};

const fallbackSemanticDraft: SemanticDraft = { roleSummary: "", nodes: [], edges: [] };

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>) {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

function sourceKindForSegment(segment: SourceSegment, assets: SourceAsset[]) {
  return assets.find((asset) => asset.id === segment.sourceId)?.kind || "private_document";
}

function taskEvidenceContextForMention(mention: ConceptMention, prepared: PreparedBuild): TaskEvidenceContext {
  const segment = prepared.segments.find((candidate) => candidate.id === mention.sourceSegmentId);
  const asset = prepared.assets.find((candidate) => candidate.id === segment?.sourceId);
  const roles = asset?.qualification?.evidenceRoles || [];
  const rolePriority = roles.includes("workspace_observation") ? 100
    : roles.includes("official_standard") ? 92
      : roles.includes("work_practice") ? 86
        : roles.includes("job_market") ? 78
          : roles.includes("role_boundary") ? 72
            : 36;
  const kindBonus = asset?.kind === "workspace_observation" ? 8
    : asset?.kind === "private_document" ? 5
      : 0;
  const tierBonus = asset?.sourceTier === "authoritative" ? 4
    : asset?.sourceTier === "primary" ? 3
      : asset?.sourceTier === "secondary" ? 1
        : 0;
  const qualificationPenalty = asset?.qualification?.status === "limited" ? 8
    : asset?.qualification?.status === "quarantined" ? 30
      : 0;
  return {
    segmentId: mention.sourceSegmentId,
    sourceKind: asset?.kind || "private_document",
    sourceTier: asset?.sourceTier,
    evidenceRoles: roles,
    qualificationStatus: asset?.qualification?.status,
    priority: Math.max(0, rolePriority + kindBonus + tierBonus - qualificationPenalty),
  };
}

function batchMentionsForTaskBarrier(mentions: ConceptMention[], tokenBudget = 6_000, itemLimit = 32) {
  const batches: ConceptMention[][] = [];
  let current: ConceptMention[] = [];
  let tokens = 0;
  for (const mention of mentions) {
    const size = estimateTokens(JSON.stringify({
      id: mention.id,
      kind: mention.kind,
      label: mention.surfaceForm,
      definition: mention.definitionHint,
      attributes: mention.attributes,
      quote: mention.evidenceSpan?.quote,
    }));
    if (current.length && (current.length >= itemLimit || tokens + size > tokenBudget)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(mention);
    tokens += size;
  }
  if (current.length) batches.push(current);
  return batches.length ? batches : [[]];
}

export function mergeResearchReports(base: WebResearchReport | undefined, next: WebResearchReport) {
  if (!base) return next;
  // Enrichment often receives the identical report already embedded in the
  // kernel. Rehydration is not another search or another billed request.
  if (JSON.stringify(base) === JSON.stringify(next)) return base;
  const includesQueries = base.provider === next.provider && next.queries.length > 0 && next.queries.every(query => base.queries.some(previous =>
    previous.id === query.id && (query.requestId || previous.requestId
      ? Boolean(query.requestId) && query.requestId === previous.requestId
      : base.completedAt === next.completedAt)));
  const includesExtraction = !next.extraction?.requestCount || (next.extraction.requestIds.length > 0
    && next.extraction.requestIds.length >= next.extraction.requestCount
    && next.extraction.requestIds.every(id => base.extraction?.requestIds.includes(id)));
  // A checkpoint may already contain this round inside its cumulative report.
  // Match executions, not query text/ID: an actual retry is still billable.
  if (includesQueries && includesExtraction) return base;
  const coverage = new Map(base.categoryCoverage.map((item) => [item.category, item]));
  for (const item of next.categoryCoverage) {
    const current = coverage.get(item.category);
    coverage.set(item.category, current ? {
      category: item.category,
      queryCount: current.queryCount + item.queryCount,
      candidateCount: current.candidateCount + item.candidateCount,
      selectedSourceCount: current.selectedSourceCount + item.selectedSourceCount,
      status: current.status === "covered" || item.status === "covered" ? "covered" : item.status,
    } : item);
  }
  return {
    ...base,
    completedAt: next.completedAt,
    queries: [...base.queries, ...next.queries],
    selectedSourceCount: base.selectedSourceCount + next.selectedSourceCount,
    candidateCount: base.candidateCount + next.candidateCount,
    deduplicatedCount: base.deduplicatedCount + next.deduplicatedCount,
    candidates: [...base.candidates, ...next.candidates],
    categoryCoverage: [...coverage.values()],
    failures: [...base.failures, ...next.failures],
    extraction: {
      requestCount: (base.extraction?.requestCount || 0) + (next.extraction?.requestCount || 0),
      requestedSourceCount: (base.extraction?.requestedSourceCount || 0) + (next.extraction?.requestedSourceCount || 0),
      extractedSourceCount: (base.extraction?.extractedSourceCount || 0) + (next.extraction?.extractedSourceCount || 0),
      failedSourceCount: (base.extraction?.failedSourceCount || 0) + (next.extraction?.failedSourceCount || 0),
      requestIds: [...(base.extraction?.requestIds || []), ...(next.extraction?.requestIds || [])],
    },
    usage: {
      searchCredits: (base.usage?.searchCredits || 0) + (next.usage?.searchCredits || 0),
      extractCredits: (base.usage?.extractCredits || 0) + (next.usage?.extractCredits || 0),
      totalCredits: (base.usage?.totalCredits || 0) + (next.usage?.totalCredits || 0),
    },
  } satisfies WebResearchReport;
}

function mergeResearchSources(existing: ColdStartRequest["sources"], incoming: ColdStartRequest["sources"]) {
  const merged = existing.map(source => ({ ...source }));
  const byContent = new Map(merged.map((source, index) => [`${source.locator || source.title}:${stableHash(source.content)}`, index]));
  for (const source of incoming) {
    const key = `${source.locator || source.title}:${stableHash(source.content)}`;
    const index = byContent.get(key);
    if (index === undefined) { byContent.set(key, merged.length); merged.push({ ...source }); }
    else {
      const previous = merged[index];
      merged[index] = { ...previous, queryIds: unique([...(previous.queryIds || []), ...(source.queryIds || [])]), searchCategories: unique([...(previous.searchCategories || []), ...(source.searchCategories || [])]) };
    }
  }
  return merged;
}

function prefixDerivedDraft(draft: SemanticDraft, prefix: string, stableTaskIds: Set<string>) {
  const remap = new Map<string, string>();
  for (const node of draft.nodes) if (!stableTaskIds.has(node.tempId)) remap.set(node.tempId, `${prefix}${node.tempId}`);
  return {
    ...draft,
    nodes: draft.nodes.map((node) => ({ ...node, tempId: remap.get(node.tempId) || node.tempId })),
    edges: draft.edges.map((edge) => ({
      ...edge,
      sourceTempId: remap.get(edge.sourceTempId) || edge.sourceTempId,
      targetTempId: remap.get(edge.targetTempId) || edge.targetTempId,
    })),
  };
}

function prefixProcessDraft(draft: ProcessDraft, prefix: string) {
  const scenarioIds = new Map(draft.scenarios.map((scenario) => [scenario.tempId, `${prefix}${scenario.tempId}`]));
  const nodeIds = new Map(draft.nodes.map((node) => [node.tempId, `${prefix}${node.tempId}`]));
  return {
    scenarios: draft.scenarios.map((scenario) => ({ ...scenario, tempId: scenarioIds.get(scenario.tempId)! })),
    nodes: draft.nodes.map((node) => ({
      ...node,
      tempId: nodeIds.get(node.tempId)!,
      scenarioTempId: scenarioIds.get(node.scenarioTempId) || node.scenarioTempId,
    })),
    edges: draft.edges.flatMap((edge) => {
      const sourceTempId = nodeIds.get(edge.sourceTempId);
      const targetTempId = nodeIds.get(edge.targetTempId);
      return sourceTempId && targetTempId ? [{ ...edge, sourceTempId, targetTempId }] : [];
    }),
    bridges: draft.bridges.flatMap((bridge) => {
      const processTempId = nodeIds.get(bridge.processTempId);
      return processTempId ? [{ ...bridge, processTempId }] : [];
    }),
  } satisfies ProcessDraft;
}

function mergeProcessDrafts(parts: ProcessDraft[]) {
  return {
    scenarios: parts.flatMap((part) => part.scenarios),
    nodes: parts.flatMap((part) => part.nodes),
    edges: parts.flatMap((part) => part.edges),
    bridges: parts.flatMap((part) => part.bridges),
  } satisfies ProcessDraft;
}

function splitTaskGroup(group: TaskGroup) {
  if (group.tasks.length < 2) return [group];
  const middle = Math.ceil(group.tasks.length / 2);
  return [group.tasks.slice(0, middle), group.tasks.slice(middle)].filter((tasks) => tasks.length).map((tasks, index) => ({
    id: `${group.id}:split-${index + 1}`,
    tasks,
    evidenceSegmentIds: unique(tasks.flatMap((task) => task.evidenceSegmentIds)),
  } satisfies TaskGroup));
}

function markRecoveredWorkItem(workItems: BuildWorkItemSummary[], stage: string, lane: string) {
  const item = workItems.findLast((candidate) => candidate.stage === stage && candidate.lane === lane && candidate.status === "failed");
  if (!item) return;
  item.status = "recovered";
  item.outputRefs = unique([...item.outputRefs, "recovered-by-local-split"]);
}

export function createColdStartSkill(model: ModelInvoker, options?: SkillOptions) {
  let sharedResearch = options?.researchAgent;
  const originalModel = model;
  let seq = options?.initialSeq || 0;
  const cache = options?.cache || new Map<string, unknown>();
  const boundaryVerifier = createBoundaryVerifier(model);

  function emit(request: ColdStartRequest, kind: BuildEventKind, profile: BuildEvent["profile"], payload: Record<string, unknown>) {
    if (options?.emitEvents === false) return;
    const event: BuildEvent = {
      version: "2.0",
      runId: request.runId,
      projectId: request.projectId,
      seq: seq += 1,
      time: new Date().toISOString(),
      kind,
      profile,
      payload,
    };
    getWriter()?.(event);
  }

  function reasoningEmitter(request: ColdStartRequest, lane: string, profile: BuildEvent["profile"]) {
    let buffer = "";
    let emittedAt = Date.now();
    const flush = () => {
      if (!buffer) return;
      emit(request, "build.reasoning.delta", profile, { lane, delta: buffer });
      buffer = "";
      emittedAt = Date.now();
    };
    return {
      push(delta: string) {
        buffer += delta;
        if (buffer.length >= 700 || Date.now() - emittedAt >= 250) flush();
      },
      flush,
    };
  }

  async function runWorkItem<T>(input: {
    request: ColdStartRequest;
    workItems: BuildWorkItemSummary[];
    stage: string;
    lane: string;
    inputRefs: string[];
    priority: number;
    estimatedInputTokens: number;
    maxOutputTokens: number;
    cachePayload: string;
    profile: BuildEvent["profile"];
    invoke: (onReasoning: (delta: string) => void) => Promise<T>;
  }) {
    const item = createWorkItem({
      runId: input.request.runId,
      stage: input.stage,
      lane: input.lane,
      inputRefs: input.inputRefs,
      priority: input.priority,
      estimatedInputTokens: input.estimatedInputTokens,
      maxOutputTokens: input.maxOutputTokens,
      cachePayload: input.cachePayload,
    });
    input.workItems.push(item);
    emit(input.request, "build.work_item.queued", input.profile, { workItem: { ...item } });
    const cached = cache.get(item.cacheKey) as T | undefined;
    if (cached !== undefined) {
      item.status = "completed";
      item.cacheHit = true;
      item.actualDurationMs = 0;
      emit(input.request, "build.work_item.completed", input.profile, { workItem: { ...item } });
      return cached;
    }
    item.status = "running";
    item.attempt += 1;
    const startedAt = Date.now();
    emit(input.request, "build.work_item.started", input.profile, { workItem: { ...item } });
    const reasoning = reasoningEmitter(input.request, input.lane, input.profile);
    try {
      const value = await input.invoke(reasoning.push);
      reasoning.flush();
      item.status = "completed";
      item.actualDurationMs = Date.now() - startedAt;
      item.outputRefs = [`result:${item.id}`];
      cache.set(item.cacheKey, value);
      emit(input.request, "build.work_item.completed", input.profile, { workItem: { ...item } });
      return value;
    } catch (error) {
      reasoning.flush();
      item.status = "failed";
      item.actualDurationMs = Date.now() - startedAt;
      item.error = error instanceof Error ? error.message.slice(0, 500) : "未知错误";
      emit(input.request, "build.work_item.failed", input.profile, { workItem: { ...item } });
      throw error;
    }
  }

  async function extractOneShard(input: {
    request: ColdStartRequest;
    prepared: PreparedBuild;
    shard: SourceShard;
    workItems: BuildWorkItemSummary[];
    signal?: AbortSignal;
    laneSuffix?: string;
    compact?: boolean;
  }) {
    const asset = input.prepared.assets.find((candidate) => candidate.id === input.shard.sourceId)!;
    const lane = `mention:${input.shard.id}${input.laneSuffix || ""}`;
    const prompt = mentionExtractionPrompt({
      roleTitle: input.request.roleTitle,
      sourceTitle: asset.title,
      evidenceRoles: input.shard.qualification.evidenceRoles,
      segments: input.shard.segments.map((segment) => ({ id: segment.id, text: segment.text })),
      mentionLimit: input.compact ? 4 : 6,
      propositionLimit: input.compact ? 2 : 4,
    });
    const estimatedInputTokens = estimateTokens(prompt.user);
    const maxOutputTokens = input.compact ? 1_400 : 1_800;
    const draft = await runWorkItem({
      request: input.request,
      workItems: input.workItems,
      stage: "source-mention-extraction",
      lane,
      inputRefs: input.shard.segmentIds,
      priority: 10,
      estimatedInputTokens,
      maxOutputTokens,
      cachePayload: `${COLD_START_WORKFLOW_VERSION}:${input.request.roleTitle}:${asset.contentHash}:${input.shard.segmentIds.join(":")}:${input.compact ? "compact" : "normal"}:${prompt.system}:${prompt.user}`,
      profile: "evidence",
      invoke: (onReasoning) => invokeStructured({
        model,
        ...prompt,
        schema: mentionExtractionSchema,
        signal: input.signal,
        thinking: "disabled",
        maxCompletionTokens: maxOutputTokens,
        timeoutMs: 45_000,
        totalTimeoutMs: 70_000,
        normalize: (value) => normalizeMentionExtraction(value, input.shard.segments),
        onReasoning,
      }),
    });
    const workItemId = input.workItems.findLast((item) => item.lane === lane)?.id || lane;
    return materializeMentionDraft({ runId: input.request.runId, workItemId, draft });
  }

  async function extractShards(input: {
    request: ColdStartRequest;
    prepared: PreparedBuild;
    shards: SourceShard[];
    workItems: BuildWorkItemSummary[];
    signal?: AbortSignal;
  }) {
    const failures: string[] = [];
    const recoverShard = async (shard: SourceShard, depth = 0): Promise<{ mentions: ConceptMention[]; propositions: RelationProposition[]; ok: boolean }> => {
      try {
        const part = await extractOneShard({ ...input, shard, laneSuffix: depth ? `:recovery-${depth}` : undefined, compact: depth > 0 });
        return { ...part, ok: true };
      } catch (error) {
        if (shard.segments.length < 2 && depth === 0) {
          try {
            const part = await extractOneShard({ ...input, shard, laneSuffix: ":recovery-1", compact: true });
            markRecoveredWorkItem(input.workItems, "source-mention-extraction", `mention:${shard.id}`);
            return { ...part, ok: true };
          } catch (recoveryError) {
            failures.push(`来源分片 ${shard.id} 紧凑恢复失败：${recoveryError instanceof Error ? recoveryError.message : "未知错误"}`);
            return { mentions: [], propositions: [], ok: false };
          }
        }
        if (shard.segments.length < 2 || depth >= 3) {
          failures.push(`来源分片 ${shard.id} 抽取失败：${error instanceof Error ? error.message : "未知错误"}`);
          return { mentions: [], propositions: [], ok: false };
        }
        const middle = Math.ceil(shard.segments.length / 2);
        const halves = [shard.segments.slice(0, middle), shard.segments.slice(middle)];
        const recovered = await mapWithConcurrency(halves, 2, async (segments, index) => {
          const child: SourceShard = {
            ...shard,
            id: `${shard.id}:split-${index + 1}`,
            segments,
            segmentIds: segments.map((segment) => segment.id),
            estimatedTokens: estimateTokens(segments.map((segment) => segment.text).join("\n")),
          };
          return recoverShard(child, depth + 1);
        });
        const ok = recovered.every((part) => part.ok);
        if (ok) markRecoveredWorkItem(input.workItems, "source-mention-extraction", `mention:${shard.id}`);
        return { mentions: recovered.flatMap((part) => part.mentions), propositions: recovered.flatMap((part) => part.propositions), ok };
      }
    };
    const parts = await mapWithConcurrency(input.shards, 4, async (shard) => {
      const part = await recoverShard(shard);
      return { mentions: part.mentions, propositions: part.propositions };
    });
    return {
      mentions: parts.flatMap((part) => part.mentions),
      propositions: parts.flatMap((part) => part.propositions),
      failures,
    };
  }

  const researchSources = async (state: typeof BuildState.State, config: { signal?: AbortSignal }) => {
    const runStartedAt = Date.now();
    emit(state.request, "build.run.started", "system", { roleTitle: state.request.roleTitle, workflowVersion: COLD_START_WORKFLOW_VERSION });
    if (state.request.research && !options?.researchPerformed) {
      const settings = state.request.research;
      sharedResearch ||= buildResearchAgent({ model: originalModel, searchConfig: options?.searchConfig, budget: settings.budget, onCheckpoint: options?.onResearchCheckpoint });
      if (options?.researchCheckpoint && !sharedResearch.record()) sharedResearch.restore(options.researchCheckpoint);
      model = sharedResearch.model;
      const prepared = prepareBuildInput(state.request);
      const contract: IterationContract = { id: state.request.runId, research: settings, objective: settings.objective || `研究${state.request.roleTitle}的岗位边界、典型任务、知识能力和完整工作过程，面向高职学生，优先支持下游项目转换`, initiativeProfile: "autonomous", mode: "deep_research", targetIds: [], targetAsOf: state.request.snapshotAsOf, changeIntents: ["expand", "verify"], evidencePolicy: [], acceptancePolicy: [], inferredFrom: ["cold_start"], budgets: { maxRounds: settings.budget.revisions, maxSources: settings.budget.queries, maxWorkItems: settings.budget.tasks, graphRadius: "global" } };
      try {
      const cards = await sharedResearch.plan({ contract, sources: prepared, graph: state.result, workItems: [], round: (sharedResearch.record()?.agenda.revision || 0) + 1, context: { role: state.request.roleTitle, boundary: state.request.roleDescription, targetAsOf: state.request.snapshotAsOf, audience: state.request.audience, currentQuality: state.result?.deliveryReadiness }, signal: config.signal });
      const results = await runResearchWorkers({ cards, concurrency: sharedResearch.concurrency, runOne: card => sharedResearch!.run(card, { request: state.request, assets: prepared.assets, segments: prepared.segments, graph: state.result, signal: config.signal }) });
      emit(state.request, "build.research.completed", "evidence", { taskCount: cards.length, findingCount: results.reduce((sum, result) => sum + result.claims.length, 0), budget: sharedResearch.budgetLedger.snapshot() });
      } catch (error) {
        if (config.signal?.aborted) throw error;
        await sharedResearch.finish(error instanceof Error && error.message.includes("BUDGET") ? "budget_exhausted" : "failed");
        emit(state.request, "build.research.completed", "evidence", { failed: error instanceof Error ? error.message : "research_failed", budget: sharedResearch.budgetLedger.snapshot() });
      }
      return { activeRequest: { ...state.request, sources: mergeResearchSources(state.request.sources, sharedResearch.collectedSources()) }, runStartedAt };
    }
    if (!options?.searchConfig) return { activeRequest: state.request, researchReport: options?.existingResearchReport, runStartedAt };
    const searchPlan = await createRoleSearchPlan({ request: state.request, model, signal: config.signal, onReasoning: (delta) => emit(state.request, "build.reasoning.delta", "evidence", { lane: "search-planning", delta }) });
    const researched = await researchRoleSources({
      request: state.request,
      config: options.searchConfig,
      queries: searchPlan.queries,
      planStrategy: searchPlan.strategy,
      plannerFallbackReason: searchPlan.fallbackReason,
      sourceLimit: options.sourceLimit,
      verifyBoundaries: boundaryVerifier,
      signal: config.signal,
      onProgress: (progress) => {
        const kind = { plan: "build.research.plan.created", "search-started": "build.search.started", "search-retrying": "build.search.retrying", "search-completed": "build.search.completed", "search-failed": "build.search.failed", "source-fetched": "build.source.fetched", "source-deduplicated": "build.source.deduplicated" }[progress.kind] as BuildEventKind;
        emit(state.request, kind, "evidence", progress.payload);
      },
    });
    emit(state.request, "build.research.completed", "evidence", { queryCount: researched.report.queries.length, selectedSourceCount: researched.report.selectedSourceCount, failureCount: researched.report.failures.length, totalCredits: researched.report.usage?.totalCredits });
    return { activeRequest: { ...state.request, sources: mergeResearchSources(state.request.sources, researched.sources) }, researchReport: mergeResearchReports(options.existingResearchReport, researched.report), runStartedAt };
  };

  const prepareSources = async (state: typeof BuildState.State) => {
    const activeRequest = state.activeRequest || state.request;
    const raw = prepareBuildInput(activeRequest);
    const assets = qualifySources(raw.assets, raw.segments);
    const prepared = { ...raw, assets };
    const routed = selectKernelSourceShards({
      shards: createSourceShards({ assets, segments: prepared.segments, targetTokens: 1_200, hardTokenLimit: 2_200 }),
      assets,
      roleTitle: activeRequest.roleTitle,
    });
    const shards = routed.selected;
    emit(state.request, "build.boundary.stabilized", "structural", { brief: prepared.brief, assumptionCount: prepared.brief.assumptions.length });
    emit(state.request, "build.plan.created", "system", { workflowVersion: COLD_START_WORKFLOW_VERSION, criticalPath: ["source-qualification", "mention-extraction", "task-barrier", "role-kernel-compile"], background: ["capability-derivation", "knowledge-detail", "skill-dependencies", "work-process", "inspection"], parallelism: { mentionShards: 4, taskKnowledge: 2, taskProcess: 2, capability: 1 } });
    for (const asset of assets) {
      emit(state.request, "build.source.registered", "evidence", { sourceId: asset.id, title: asset.title, kind: asset.kind, visibility: asset.visibility });
      emit(state.request, "build.source.qualified", "evidence", { sourceId: asset.id, qualification: asset.qualification });
    }
    emit(state.request, "build.source.segmented", "evidence", { sourceCount: assets.length, segmentCount: prepared.segments.length, shardCount: shards.length, deferredShardCount: routed.deferred.length, deferredSourceIds: unique(routed.deferred.map((shard) => shard.sourceId)), shards: shards.map((shard) => ({ id: shard.id, sourceId: shard.sourceId, segmentCount: shard.segments.length, estimatedTokens: shard.estimatedTokens })) });
    return { prepared, shards, workItems: [], mentions: [], relationPropositions: [], laneFailures: [] };
  };

  const extractMentions = async (state: typeof BuildState.State, config: { signal?: AbortSignal }) => {
    const workItems = [...state.workItems];
    emit(state.request, "build.lane.started", "evidence", { lane: "mention-extraction", shardCount: state.shards.length, concurrency: 4 });
    const extracted = await extractShards({ request: state.request, prepared: state.prepared!, shards: state.shards, workItems, signal: config.signal });
    emit(state.request, "build.lane.completed", "evidence", { lane: "mention-extraction", mentionCount: extracted.mentions.length, propositionCount: extracted.propositions.length, failedShardCount: extracted.failures.length });
    return { mentions: extracted.mentions, relationPropositions: extracted.propositions, workItems, laneFailures: extracted.failures };
  };

  const convergeTasks = async (state: typeof BuildState.State, config: { signal?: AbortSignal }) => {
    const workItems = [...state.workItems];
    const mentionContexts = new Map(state.mentions.map((mention) => [mention.id, taskEvidenceContextForMention(mention, state.prepared!)]));
    const taskMentions = state.mentions
      .filter((mention) => ["task", "work_event", "deliverable", "role_context"].includes(mention.kind))
      .sort((left, right) => (mentionContexts.get(right.id)?.priority || 0) - (mentionContexts.get(left.id)?.priority || 0));
    const batches = batchMentionsForTaskBarrier(taskMentions);
    const candidates = await mapWithConcurrency(batches, 2, async (mentions, index) => {
      if (!mentions.length) return fallbackTaskBarrier(state.request.roleTitle, state.mentions);
      const prompt = taskBarrierPrompt({
        roleTitle: state.request.roleTitle,
        roleDescription: state.request.roleDescription,
        mentions,
        sourceContexts: mentions.map((mention) => mentionContexts.get(mention.id)!),
      });
      try {
        return await runWorkItem({
          request: state.request,
          workItems,
          stage: "task-normalization",
          lane: `task-barrier:batch-${index + 1}`,
          inputRefs: mentions.map((mention) => mention.id),
          priority: 9,
          estimatedInputTokens: estimateTokens(prompt.user),
          maxOutputTokens: 2_400,
          cachePayload: prompt.user,
          profile: "semantic",
          invoke: (onReasoning) => invokeStructured({ model, ...prompt, schema: taskBarrierSchema, signal: config.signal, thinking: "disabled", maxCompletionTokens: 2_400, timeoutMs: 45_000, totalTimeoutMs: 70_000, normalize: (value) => normalizeTaskBarrier(value, state.mentions), onReasoning }),
        });
      } catch {
        return fallbackTaskBarrier(state.request.roleTitle, mentions);
      }
    });
    let layer = candidates;
    let consolidationRound = 0;
    while (layer.length > 1) {
      consolidationRound += 1;
      const groups = Array.from({ length: Math.ceil(layer.length / 3) }, (_, index) => layer.slice(index * 3, (index + 1) * 3));
      layer = await mapWithConcurrency(groups, 2, async (candidateGroup, index) => {
        if (candidateGroup.length === 1) return candidateGroup[0];
        const candidateMentionIds = unique(candidateGroup.flatMap((candidate) => candidate.tasks.flatMap((task) => task.mentionIds)));
        const prompt = taskConsolidationPrompt({
          roleTitle: state.request.roleTitle,
          roleDescription: state.request.roleDescription,
          candidates: candidateGroup,
          mentionPriorities: Object.fromEntries(candidateMentionIds.map((id) => [id, mentionContexts.get(id)?.priority || 0])),
        });
        try {
          return await runWorkItem({
            request: state.request,
            workItems,
            stage: "task-consolidation",
            lane: `task-barrier:reduce-${consolidationRound}-${index + 1}`,
            inputRefs: candidateGroup.flatMap((candidate) => candidate.tasks.flatMap((task) => task.mentionIds)),
            priority: 10,
            estimatedInputTokens: estimateTokens(prompt.user),
            maxOutputTokens: 3_400,
            cachePayload: prompt.user,
            profile: "semantic",
            invoke: (onReasoning) => invokeStructured({ model, ...prompt, schema: taskBarrierSchema, signal: config.signal, thinking: "disabled", maxCompletionTokens: 3_400, timeoutMs: 50_000, totalTimeoutMs: 80_000, normalize: (value) => normalizeTaskBarrier(value, state.mentions), onReasoning }),
          });
        } catch {
          const allowed = new Set(candidateGroup.flatMap((candidate) => candidate.tasks.flatMap((task) => task.mentionIds)));
          return fallbackTaskBarrier(state.request.roleTitle, state.mentions.filter((mention) => allowed.has(mention.id)));
        }
      });
    }
    let barrier: TaskBarrierDraft = layer[0] || fallbackTaskBarrier(state.request.roleTitle, state.mentions);
    if (!barrier.tasks.length) barrier = fallbackTaskBarrier(state.request.roleTitle, state.mentions);
    const taskDraft = taskBarrierToSemanticDraft(barrier, state.mentions);
    const taskGroups = groupTasks(taskDraft.nodes);
    const fast = compileSemanticDraft({ request: state.request, draft: taskDraft, segments: state.prepared!.segments, assets: state.prepared!.assets });
    const firstTaskSkeletonMs = Date.now() - (state.runStartedAt || Date.now());
    emit(state.request, "build.task_barrier.completed", "semantic", { taskCount: barrier.tasks.length, taskGroupCount: taskGroups.length, durationMs: firstTaskSkeletonMs });
    emit(state.request, "build.semantic.patch", "semantic", { phase: "task-skeleton", partial: true, nodes: fast.nodes, edges: fast.edges });
    return { taskDraft, taskGroups, firstTaskSkeletonMs, workItems };
  };

  const buildKernel = async (state: typeof BuildState.State) => {
    const workItems = [...state.workItems];
    const kernelFailures = [...state.laneFailures];
    const taskDraft = state.taskDraft || fallbackSemanticDraft;
    const projection = buildKernelTaskProjection(taskDraft, 8);
    const visibleTasks = visibleKernelTaskDraft(taskDraft, projection);
    emit(state.request, "build.lane.started", "semantic", { lane: "kernel", taskCount: visibleTasks.length, concurrency: 0, deterministicCompile: true });
    // Stop the user-facing critical path at the stable task barrier. The same
    // immutable package already retains all evidence; capability, knowledge,
    // dependencies and process expand as child versions in the workspace.
    const kernelDraft = taskDraft;
    const linked = materializeRelationPropositions({ draft: kernelDraft, propositions: state.relationPropositions });
    const kernelRequest = { ...state.request, runId: `${state.request.runId}:kernel` };
    const semantic = compileSemanticDraft({ request: kernelRequest, draft: linked.draft, segments: state.prepared!.segments, assets: state.prepared!.assets });
    semantic.nodes = annotateKernelNodes({ nodes: semantic.nodes, tempToId: semantic.tempToId, projection });
    const process = compileProcessDraft({ draft: emptyProcessDraft(), segments: state.prepared!.segments, assets: state.prepared!.assets, semanticNodes: semantic.nodes });
    const firstKernelMs = Date.now() - (state.runStartedAt || Date.now());
    const metrics: ColdStartBuildMetrics = {
      firstTaskSkeletonMs: state.firstTaskSkeletonMs,
      firstKernelMs,
      estimatedInputTokens: workItems.reduce((sum, item) => sum + item.estimatedInputTokens, 0),
      maxOutputTokens: workItems.reduce((sum, item) => sum + item.maxOutputTokens, 0),
      cacheHits: workItems.filter((item) => item.cacheHit).length,
      failedWorkItems: workItems.filter((item) => item.status === "failed").length,
      targetedResearchQueries: state.targetedResearchQueries,
    };
    const kernelResult = compileRolePackage({
      request: kernelRequest,
      brief: state.prepared!.brief,
      assets: state.prepared!.assets,
      segments: state.prepared!.segments,
      semantic,
      process,
      laneFailures: kernelFailures,
      research: state.researchReport,
      mentions: state.mentions,
      relationPropositions: linked.propositions,
      workItems,
      buildMetrics: metrics,
    });
    kernelResult.process.capsules = createProcessCapsules(kernelResult.semantic.nodes, state.mentions);
    const processSection = kernelResult.snapshot.sections.find((section) => section.id === "work-process");
    if (processSection) {
      processSection.itemIds = kernelResult.process.capsules.map((capsule) => capsule.id);
      processSection.summary = "已形成与默认任务雷达一致的事理胶囊；场景、分支、交付物和返工将在后台按证据增量展开。";
    }
    kernelResult.validation.publishable = false;
    kernelResult.snapshot.status = "candidate";
    kernelResult.packages.rolePackage.status = "candidate";
    refreshRolePackageManifest(kernelResult, { status: "candidate" });
    kernelResult.build = {
      ...kernelResult.build!,
      stage: "kernel",
      enrichment: {
        baseSnapshotId: kernelResult.snapshot.id,
        status: "queued",
        completedLanes: [],
        pendingLanes: ["capability", "knowledge", "skill_dependencies", "process", "inspection"],
        updatedAt: new Date().toISOString(),
      },
    };
    const visibleNodeCount = kernelResult.semantic.nodes.filter((node) => node.defaultVisibility !== false).length;
    emit(state.request, "build.semantic.patch", "semantic", { phase: "kernel", nodes: kernelResult.semantic.nodes, edges: kernelResult.semantic.edges, visibleNodeCount });
    emit(state.request, "build.lane.completed", "semantic", { lane: "kernel", visibleTaskCount: visibleTasks.length, visibleNodeCount, durationMs: firstKernelMs });
    emit(state.request, "build.fast_snapshot.completed", "structural", { preview: Boolean(state.request.research), result: kernelResult, metrics, parentRunId: state.request.runId, compatibilityAlias: true });
    emit(state.request, "build.kernel.completed", "structural", { preview: Boolean(state.request.research), result: kernelResult, metrics, visibleTaskCount: visibleTasks.length, visibleNodeCount, backgroundLanes: ["capability", "knowledge", "skill_dependencies", "process", "inspection"] });
    if (!state.request.research) emit(state.request, "build.enrichment.queued", "system", { baseSnapshotId: kernelResult.snapshot.id, lanes: ["capability", "knowledge", "skill_dependencies", "process", "inspection"] });
    return {
      kernelResult,
      result: kernelResult,
      semanticDraft: kernelDraft,
      taskGroups: groupTasks(taskDraft.nodes.filter(node => node.type === "task")),
      workItems,
      relationPropositions: linked.propositions,
      laneFailures: kernelFailures,
    };
  };

  const needsTaskRecovery = (state: typeof BuildState.State) => {
    if (state.request.research) return "build_kernel";
    if (state.taskDraft?.nodes.some(node => node.type === "task")) return "build_kernel";
    if (state.taskRecoveryRound >= 2) return "build_kernel";
    const allShards = createSourceShards({ assets: state.prepared!.assets, segments: state.prepared!.segments });
    const unexamined = allShards.some(shard => !state.shards.some(existing => existing.id === shard.id)
      && state.prepared!.assets.find(asset => asset.id === shard.sourceId)?.kind !== "user_brief");
    return options?.searchConfig || unexamined ? "recover_task_evidence" : "build_kernel";
  };

  const recoverTaskEvidence = async (state: typeof BuildState.State, config: { signal?: AbortSignal }) => {
    const round = state.taskRecoveryRound + 1;
    const role = researchRoleTitle(state.request.roleTitle);
    let activeRequest = state.activeRequest || state.request;
    let report = state.researchReport;
    const failures = [...state.laneFailures];
    const queries: PlannedQuery[] = (round === 1
      ? [{ category: "job_market" as const, query: `${role} 岗位职责 任职要求` }, { category: "work_practice" as const, query: `${role} 项目交付 工作流程` }]
      : [{ category: "job_market" as const, query: `${role} 招聘 职位描述` }, { category: "work_practice" as const, query: `${role} 项目案例 实施过程` }]
    ).map((query, i) => ({ ...query, id: `task-recovery:${state.request.runId}:${round}:${i}`, priority: 10 - i }));
    emit(state.request, "build.targeted_research.started", "evidence", { reason: "missing_task_layer", round, queryCount: options?.searchConfig ? queries.length : 0, message: "尚未找到可支撑岗位任务的证据，正在补充招聘职责和真实工作实践。" });
    if (options?.searchConfig) {
      try {
        const researched = await researchRoleSources({ request: { ...state.request, roleTitle: role }, config: options.searchConfig, queries, sourceLimit: 16, verifyBoundaries: boundaryVerifier, signal: config.signal });
        activeRequest = { ...activeRequest, sources: mergeResearchSources(activeRequest.sources, researched.sources) };
        report = mergeResearchReports(report, researched.report);
      } catch (error) {
        if (config.signal?.aborted) throw error;
        failures.push(`任务证据补研未完成：${error instanceof Error ? error.message : "检索失败"}`);
      }
    }
    const raw = prepareBuildInput(activeRequest);
    const assets = qualifySources(raw.assets, raw.segments);
    const prepared = { ...raw, assets };
    const examined = new Set(state.shards.map(shard => shard.id));
    const routed = selectKernelSourceShards({ shards: createSourceShards({ assets, segments: raw.segments }).filter(shard => !examined.has(shard.id)), assets, roleTitle: role, maxPublicShards: 16 });
    const shards = [...state.shards, ...routed.selected];
    emit(state.request, "build.targeted_research.completed", "evidence", { reason: "missing_task_layer", round, addedSourceShards: routed.selected.length, report });
    return { activeRequest, prepared, researchReport: report, shards, taskRecoveryRound: round, targetedResearchQueries: state.targetedResearchQueries + (options?.searchConfig ? queries.length : 0), laneFailures: failures };
  };

  const hydrateKernel = async (state: typeof BuildState.State) => {
    const base = state.baseResult;
    if (!base) throw new Error("KERNEL_SNAPSHOT_REQUIRED");
    const taskDraft = semanticDraftFromKernel(base);
    const prepared: PreparedBuild = { brief: base.brief, assets: base.sources.assets, segments: base.sources.segments };
    emit(state.request, "build.enrichment.started", "system", {
      baseSnapshotId: base.snapshot.id,
      kernelNodeCount: base.semantic.nodes.filter((node) => node.defaultVisibility !== false).length,
      lanes: ["capability", "knowledge", "skill_dependencies", "process", "inspection"],
    });
    return {
      activeRequest: state.request,
      runStartedAt: Date.now(),
      researchReport: options?.existingResearchReport
        ? mergeResearchReports(base.sources.research, options.existingResearchReport) : base.sources.research,
      prepared,
      shards: [],
      mentions: base.sources.mentions || [],
      relationPropositions: base.sources.relationPropositions || [],
      taskDraft,
      semanticDraft: taskDraft,
      taskGroups: groupTasks(taskDraft.nodes.filter(node => node.type === "task"
        && (!options?.knowledgeTargetIds?.length || options.knowledgeTargetIds.includes(node.tempId)))),
      firstTaskSkeletonMs: base.build?.metrics.firstTaskSkeletonMs,
      kernelResult: base,
      workItems: [...(base.build?.workItems || [])],
      targetedResearchQueries: 0,
      laneFailures: [],
    };
  };

  const targetedKnowledgeResearch = async (state: typeof BuildState.State, config: { signal?: AbortSignal }, knowledgeGroups: TaskGroup[]) => {
    if (state.request.research || !options?.searchConfig || !knowledgeGroups.length) return {};
    const budget = Math.max(0, 32 - state.targetedResearchQueries);
    // A failed quality check overrides pre-extraction heuristics: the presence
    // of a technical document or mention did not actually close these gaps.
    const needy = knowledgeGroups.filter(group => state.qualityRepairRound > 0
      || taskGroupNeedsKnowledgeResearch(group, state.mentions, state.prepared!.assets, state.prepared!.segments)).slice(0, Math.min(8, budget));
    if (!needy.length) return {};
    const category = state.qualityRepairRound === 1 ? "work_practice" : state.qualityRepairRound > 1 ? "education" : "technology";
    const angle = category === "technology" ? "官方文档 原理 操作 验证" : category === "work_practice" ? "项目实践 操作流程 故障诊断 交付 验收" : "实训项目 知识原理 技能练习 评价标准";
    const queries: PlannedQuery[] = needy.map((group, index) => ({ id: `targeted:${state.request.runId}:${state.qualityRepairRound}:${index + 1}`, category, query: `${researchRoleTitle(state.request.roleTitle)} ${group.tasks.map((task) => task.label).join(" ")} ${angle}`, priority: 9 - index * 0.1 }));
    emit(state.request, "build.targeted_research.started", "evidence", { queryCount: queries.length, taskGroupIds: needy.map((group) => group.id) });
    try {
      const researched = await researchRoleSources({
        request: state.activeRequest || state.request,
        config: options.searchConfig,
        queries,
        planStrategy: "deterministic",
        sourceLimit: Math.min(16, Math.max(6, queries.length * 2)),
        verifyBoundaries: boundaryVerifier,
        signal: config.signal,
        onProgress: (progress) => {
          const kind = { plan: "build.research.plan.created", "search-started": "build.search.started", "search-retrying": "build.search.retrying", "search-completed": "build.search.completed", "search-failed": "build.search.failed", "source-fetched": "build.source.fetched", "source-deduplicated": "build.source.deduplicated" }[progress.kind] as BuildEventKind;
          emit(state.request, kind, "evidence", { ...progress.payload, targeted: true });
        },
      });
      if (!researched.sources.length) {
        emit(state.request, "build.targeted_research.completed", "evidence", { queryCount: queries.length, selectedSourceCount: 0 });
        return { targetedResearchQueries: queries.length, researchReport: mergeResearchReports(state.researchReport, researched.report) };
      }
      const rawNew = prepareBuildInput({ ...state.request, sources: researched.sources });
      const qualifiedNew = qualifySources(rawNew.assets, rawNew.segments);
      const oldSources = new Set(state.prepared!.assets.map((asset) => asset.contentHash));
      const appendedAssets = qualifiedNew.filter((asset) => !oldSources.has(asset.contentHash));
      const newSourceIds = new Set(appendedAssets.map((asset) => asset.id));
      const appendedSegments = rawNew.segments.filter((segment) => newSourceIds.has(segment.sourceId));
      const prepared: PreparedBuild = {
        brief: state.prepared!.brief,
        assets: [...state.prepared!.assets, ...appendedAssets],
        segments: [...state.prepared!.segments, ...appendedSegments],
      };
      const shards = createSourceShards({ assets: appendedAssets, segments: appendedSegments, targetTokens: 1_200, hardTokenLimit: 2_200 });
      emit(state.request, "build.targeted_research.completed", "evidence", { queryCount: queries.length, selectedSourceCount: researched.sources.length, newMentionCount: 0, directToKnowledgeLane: true });
      return { prepared, shards: [...state.shards, ...shards], targetedResearchQueries: queries.length, researchReport: mergeResearchReports(state.researchReport, researched.report) };
    } catch (error) {
      if (config.signal?.aborted) throw error;
      const detail = error instanceof Error ? error.message : "定点补研失败";
      emit(state.request, "build.targeted_research.completed", "evidence", { queryCount: queries.length, degraded: true, detail });
      return { targetedResearchQueries: queries.length, laneFailures: [...state.laneFailures, `知识技能定点补研失败：${detail}`] };
    }
  };

  const deriveLayers = async (state: typeof BuildState.State, config: { signal?: AbortSignal }) => {
    const workItems = [...state.workItems];
    // Execution records retain earlier failures; the final audit describes the
    // current attempt instead of re-importing already repaired lane warnings.
    const failures = state.qualityRepairRound ? [] : [...state.laneFailures];
    const stableTaskIds = new Set((state.taskDraft?.nodes || []).filter((node) => node.type === "task").map((node) => node.tempId));

    // Presentation folding is not a research boundary: hidden detail tasks need
    // their own learning support too. Two tasks share a bounded context/output.
    const focusIds = state.qualityRepairRound && state.qualityTaskIds.length ? new Set(state.qualityTaskIds)
      : options?.execution === "enrichment" && options.knowledgeTargetIds?.length ? new Set(options.knowledgeTargetIds) : undefined;
    const knowledgeGroups = groupTasks((state.taskDraft?.nodes || []).filter(node => state.qualityRepairRound
      ? state.qualityKnowledgeTaskIds.includes(node.tempId) : !focusIds || focusIds.has(node.tempId)), 2);
    const researchGroups = state.qualityRepairRound ? groupTasks((state.taskDraft?.nodes || []).filter(node => state.qualityTaskIds.includes(node.tempId)), 2) : knowledgeGroups;
    // All downstream lanes consume the fresh evidence, including process and
    // capability repair (previously only the knowledge lane saw these sources).
    const targeted = await targetedKnowledgeResearch(state, config, researchGroups);
    const evidenceState = { ...state, prepared: targeted.prepared || state.prepared! };
    const targetedPromise = Promise.resolve(targeted);
    const invokeKnowledgeGroup = async (group: TaskGroup, prefix: string, prepared: PreparedBuild) => {
      const segments = selectKnowledgeContext({ group, segments: prepared.segments, mentions: state.mentions, assets: prepared.assets, maxTokens: 9_600 });
      const mentions = mentionsForSegments(state.mentions, segments.map((segment) => segment.id));
      const prompt = knowledgeDerivationPrompt({ roleTitle: state.request.roleTitle, roleDescription: state.request.roleDescription, group, mentions, segments, assets: prepared.assets, definitionTargets: (state.semanticDraft?.nodes || []).filter(node => options?.learningDefinitionTargetIds?.includes(node.tempId)), mode: "detail", iterationObjective: options?.iterationObjective });
      const lane = `knowledge:${group.id}${state.qualityRepairRound ? `:pass-${state.qualityRepairRound}` : ""}`;
      const outputBudget = group.tasks.length > 1 ? 8_000 : 6_000;
      const draft = await runWorkItem({ request: state.request, workItems, stage: "task-knowledge-derivation", lane, inputRefs: [group.id, ...group.tasks.map(task => task.tempId), ...segments.map((segment) => segment.id)], priority: 7, estimatedInputTokens: estimateTokens(prompt.user), maxOutputTokens: outputBudget, cachePayload: JSON.stringify(prompt), profile: "semantic", invoke: (onReasoning) => invokeStructured({ model, ...prompt, schema: knowledgeDerivationSchema, signal: config.signal, thinking: "disabled", maxCompletionTokens: outputBudget, timeoutMs: 65_000, totalTimeoutMs: 95_000, onReasoning }) });
      const checked = inspectKnowledgeDerivation({ draft, group, mentions, segments });
      let accepted = checked.accepted;
      let quality = checked;
      let remainingIssues = checked.issues;
      if (checked.incompleteTaskIds.length || checked.issues.length) {
        const repairPrompt = knowledgeDerivationPrompt({ roleTitle: state.request.roleTitle, roleDescription: state.request.roleDescription, group, mentions, segments, assets: prepared.assets, definitionTargets: (state.semanticDraft?.nodes || []).filter(node => options?.learningDefinitionTargetIds?.includes(node.tempId)), mode: "detail", iterationObjective: options?.iterationObjective, repair: {
          acceptedPoints: accepted.skills.map((point) => ({ label: point.label, learningKind: point.learningKind, scopeNote: point.learningDefinition?.scopeNote, taskTempIds: point.taskTempIds })),
          issues: checked.issues,
          uncoveredTaskIds: checked.uncoveredTaskIds,
          coverage: checked.coverage,
        } });
        try {
          const repaired = await runWorkItem({ request: state.request, workItems, stage: "task-knowledge-derivation", lane: `${lane}:coverage-repair`, inputRefs: [group.id, ...checked.incompleteTaskIds], priority: 7, estimatedInputTokens: estimateTokens(repairPrompt.user), maxOutputTokens: outputBudget, cachePayload: JSON.stringify(repairPrompt), profile: "semantic", invoke: (onReasoning) => invokeStructured({ model, ...repairPrompt, schema: knowledgeDerivationSchema, signal: config.signal, thinking: "disabled", maxCompletionTokens: outputBudget, timeoutMs: 65_000, totalTimeoutMs: 95_000, onReasoning }) });
          const repairCheck = inspectKnowledgeDerivation({ draft: repaired, group, mentions, segments });
          quality = inspectKnowledgeDerivation({ draft: mergeKnowledgeDerivations(accepted, repairCheck.accepted), group, mentions, segments });
          accepted = quality.accepted;
          remainingIssues = repairCheck.issues;
        } catch (error) {
          if (config.signal?.aborted) throw error;
          failures.push(`任务组 ${group.id} 的知识技能补齐未完成：${error instanceof Error ? error.message : "未知错误"}`);
        }
      }
      for (const gap of accepted.gaps) {
        const label = group.tasks.find((task) => task.tempId === gap.taskTempId)?.label || gap.taskTempId;
        failures.push(`知识技能覆盖缺口「${label}」：${gap.reason}`);
      }
      for (const issue of remainingIssues) failures.push(`知识技能待拆解或补证：${issue.detail}`);
      emit(state.request, "build.lane.completed", "semantic", { lane: `${lane}:quality`, acceptedPointCount: accepted.skills.length, coverage: quality.coverage, uncoveredTaskIds: quality.uncoveredTaskIds, incompleteTaskIds: quality.incompleteTaskIds, gaps: accepted.gaps, rejectedPointCount: remainingIssues.length, degraded: accepted.gaps.length > 0 || remainingIssues.length > 0 });
      return prefixDerivedDraft(knowledgeToSemanticDraft({ draft: accepted, group, mentions, segments }), prefix, stableTaskIds);
    };

    const knowledgeBranchPromise = (async () => {
      const targeted = await targetedPromise;
      const prepared = targeted.prepared || state.prepared!;
      const partsNested = await mapWithConcurrency(knowledgeGroups, 2, async (group, index) => {
      try {
        return [await invokeKnowledgeGroup(group, `q${state.qualityRepairRound}:g${index + 1}:`, prepared)];
      } catch (error) {
        if (config.signal?.aborted) throw error;
        const children = splitTaskGroup(group);
        if (children.length === 1) {
          failures.push(`任务组 ${group.id} 的知识技能派生失败：${error instanceof Error ? error.message : "未知错误"}`);
          return [fallbackSemanticDraft];
        }
        const recovered = await mapWithConcurrency(children, 2, async (child, childIndex) => {
          try {
            return { ok: true as const, draft: await invokeKnowledgeGroup(child, `q${state.qualityRepairRound}:g${index + 1}r${childIndex + 1}:`, prepared) };
          } catch (childError) {
            if (config.signal?.aborted) throw childError;
            failures.push(`任务子组 ${child.id} 的知识技能派生失败：${childError instanceof Error ? childError.message : "未知错误"}`);
            return { ok: false as const, draft: fallbackSemanticDraft };
          }
        });
        const recoveredCount = recovered.filter((item) => item.ok).length;
        if (recoveredCount === recovered.length) markRecoveredWorkItem(workItems, "task-knowledge-derivation", `knowledge:${group.id}`);
        emit(state.request, "build.lane.completed", "semantic", { lane: `knowledge:${group.id}:local-recovery`, recoveredCount, childCount: recovered.length, degraded: recoveredCount !== recovered.length });
        return recovered.map((item) => item.draft);
      }
      });
      const parts = partsNested.flat();
      const preDependencyDraft = mergeDerivedSemanticDrafts(state.semanticDraft || state.taskDraft || fallbackSemanticDraft, parts);
      const dependencyPrompt = skillDependencyDerivationPrompt({ roleTitle: state.request.roleTitle, skills: preDependencyDraft.nodes, taskEdges: preDependencyDraft.edges });
      let dependencyPart = fallbackSemanticDraft;
      if (preDependencyDraft.nodes.filter((node) => node.type === "knowledge_skill").length >= 2) {
        try {
          const dependencyDraft = await runWorkItem({
            request: state.request,
            workItems,
            stage: "skill-dependency-derivation",
            lane: "knowledge:dependencies",
            inputRefs: preDependencyDraft.nodes.filter((node) => node.type === "knowledge_skill").map((node) => node.tempId),
            priority: 6,
            estimatedInputTokens: estimateTokens(dependencyPrompt.user),
            maxOutputTokens: 2_200,
            cachePayload: dependencyPrompt.user,
            profile: "semantic",
            invoke: (onReasoning) => invokeStructured({ model, ...dependencyPrompt, schema: skillDependencyDerivationSchema, signal: config.signal, thinking: "disabled", maxCompletionTokens: 2_200, timeoutMs: 45_000, totalTimeoutMs: 70_000, onReasoning }),
          });
          dependencyPart = skillDependenciesToSemanticDraft({ draft: dependencyDraft, skills: preDependencyDraft.nodes });
        } catch (error) {
          failures.push(`知识技能依赖归纳失败：${error instanceof Error ? error.message : "未知错误"}`);
        }
      }
      return {
        parts,
        dependencyPart,
        prepared,
        researchReport: targeted.researchReport || state.researchReport,
        targetedResearchQueries: state.targetedResearchQueries + (targeted.targetedResearchQueries || 0),
        laneFailures: targeted.laneFailures || [],
      };
    })();
    const capabilityPartPromise = (async () => {
      if (!(state.taskDraft?.nodes.filter((node) => node.type === "task").length || 0)) return fallbackSemanticDraft;
      const base = state.semanticDraft || state.taskDraft!;
      let combined = base;
      let output = fallbackSemanticDraft;
      // A single existing capability must not suppress research of uncovered
      // tasks. Keep accepted material and retry only the remaining gaps once.
      for (let round = 0; round < 2; round += 1) {
        const coverage = capabilityCoverage(combined);
        if (!coverage.uncoveredTaskIds.length && !coverage.capabilitiesWithoutUnits.length && !coverage.unitsWithoutCultivation.length && !coverage.capabilitiesWithoutTransfer.length) break;
        const capabilitySegments = selectKnowledgeContext({ group: { id: "capability", tasks: state.taskDraft!.nodes.filter(node => node.type === "task"), evidenceSegmentIds: [] }, segments: evidenceState.prepared.segments, mentions: state.mentions, assets: evidenceState.prepared.assets, maxTokens: 7_200 });
        const prompt = capabilityDerivationPrompt({ roleTitle: state.request.roleTitle, roleDescription: state.request.roleDescription, segments: capabilitySegments, tasks: state.taskDraft!.nodes, mentions: state.mentions, coverage, repairAttempt: round > 0 || state.qualityRepairRound > 0, existing: combined.nodes.filter(node => ["capability", "capability_unit"].includes(node.type)).map(node => ({ id: node.tempId, label: node.label, summary: node.summary })) });
        try {
          const draft = await runWorkItem({ request: state.request, workItems, stage: "cross-task-capability-derivation", lane: round ? "capability:coverage-repair" : "capability:cross-task", inputRefs: [...stableTaskIds], priority: 8, estimatedInputTokens: estimateTokens(prompt.user), maxOutputTokens: 8_000, cachePayload: prompt.user, profile: "semantic", invoke: (onReasoning) => invokeStructured({ model, ...prompt, schema: capabilityDerivationSchema, signal: config.signal, thinking: "disabled", maxCompletionTokens: 8_000, timeoutMs: 65_000, totalTimeoutMs: 95_000, onReasoning }) });
          const part = prefixDerivedDraft(capabilityToSemanticDraft({ draft, tasks: state.taskDraft!.nodes, mentions: state.mentions }), `q${state.qualityRepairRound}:cross${round}:`, stableTaskIds);
          output = mergeDerivedSemanticDrafts(output, [part]);
          combined = mergeDerivedSemanticDrafts(base, [output]);
        } catch (error) {
          if (config.signal?.aborted) throw error;
          failures.push(`跨任务能力归纳失败：${error instanceof Error ? error.message : "未知错误"}`);
        }
      }
      const remaining = capabilityCoverage(combined);
      if (remaining.uncoveredTaskIds.length) failures.push(`岗位能力仍缺少任务支撑：${remaining.uncoveredTaskIds.map(id => state.taskDraft!.nodes.find(node => node.tempId === id)?.label || id).join("、")}`);
      return output;
    })();
    const invokeProcessGroup = async (group: TaskGroup, prefix: string) => {
      const segments = selectSegmentsForTaskGroup({ group, segments: evidenceState.prepared.segments, mentions: state.mentions, assets: evidenceState.prepared.assets, purpose: "process", maxTokens: 8_000 });
      const mentions = mentionsForSegments(state.mentions, segments.map((segment) => segment.id));
      const prompt = taskProcessPrompt({ roleTitle: state.request.roleTitle, roleDescription: state.request.roleDescription, group, mentions, segments: segments.map((segment) => ({ id: segment.id, sourceKind: sourceKindForSegment(segment, evidenceState.prepared.assets), text: segment.text })) });
      const lane = `process:${group.id}${state.qualityRepairRound ? `:pass-${state.qualityRepairRound}` : ""}`;
      const draft = await runWorkItem({ request: state.request, workItems, stage: "task-process-expansion", lane, inputRefs: [group.id, ...segments.map((segment) => segment.id)], priority: 6, estimatedInputTokens: estimateTokens(prompt.user), maxOutputTokens: 6_000, cachePayload: prompt.user, profile: "process", invoke: (onReasoning) => invokeStructured({ model, ...prompt, schema: processDraftSchema, signal: config.signal, thinking: "disabled", maxCompletionTokens: 6_000, timeoutMs: 55_000, totalTimeoutMs: 90_000, normalize: (value) => normalizeProcessDraft(value, { roleTitle: state.request.roleTitle, rejectOffScope: true, maxScenarios: 5, maxNodes: 48, maxEdges: 96 }), onReasoning }) });
      return prefixProcessDraft(draft, prefix);
    };

    const processGroups = (state.qualityRepairRound ? groupTasks((state.taskDraft?.nodes || []).filter(node => state.qualityProcessTaskIds.includes(node.tempId)), 2) : state.taskGroups).flatMap((group) => group.tasks.length > 3 ? splitTaskGroup(group) : [group]);
    const processPartsPromise = mapWithConcurrency(processGroups, 2, async (group, index) => {
      try {
        return [await invokeProcessGroup(group, `q${state.qualityRepairRound}:g${index + 1}:`)];
      } catch (error) {
        const children = splitTaskGroup(group);
        if (children.length === 1) {
          failures.push(`任务组 ${group.id} 的事理展开失败：${error instanceof Error ? error.message : "未知错误"}`);
          return [emptyProcessDraft()];
        }
        const recovered = await mapWithConcurrency(children, 2, async (child, childIndex) => {
          try {
            return { ok: true as const, draft: await invokeProcessGroup(child, `q${state.qualityRepairRound}:g${index + 1}r${childIndex + 1}:`) };
          } catch (childError) {
            failures.push(`任务子组 ${child.id} 的事理展开失败：${childError instanceof Error ? childError.message : "未知错误"}`);
            return { ok: false as const, draft: emptyProcessDraft() };
          }
        });
        const recoveredCount = recovered.filter((item) => item.ok).length;
        if (recoveredCount === recovered.length) markRecoveredWorkItem(workItems, "task-process-expansion", `process:${group.id}`);
        emit(state.request, "build.lane.completed", "process", { lane: `process:${group.id}:local-recovery`, recoveredCount, childCount: recovered.length, degraded: recoveredCount !== recovered.length });
        return recovered.map((item) => item.draft);
      }
    });
    // Once the task barrier is stable, these three lanes have no data
    // dependency on each other. Run them together; each lane keeps its own
    // bounded concurrency and local recovery policy.
    // Process expansion starts immediately, but the semantic branch is allowed
    // to publish its own immutable child version without waiting for it.
    const [knowledgeBranch, capabilityPart] = await Promise.all([
      knowledgeBranchPromise,
      capabilityPartPromise,
    ]);
    const knowledgeParts = knowledgeBranch.parts;
    failures.push(...knowledgeBranch.laneFailures);
    const semanticDraft = mergeDerivedSemanticDrafts(state.semanticDraft || state.taskDraft || fallbackSemanticDraft, [...knowledgeParts, capabilityPart, knowledgeBranch.dependencyPart]);
    for (const target of semanticDraft.nodes.filter(node => options?.learningDefinitionTargetIds?.includes(node.tempId))) {
      const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
      const repair = knowledgeParts.flatMap(part => part.nodes).find(node => node.type === "knowledge_skill" && node.learningKind === target.learningKind
        && normalize(node.label) === normalize(target.label) && node.learningDefinition && node.evidenceSpans?.length);
      if (repair) target.learningDefinition = repair.learningDefinition;
    }
    const linkedSemantic = materializeRelationPropositions({ draft: semanticDraft, propositions: state.relationPropositions });
    const semanticRequest = { ...state.request, runId: `${state.request.runId}:semantic` };
    const semanticMaterialized = compileSemanticDraft({ request: semanticRequest, draft: linkedSemantic.draft, segments: knowledgeBranch.prepared.segments, assets: knowledgeBranch.prepared.assets });
    if (state.kernelResult) semanticMaterialized.nodes = carryKernelPresentation(semanticMaterialized.nodes, state.kernelResult, "semantic");
    const emptyProcess = compileProcessDraft({ draft: emptyProcessDraft(), segments: knowledgeBranch.prepared.segments, assets: knowledgeBranch.prepared.assets, semanticNodes: semanticMaterialized.nodes });
    const semanticMetrics: ColdStartBuildMetrics = {
      firstTaskSkeletonMs: state.firstTaskSkeletonMs,
      firstKernelMs: state.kernelResult?.build?.metrics.firstKernelMs,
      estimatedInputTokens: workItems.reduce((sum, item) => sum + item.estimatedInputTokens, 0),
      maxOutputTokens: workItems.reduce((sum, item) => sum + item.maxOutputTokens, 0),
      cacheHits: workItems.filter((item) => item.cacheHit).length,
      failedWorkItems: workItems.filter((item) => item.status === "failed").length,
      targetedResearchQueries: knowledgeBranch.targetedResearchQueries,
    };
    const semanticResult = compileRolePackage({
      request: semanticRequest,
      brief: knowledgeBranch.prepared.brief,
      assets: knowledgeBranch.prepared.assets,
      segments: knowledgeBranch.prepared.segments,
      semantic: semanticMaterialized,
      process: emptyProcess,
      laneFailures: failures,
      research: knowledgeBranch.researchReport,
      mentions: state.mentions,
      relationPropositions: linkedSemantic.propositions,
      workItems,
      buildMetrics: semanticMetrics,
    });
    semanticResult.process.capsules = (state.kernelResult?.process.capsules || []).map((capsule) => ({ ...capsule, expansionStatus: "running" }));
    semanticResult.validation.publishable = false;
    semanticResult.snapshot.status = "candidate";
    semanticResult.packages.rolePackage.status = "candidate";
    refreshRolePackageManifest(semanticResult, { status: "candidate" });
    semanticResult.build = {
      ...semanticResult.build!,
      stage: "semantic_enrichment",
      enrichment: {
        baseSnapshotId: state.kernelResult?.snapshot.id,
        status: "running",
        completedLanes: ["capability", "knowledge", "skill_dependencies"],
        pendingLanes: ["process", "inspection"],
        updatedAt: new Date().toISOString(),
      },
    };
    if (!state.qualityRepairRound) emit(state.request, "build.enrichment.semantic.completed", "semantic", {
      result: semanticResult,
      baseSnapshotId: state.kernelResult?.snapshot.id,
      visibleNodeCount: semanticResult.semantic.nodes.filter((node) => node.defaultVisibility !== false).length,
      detailNodeCount: semanticResult.semantic.nodes.filter((node) => node.defaultVisibility === false).length,
      dependencyCount: semanticResult.semantic.edges.filter((edge) => edge.type === "prerequisite_for" || edge.type === "co_requisite").length,
    });
    const processPartsNested = await processPartsPromise;
    const processParts = processPartsNested.flat();
    const processDraft = mergeProcessDrafts([...(state.processDraft ? [state.processDraft] : []), ...processParts]);
    emit(state.request, "build.lane.completed", "semantic", { lane: "derived-layers", knowledgeNodes: knowledgeParts.flatMap((part) => part.nodes).length, capabilityNodes: capabilityPart.nodes.length, processScenarios: processDraft.scenarios.length, failedWorkItems: workItems.filter((item) => item.status === "failed").length });
    return {
      semanticDraft,
      processDraft,
      semantic: semanticMaterialized,
      prepared: knowledgeBranch.prepared,
      researchReport: knowledgeBranch.researchReport,
      targetedResearchQueries: knowledgeBranch.targetedResearchQueries,
      workItems,
      laneFailures: failures,
    };
  };

  const materializeDualGraph = async (state: typeof BuildState.State) => {
    const prepared = state.prepared!;
    const linked = materializeRelationPropositions({ draft: state.semanticDraft || state.taskDraft || fallbackSemanticDraft, propositions: state.relationPropositions });
    const semantic = compileSemanticDraft({ request: state.request, draft: linked.draft, segments: prepared.segments, assets: prepared.assets });
    if (state.kernelResult) semantic.nodes = carryKernelPresentation(semantic.nodes, state.kernelResult, "full");
    emit(state.request, "build.semantic.patch", "semantic", { phase: "canonicalized", nodes: semantic.nodes, edges: semantic.edges, taskCount: semantic.nodes.filter((node) => node.type === "task").length, knowledgeSkillCount: semantic.nodes.filter((node) => node.type === "knowledge_skill").length, capabilityCount: semantic.nodes.filter((node) => node.type === "capability").length });
    const process = compileProcessDraft({ draft: state.processDraft || emptyProcessDraft(), segments: prepared.segments, assets: prepared.assets, semanticNodes: semantic.nodes });
    emit(state.request, "build.process.patch", "process", { phase: "canonicalized", scenarios: process.scenarios, nodes: process.nodes, edges: process.edges, bridges: process.bridges });
    emit(state.request, "build.enrichment.process.completed", "process", { scenarioCount: process.scenarios.length, nodeCount: process.nodes.length, bridgeCount: process.bridges.length });
    const bindings = [...semantic.bindings, ...process.bindings];
    emit(state.request, "build.evidence.bound", "evidence", { bindingCount: bindings.length, directCount: bindings.filter((binding) => binding.support === "direct").length, inferredCount: bindings.filter((binding) => binding.support === "inferred").length });
    return { semantic, process, relationPropositions: linked.propositions };
  };

  const auditAndCompile = async (state: typeof BuildState.State) => {
    const prepared = state.prepared!;
    emit(state.request, "build.package.compile.started", "system", { semanticNodes: state.semantic!.nodes.length, processScenarios: state.process!.scenarios.length });
    const metrics: ColdStartBuildMetrics = {
      firstTaskSkeletonMs: state.firstTaskSkeletonMs,
      firstKernelMs: state.kernelResult?.build?.metrics.firstKernelMs,
      estimatedInputTokens: state.workItems.reduce((sum, item) => sum + item.estimatedInputTokens, 0),
      maxOutputTokens: state.workItems.reduce((sum, item) => sum + item.maxOutputTokens, 0),
      cacheHits: state.workItems.filter((item) => item.cacheHit).length,
      failedWorkItems: state.workItems.filter((item) => item.status === "failed").length,
      targetedResearchQueries: state.targetedResearchQueries,
    };
    const result = compileRolePackage({ request: state.request, brief: prepared.brief, assets: prepared.assets, segments: prepared.segments, semantic: state.semantic!, process: state.process!, laneFailures: state.laneFailures, research: state.researchReport, mentions: state.mentions, relationPropositions: state.relationPropositions, workItems: state.workItems, buildMetrics: metrics });
    result.process.capsules = completeProcessCapsules(state.kernelResult?.process.capsules || createProcessCapsules(result.semantic.nodes, state.mentions), result);
    const degraded = !result.semantic.nodes.some(node => node.type === "task") || state.laneFailures.length > 0 || result.process.capsules.some((capsule) => capsule.expansionStatus === "degraded");
    result.build = {
      ...result.build!,
      stage: "full_enrichment",
      enrichment: {
        baseSnapshotId: state.kernelResult?.snapshot.id,
        status: degraded ? "degraded" : "complete",
        completedLanes: ["capability", "knowledge", "skill_dependencies", "process", "inspection"],
        pendingLanes: [],
        updatedAt: new Date().toISOString(),
      },
    };
    emit(state.request, "build.inspection.started", "system", { snapshotId: result.snapshot.id, policy: "diagnostic_not_crude_gate" });
    const inspection = inspectSnapshot(result);
    const inspectedAudit = inspectionToBuildAudit(inspection);
    const issueFamily = (code: string) => ({ NO_TASKS: "MISSING_TASK_LAYER", MISSING_TASK_LAYER: "MISSING_TASK_LAYER" }[code] || code);
    const issueKey = (issue: { code: string; targetIds: string[]; detail: string }) => `${issueFamily(issue.code)}:${issue.targetIds.join("|")}${issue.code === "LANE_FALLBACK" ? `:${issue.detail}` : ""}`;
    const issueMap = new Map(result.audit.issues.map((issue) => [issueKey(issue), issue]));
    for (const issue of inspectedAudit.issues) issueMap.set(issueKey(issue), issue);
    const topicMap = new Map(result.audit.researchTopics.map((topic) => [`${topic.title}:${topic.targetIds.join("|")}`, topic]));
    for (const topic of inspectedAudit.researchTopics) topicMap.set(`${topic.title}:${topic.targetIds.join("|")}`, topic);
    result.audit.issues = [...issueMap.values()];
    result.audit.researchTopics = [...topicMap.values()];
    result.audit.inspection = { protocolValid: inspection.protocolValid, axes: inspection.axes, core: inspection.core, frontier: inspection.frontier, coverage: inspection.coverage, agentProbes: inspection.agentProbes, hardBlockerIds: inspection.hardBlockers.map((finding) => finding.id) };
    if (!inspection.protocolValid) {
      result.validation.structural.passed = false;
      result.validation.structural.issues = unique([...result.validation.structural.issues, ...inspection.hardBlockers.map((finding) => finding.title)]);
      result.validation.publishable = false;
      result.snapshot.status = "candidate";
      result.packages.rolePackage.status = "candidate";
      refreshRolePackageManifest(result, { status: "candidate" });
    }
    for (const finding of inspection.findings) emit(state.request, "build.inspection.finding.created", finding.layer === "coverage" ? "semantic" : finding.layer === "agent" ? "system" : finding.layer === "protocol" ? "structural" : finding.layer, { finding });
    emit(state.request, "build.inspection.completed", "system", { protocolValid: inspection.protocolValid, findingCount: inspection.findings.length, hardBlockerCount: inspection.hardBlockers.length });
    for (const issue of result.audit.issues) emit(state.request, "build.audit.issue.created", issue.severity === "error" ? "evidence" : "semantic", { issue });
    for (const section of result.snapshot.sections) emit(state.request, "build.snapshot.section.drafted", "structural", { section });
    emit(state.request, "build.package.compile.completed", "system", { rolePackage: result.packages.rolePackage, namespaces: result.packages.rolePackage.namespaces });
    emit(state.request, "build.package.validation.completed", "system", { validation: result.validation });
    const repairCodes = new Set(["TASK_SKILL_GAP", "TASK_LEARNING_KIND_GAP", "TASK_CAPABILITY_GAP", "TASK_CAPABILITY_UNIT_GAP", "CAPABILITY_UNIT_CULTIVATION_GAP", "CAPABILITY_NOT_CROSS_TASK", "TASK_PROCESS_GAP", "TASK_PROCESS_INCOMPLETE", "NO_PROCESS_SCENARIOS", "SCENARIO_WITHOUT_EVENT", "SCENARIO_WITHOUT_ARTIFACT"]);
    const repairable = inspection.findings.filter(finding => repairCodes.has(finding.code) && finding.suggestedAction === "research");
    const score = inspection.hardBlockers.length * 1_000 + inspection.coverage.tasksWithoutSkills * 10 + inspection.coverage.tasksWithoutProcess * 8 + repairable.length;
    const better = state.bestQualityScore === undefined || score <= state.bestQualityScore;
    const activeTasks = result.semantic.nodes.filter(node => node.type === "task" && node.lifecycle !== "rejected");
    const wanted = new Set(repairable.flatMap(finding => finding.targetIds));
    // Unit/scenario gaps may target child objects. Include their owning task
    // groups rather than leaving them as an unactionable warning.
    const expanded = new Set(wanted);
    for (let step = 0; step < 3; step += 1) for (const edge of result.semantic.edges) if (expanded.has(edge.target)) expanded.add(edge.source);
    const missingProcess = new Set(processCoverage(result).filter(item => !item.complete).map(item => item.taskId));
    const selected = activeTasks.filter(task => expanded.has(task.id) || missingProcess.has(task.id));
    const inverse = new Map([...state.semantic!.tempToId].map(([temp, id]) => [id, temp]));
    const qualityTaskIds = (selected.length ? selected : repairable.length ? activeTasks : []).map(task => inverse.get(task.id) || task.id);
    if (repairable.length) {
      result.build!.enrichment!.status = "degraded";
      result.validation.publishable = false;
      result.snapshot.status = "candidate";
      refreshRolePackageManifest(result, { status: "candidate" });
    }
    const qualityKnowledgeTaskIds = learningCoverage(result).tasksWithoutSkills.map(task => inverse.get(task.id) || task.id);
    const qualityProcessTaskIds = [...missingProcess].map(id => inverse.get(id) || id);
    return { result, qualityTaskIds, qualityKnowledgeTaskIds, qualityProcessTaskIds, bestResult: better ? result : state.bestResult, bestQualityScore: better ? score : state.bestQualityScore };
  };

  const routeQuality = (state: typeof BuildState.State) => !state.request.research && state.qualityTaskIds.length > 0
    && state.qualityRepairRound < (options?.qualityRepairRounds ?? 2)
    && state.prepared!.assets.some(asset => asset.kind !== "user_brief" && asset.qualification?.status !== "quarantined")
    ? "repair_quality" : "finish_build";
  const repairQuality = async (state: typeof BuildState.State) => {
    const round = state.qualityRepairRound + 1;
    emit(state.request, "build.targeted_research.started", "evidence", { reason: "quality_feedback", round, targetTaskIds: state.qualityTaskIds,
      message: "检查发现可补齐的任务支撑缺口，正在更换来源角度补研并保留已有成果。" });
    return { qualityRepairRound: round };
  };
  const finishBuild = async (state: typeof BuildState.State, config: { signal?: AbortSignal }) => {
    let result = state.bestResult || state.result!;
    let researchContinue = false, researchStagnant = state.researchStagnant, researchSignature = state.researchSignature;
    if (state.request.research) {
      await deriveTaskDefinitions(model, result, config.signal, sharedResearch?.reviewModel || model);
      const run = sharedResearch?.record();
      if (run) {
        linkResearchFindings(result, run);
        const signature = JSON.stringify({ quality: researchQuality(result), findings: run.findings.map(finding => finding.id) });
        researchStagnant = signature === state.researchSignature ? state.researchStagnant + 1 : 0;
        researchSignature = signature;
        const remaining = sharedResearch!.budgetLedger.snapshot().remainingResearch;
        const exhausted = remaining.tokens < 1000 || remaining.turns < 1 || run.agenda.revision >= state.request.research.budget.revisions;
        researchContinue = !run.stopReason && !result.deliveryReadiness?.ready && !exhausted && researchStagnant < state.request.research.budget.stagnantRounds && run.agenda.tasks.some(task => task.status !== "failed");
        if (!researchContinue) await sharedResearch!.finish(run.stopReason || (result.deliveryReadiness?.ready ? "goal_reached" : exhausted ? "budget_exhausted" : researchStagnant >= state.request.research.budget.stagnantRounds ? "no_progress" : "insufficient_material"));
        result.researchRun = sharedResearch!.record();
      }
      result = refreshRolePackageManifest(result, { status: result.deliveryReadiness?.ready ? "ready" : "candidate" });
    }
    if (researchContinue) return { result, bestResult: result, researchContinue, researchStagnant, researchSignature };
    emit(state.request, "build.run.completed", "system", { result, publishable: result.validation.publishable, metrics: result.build?.metrics,
      qualityRepairRounds: state.qualityRepairRound, remainingTaskIds: state.qualityTaskIds, stoppedBecause: state.qualityTaskIds.length ? "research_budget_or_evidence_limit" : "task_support_complete" });
    return { result, researchContinue, researchStagnant, researchSignature };
  };

  if (options?.execution === "enrichment") {
    return new StateGraph(BuildState)
      .addNode("hydrate_kernel", hydrateKernel)
      .addNode("derive_layers", deriveLayers)
      .addNode("materialize_dual_graph", materializeDualGraph)
      .addNode("audit_and_compile", auditAndCompile)
      .addNode("repair_quality", repairQuality)
      .addNode("finish_build", finishBuild)
      .addEdge(START, "hydrate_kernel")
      .addEdge("hydrate_kernel", "derive_layers")
      .addEdge("derive_layers", "materialize_dual_graph")
      .addEdge("materialize_dual_graph", "audit_and_compile")
      .addConditionalEdges("audit_and_compile", routeQuality, ["repair_quality", "finish_build"])
      .addEdge("repair_quality", "derive_layers")
      .addEdge("finish_build", END)
      .compile({ checkpointer: false }).withConfig({ recursionLimit: 80 });
  }
  if (options?.execution === "kernel") {
    return new StateGraph(BuildState)
      .addNode("research_sources", researchSources, { retryPolicy: { maxAttempts: 2, initialInterval: 1 } })
      .addNode("prepare_sources", prepareSources)
      .addNode("extract_mentions", extractMentions)
      .addNode("converge_tasks", convergeTasks)
      .addNode("build_kernel", buildKernel)
      .addNode("recover_task_evidence", recoverTaskEvidence)
      .addEdge(START, "research_sources")
      .addEdge("research_sources", "prepare_sources")
      .addEdge("prepare_sources", "extract_mentions")
      .addEdge("extract_mentions", "converge_tasks")
      .addConditionalEdges("converge_tasks", needsTaskRecovery, ["build_kernel", "recover_task_evidence"])
      .addEdge("recover_task_evidence", "extract_mentions")
      .addEdge("build_kernel", END)
      .compile({ checkpointer: false }).withConfig({ recursionLimit: 80 });
  }
  return new StateGraph(BuildState)
    .addNode("research_sources", researchSources, { retryPolicy: { maxAttempts: 2, initialInterval: 1 } })
    .addNode("prepare_sources", prepareSources)
    .addNode("extract_mentions", extractMentions)
    .addNode("converge_tasks", convergeTasks)
    .addNode("build_kernel", buildKernel)
    .addNode("recover_task_evidence", recoverTaskEvidence)
    .addNode("derive_layers", deriveLayers)
    .addNode("materialize_dual_graph", materializeDualGraph)
    .addNode("audit_and_compile", auditAndCompile)
      .addNode("repair_quality", repairQuality)
      .addNode("finish_build", finishBuild)
    .addEdge(START, "research_sources")
    .addEdge("research_sources", "prepare_sources")
    .addEdge("prepare_sources", "extract_mentions")
    .addEdge("extract_mentions", "converge_tasks")
    .addConditionalEdges("converge_tasks", needsTaskRecovery, ["build_kernel", "recover_task_evidence"])
    .addEdge("recover_task_evidence", "extract_mentions")
    .addEdge("build_kernel", "derive_layers")
    .addEdge("derive_layers", "materialize_dual_graph")
    .addEdge("materialize_dual_graph", "audit_and_compile")
    .addConditionalEdges("audit_and_compile", routeQuality, ["repair_quality", "finish_build"])
      .addEdge("repair_quality", "derive_layers")
      .addConditionalEdges("finish_build", state => state.researchContinue ? "research_sources" : END, ["research_sources", END])
    .compile({ checkpointer: false }).withConfig({ recursionLimit: 80 });
}
