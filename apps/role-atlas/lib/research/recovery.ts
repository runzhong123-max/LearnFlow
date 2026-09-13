import type { BuildEvent } from "@/lib/build/events";
import type { ColdStartBuildResult } from "@/lib/build/types";
import type { IterationEvent, SnapshotIterationResult } from "@/lib/iteration/types";
/** Replay final compiler output through the same fenced commit path, without new model spending. */
export async function* replayBuildCompletion(result: ColdStartBuildResult, seq: number): AsyncGenerator<BuildEvent> {
  yield { version: "2.0", runId: result.runId, projectId: result.projectId, seq, time: new Date().toISOString(), kind: "build.run.completed", profile: "system", payload: { result, recovered: true, publishable: result.validation.publishable } };
}
export async function* replayIterationCompletion(result: SnapshotIterationResult, seq: number): AsyncGenerator<IterationEvent> {
  yield { version: "1.0", runId: result.runId, snapshotId: result.baseSnapshotId, projectId: result.projectId, seq, time: new Date().toISOString(), kind: "iteration.run.completed", phase: "system", payload: { result, recovered: true, createdSnapshot: result.createdSnapshot } };
}

/** A recovered worker may finish its own already-committed version after the conversation moves. */
export function canReplayCommittedIteration(input: { dispatched: boolean; runId: string; projectId: string; baseVersionId?: string | null; committed?: { sourceRunId: string | null; projectId: string; parentVersionId: string | null } | null }) {
  return input.dispatched && input.committed?.sourceRunId === input.runId
    && input.committed.projectId === input.projectId
    && input.committed.parentVersionId === (input.baseVersionId || null);
}

/** Explicit continuation is a new run with the saved material, not a retry that resets a ledger. */
export function reusableResearchSources(result: ColdStartBuildResult): import("@/lib/build/types").SourceInput[] {
  return result.sources.assets.filter(asset => asset.kind !== "user_brief").flatMap(asset => {
    const segments = result.sources.segments.filter(segment => segment.sourceId === asset.id).sort((a, b) => a.ordinal - b.ordinal);
    const content = segments.map(segment => segment.text).join("\n\n");
    const excerptType = segments.some(segment => segment.excerptType === "research_note") ? "research_note" as const : segments.some(segment => segment.excerptType === "close_paraphrase") ? "close_paraphrase" as const : undefined;
    const parts = [];
    for (let offset = 0; offset < content.length; offset += 60000) {
      const suffix = content.length > 60000 ? `（续读 ${offset / 60000 + 1}）` : "";
      parts.push({ ...asset, title: asset.title.slice(0, 220) + suffix, content: content.slice(offset, offset + 60000), excerptType });
    }
    return parts;
  });
}
