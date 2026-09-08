import { END, getWriter, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod/v4";
import type { ModelInvoker } from "@/lib/agent/model";
import { inspectSnapshot, inspectionToBuildAudit } from "@/lib/iteration/inspector";
import { refreshRolePackageManifest } from "@/lib/packages/role-package-manifest";
import { createRoleSearchPlan } from "@/lib/search/query-planner";
import type { SearchProviderConfig } from "@/lib/search/providers";
import { researchRoleSources, type PlannedQuery } from "@/lib/search/web-research";
import { compileProcessDraft, compileRolePackage, compileSemanticDraft, prepareBuildInput } from "./compiler";
import { inspectKnowledgeDerivation, mergeKnowledgeDerivations } from "./knowledge-quality";
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
  laneFailures: z.array(z.string()).default(() => []),
  result: z.custom<ColdStartBuildResult>().optional(),
});

type SkillOptions = {
  initialSeq?: number;
  searchConfig?: SearchProviderConfig;
  sourceLimit?: number;
  existingResearchReport?: WebResearchReport;
  emitEvents?: boolean;
  cache?: Map<string, unknown>;
  execution?: "full" | "kernel" | "enrichment";
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

function mergeResearchReports(base: WebResearchReport | undefined, next: WebResearchReport) {
  if (!base) return next;
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
    scenarios: parts.flatMap((part) => part.scenarios).slice(0, 16),
    nodes: parts.flatMap((part) => part.nodes).slice(0, 120),
    edges: parts.flatMap((part) => part.edges).slice(0, 240),
    bridges: parts.flatMap((part) => part.bridges).slice(0, 80),
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
  let seq = options?.initialSeq || 0;
  const cache = options?.cache || new Map<string, unknown>();

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
    if (!options?.searchConfig) return { activeRequest: state.request, researchReport: options?.existingResearchReport, runStartedAt };
    const searchPlan = await createRoleSearchPlan({ request: state.request, model, signal: config.signal, onReasoning: (delta) => emit(state.request, "build.reasoning.delta", "evidence", { lane: "search-planning", delta }) });
    const researched = await researchRoleSources({
      request: state.request,
      config: options.searchConfig,
      queries: searchPlan.queries,
      planStrategy: searchPlan.strategy,
      plannerFallbackReason: searchPlan.fallbackReason,
      sourceLimit: options.sourceLimit,
      signal: config.signal,
      onProgress: (progress) => {
        const kind = { plan: "build.research.plan.created", "search-started": "build.search.started", "search-retrying": "build.search.retrying", "search-completed": "build.search.completed", "search-failed": "build.search.failed", "source-fetched": "build.source.fetched", "source-deduplicated": "build.source.deduplicated" }[progress.kind] as BuildEventKind;
        emit(state.request, kind, "evidence", progress.payload);
      },
    });
    emit(state.request, "build.research.completed", "evidence", { queryCount: researched.report.queries.length, selectedSourceCount: researched.report.selectedSourceCount, failureCount: researched.report.failures.length, totalCredits: researched.report.usage?.totalCredits });
    return { activeRequest: { ...state.request, sources: [...state.request.sources, ...researched.sources] }, researchReport: researched.report, runStartedAt };
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
      targetedResearchQueries: 0,
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
    emit(state.request, "build.fast_snapshot.completed", "structural", { result: kernelResult, metrics, parentRunId: state.request.runId, compatibilityAlias: true });
    emit(state.request, "build.kernel.completed", "structural", { result: kernelResult, metrics, visibleTaskCount: visibleTasks.length, visibleNodeCount, backgroundLanes: ["capability", "knowledge", "skill_dependencies", "process", "inspection"] });
    emit(state.request, "build.enrichment.queued", "system", { baseSnapshotId: kernelResult.snapshot.id, lanes: ["capability", "knowledge", "skill_dependencies", "process", "inspection"] });
    return {
      kernelResult,
      result: kernelResult,
      semanticDraft: kernelDraft,
      taskGroups: groupTasks(visibleTasks),
      workItems,
      relationPropositions: linked.propositions,
      laneFailures: kernelFailures,
    };
  };

  const hydrateKernel = async (state: typeof BuildState.State) => {
    const base = state.baseResult;
    if (!base) throw new Error("KERNEL_SNAPSHOT_REQUIRED");
    const taskDraft = semanticDraftFromKernel(base);
    const visibleTasks = taskDraft.nodes.filter((node) => {
      if (node.type !== "task") return false;
      return base.semantic.nodes.find((candidate) => candidate.id === node.tempId)?.defaultVisibility !== false;
    });
    const prepared: PreparedBuild = { brief: base.brief, assets: base.sources.assets, segments: base.sources.segments };
    emit(state.request, "build.enrichment.started", "system", {
      baseSnapshotId: base.snapshot.id,
      kernelNodeCount: base.semantic.nodes.filter((node) => node.defaultVisibility !== false).length,
      lanes: ["capability", "knowledge", "skill_dependencies", "process", "inspection"],
    });
    return {
      activeRequest: state.request,
      runStartedAt: Date.now(),
      researchReport: base.sources.research,
      prepared,
      shards: [],
      mentions: base.sources.mentions || [],
      relationPropositions: base.sources.relationPropositions || [],
      taskDraft,
      semanticDraft: taskDraft,
      taskGroups: groupTasks(visibleTasks),
      firstTaskSkeletonMs: base.build?.metrics.firstTaskSkeletonMs,
      kernelResult: base,
      workItems: [...(base.build?.workItems || [])],
      targetedResearchQueries: 0,
      laneFailures: [],
    };
  };

  const targetedKnowledgeResearch = async (state: typeof BuildState.State, config: { signal?: AbortSignal }) => {
    if (!options?.searchConfig || !state.taskGroups.length) return {};
    const needy = state.taskGroups.filter((group) => taskGroupNeedsKnowledgeResearch(group, state.mentions, state.prepared!.assets, state.prepared!.segments)).slice(0, 3);
    if (!needy.length) return {};
    const queries: PlannedQuery[] = needy.map((group, index) => ({ id: `targeted:${state.request.runId}:${index + 1}`, category: "technology", query: `${state.request.roleTitle} ${group.tasks.map((task) => task.label).join(" ")} 官方文档 工程实践 知识技能`, priority: 9 - index * 0.1 }));
    emit(state.request, "build.targeted_research.started", "evidence", { queryCount: queries.length, taskGroupIds: needy.map((group) => group.id) });
    try {
      const researched = await researchRoleSources({
        request: state.activeRequest || state.request,
        config: options.searchConfig,
        queries,
        planStrategy: "deterministic",
        sourceLimit: Math.min(6, Math.max(3, queries.length * 2)),
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
      const detail = error instanceof Error ? error.message : "定点补研失败";
      emit(state.request, "build.targeted_research.completed", "evidence", { queryCount: queries.length, degraded: true, detail });
      return { targetedResearchQueries: queries.length, laneFailures: [...state.laneFailures, `知识技能定点补研失败：${detail}`] };
    }
  };

  const deriveLayers = async (state: typeof BuildState.State, config: { signal?: AbortSignal }) => {
    const workItems = [...state.workItems];
    const failures = [...state.laneFailures];
    const stableTaskIds = new Set((state.taskDraft?.nodes || []).filter((node) => node.type === "task").map((node) => node.tempId));

    const targetedPromise = targetedKnowledgeResearch(state, config);
    const invokeKnowledgeGroup = async (group: TaskGroup, prefix: string, prepared: PreparedBuild) => {
      const segments = selectSegmentsForTaskGroup({ group, segments: prepared.segments, mentions: state.mentions, assets: prepared.assets, purpose: "knowledge", maxTokens: 3_200 });
      const mentions = mentionsForSegments(state.mentions, segments.map((segment) => segment.id));
      const prompt = knowledgeDerivationPrompt({ roleTitle: state.request.roleTitle, group, mentions, segments: segments.map((segment) => ({ id: segment.id, text: segment.text })), mode: "detail" });
      const lane = `knowledge:${group.id}`;
      const draft = await runWorkItem({ request: state.request, workItems, stage: "task-knowledge-derivation", lane, inputRefs: [group.id, ...segments.map((segment) => segment.id)], priority: 7, estimatedInputTokens: estimateTokens(prompt.user), maxOutputTokens: 2_800, cachePayload: prompt.user, profile: "semantic", invoke: (onReasoning) => invokeStructured({ model, ...prompt, schema: knowledgeDerivationSchema, signal: config.signal, thinking: "disabled", maxCompletionTokens: 2_800, timeoutMs: 50_000, totalTimeoutMs: 80_000, onReasoning }) });
      const checked = inspectKnowledgeDerivation({ draft, group, mentions, segments });
      let accepted = checked.accepted;
      let remainingIssues = checked.issues;
      if (checked.uncoveredTaskIds.length || checked.issues.length) {
        const repairPrompt = knowledgeDerivationPrompt({ roleTitle: state.request.roleTitle, group, mentions, segments, mode: "detail", repair: {
          acceptedPoints: accepted.skills.map((point) => ({ label: point.label, taskTempIds: point.taskTempIds })),
          issues: checked.issues,
          uncoveredTaskIds: checked.uncoveredTaskIds,
        } });
        try {
          const repaired = await runWorkItem({ request: state.request, workItems, stage: "task-knowledge-derivation", lane: `${lane}:coverage-repair`, inputRefs: [group.id, ...checked.uncoveredTaskIds], priority: 7, estimatedInputTokens: estimateTokens(repairPrompt.user), maxOutputTokens: 2_800, cachePayload: repairPrompt.user, profile: "semantic", invoke: (onReasoning) => invokeStructured({ model, ...repairPrompt, schema: knowledgeDerivationSchema, signal: config.signal, thinking: "disabled", maxCompletionTokens: 2_800, timeoutMs: 50_000, totalTimeoutMs: 80_000, onReasoning }) });
          const repairCheck = inspectKnowledgeDerivation({ draft: repaired, group, mentions, segments });
          accepted = mergeKnowledgeDerivations(accepted, repairCheck.accepted);
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
      emit(state.request, "build.lane.completed", "semantic", { lane: `${lane}:quality`, acceptedPointCount: accepted.skills.length, uncoveredTaskIds: accepted.gaps.map((gap) => gap.taskTempId), rejectedPointCount: remainingIssues.length, degraded: accepted.gaps.length > 0 || remainingIssues.length > 0 });
      return prefixDerivedDraft(knowledgeToSemanticDraft({ draft: accepted, group, mentions, segments }), prefix, stableTaskIds);
    };

    const knowledgeBranchPromise = (async () => {
      const targeted = await targetedPromise;
      const prepared = targeted.prepared || state.prepared!;
      const partsNested = await mapWithConcurrency(state.taskGroups, 2, async (group, index) => {
      try {
        return [await invokeKnowledgeGroup(group, `g${index + 1}:`, prepared)];
      } catch (error) {
        const children = splitTaskGroup(group);
        if (children.length === 1) {
          failures.push(`任务组 ${group.id} 的知识技能派生失败：${error instanceof Error ? error.message : "未知错误"}`);
          return [fallbackSemanticDraft];
        }
        const recovered = await mapWithConcurrency(children, 2, async (child, childIndex) => {
          try {
            return { ok: true as const, draft: await invokeKnowledgeGroup(child, `g${index + 1}r${childIndex + 1}:`, prepared) };
          } catch (childError) {
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
        targetedResearchQueries: targeted.targetedResearchQueries || 0,
        laneFailures: targeted.laneFailures || [],
      };
    })();
    const capabilityPartPromise = (async () => {
      if (state.kernelResult?.semantic.nodes.some((node) => node.type === "capability" || node.type === "capability_unit")) return fallbackSemanticDraft;
      if ((state.taskDraft?.nodes.filter((node) => node.type === "task").length || 0) < 2) return fallbackSemanticDraft;
      const prompt = capabilityDerivationPrompt({ roleTitle: state.request.roleTitle, tasks: state.taskDraft!.nodes, mentions: state.mentions });
      try {
        const draft = await runWorkItem({ request: state.request, workItems, stage: "cross-task-capability-derivation", lane: "capability:cross-task", inputRefs: [...stableTaskIds], priority: 8, estimatedInputTokens: estimateTokens(prompt.user), maxOutputTokens: 2_800, cachePayload: prompt.user, profile: "semantic", invoke: (onReasoning) => invokeStructured({ model, ...prompt, schema: capabilityDerivationSchema, signal: config.signal, thinking: "disabled", maxCompletionTokens: 2_800, timeoutMs: 50_000, totalTimeoutMs: 80_000, onReasoning }) });
        return prefixDerivedDraft(capabilityToSemanticDraft({ draft, tasks: state.taskDraft!.nodes, mentions: state.mentions }), "cross:", stableTaskIds);
      } catch (error) {
        failures.push(`跨任务能力归纳失败：${error instanceof Error ? error.message : "未知错误"}`);
        return fallbackSemanticDraft;
      }
    })();
    const invokeProcessGroup = async (group: TaskGroup, prefix: string) => {
      const segments = selectSegmentsForTaskGroup({ group, segments: state.prepared!.segments, mentions: state.mentions, assets: state.prepared!.assets, purpose: "process", maxTokens: 2_800 });
      const mentions = mentionsForSegments(state.mentions, segments.map((segment) => segment.id));
      const prompt = taskProcessPrompt({ roleTitle: state.request.roleTitle, group, mentions, segments: segments.map((segment) => ({ id: segment.id, sourceKind: sourceKindForSegment(segment, state.prepared!.assets), text: segment.text })) });
      const lane = `process:${group.id}`;
      const draft = await runWorkItem({ request: state.request, workItems, stage: "task-process-expansion", lane, inputRefs: [group.id, ...segments.map((segment) => segment.id)], priority: 6, estimatedInputTokens: estimateTokens(prompt.user), maxOutputTokens: 3_800, cachePayload: prompt.user, profile: "process", invoke: (onReasoning) => invokeStructured({ model, ...prompt, schema: processDraftSchema, signal: config.signal, thinking: "disabled", maxCompletionTokens: 3_800, timeoutMs: 55_000, totalTimeoutMs: 90_000, normalize: (value) => normalizeProcessDraft(value, { roleTitle: state.request.roleTitle, rejectOffScope: true, maxScenarios: 3, maxNodes: 30, maxEdges: 60 }), onReasoning }) });
      return prefixProcessDraft(draft, prefix);
    };

    const processGroups = state.taskGroups.flatMap((group) => group.tasks.length > 3 ? splitTaskGroup(group) : [group]);
    const processPartsPromise = mapWithConcurrency(processGroups, 2, async (group, index) => {
      try {
        return [await invokeProcessGroup(group, `g${index + 1}:`)];
      } catch (error) {
        const children = splitTaskGroup(group);
        if (children.length === 1) {
          failures.push(`任务组 ${group.id} 的事理展开失败：${error instanceof Error ? error.message : "未知错误"}`);
          return [emptyProcessDraft()];
        }
        const recovered = await mapWithConcurrency(children, 2, async (child, childIndex) => {
          try {
            return { ok: true as const, draft: await invokeProcessGroup(child, `g${index + 1}r${childIndex + 1}:`) };
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
    emit(state.request, "build.enrichment.semantic.completed", "semantic", {
      result: semanticResult,
      baseSnapshotId: state.kernelResult?.snapshot.id,
      visibleNodeCount: semanticResult.semantic.nodes.filter((node) => node.defaultVisibility !== false).length,
      detailNodeCount: semanticResult.semantic.nodes.filter((node) => node.defaultVisibility === false).length,
      dependencyCount: semanticResult.semantic.edges.filter((edge) => edge.type === "prerequisite_for" || edge.type === "co_requisite").length,
    });
    const processPartsNested = await processPartsPromise;
    const processParts = processPartsNested.flat();
    const processDraft = mergeProcessDrafts(processParts);
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
    const degraded = state.laneFailures.length > 0 || result.process.capsules.some((capsule) => capsule.expansionStatus === "degraded");
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
    emit(state.request, "build.run.completed", "system", { result, publishable: result.validation.publishable, metrics });
    return { result };
  };

  if (options?.execution === "enrichment") {
    return new StateGraph(BuildState)
      .addNode("hydrate_kernel", hydrateKernel)
      .addNode("derive_layers", deriveLayers)
      .addNode("materialize_dual_graph", materializeDualGraph)
      .addNode("audit_and_compile", auditAndCompile)
      .addEdge(START, "hydrate_kernel")
      .addEdge("hydrate_kernel", "derive_layers")
      .addEdge("derive_layers", "materialize_dual_graph")
      .addEdge("materialize_dual_graph", "audit_and_compile")
      .addEdge("audit_and_compile", END)
      .compile({ checkpointer: false });
  }
  if (options?.execution === "kernel") {
    return new StateGraph(BuildState)
      .addNode("research_sources", researchSources, { retryPolicy: { maxAttempts: 2, initialInterval: 1 } })
      .addNode("prepare_sources", prepareSources)
      .addNode("extract_mentions", extractMentions)
      .addNode("converge_tasks", convergeTasks)
      .addNode("build_kernel", buildKernel)
      .addEdge(START, "research_sources")
      .addEdge("research_sources", "prepare_sources")
      .addEdge("prepare_sources", "extract_mentions")
      .addEdge("extract_mentions", "converge_tasks")
      .addEdge("converge_tasks", "build_kernel")
      .addEdge("build_kernel", END)
      .compile({ checkpointer: false });
  }
  return new StateGraph(BuildState)
    .addNode("research_sources", researchSources, { retryPolicy: { maxAttempts: 2, initialInterval: 1 } })
    .addNode("prepare_sources", prepareSources)
    .addNode("extract_mentions", extractMentions)
    .addNode("converge_tasks", convergeTasks)
    .addNode("build_kernel", buildKernel)
    .addNode("derive_layers", deriveLayers)
    .addNode("materialize_dual_graph", materializeDualGraph)
    .addNode("audit_and_compile", auditAndCompile)
    .addEdge(START, "research_sources")
    .addEdge("research_sources", "prepare_sources")
    .addEdge("prepare_sources", "extract_mentions")
    .addEdge("extract_mentions", "converge_tasks")
    .addEdge("converge_tasks", "build_kernel")
    .addEdge("build_kernel", "derive_layers")
    .addEdge("derive_layers", "materialize_dual_graph")
    .addEdge("materialize_dual_graph", "audit_and_compile")
    .addEdge("audit_and_compile", END)
    .compile({ checkpointer: false });
}
