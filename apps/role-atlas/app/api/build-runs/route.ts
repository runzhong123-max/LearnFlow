import { startRoleJobExecution } from "@/lib/jobs/execution";
import { projectVersionHeadState } from "@/lib/versioning/commit";
import { authorizeApiRequest } from "@/lib/access";
import { z } from "zod/v4";
import { createModelInvoker } from "@/lib/agent/model";
import { createColdStartSkill } from "@/lib/build/graph";
import type { BuildEvent } from "@/lib/build/events";
import { coldStartRequestSchema, type ColdStartBuildResult } from "@/lib/build/types";
import { resolveProviderConfig, resolveSearchProviderConfig } from "@/lib/server-runtime-config";
import { workerRuntimeBindings } from "@/lib/worker-runtime-bindings";
import { appendBuildEvent, completeBuildStageRun, completeFastBuildSnapshot, failBuildRun, getConversation, getProjectWorkspace, startBuildRun } from "@/lib/projects/repository";
import { createDurableJobStream, durableJobResponse } from "@/lib/jobs/runtime";
import { appendRoleJobEvent, assertRoleJobLease, checkpointRoleJob, claimRoleJob, completeRoleJob, failRoleJob } from "@/lib/jobs/repository";

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
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 800_000) return Response.json({ ok: false, error: "冷启动请求体过大。" }, { status: 413 });

  let parsed: z.infer<typeof requestSchema>;
  try {
    parsed = requestSchema.parse(await request.json());
  } catch (error) {
    return Response.json({ ok: false, error: "冷启动项目简报、资料或模型配置无效。", detail: error instanceof Error ? error.message : undefined }, { status: 400 });
  }

  let buildRequest = parsed.build;
  let existingResearchReport: ColdStartBuildResult["sources"]["research"];
  if (parsed.reuseProjectSources) {
    const workspace = await getProjectWorkspace(parsed.build.projectId).catch(() => null);
    const previous = workspace?.result;
    if (!previous) return Response.json({ ok: false, error: "当前项目还没有可复用的来源索引。" }, { status: 409 });
    const existingKeys = new Set(parsed.build.sources.map((source) => `${source.locator || ""}:${source.title}`));
    const reused = previous.sources.assets
      .filter((asset) => asset.kind !== "user_brief")
      .flatMap((asset) => {
        const content = previous.sources.segments
          .filter((segment) => segment.sourceId === asset.id)
          .sort((left, right) => left.ordinal - right.ordinal)
          .map((segment) => segment.text)
          .join("\n\n")
          .slice(0, 60_000);
        const key = `${asset.locator || ""}:${asset.title}`;
        if (!content || existingKeys.has(key)) return [];
        existingKeys.add(key);
        return [{
          title: asset.title,
          content,
          kind: asset.kind,
          locator: asset.locator,
          observedAt: asset.observedAt,
          publisher: asset.publisher,
          domain: asset.domain,
          publishedAt: asset.publishedAt,
          fetchedAt: asset.fetchedAt,
          sourceTier: asset.sourceTier,
          queryIds: asset.queryIds,
          searchCategories: asset.searchCategories,
          retrievalScore: asset.retrievalScore,
          provider: asset.provider,
          providerRequestIds: asset.providerRequestIds,
          extractionMethod: asset.extractionMethod,
        }];
      });
    buildRequest = { ...parsed.build, sources: [...parsed.build.sources, ...reused].slice(0, 20) };
    existingResearchReport = previous.sources.research;
  }

  let providerConfig;
  let searchConfig;
  try {
    const bindings = workerRuntimeBindings();
    providerConfig = resolveProviderConfig(parsed.providerConfig, bindings);
    searchConfig = parsed.reuseProjectSources || !parsed.webResearch
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
  const job = await claimRoleJob({
    conversationId: parsed.conversationId,
    baseVersionId: buildConversation.conversation.versionId || undefined,
    id: buildRequest.runId,
    kind: "cold_start",
    threadId: `${buildRequest.projectId}:${buildRequest.runId}`,
    projectId: buildRequest.projectId,
    phase: "kernel",
    owner: jobOwner,
    payload: { build: buildRequest, conversationId: parsed.conversationId, webResearch: parsed.webResearch },
  }).catch(() => null);
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
  const graph = createColdStartSkill(createModelInvoker(providerConfig), {
    searchConfig,
    sourceLimit: 16,
    existingResearchReport,
    cache: coldStartWorkItemCache,
    execution: "kernel",
  });
  const stream = createDurableJobStream<BuildEvent>({
    signal: execution.signal,
    execute: () => graph.stream(
      { request: buildRequest, laneFailures: [] },
      {
        configurable: { thread_id: `${buildRequest.projectId}:${buildRequest.runId}` },
        streamMode: "custom",
        signal: execution.signal,
      },
    ),
    persist: async (event) => {
      try { await appendBuildEvent(event); await appendRoleJobEvent(buildRequest.runId, event); }
      catch { throw new Error("PERSISTENCE_FAILED"); }
    },
    handle: async (raw, journal) => {
      const buildEvent = raw as BuildEvent;
      if (buildEvent.kind !== "build.kernel.completed" || !buildEvent.payload.result) {
        journal.publish(buildEvent);
        return;
      }
      await assertRoleJobLease(buildRequest.runId, jobOwner);
      const kernel = buildEvent.payload.result as ColdStartBuildResult;
      await journal.commit(buildEvent, async () => {
        try {
          await checkpointRoleJob({ jobId: buildRequest.runId, owner: jobOwner, kind: "cold_start", phase: "kernel.commit", state: { snapshotId: kernel.snapshot.id, eventSeq: buildEvent.seq } });
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
