import { assertRoleJobLease } from "@/lib/jobs/repository";
import type { ModelInvoker } from "@/lib/agent/model";
import type { ColdStartBuildResult } from "@/lib/build/types";
import type { SearchProviderConfig } from "@/lib/search/providers";
import { createSnapshotIterationSkill } from "./graph";
import {
  appendIterationEvent,
  attachIterationProjectVersion,
  completeSnapshotIteration,
  failSnapshotIteration,
  saveIterationCheckpoint,
  startSnapshotIteration,
} from "./repository";
import type { IterationEvent, SnapshotIterationRequest, SnapshotIterationResult } from "./types";
import { saveProjectCandidateFromIteration } from "@/lib/projects/repository";

export async function runAutomaticSnapshotIteration(input: {
  request: SnapshotIterationRequest;
  base: ColdStartBuildResult;
  model: ModelInvoker;
  modelLabel?: string;
  searchConfig?: SearchProviderConfig;
  execution?: { jobId: string; jobOwner: string };
  signal?: AbortSignal;
}) {
  await startSnapshotIteration(input.request);
  const graph = createSnapshotIterationSkill({
    model: input.model,
    modelLabel: input.modelLabel,
    searchConfig: input.searchConfig,
    onCheckpoint: (phase, state) => saveIterationCheckpoint(input.request.runId, phase, state),
  });
  let completed: SnapshotIterationResult | undefined;
  try {
    const events = await graph.stream({
      request: input.request,
      base: input.base,
      candidate: input.base,
      round: 1,
      opportunities: [], workItems: [], researchPlans: [], researchReports: [], researchedSources: [], patches: [], migrations: {},
    }, {
      configurable: { thread_id: `${input.base.snapshot.id}:${input.request.runId}:automatic` },
      streamMode: "custom",
      signal: input.signal,
    });
    for await (const raw of events) {
      const event = raw as IterationEvent;
      if (event.kind !== "iteration.run.completed" || !event.payload.result) {
        await appendIterationEvent(event);
        continue;
      }
      const result = event.payload.result as SnapshotIterationResult;
      if (result.createdSnapshot) await appendIterationEvent({
        ...event, kind: "iteration.snapshot.write.started", phase: "snapshot",
        payload: { parentSnapshotId: result.baseSnapshotId, status: "candidate" },
      });
      if (input.execution) await assertRoleJobLease(input.execution.jobId, input.execution.jobOwner);
      const candidateSnapshotId = await completeSnapshotIteration(result);
      const projectVersionId = input.request.projectId
        ? await saveProjectCandidateFromIteration(result, input.request.projectId, input.request.conversationId, input.execution)
        : null;
      result.candidateSnapshotId = candidateSnapshotId || undefined;
      result.projectVersionId = projectVersionId || undefined;
      if (projectVersionId) await attachIterationProjectVersion(result, projectVersionId);
      if (candidateSnapshotId) await appendIterationEvent({
        ...event, seq: event.seq + 1, kind: "iteration.snapshot.created", phase: "snapshot",
        payload: { candidateSnapshotId, projectVersionId, parentSnapshotId: result.baseSnapshotId, status: "candidate" },
      });
      await appendIterationEvent({
        ...event, seq: event.seq + (candidateSnapshotId ? 2 : 0),
        payload: { ...event.payload, result, candidateSnapshotId, projectVersionId },
      });
      completed = result;
    }
  } catch (error) {
    await failSnapshotIteration(input.request.runId, error instanceof Error ? error.message : "自动迭代失败", false).catch(() => undefined);
    throw error;
  }
  if (!completed) throw new Error("自动迭代结束但没有形成可核验结果");
  return completed;
}
