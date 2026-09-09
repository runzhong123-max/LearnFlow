import { enqueueRoleJob } from "@/lib/jobs/dispatch";
import { iterationOutcome } from "@/lib/jobs/iteration-outcome";
import { emptyWorkspaceUpgradeOutcome, usableWorkspaceObservations, workspaceIterationRequest, workspaceUpgradeIterationSchema } from "@/lib/skills/workspace-upgrade";
import { normalizeWorkspaceConnection } from "@/lib/workspaces/adapters";
import { rememberResearchRequester } from "@/lib/research-collection/store";
import { startRoleJobExecution } from "@/lib/jobs/execution";
import { projectVersionHeadState } from "@/lib/versioning/commit";
import { authorizeApiRequest } from "@/lib/access";
import { z } from "zod/v4";
import { createRecordedModelInvoker } from "@/lib/research-collection/model";
import { stableHash } from "@/lib/build/compiler";
import { createSnapshotIterationSkill } from "@/lib/iteration/graph";
import {
  appendIterationEvent,
  attachIterationProjectVersion,
  completeSnapshotIteration,
  failSnapshotIteration,
  saveIterationCheckpoint,
  startSnapshotIteration,
} from "@/lib/iteration/repository";
import type { IterationEvent, SnapshotIterationResult } from "@/lib/iteration/types";
import { getConversation, saveProjectCandidateFromIteration } from "@/lib/projects/repository";
import { resolveProviderConfig, resolveSearchProviderConfig } from "@/lib/server-runtime-config";
import { resolveSnapshot } from "@/lib/snapshots/resolver";
import { snapshotReferenceSchema } from "@/lib/snapshots/types";
import { workerRuntimeBindings } from "@/lib/worker-runtime-bindings";
import type { WorkspaceRunEvent } from "@/lib/workspaces/events";
import { createWorkspaceIngestionSkill } from "@/lib/workspaces/graph";
import {
  appendWorkspaceEvent,
  completeWorkspaceIngestion,
  failWorkspaceIngestion,
  saveWorkspaceCheckpoint,
  startWorkspaceIngestion,
} from "@/lib/workspaces/repository";
import { workspaceIngestionRequestSchema, type WorkspaceAlignmentReport, type WorkspaceIngestionResult } from "@/lib/workspaces/types";
import { createDurableJobStream, durableJobResponse } from "@/lib/jobs/runtime";
import { lastRoleEventSequence, appendRoleJobEvent, assertRoleJobLease, checkpointRoleJob, claimRoleJob, completeRoleJob, failRoleJob } from "@/lib/jobs/repository";

export const runtime = "edge";

const postSchema = z.object({
  snapshotRef: snapshotReferenceSchema,
  workspace: workspaceIngestionRequestSchema,
  conversationId: z.string().min(4).max(100).optional(),
  iteration: workspaceUpgradeIterationSchema.default({ prompt: "", webResearch: true, maxRounds: 4, sourceLimit: 20, maxWorkItems: 16 }),
  providerConfig: z.unknown().optional(),
  searchConfig: z.unknown().optional(),
});

function iterationFailureEvent(input: { runId: string; snapshotId: string; projectId?: string }, error: unknown): IterationEvent {
  const raw = error instanceof Error ? error.message : "未知错误";
  const message = raw === "SERVER_MODEL_NOT_CONFIGURED"
    ? "工作区已经提取，但服务端尚未配置模型 API Key；原快照未改变，可配置后重跑。"
    : raw === "SERVER_SEARCH_NOT_CONFIGURED"
      ? "工作区已经提取，但已开启联网交叉验证且服务端尚未配置搜索 API Key；可关闭联网或配置后重跑。"
      : /401|api key|authentication|auth/i.test(raw)
    ? "模型或检索供应商拒绝了凭据。工作区提取结果已经保留。"
    : /429|rate limit/i.test(raw)
      ? "供应商正在限流；工作区提取结果已经保留，可稍后继续升级。"
      : /abort/i.test(raw)
        ? "工作区驱动的岗位快照升级已取消；原快照未改变。"
        : `工作区已经提取，但岗位快照升级失败：${raw}`;
  return {
    version: "1.0",
    runId: input.runId,
    snapshotId: input.snapshotId,
    projectId: input.projectId,
    seq: Number.MAX_SAFE_INTEGER,
    time: new Date().toISOString(),
    kind: "iteration.run.failed",
    phase: "system",
    payload: { message, workspaceResultRetained: true },
  };
}

export async function POST(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  await rememberResearchRequester(request);
  let parsed: z.infer<typeof postSchema>;
  try {
    parsed = postSchema.parse(await request.json());
  } catch (error) {
    return Response.json({ error: "工作区升级范围或运行配置无效。", detail: error instanceof Error ? error.message : undefined }, { status: 400 });
  }
  // Adapter shape errors should be an actionable input error, not a queued
  // job that reports a failed model run after the user has already waited.
  try {
    normalizeWorkspaceConnection(parsed.workspace.connection);
  } catch (error) {
    const fields = error instanceof z.ZodError ? [...new Set(error.issues.map(issue => issue.path.join(".")).filter(Boolean))].slice(0, 4) : [];
    return Response.json({ error: `工作资料不符合所选类型${fields.length ? `，请检查 ${fields.join("、")}` : "，请检查事件或交付物结构"}。`, code: "WORKSPACE_ADAPTER_INPUT_INVALID" }, { status: 400 });
  }
  const resolved = await resolveSnapshot(parsed.snapshotRef).catch(() => null);
  if (!resolved) return Response.json({ error: "没有可升级的岗位快照。" }, { status: 404 });
  const resolvedSnapshot = resolved;
  const projectId = resolvedSnapshot.reference.projectId || parsed.workspace.projectId;
  if (!projectId || !parsed.conversationId) return Response.json({ error: "请选择当前项目的迭代对话。", code: "CONVERSATION_REQUIRED" }, { status: 400 });
  {
    const conversation = await getConversation(parsed.conversationId).catch(() => null);
    if (!conversation || conversation.conversation.projectId !== projectId) {
      return Response.json({ error: "会话不存在或不属于当前项目。" }, { status: 404 });
    }
    if (conversation.conversation.mode !== "iteration") return Response.json({ error: "请先切换到迭代态再运行工具。", code: "ITERATION_MODE_REQUIRED" }, { status: 409 });
    if (conversation.conversation.versionId !== (resolvedSnapshot.reference.versionId || null) || conversation.conversation.snapshotId !== resolvedSnapshot.reference.snapshotId) {
      return Response.json({ error: "对话基线已改变，请刷新后继续。", code: "CONVERSATION_BASE_CHANGED" }, { status: 409 });
    }
  }
  const workspaceRequest = { ...parsed.workspace, projectId };
  const jobOwner = crypto.randomUUID();
  const claimInput = {
    conversationId: parsed.conversationId,
    baseVersionId: resolvedSnapshot.reference.versionId,
    id: workspaceRequest.runId,
    kind: "workspace_instantiation" as const,
    threadId: `${resolvedSnapshot.reference.snapshotId}:${workspaceRequest.runId}`,
    projectId,
    baseSnapshotId: resolvedSnapshot.reference.snapshotId,
    phase: "workspace.register",
    owner: jobOwner,
    payload: { snapshotRef: resolvedSnapshot.reference, workspace: workspaceRequest, conversationId: parsed.conversationId, iteration: parsed.iteration },
  };
  const queued = await enqueueRoleJob(request, claimInput, { ...parsed, snapshotRef: resolvedSnapshot.reference, workspace: workspaceRequest });
  if (queued) return queued;
  const job = await claimRoleJob(claimInput).catch(() => null);
  if (!job?.claimed) return Response.json({ error: "同一工作区实例化仍由另一个执行器处理。", code: "JOB_LEASE_HELD" }, { status: 409 });
  try {
    await startWorkspaceIngestion({ request: workspaceRequest, baseSnapshotId: resolvedSnapshot.reference.snapshotId });
  } catch (error) {
    await failRoleJob({ jobId: workspaceRequest.runId, owner: jobOwner, error: "无法创建工作区实例化运行。", retryable: false }).catch(() => undefined);
    return Response.json({ error: error instanceof Error ? error.message : "无法创建工作区实例化运行。" }, { status: 500 });
  }
  const execution = startRoleJobExecution(workspaceRequest.runId, jobOwner);

  const recovered = (job.job?.attempt || 1) > 1 && job.checkpoint?.state && typeof job.checkpoint.state === "object"
    ? job.checkpoint.state as Record<string, unknown>
    : undefined;
  let workspaceResult = recovered?.workspaceResult as WorkspaceIngestionResult | undefined;
  let alignment = recovered?.alignment as WorkspaceAlignmentReport | undefined;
  const recoveredIterationState = recovered?.iterationState && typeof recovered.iterationState === "object"
    ? recovered.iterationState as Record<string, unknown>
    : undefined;
  const iterationRunId = `workspace-iteration:${stableHash(workspaceRequest.runId)}`;

  async function* executeWorkflow(): AsyncGenerator<WorkspaceRunEvent | IterationEvent> {
    if (!workspaceResult) {
      const workspaceGraph = createWorkspaceIngestionSkill({
        onCheckpoint: async (phase, state) => {
          await Promise.all([
            saveWorkspaceCheckpoint(workspaceRequest.runId, phase, state),
            checkpointRoleJob({ jobId: workspaceRequest.runId, owner: jobOwner, kind: "workspace_instantiation", phase: `workspace.${phase}`, state: { workspaceState: state } }),
          ]);
        },
      });
      const workspaceEvents = await workspaceGraph.stream({
        request: workspaceRequest,
        base: resolvedSnapshot.result,
        observationLanes: [],
        observations: [],
        safetyFindings: [],
        quarantinedResourceIds: [],
      }, {
        configurable: { thread_id: `${resolvedSnapshot.reference.snapshotId}:${workspaceRequest.runId}:workspace` },
        streamMode: "custom",
        signal: execution.signal,
      });
      for await (const raw of workspaceEvents) yield raw as WorkspaceRunEvent;
    }
    if (!workspaceResult) throw new Error("工作区编排没有产生可迭代结果。");
    if (recovered?.workspaceResult) {
      await completeWorkspaceIngestion({
        runId: workspaceRequest.runId,
        result: workspaceResult,
        alignment,
        iterationRunId: usableWorkspaceObservations(workspaceResult).length ? iterationRunId : undefined,
      });
    }
    if (!usableWorkspaceObservations(workspaceResult).length) {
      await completeRoleJob({ jobId: workspaceRequest.runId, owner: jobOwner, phase: "completed.no_observations", result: { packageId: workspaceResult.package.id, observationCount: 0, outcome: emptyWorkspaceUpgradeOutcome(workspaceResult) } });
      return;
    }

    const iterationRequest = workspaceIterationRequest({ runId: iterationRunId, snapshotRef: resolvedSnapshot.reference,
      projectId: projectId!, conversationId: parsed.conversationId!, result: workspaceResult, alignment, iteration: parsed.iteration });
    await startSnapshotIteration(iterationRequest);
    const bindings = workerRuntimeBindings();
    const modelConfig = resolveProviderConfig(parsed.providerConfig, bindings);
    const searchConfig = parsed.iteration.webResearch ? resolveSearchProviderConfig(parsed.searchConfig, bindings) : undefined;
    const iterationGraph = createSnapshotIterationSkill({
      initialSeq: await lastRoleEventSequence(workspaceRequest.runId),
      model: createRecordedModelInvoker(modelConfig,{projectId:workspaceRequest.projectId,runId:iterationRunId}),
      modelLabel: `${modelConfig.provider}/${modelConfig.model}`,
      searchConfig,
      onCheckpoint: async (phase, state) => {
        await Promise.all([
          saveIterationCheckpoint(iterationRunId, phase, state),
          checkpointRoleJob({ jobId: workspaceRequest.runId, owner: jobOwner, kind: "workspace_instantiation", phase: `iteration.${phase}`, state: { workspaceResult, alignment, iterationState: state } }),
        ]);
      },
    });
    const iterationResumePhases = new Set(["contract", "discovery", "research-plan", "research", "rebuild", "consolidate", "evaluate", "next-round"]);
    const iterationResumeFrom = recoveredIterationState && iterationResumePhases.has(String(recoveredIterationState.phase))
      ? String(recoveredIterationState.phase) as "contract" | "discovery" | "research-plan" | "research" | "rebuild" | "consolidate" | "evaluate" | "next-round"
      : undefined;
    const iterationEvents = await iterationGraph.stream({
      round: 1,
      opportunities: [],
      workItems: [],
      researchPlans: [],
      researchReports: [],
      researchedSources: [],
      patches: [],
      migrations: {},
      ...recoveredIterationState,
      request: iterationRequest,
      base: resolvedSnapshot.result,
      candidate: recoveredIterationState?.candidate as typeof resolvedSnapshot.result || resolvedSnapshot.result,
      resumeFrom: iterationResumeFrom,
    }, {
      configurable: { thread_id: `${resolvedSnapshot.reference.snapshotId}:${iterationRunId}` },
      streamMode: "custom",
      signal: execution.signal,
    });
    for await (const raw of iterationEvents) yield raw as IterationEvent;
  }

  const stream = createDurableJobStream<WorkspaceRunEvent | IterationEvent>({
    signal: execution.signal,
    execute: executeWorkflow,
    persist: async (event) => {
      if (event.runId === workspaceRequest.runId) await appendWorkspaceEvent(event as WorkspaceRunEvent);
      else await appendIterationEvent(event as IterationEvent);
      await appendRoleJobEvent(workspaceRequest.runId, event);
    },
    handle: async (raw, journal) => {
      const event = raw as WorkspaceRunEvent | IterationEvent;
      if (event.runId === workspaceRequest.runId) {
        const workspaceEvent = event as WorkspaceRunEvent;
        if (workspaceEvent.kind === "workspace.run.completed") {
          workspaceResult = workspaceEvent.payload.result;
          alignment = workspaceEvent.payload.alignment;
          await journal.commit(workspaceEvent, async () => {
            await checkpointRoleJob({ jobId: workspaceRequest.runId, owner: jobOwner, kind: "workspace_instantiation", phase: "workspace.completed", state: { workspaceResult, alignment } });
            if (workspaceResult) {
              await completeWorkspaceIngestion({ runId: workspaceRequest.runId, result: workspaceResult, alignment, iterationRunId: usableWorkspaceObservations(workspaceResult).length ? iterationRunId : undefined });
            }
          });
        } else journal.publish(workspaceEvent);
        return;
      }
      const iterationEvent = event as IterationEvent;
      if (iterationEvent.kind !== "iteration.run.completed" || !iterationEvent.payload.result) {
        journal.publish(iterationEvent);
        return;
      }
      const result = iterationEvent.payload.result as SnapshotIterationResult;
      if (result.createdSnapshot) {
        await journal.commit({
          ...iterationEvent,
          kind: "iteration.snapshot.write.started",
          phase: "snapshot",
          time: new Date().toISOString(),
          payload: { parentSnapshotId: result.baseSnapshotId, workspaceRunId: workspaceRequest.runId, status: "candidate" },
        });
      }
      await assertRoleJobLease(workspaceRequest.runId, jobOwner);
      const candidateSnapshotId = await completeSnapshotIteration(result);
      const projectVersionId = projectId ? await saveProjectCandidateFromIteration(result, projectId, parsed.conversationId, { jobId: workspaceRequest.runId, jobOwner }) : null;
      const headState = projectId && projectVersionId ? await projectVersionHeadState(projectId, projectVersionId) : undefined;
      Object.assign(result, headState);
      result.candidateSnapshotId = candidateSnapshotId || undefined;
      result.projectVersionId = projectVersionId || undefined;
      if (projectVersionId) await attachIterationProjectVersion(result, projectVersionId);
      if (candidateSnapshotId) {
        await journal.commit({
          ...iterationEvent,
          seq: iterationEvent.seq + 1,
          kind: "iteration.snapshot.created",
          phase: "snapshot",
          time: new Date().toISOString(),
          payload: { candidateSnapshotId, projectVersionId, parentSnapshotId: result.baseSnapshotId, workspaceRunId: workspaceRequest.runId, status: "candidate" },
        });
        await journal.commit({
          ...iterationEvent,
          seq: iterationEvent.seq + 2,
          time: new Date().toISOString(),
          payload: { ...iterationEvent.payload, result, candidateSnapshotId, projectVersionId, workspaceRunId: workspaceRequest.runId },
        });
      } else {
        await journal.commit({ ...iterationEvent, payload: { ...iterationEvent.payload, result, projectVersionId, workspaceRunId: workspaceRequest.runId } });
      }
      await completeRoleJob({ jobId: workspaceRequest.runId, owner: jobOwner, phase: "completed", result: { candidateSnapshotId, projectVersionId, ...headState, workspacePackageId: workspaceResult?.package.id, outcome: iterationOutcome(result) } });
    },
    onFailure: async (error, journal) => {
      if (!workspaceResult) {
        const message = error instanceof Error ? error.message : "工作区读取、归一化或安全扫描失败。";
        const workspaceEvent: WorkspaceRunEvent = {
          version: "1.0",
          runId: workspaceRequest.runId,
          projectId,
          seq: Number.MAX_SAFE_INTEGER,
          time: new Date().toISOString(),
          kind: "workspace.run.failed",
          phase: "system",
          payload: { message },
        };
        await journal.commit(workspaceEvent, () => failWorkspaceIngestion(workspaceRequest.runId, message, execution.signal.aborted)).catch(() => undefined);
        await failRoleJob({ jobId: workspaceRequest.runId, owner: jobOwner, error: message, retryable: !execution.signal.aborted }).catch(() => undefined);
        return;
      }
      const event = iterationFailureEvent({ runId: iterationRunId, snapshotId: resolvedSnapshot.reference.snapshotId, projectId }, error);
      await journal.commit(event, async () => {
        await Promise.allSettled([
          failSnapshotIteration(iterationRunId, String(event.payload.message || "工作区升级失败"), execution.signal.aborted),
          failWorkspaceIngestion(workspaceRequest.runId, String(event.payload.message || "工作区升级失败"), execution.signal.aborted),
        ]);
      }).catch(() => undefined);
      await failRoleJob({ jobId: workspaceRequest.runId, owner: jobOwner, error: String(event.payload.message || "工作区升级失败"), retryable: !execution.signal.aborted }).catch(() => undefined);
    },
    onFinally: execution.stop,
    keepAlive: execution.keepAlive,
  });
  return durableJobResponse(stream);
}
