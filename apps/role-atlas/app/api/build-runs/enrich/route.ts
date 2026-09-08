import { enqueueRoleJob } from "@/lib/jobs/dispatch";
import { rememberResearchRequester } from "@/lib/research-collection/store";
import { startRoleJobExecution } from "@/lib/jobs/execution";
import { projectVersionHeadState } from "@/lib/versioning/commit";
import { authorizeApiRequest } from "@/lib/access";
import { z } from "zod/v4";
import { createRecordedModelInvoker } from "@/lib/research-collection/model";
import { createColdStartSkill } from "@/lib/build/graph";
import { assertTaskKernel } from "@/lib/build/completion";
import type { BuildEvent } from "@/lib/build/events";
import { coldStartRequestSchema, type ColdStartBuildResult } from "@/lib/build/types";
import {
  appendBuildEvent,
  completeBuildStageRun,
  completeEnrichmentBuildSnapshot,
  failBuildRun,
  getBuildRunStatus,
  getConversation,
  getProjectWorkspace,
  startBuildRun,
} from "@/lib/projects/repository";
import { lastRoleEventSequence, appendRoleJobEvent, assertRoleJobLease, checkpointRoleJob, claimRoleJob, completeRoleJob, failRoleJob } from "@/lib/jobs/repository";
import { createDurableJobStream, durableJobResponse } from "@/lib/jobs/runtime";
import { resolveProviderConfig, resolveSearchProviderConfig } from "@/lib/server-runtime-config";
import { workerRuntimeBindings } from "@/lib/worker-runtime-bindings";
import { createColdStartDeepResearchRequest, createColdStartRiskRepairRequest } from "@/lib/iteration/automatic-followup";
import { runAutomaticSnapshotIteration } from "@/lib/iteration/automatic-runner";
import { snapshotQualitySummary } from "@/lib/iteration/learning-health";

export const runtime = "edge";

const enrichmentCache = new Map<string, unknown>();

const requestSchema = z.object({
  build: coldStartRequestSchema,
  baseSnapshotId: z.string().min(4).max(220),
  conversationId: z.string().min(4).max(100),
  providerConfig: z.unknown().optional(),
  searchConfig: z.unknown().optional(),
  webResearch: z.boolean().default(true),
});

function failureEvent(input: { runId: string; projectId: string }, error: unknown): BuildEvent {
  const raw = error instanceof Error ? error.message : "未知错误";
  return {
    version: "2.0",
    runId: input.runId,
    projectId: input.projectId,
    seq: Number.MAX_SAFE_INTEGER,
    time: new Date().toISOString(),
    kind: "build.run.failed",
    profile: "system",
    payload: {
      message: /abort/i.test(raw) ? "后台增量已暂停；岗位内核与已完成子版本仍可使用。" : `后台增量失败：${raw}`,
      retryable: true,
      kernelPreserved: true,
    },
  };
}

export async function POST(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  await rememberResearchRequester(request);
  let parsed: z.infer<typeof requestSchema>;
  try {
    parsed = requestSchema.parse(await request.json());
  } catch (error) {
    return Response.json({ ok: false, error: "后台增量请求无效。", detail: error instanceof Error ? error.message : undefined }, { status: 400 });
  }
  const workspace = await getProjectWorkspace(parsed.build.projectId, parsed.baseSnapshotId).catch(() => null);
  if (!workspace?.result) return Response.json({ ok: false, error: "岗位内核快照不存在。" }, { status: 404 });
  const baseResult = workspace.result;
  try { assertTaskKernel(baseResult); }
  catch (error) { return Response.json({ ok: false, code: "TASK_EVIDENCE_MISSING", error: (error as Error).message }, { status: 422 }); }
  const conversation = await getConversation(parsed.conversationId).catch(() => null);
  if (!conversation || conversation.conversation.projectId !== parsed.build.projectId) {
    return Response.json({ ok: false, error: "构建会话不存在或不属于当前项目。" }, { status: 404 });
  }
  if (conversation.conversation.mode !== "iteration") return Response.json({ error: "请先切换到迭代态。", code: "ITERATION_MODE_REQUIRED" }, { status: 409 });
  if (conversation.conversation.snapshotId !== parsed.baseSnapshotId) return Response.json({ error: "对话基线已改变。", code: "CONVERSATION_BASE_CHANGED" }, { status: 409 });
  let parentVersionId = conversation.conversation.versionId;
  const existingRun = await getBuildRunStatus(parsed.build.projectId, parsed.build.runId);
  if (existingRun?.status === "completed") {
    return Response.json({
      ok: false,
      code: "ENRICHMENT_ALREADY_COMPLETED",
      error: "同一后台增量已经完成。",
    }, { status: 409 });
  }
  let providerConfig;
  let searchConfig;
  const bindings = workerRuntimeBindings();
  try {
    providerConfig = resolveProviderConfig(parsed.providerConfig, bindings);
  } catch (error) {
    const message = error instanceof Error && error.message === "SERVER_MODEL_NOT_CONFIGURED"
      ? "服务端尚未配置模型 API Key。"
      : "模型配置无效。";
    return Response.json({ ok: false, error: message }, { status: 400 });
  }
  try { searchConfig = parsed.webResearch ? resolveSearchProviderConfig(parsed.searchConfig, bindings) : undefined; }
  catch (error) {
    if (parsed.webResearch) {
      const message = error instanceof Error && error.message === "SERVER_SEARCH_NOT_CONFIGURED"
        ? "后台补研需要搜索 API Key。" : "联网搜索配置无效。";
      return Response.json({ ok: false, error: message }, { status: 400 });
    }
    searchConfig = undefined;
  }
  const jobOwner = crypto.randomUUID();
  const claimInput = {
    conversationId: parsed.conversationId,
    baseVersionId: parentVersionId || undefined,
    id: parsed.build.runId,
    kind: "cold_start" as const,
    threadId: `${parsed.build.projectId}:${parsed.build.runId}`,
    projectId: parsed.build.projectId,
    baseSnapshotId: parsed.baseSnapshotId,
    phase: "semantic.enrichment",
    owner: jobOwner,
    payload: { build: parsed.build, baseSnapshotId: parsed.baseSnapshotId, conversationId: parsed.conversationId, webResearch: parsed.webResearch },
  };
  const queued = await enqueueRoleJob(request, claimInput, parsed);
  if (queued) return queued;
  const job = await claimRoleJob(claimInput).catch(() => null);
  if (!job?.claimed) return Response.json({ ok: false, code: "ENRICHMENT_ALREADY_RUNNING", error: "同一后台增量正在运行。" }, { status: 409 });

  try {
    await startBuildRun(parsed.build);
  } catch (error) {
    await failRoleJob({ jobId: parsed.build.runId, owner: jobOwner, error: "无法保存后台增量运行。", retryable: false }).catch(() => undefined);
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "无法保存后台增量运行。" }, { status: 500 });
  }
  const execution = startRoleJobExecution(parsed.build.runId, jobOwner);
  const commitExecution = { jobId: parsed.build.runId, jobOwner };
  const model = createRecordedModelInvoker(providerConfig,{projectId:parsed.build.projectId,runId:parsed.build.runId});
  const modelLabel = `${providerConfig.provider}/${providerConfig.model}`;
  const graph = createColdStartSkill(model, {
    initialSeq: await lastRoleEventSequence(parsed.build.runId),
    execution: "enrichment",
    searchConfig,
    sourceLimit: 8,
    existingResearchReport: baseResult.sources.research,
    cache: enrichmentCache,
  });
  const stream = createDurableJobStream<BuildEvent>({
    execute: () => graph.stream(
      { request: parsed.build, baseResult, laneFailures: [] },
      {
        configurable: { thread_id: `${parsed.build.projectId}:${parsed.build.runId}` },
        streamMode: "custom",
        signal: execution.signal,
      },
    ),
    persist: async (event) => { await appendBuildEvent(event); await appendRoleJobEvent(parsed.build.runId, event); },
    handle: async (raw, journal) => {
      const event = raw as BuildEvent;
      if (event.kind === "build.enrichment.semantic.completed" && event.payload.result) {
        const result = event.payload.result as ColdStartBuildResult;
        await journal.commit(event, async () => {
          await checkpointRoleJob({ jobId: parsed.build.runId, owner: jobOwner, kind: "cold_start", phase: "semantic.completed", state: { snapshotId: result.snapshot.id, eventSeq: event.seq } });
          await assertRoleJobLease(parsed.build.runId, jobOwner);
          const committed = await completeEnrichmentBuildSnapshot(result, parsed.conversationId, "semantic", { ...commitExecution, parentVersionId });
          parentVersionId = committed.id;
        });
        return;
      }
      if (event.kind === "build.run.completed" && event.payload.result) {
        const result = event.payload.result as ColdStartBuildResult;
        await journal.commit(event, async () => {
          await checkpointRoleJob({ jobId: parsed.build.runId, owner: jobOwner, kind: "cold_start", phase: "full.commit", state: { snapshotId: result.snapshot.id, eventSeq: event.seq } });
          await assertRoleJobLease(parsed.build.runId, jobOwner);
          const committed = await completeEnrichmentBuildSnapshot(result, parsed.conversationId, "full", { ...commitExecution, parentVersionId });
          parentVersionId = committed.id;
          await completeBuildStageRun(parsed.build.runId, parsed.build.projectId, result);
        });
        try {
          let deepResult: Awaited<ReturnType<typeof runAutomaticSnapshotIteration>> | undefined;
          if (searchConfig) {
            journal.publish({ ...event, seq: event.seq + 1, time: new Date().toISOString(), kind: "build.followup.deep_research.started", profile: "system", payload: { baseSnapshotId: result.snapshot.id, maxImportantTopics: 5 } });
            try {
              deepResult = await runAutomaticSnapshotIteration({
                request: createColdStartDeepResearchRequest({
                  runId: parsed.build.runId,
                  snapshotId: result.snapshot.id,
                  versionId: parentVersionId || undefined,
                  projectId: parsed.build.projectId,
                  conversationId: parsed.conversationId,
                  learningPathGraph: parsed.build.learningPathGraph,
                }),
                execution: commitExecution,
                signal: execution.signal,
                base: result,
                model: createRecordedModelInvoker(providerConfig,{projectId:parsed.build.projectId,runId:`${parsed.build.runId.slice(0,94)}:deep`}),
                modelLabel,
                searchConfig,
              });
              journal.publish({ ...event, seq: event.seq + 2, time: new Date().toISOString(), kind: "build.followup.deep_research.completed", profile: "system", payload: { result: deepResult, snapshotId: deepResult.candidateSnapshotId || deepResult.candidate.snapshot.id } });
            } catch (deepError) {
              journal.publish({ ...event, seq: event.seq + 2, time: new Date().toISOString(), kind: "build.followup.deep_research.skipped", profile: "system", payload: { message: deepError instanceof Error ? deepError.message : "重要问题深研失败", baseSnapshotId: result.snapshot.id } });
            }
          } else {
            journal.publish({ ...event, seq: event.seq + 2, time: new Date().toISOString(), kind: "build.followup.deep_research.skipped", profile: "system", payload: { message: parsed.webResearch ? "未配置搜索供应商，重要问题深研未执行。" : "本轮已关闭联网，保留资料内分析与检查；未执行联网深研。", baseSnapshotId: result.snapshot.id } });
          }
          const researchedSnapshotId = deepResult?.candidateSnapshotId || deepResult?.candidate.snapshot.id || result.snapshot.id;
          journal.publish({ ...event, seq: event.seq + 3, time: new Date().toISOString(), kind: "build.followup.risk_repair.started", profile: "system", payload: { baseSnapshotId: researchedSnapshotId, scope: "global" } });
          const repairResult = await runAutomaticSnapshotIteration({
            request: createColdStartRiskRepairRequest({
              runId: parsed.build.runId,
              snapshotId: researchedSnapshotId,
              projectId: parsed.build.projectId,
              versionId: deepResult?.projectVersionId || parentVersionId || undefined,
              conversationId: parsed.conversationId,
              learningPathGraph: parsed.build.learningPathGraph,
            }),
            execution: commitExecution,
            signal: execution.signal,
            base: deepResult?.candidate || result,
            model: createRecordedModelInvoker(providerConfig,{projectId:parsed.build.projectId,runId:`${parsed.build.runId.slice(0,92)}:repair`}),
            modelLabel,
          });
          const finalSnapshotId = repairResult.candidateSnapshotId || repairResult.candidate.snapshot.id;
          const quality = snapshotQualitySummary(repairResult.candidate);
          await journal.commit({ ...event, seq: event.seq + 4, time: new Date().toISOString(), kind: "build.followup.risk_repair.completed", profile: "system", payload: { result: repairResult, snapshotId: finalSnapshotId, quality, deepResearchStatus: deepResult ? deepResult.status : "skipped" } }, async () => {
            await completeRoleJob({ jobId: parsed.build.runId, owner: jobOwner, phase: deepResult && !quality.needsResearch ? "followup.completed" : "followup.degraded", result: { snapshotId: finalSnapshotId, candidateSnapshotId: finalSnapshotId, quality, projectVersionId: repairResult.projectVersionId, ...await projectVersionHeadState(parsed.build.projectId, repairResult.projectVersionId || ""), deepResearchRunId: deepResult?.runId, riskRepairRunId: repairResult.runId } });
          });
        } catch (followupError) {
          await journal.commit({
            ...event,
            seq: event.seq + 5,
            time: new Date().toISOString(),
            kind: "build.followup.failed",
            profile: "system",
            payload: { message: followupError instanceof Error ? followupError.message : "自动深研或风险修复失败", coldStartSnapshotId: result.snapshot.id },
          }, () => completeRoleJob({ jobId: parsed.build.runId, owner: jobOwner, phase: "followup.degraded", result: { snapshotId: result.snapshot.id, quality: snapshotQualitySummary(result), followupError: followupError instanceof Error ? followupError.message : "自动深研或风险修复失败" } }));
        }
        return;
      }
      journal.publish(event);
    },
    onFailure: async (error, journal) => {
      const event = failureEvent(parsed.build, error);
      await journal.commit(event, () => failBuildRun(parsed.build.runId, parsed.build.projectId, String(event.payload.message || "后台增量失败"), false)).catch(() => undefined);
      await failRoleJob({ jobId: parsed.build.runId, owner: jobOwner, error: String(event.payload.message || "后台增量失败"), retryable: true }).catch(() => undefined);
    },
    onFinally: execution.stop,
    keepAlive: execution.keepAlive,
  });
  return durableJobResponse(stream);
}
