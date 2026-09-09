import { enqueueRoleJob, isDispatchedRoleJob } from "@/lib/jobs/dispatch";
import { readAutomaticMountResearchFeedback } from "@/lib/learning-path/automatic";
import { iterationOutcome } from "@/lib/jobs/iteration-outcome";
import { rememberResearchRequester } from "@/lib/research-collection/store";
import { startRoleJobExecution } from "@/lib/jobs/execution";
import { projectVersionHeadState } from "@/lib/versioning/commit";
import { authorizeApiRequest, requestActor } from "@/lib/access";
import { z } from "zod/v4";
import type { ModelInvoker } from "@/lib/agent/model";
import { createRecordedModelInvoker } from "@/lib/research-collection/model";
import { createSnapshotIterationSkill } from "@/lib/iteration/graph";
import { iterationBriefError } from "@/lib/iteration/brief";
import { iterationTargetNodes } from "@/lib/iteration/targets";
import {
  appendIterationEvent,
  attachIterationProjectVersion,
  completeSnapshotIteration,
  failSnapshotIteration,
  getLatestSnapshotIteration,
  saveIterationCheckpoint,
  startSnapshotIteration,
} from "@/lib/iteration/repository";
import {
  snapshotIterationRequestSchema,
  type IterationEvent,
  type SnapshotIterationResult,
} from "@/lib/iteration/types";
import { getConversation, saveProjectCandidateFromIteration } from "@/lib/projects/repository";
import { resolveProviderConfig, resolveSearchProviderConfig } from "@/lib/server-runtime-config";
import { resolveSnapshot } from "@/lib/snapshots/resolver";
import { workerRuntimeBindings } from "@/lib/worker-runtime-bindings";
import { createDurableJobStream, durableJobResponse } from "@/lib/jobs/runtime";
import { lastRoleEventSequence, appendRoleJobEvent, assertRoleJobLease, checkpointRoleJob, claimRoleJob, completeRoleJob, failRoleJob } from "@/lib/jobs/repository";

export const runtime = "edge";

const postSchema = z.object({
  iteration: snapshotIterationRequestSchema,
  providerConfig: z.unknown().optional(),
  searchConfig: z.unknown().optional(),
});

function failureEvent(
  input: { runId: string; snapshotRef: { snapshotId: string }; projectId?: string },
  error: unknown,
): IterationEvent {
  const raw = error instanceof Error ? error.message : "未知错误";
  const message = /401|api key|authentication|auth/i.test(raw)
    ? "模型或检索供应商拒绝了凭据。"
    : /429|rate limit/i.test(raw)
      ? "供应商正在限流；运行记录已保留，可稍后重试。"
      : /abort/i.test(raw)
        ? "岗位快照迭代已取消，当前快照未改变。"
        : `岗位快照迭代失败：${raw}`;
  return {
    version: "1.0",
    runId: input.runId,
    snapshotId: input.snapshotRef.snapshotId,
    projectId: input.projectId,
    seq: Number.MAX_SAFE_INTEGER,
    time: new Date().toISOString(),
    kind: "iteration.run.failed",
    phase: "system",
    payload: { message, retryable: !/凭据/u.test(message) },
  };
}

function inactiveModel(): ModelInvoker {
  return async function* noModelRequired() {
    yield* [];
    throw new Error("本轮未进入模型重建阶段。");
  };
}

export async function GET(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  await rememberResearchRequester(request);
  const snapshotId = new URL(request.url).searchParams.get("snapshotId");
  if (!snapshotId) return Response.json({ error: "缺少 snapshotId。" }, { status: 400 });
  try {
    return Response.json({ run: await getLatestSnapshotIteration(snapshotId, (await requestActor(request)).subjectId) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "迭代运行读取失败。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  let parsed: z.infer<typeof postSchema>;
  try {
    parsed = postSchema.parse(await request.json());
  } catch (error) {
    return Response.json({ error: "岗位快照迭代范围或运行配置无效。", detail: error instanceof Error ? error.message : undefined }, { status: 400 });
  }

  const resolved = await resolveSnapshot(parsed.iteration.snapshotRef).catch(() => null);
  if (!resolved) return Response.json({ error: "没有可迭代的岗位快照。" }, { status: 404 });
  const briefError = iterationBriefError(parsed.iteration);
  if (briefError) return Response.json({ error: briefError }, { status: 400 });
  const nodeIds = new Set(iterationTargetNodes(resolved.result).map((node) => node.id));
  if (parsed.iteration.targetIds.some((id) => !nodeIds.has(id))) return Response.json({ error: "研究节点不属于本对话固定的岗位版本，请重新选择。", code: "ITERATION_TARGET_NOT_FOUND" }, { status: 400 });
  const projectId = resolved.reference.projectId || parsed.iteration.projectId;
  if (!projectId || !parsed.iteration.conversationId) return Response.json({ error: "请选择当前项目的迭代对话。", code: "CONVERSATION_REQUIRED" }, { status: 400 });
  {
    const conversation = await getConversation(parsed.iteration.conversationId).catch(() => null);
    if (!conversation || conversation.conversation.projectId !== projectId) {
      return Response.json({ error: "会话不存在或不属于当前项目。" }, { status: 404 });
    }
    if (conversation.conversation.mode !== "iteration") return Response.json({ error: "请先切换到迭代态再运行工具。", code: "ITERATION_MODE_REQUIRED" }, { status: 409 });
    if (conversation.conversation.versionId !== (resolved.reference.versionId || null) || conversation.conversation.snapshotId !== resolved.reference.snapshotId) {
      return Response.json({ error: "对话基线已改变，请刷新后继续。", code: "CONVERSATION_BASE_CHANGED" }, { status: 409 });
    }
  }

  // Keep external mount observations fixed in the queued request; worker retries must not change input identity.
  const learningMountFeedback = !isDispatchedRoleJob(request) && resolved.reference.versionId
    ? (await readAutomaticMountResearchFeedback(projectId, resolved.reference.versionId)).map(({ roleNodeId, reason, researchGoal }) => ({ roleNodeId, reason, researchGoal }))
    : parsed.iteration.learningMountFeedback;
  const iterationRequest = {
    ...parsed.iteration,
    learningMountFeedback,
    targetIds: [...new Set(parsed.iteration.targetIds)],
    targetAsOf: parsed.iteration.targetAsOf || (parsed.iteration.mode === "freshness" ? new Date().toISOString().slice(0, 10) : undefined),
    snapshotRef: resolved.reference,
    projectId,
  };
  const mayRebuild = iterationRequest.webResearch || iterationRequest.supplementalSources.length > 0
    || resolved.result.sources.assets.some(asset => asset.kind !== "user_brief" && resolved.result.sources.segments.some(segment => segment.sourceId === asset.id && segment.text.trim()));
  let model = inactiveModel();
  let modelLabel: string | undefined;
  let searchConfig;
  try {
    const bindings = workerRuntimeBindings();
    if (mayRebuild) {
      const modelConfig = resolveProviderConfig(parsed.providerConfig, bindings);
      model = createRecordedModelInvoker(modelConfig,{projectId,runId:iterationRequest.runId});
      modelLabel = `${modelConfig.provider}/${modelConfig.model}`;
    }
    if (iterationRequest.webResearch) searchConfig = resolveSearchProviderConfig(parsed.searchConfig, bindings);
  } catch (error) {
    const message = error instanceof Error && error.message === "SERVER_MODEL_NOT_CONFIGURED"
      ? "本轮可能重建快照，但服务端尚未配置模型 API Key。"
      : error instanceof Error && error.message === "SERVER_SEARCH_NOT_CONFIGURED"
        ? "已开启联网研究，但尚未配置搜索 API Key。"
        : "模型或搜索配置无效。";
    return Response.json({ error: message }, { status: 400 });
  }

  const jobOwner = crypto.randomUUID();
  const jobKind = iterationRequest.initiativeProfile === "user_directed" && iterationRequest.targetIds.length > 0
    ? "node_deepening" as const
    : "snapshot_iteration" as const;
  const claimInput = {
    conversationId: iterationRequest.conversationId,
    baseVersionId: resolved.reference.versionId,
    id: iterationRequest.runId,
    kind: jobKind,
    threadId: `${resolved.reference.snapshotId}:${iterationRequest.runId}`,
    projectId,
    baseSnapshotId: resolved.reference.snapshotId,
    phase: "contract",
    owner: jobOwner,
    payload: { iteration: iterationRequest },
  };
  const queued = await enqueueRoleJob(request, claimInput, { ...parsed, iteration: iterationRequest });
  if (queued) return queued;
  const job = await claimRoleJob(claimInput).catch(() => null);
  if (!job?.claimed) return Response.json({ error: "同一岗位快照迭代仍由另一个执行器处理。", code: "JOB_LEASE_HELD" }, { status: 409 });

  try {
    await startSnapshotIteration(iterationRequest);
  } catch (error) {
    await failRoleJob({ jobId: iterationRequest.runId, owner: jobOwner, error: "无法创建岗位快照迭代运行。", retryable: false }).catch(() => undefined);
    return Response.json({ error: error instanceof Error ? error.message : "无法创建岗位快照迭代运行。" }, { status: 500 });
  }

  const execution = startRoleJobExecution(iterationRequest.runId, jobOwner);

  const graph = createSnapshotIterationSkill({
    model,
    modelLabel,
    initialSeq: await lastRoleEventSequence(iterationRequest.runId),
    searchConfig,
    onCheckpoint: async (phase, state) => {
      await assertRoleJobLease(iterationRequest.runId, jobOwner);
      if (!await checkpointRoleJob({ jobId: iterationRequest.runId, owner: jobOwner, kind: jobKind, phase, state })) throw new Error("JOB_LEASE_LOST");
      await saveIterationCheckpoint(iterationRequest.runId, phase, state);
    },
  });
  const recovered = (job.job?.attempt || 1) > 1 && job.checkpoint?.state && typeof job.checkpoint.state === "object"
    ? job.checkpoint.state as Record<string, unknown>
    : undefined;
  const resumablePhases = new Set(["contract", "discovery", "research-plan", "research", "rebuild", "consolidate", "evaluate", "next-round"]);
  const resumeFrom = recovered && resumablePhases.has(String(recovered.phase))
    ? String(recovered.phase) as "contract" | "discovery" | "research-plan" | "research" | "rebuild" | "consolidate" | "evaluate" | "next-round"
    : undefined;
  const stream = createDurableJobStream<IterationEvent>({
    signal: execution.signal,
    execute: () => graph.stream(
      {
        round: 1,
        opportunities: [],
        workItems: [],
        researchPlans: [],
        researchReports: [],
        researchedSources: [],
        patches: [],
        migrations: {},
        ...recovered,
        request: iterationRequest,
        base: resolved.result,
        candidate: recovered?.candidate as typeof resolved.result || resolved.result,
        resumeFrom,
      },
      {
        configurable: { thread_id: `${resolved.reference.snapshotId}:${iterationRequest.runId}` },
        streamMode: "custom",
        signal: execution.signal,
      },
    ),
    persist: async (event) => { await appendIterationEvent(event); await appendRoleJobEvent(iterationRequest.runId, event); },
    handle: async (raw, journal) => {
      await assertRoleJobLease(iterationRequest.runId, jobOwner);
      const event = raw as IterationEvent;
      if (event.kind !== "iteration.run.completed" || !event.payload.result) {
        journal.publish(event);
        return;
      }
      const result = event.payload.result as SnapshotIterationResult;
      if (result.createdSnapshot) {
        await journal.commit({
          ...event,
          kind: "iteration.snapshot.write.started",
          phase: "snapshot",
          time: new Date().toISOString(),
          payload: { parentSnapshotId: result.baseSnapshotId, status: "candidate" },
        });
      }
      await assertRoleJobLease(iterationRequest.runId, jobOwner);
      const candidateSnapshotId = await completeSnapshotIteration(result);
      const projectVersionId = projectId
        ? await saveProjectCandidateFromIteration(result, projectId, iterationRequest.conversationId, { jobId: iterationRequest.runId, jobOwner })
        : null;
      const headState = projectId && projectVersionId ? await projectVersionHeadState(projectId, projectVersionId) : undefined;
      Object.assign(result, headState);
      result.candidateSnapshotId = candidateSnapshotId || undefined;
      result.projectVersionId = projectVersionId || undefined;
      if (projectVersionId) await attachIterationProjectVersion(result, projectVersionId);
      if (candidateSnapshotId) {
        await journal.commit({
          ...event,
          seq: event.seq + 1,
          kind: "iteration.snapshot.created",
          phase: "snapshot",
          time: new Date().toISOString(),
          payload: { candidateSnapshotId, projectVersionId, parentSnapshotId: result.baseSnapshotId, status: "candidate" },
        });
        await journal.commit({
          ...event,
          seq: event.seq + 2,
          time: new Date().toISOString(),
          payload: { ...event.payload, result, candidateSnapshotId, projectVersionId },
        });
      } else {
        await journal.commit({ ...event, payload: { ...event.payload, result, projectVersionId } });
      }
      await completeRoleJob({ jobId: iterationRequest.runId, owner: jobOwner, phase: "completed", result: { candidateSnapshotId, projectVersionId, ...headState, outcome: iterationOutcome(result) } });
    },
    onFailure: async (error, journal) => {
      const event = failureEvent(iterationRequest, error);
      event.seq = await lastRoleEventSequence(iterationRequest.runId) + 1;
      await journal.commit(event, () => failSnapshotIteration(
        iterationRequest.runId,
        String(event.payload.message || "迭代失败"),
        execution.signal.aborted,
      )).catch(() => undefined);
      await failRoleJob({ jobId: iterationRequest.runId, owner: jobOwner, error: String(event.payload.message || "迭代失败"), retryable: !execution.signal.aborted }).catch(() => undefined);
    },
    onFinally: execution.stop,
    keepAlive: execution.keepAlive,
  });
  return durableJobResponse(stream);
}
