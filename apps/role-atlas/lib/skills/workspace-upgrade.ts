import { z } from "zod/v4";
import { learningPathGraphInputSchema } from "@/lib/build/types";
import type { IterationOutcome } from "@/lib/jobs/iteration-outcome";
import { snapshotIterationRequestSchema } from "@/lib/iteration/types";
import type { SnapshotReference } from "@/lib/snapshots/types";
import type { WorkspaceAlignmentReport, WorkspaceIngestionResult } from "@/lib/workspaces/types";

export const workspaceUpgradeIterationSchema = z.object({
  prompt: z.string().max(4_000).default(""),
  targetAsOf: z.string().max(40).optional(),
  webResearch: z.boolean().default(true),
  learningPathGraph: learningPathGraphInputSchema,
  maxRounds: z.number().int().min(1).max(12).default(12),
  sourceLimit: z.number().int().min(4).max(64).default(64),
  maxWorkItems: z.number().int().min(3).max(32).default(32),
});

function hasContent(value?: string) {
  return Boolean(value?.replace(/\[REDACTED_[A-Z_]+\]/gu, "").trim());
}

/** Generated headings are not a work observation. Check its retained originals. */
export function usableWorkspaceObservations(result: WorkspaceIngestionResult) {
  const quarantined = new Set(result.quarantinedResourceIds);
  const resources = new Map(result.package.resources.filter(resource => !quarantined.has(resource.id)).map(resource => [resource.id, resource]));
  const events = new Map(result.package.events.map(event => [event.id, event]));
  return result.observations.filter(observation => {
    if (observation.source.kind !== "workspace_observation"
      || observation.source.workspaceEvidence?.workspacePackageId !== result.package.id) return false;
    const hasArtifact = observation.resourceIds.some(id => {
      const resource = resources.get(id);
      return resource && (hasContent(resource.summary) || hasContent(resource.content));
    });
    const hasEvent = observation.eventIds.some(id => {
      const event = events.get(id);
      return event && (hasContent(event.summary) || hasContent(event.outcome));
    });
    return hasArtifact || hasEvent;
  });
}

export function emptyWorkspaceUpgradeOutcome(result: WorkspaceIngestionResult): IterationOutcome {
  const message = result.observations.length
    ? "已读取工作区，但资料只有标题、占位内容或无法追溯的观察，尚不能支持岗位更新。请补充事件经过、处理结果或交付物正文。"
    : "已读取工作区，但没有提取到工作事件或交付物。请补充任务经过、处理结果或交付物正文。";
  return {
    status: "waiting_user", createdSnapshot: false,
    summary: [message, "工作区读取记录已保留，当前岗位版本保持不变。"], reasons: [message],
    remainingGapCount: 1, remainingGaps: [{ code: "WORKSPACE_NO_USABLE_OBSERVATIONS", title: "缺少可追溯的工作观察" }],
    work: { total: 1, completed: 0, unresolved: 1 },
    research: { queries: 0, selectedSources: 0, failures: 0 },
  };
}

export function workspaceIterationRequest(input: {
  runId: string; snapshotRef: SnapshotReference; projectId: string; conversationId: string;
  result: WorkspaceIngestionResult; alignment?: WorkspaceAlignmentReport;
  iteration: z.infer<typeof workspaceUpgradeIterationSchema>;
}) {
  const observations = usableWorkspaceObservations(input.result);
  if (!observations.length) throw new Error("WORKSPACE_NO_USABLE_OBSERVATIONS");
  const evidenceClasses = [...new Set(observations.map(item => item.source.workspaceEvidence?.evidenceClass).filter(Boolean))];
  const prompt = [
    input.iteration.prompt.trim().slice(0, 3_500) || "依据本轮工作区中的真实工作事件、对象与交付物实例化当前岗位快照。",
    "把能由资料直接支持的组织实例写入事理森林与证据层；只有得到岗位级证据时才提升为岗位共性。",
    "检查现有典型任务与实例事件是否对齐，保留冲突、未覆盖任务和候选新任务，不用单个工作区代表整个行业。",
    `资料真实性等级：${evidenceClasses.join("、") || input.result.package.evidenceClass}。`,
  ].join("\n").slice(0, 4_000);
  return snapshotIterationRequestSchema.parse({
    ...input.iteration, runId: input.runId, snapshotRef: input.snapshotRef, projectId: input.projectId,
    conversationId: input.conversationId, initiativeProfile: "co_guided", mode: "auto", prompt,
    targetIds: [...new Set(input.alignment?.alignments.flatMap(item => item.taskId ? [item.taskId] : []) || [])].slice(0, 60),
    supplementalSources: observations.map(observation => observation.source).slice(0, 20),
  });
}
