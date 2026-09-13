import { replayBuildCompletion, reusableResearchSources } from "@/lib/research/recovery";
import { researchOptionsSchema } from "@/lib/research/protocol";
import type { ResearchAgentCheckpoint } from "@/lib/iteration/research-agent";
import { enqueueRoleJob, isDispatchedRoleJob } from "@/lib/jobs/dispatch";
import { rememberResearchRequester } from "@/lib/research-collection/store";
import { startRoleJobExecution } from "@/lib/jobs/execution";
import { projectVersionHeadState } from "@/lib/versioning/commit";
import { authorizeApiRequest, requestActor } from "@/lib/access";
import { requireConfirmedIntake } from "@/lib/intake/server";
import { intakeBuildGuard } from "@/lib/intake/build-guard";
import { z } from "zod/v4";
import { createRecordedModelInvoker } from "@/lib/research-collection/model";
import { createColdStartSkill } from "@/lib/build/graph";
import { assertTaskKernel } from "@/lib/build/completion";
import type { BuildEvent } from "@/lib/build/events";
import { coldStartRequestSchema, type ColdStartBuildResult } from "@/lib/build/types";
import { resolveProviderConfig, resolveSearchProviderConfig } from "@/lib/server-runtime-config";
import { workerRuntimeBindings } from "@/lib/worker-runtime-bindings";
import { appendBuildEvent, completeBuildStageRun, completeFastBuildSnapshot, failBuildRun, getConversation, getProjectWorkspace, startBuildRun } from "@/lib/projects/repository";
import { createDurableJobStream, durableJobResponse } from "@/lib/jobs/runtime";
import { lastRoleEventSequence, appendRoleJobEvent, assertRoleJobLease, checkpointRoleJob, claimRoleJob, completeRoleJob, failRoleJob } from "@/lib/jobs/repository";

export const runtime = "edge";

// Warm worker isolates reuse deterministic, source-bound work items. Published
// snapshots never depend on this cache; a miss simply recomputes the shard.
const coldStartWorkItemCache = new Map<string, unknown>();

function pruneWorkItemCache(limit = 800) {
  while (coldStartWorkItemCache.size > limit) {
    const oldest = coldStartWorkItemCache.keys().next().value as string | undefined;
    if (!oldest) break;
    coldStartWorkItemCache.delete(oldest);
  }
}

const requestSchema = z.object({
  build: coldStartRequestSchema,
  intakeConfirmation: z.object({ revisionId: z.string().min(4).max(220), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  conversationId: z.string().min(4).max(100),
  providerConfig: z.unknown().optional(),
  searchConfig: z.unknown().optional(),
  webResearch: z.boolean().default(false),
  reuseProjectSources: z.boolean().default(false),
});

function failureEvent(input: { runId?: string; projectId?: string }, error: unknown): BuildEvent {
  const raw = error instanceof Error ? error.message : "未知错误";
  const message = /PERSISTENCE_FAILED/i.test(raw)
    ? "冷启动产物已经生成，但项目版本保存失败；本轮未标记为完成，请重试。"
    : /401|api key|authentication|auth/i.test(raw)
    ? "模型供应商拒绝了凭据，请重新测试 API Key。"
    : /429|rate limit/i.test(raw)
      ? "模型供应商正在限流，请稍后继续本次构建。"
      : /abort/i.test(raw)
        ? "冷启动运行已取消，候选工作区已保留。"
        : `冷启动运行失败：${raw}`;
  return {
    version: "2.0",
    runId: input.runId || "unknown",
    projectId: input.projectId || "unknown",
    seq: Number.MAX_SAFE_INTEGER,
    time: new Date().toISOString(),
    kind: "build.run.failed",
    profile: "system",
    payload: { message, retryable: !/凭据/.test(message) },
  };
}

export async function POST(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  await rememberResearchRequester(request);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 800_000) return Response.json({ ok: false, error: "冷启动请求体过大。" }, { status: 413 });

  let parsed: z.infer<typeof requestSchema>;
  try {
    parsed = requestSchema.parse(await request.json());
  } catch (error) {
    return Response.json({ ok: false, error: "冷启动项目简报、资料或模型配置无效。", detail: error instanceof Error ? error.message : undefined }, { status: 400 });
  }

  // Only the saved user confirmation defines the research brief. Workers replay sealed, immutable input.
  if (!isDispatchedRoleJob(request)) {
    if (!parsed.intakeConfirmation) return Response.json({ error: "请先在右侧对话确认岗位说明，再开始生成图谱。", code: "INTAKE_CONFIRMATION_REQUIRED" }, { status: 409 });
    try {
      const confirmed = await requireConfirmedIntake({ actor: await requestActor(request), projectId: parsed.build.projectId, conversationId: parsed.conversationId, runId: parsed.build.runId, ...parsed.intakeConfirmation });
      parsed.build = coldStartRequestSchema.parse({ ...parsed.build, roleTitle: confirmed.roleTitle, roleDescription: confirmed.description, market: confirmed.market, sources: confirmed.sources });
      parsed.webResearch = true;
      parsed.reuseProjectSources = false;
    } catch {
      return Response.json({ error: "岗位说明已更新或尚未确认，请查看最新说明后再确定。", code: "INTAKE_CONFIRMATION_STALE" }, { status: 409 });
    }
  }
  let buildRequest = parsed.build;
  let existingResearchReport: ColdStartBuildResult["sources"]["research"];
  if (parsed.reuseProjectSources && !isDispatchedRoleJob(request)) {
    const workspace = await getProjectWorkspace(parsed.build.projectId).catch(() => null);
    const previous = workspace?.result;
    if (!previous) return Response.json({ ok: false, error: "当前项目还没有可复用的来源索引。" }, { status: 409 });
    const existingKeys = new Set(parsed.build.sources.map((source) => `${source.locator || ""}:${source.title}`));
    const reused = reusableResearchSources(previous).filter(source => !existingKeys.has(`${source.locator || ""}:${source.title}`));
    // Fail explicitly at the public request boundary rather than silently retaining the first 20 sources.
    buildRequest = coldStartRequestSchema.parse({ ...parsed.build, sources: [...parsed.build.sources, ...reused] });
    existingResearchReport = previous.sources.research;
  }

  if (!isDispatchedRoleJob(request)) buildRequest.research ||= researchOptionsSchema.parse({});

  let providerConfig;
  let searchConfig;
  try {
    const bindings = workerRuntimeBindings();
    providerConfig = resolveProviderConfig(parsed.providerConfig, bindings);
    searchConfig = !parsed.webResearch
      ? undefined
      : resolveSearchProviderConfig(parsed.searchConfig, bindings);
  } catch (error) {
    const message = error instanceof Error && error.message === "SERVER_MODEL_NOT_CONFIGURED"
      ? "服务端尚未配置模型 API Key，请填写 .env.local 或在设置页保存会话级 Key。"
      : error instanceof Error && error.message === "SERVER_SEARCH_NOT_CONFIGURED"
        ? "已开启自主联网，但服务端尚未配置搜索 API Key。"
        : "模型或联网搜索配置无效。";
    return Response.json({ ok: false, error: message }, { status: 400 });
  }

  const buildConversation = await getConversation(parsed.conversationId).catch(() => null);
  if (!buildConversation || buildConversation.conversation.projectId !== buildRequest.projectId) {
    return Response.json({ ok: false, error: "构建会话不存在或不属于当前项目。" }, { status: 404 });
  }

  if (buildConversation.conversation.mode !== "iteration") return Response.json({ error: "请先切换到迭代态再运行工具。", code: "ITERATION_MODE_REQUIRED" }, { status: 409 });

  const jobOwner = crypto.randomUUID();
  const claimInput = {
    conversationId: parsed.conversationId,
    baseVersionId: buildConversation.conversation.versionId || undefined,
    id: buildRequest.runId,
    kind: "cold_start" as const,
    threadId: `${buildRequest.projectId}:${buildRequest.runId}`,
    projectId: buildRequest.projectId,
    phase: "kernel",
    owner: jobOwner,
    payload: { build: buildRequest, conversationId: parsed.conversationId, webResearch: parsed.webResearch, ...(parsed.intakeConfirmation ? { intakeConfirmation: parsed.intakeConfirmation } : {}) },
  };
  const insertionFence = parsed.intakeConfirmation && !isDispatchedRoleJob(request)
    ? intakeBuildGuard({ ...parsed.intakeConfirmation, projectId: buildRequest.projectId, conversationId: parsed.conversationId, runId: buildRequest.runId, subjectId: (await requestActor(request)).subjectId }) : undefined;
  const queued = await enqueueRoleJob(request, claimInput, { ...parsed, build: buildRequest }, { forceDurable: true, insertionFence });
  if (queued) return queued;
  const job = await claimRoleJob(claimInput).catch(() => null);
  if (!job?.claimed) return Response.json({ ok: false, code: "JOB_LEASE_HELD", error: "同一冷启动仍由另一个执行器处理。" }, { status: 409 });

  try {
    await startBuildRun(buildRequest);
  } catch (error) {
    await failRoleJob({ jobId: buildRequest.runId, owner: jobOwner, error: "无法保存冷启动运行。", retryable: false }).catch(() => undefined);
    const notFound = error instanceof Error && error.message === "PROJECT_NOT_FOUND";
    return Response.json({ ok: false, error: notFound ? "项目不存在，请重新创建项目。" : "无法保存冷启动运行。" }, { status: notFound ? 404 : 500 });
  }

  const execution = startRoleJobExecution(buildRequest.runId, jobOwner);

  pruneWorkItemCache();
  let latestResearchCheckpoint = (job.checkpoint?.state as { researchCheckpoint?: ResearchAgentCheckpoint } | undefined)?.researchCheckpoint;
  const recoveredResult = (job.checkpoint?.state as { completedResult?: ColdStartBuildResult } | undefined)?.completedResult;
  const replay = buildRequest.research && recoveredResult?.runId === buildRequest.runId && recoveredResult.projectId === buildRequest.projectId ? recoveredResult : undefined;
  const nextSequence = await lastRoleEventSequence(buildRequest.runId) + 1;
  const graph = createColdStartSkill(createRecordedModelInvoker(providerConfig, { projectId: buildRequest.projectId, runId: buildRequest.runId }), {
    initialSeq: await lastRoleEventSequence(buildRequest.runId),
    searchConfig,
    sourceLimit: 64,
    existingResearchReport,
    cache: coldStartWorkItemCache,
    execution: buildRequest.research ? "full" : "kernel",
    researchCheckpoint: latestResearchCheckpoint,
    onResearchCheckpoint: async researchCheckpoint => {
      latestResearchCheckpoint = researchCheckpoint;
      await assertRoleJobLease(buildRequest.runId, jobOwner);
      await checkpointRoleJob({ jobId: buildRequest.runId, owner: jobOwner, kind: "cold_start", phase: "research", state: { researchCheckpoint } });
    },
  });
  const stream = createDurableJobStream<BuildEvent>({
    signal: execution.signal,
    execute: () => replay ? Promise.resolve(replayBuildCompletion(replay, nextSequence)) : graph.stream(
      { request: buildRequest, laneFailures: [] },
      {
        configurable: { thread_id: `${buildRequest.projectId}:${buildRequest.runId}` },
        streamMode: "custom",
        recursionLimit: 10_000,
        signal: execution.signal,
      },
    ),
    persist: async (event) => {
      try { await appendBuildEvent(event); await appendRoleJobEvent(buildRequest.runId, event); }
      catch { throw new Error("PERSISTENCE_FAILED"); }
    },
    handle: async (raw, journal) => {
      const buildEvent = raw as BuildEvent;
      if (buildEvent.kind !== (buildRequest.research ? "build.run.completed" : "build.kernel.completed") || !buildEvent.payload.result) {
        journal.publish(buildEvent);
        return;
      }
      await assertRoleJobLease(buildRequest.runId, jobOwner);
      const kernel = buildEvent.payload.result as ColdStartBuildResult;
      if (buildRequest.research) await checkpointRoleJob({ jobId: buildRequest.runId, owner: jobOwner, kind: "cold_start", phase: "research.commit", state: { researchCheckpoint: latestResearchCheckpoint, completedResult: kernel } });
      if (buildRequest.research && !kernel.deliveryReadiness?.ready) {
        await completeBuildStageRun(buildRequest.runId, buildRequest.projectId, kernel);
        await completeRoleJob({ jobId: buildRequest.runId, owner: jobOwner, phase: "draft", result: { stopReason: kernel.researchRun?.stopReason || "insufficient_material", draft: true, blockers: kernel.deliveryReadiness?.blockers || ["首版尚未完整"] } });
        buildEvent.payload.completed = false;
        buildEvent.payload.draft = true;
        journal.publish(buildEvent);
        return;
      }
      assertTaskKernel(kernel);
      await journal.commit(buildEvent, async () => {
        try {
          await checkpointRoleJob({ jobId: buildRequest.runId, owner: jobOwner, kind: "cold_start", phase: "kernel.commit", state: { snapshotId: kernel.snapshot.id, eventSeq: buildEvent.seq, ...(buildRequest.research ? { researchCheckpoint: latestResearchCheckpoint, completedResult: kernel } : {}) } });
          const committed = await completeFastBuildSnapshot(kernel, parsed.conversationId, { parentVersionId: job.job?.baseVersionId || null, jobId: buildRequest.runId, jobOwner });
          buildEvent.payload.projectVersionId = committed.id;
          buildEvent.payload.appliedToHead = committed.appliedToHead;
          buildEvent.payload.currentHeadVersionId = committed.currentHeadVersionId;
          await completeBuildStageRun(buildRequest.runId, buildRequest.projectId, kernel);
          await completeRoleJob({ jobId: buildRequest.runId, owner: jobOwner, phase: "kernel.completed", result: { snapshotId: kernel.snapshot.id, candidateSnapshotId: kernel.snapshot.id, projectVersionId: committed.id, appliedToHead: committed.appliedToHead, currentHeadVersionId: committed.currentHeadVersionId } });
        } catch {
          throw new Error("PERSISTENCE_FAILED");
        }
      });
    },
    onFailure: async (error, journal) => {
      const event = failureEvent(buildRequest, error);
      await journal.commit(event, () => failBuildRun(
        buildRequest.runId,
        buildRequest.projectId,
        String(event.payload.message || "冷启动失败"),
        execution.signal.aborted,
      )).catch(() => undefined);
      await failRoleJob({ jobId: buildRequest.runId, owner: jobOwner, error: String(event.payload.message || "冷启动失败"), retryable: event.payload.retryable !== false }).catch(() => undefined);
    },
    onFinally: execution.stop,
    keepAlive: execution.keepAlive,
  });
  return durableJobResponse(stream);
}
