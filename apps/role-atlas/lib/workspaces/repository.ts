import { and, sql, asc, desc, eq } from "drizzle-orm";
import { ensureAppSchema, getDb } from "@/db";
import { workspaceIngestionEvents, workspaceIngestionRuns } from "@/db/schema";
import type { WorkspaceRunEvent } from "./events";
import type {
  WorkspaceAlignmentReport,
  WorkspaceIngestionRequest,
  WorkspaceIngestionResult,
} from "./types";

export async function startWorkspaceIngestion(input: {
  request: WorkspaceIngestionRequest;
  baseSnapshotId?: string;
}) {
  await ensureAppSchema();
  const db = getDb();
  await db.insert(workspaceIngestionRuns).values({
    id: input.request.runId,
    projectId: input.request.projectId,
    baseSnapshotId: input.baseSnapshotId,
    adapterId: input.request.connection.adapterId,
    status: "running",
    phase: "register",
    inputJson: JSON.stringify(input.request),
  }).onConflictDoUpdate({
    target: workspaceIngestionRuns.id,
    set: {
      projectId: input.request.projectId,
      baseSnapshotId: input.baseSnapshotId,
      adapterId: input.request.connection.adapterId,
      packageId: null,
      iterationRunId: null,
      status: "running",
      phase: "register",
      inputJson: JSON.stringify(input.request),
      error: null,
      completedAt: null,
    },
    setWhere: and(eq(workspaceIngestionRuns.projectId, input.request.projectId || ""), eq(workspaceIngestionRuns.baseSnapshotId, input.baseSnapshotId || ""), eq(workspaceIngestionRuns.status, "failed")),
  });
}

export async function appendWorkspaceEvent(event: WorkspaceRunEvent) {
  await ensureAppSchema();
  const db = getDb();
  await db.insert(workspaceIngestionEvents).values({
    runId: event.runId,
    seq: event.seq,
    kind: event.kind,
    eventJson: JSON.stringify(event),
  }).onConflictDoNothing();
}

export async function saveWorkspaceCheckpoint(runId: string, phase: string, checkpoint: unknown) {
  await ensureAppSchema();
  const db = getDb();
  const packageId = checkpoint && typeof checkpoint === "object" && "packageId" in checkpoint
    ? String((checkpoint as { packageId?: unknown }).packageId || "") || null
    : undefined;
  await db.update(workspaceIngestionRuns).set({
    phase,
    checkpointJson: JSON.stringify(checkpoint),
    ...(packageId !== undefined ? { packageId } : {}),
  }).where(eq(workspaceIngestionRuns.id, runId));
}

export async function completeWorkspaceIngestion(input: {
  runId: string;
  result: WorkspaceIngestionResult;
  alignment?: WorkspaceAlignmentReport;
  iterationRunId?: string;
}) {
  await ensureAppSchema();
  const db = getDb();
  await db.update(workspaceIngestionRuns).set({
    status: "completed",
    phase: input.iterationRunId ? "iterate" : "complete",
    packageId: input.result.package.id,
    iterationRunId: input.iterationRunId,
    resultJson: JSON.stringify(input.result),
    alignmentJson: input.alignment ? JSON.stringify(input.alignment) : null,
    completedAt: new Date().toISOString(),
  }).where(eq(workspaceIngestionRuns.id, input.runId));
}

export async function failWorkspaceIngestion(runId: string, error: string, cancelled = false) {
  await ensureAppSchema();
  const db = getDb();
  await db.update(workspaceIngestionRuns).set({
    status: cancelled ? "cancelled" : "failed",
    error,
    completedAt: new Date().toISOString(),
  }).where(and(eq(workspaceIngestionRuns.id, runId), eq(workspaceIngestionRuns.status, "running")));
}

export async function getLatestWorkspaceIngestion(input: { projectId?: string; snapshotId?: string; ownerSubjectId?: string }) {
  await ensureAppSchema();
  const db = getDb();
  const condition = input.projectId
    ? eq(workspaceIngestionRuns.projectId, input.projectId)
    : input.snapshotId
      ? eq(workspaceIngestionRuns.baseSnapshotId, input.snapshotId)
      : undefined;
  if (!condition) return null;
  const [run] = await db.select().from(workspaceIngestionRuns).where(and(condition, input.ownerSubjectId ? sql`EXISTS (SELECT 1 FROM projects p WHERE p.id=${workspaceIngestionRuns.projectId} AND p.owner_subject_id=${input.ownerSubjectId} AND p.deleted_at IS NULL)` : undefined))
    .orderBy(desc(workspaceIngestionRuns.startedAt)).limit(1);
  if (!run) return null;
  const events = await db.select().from(workspaceIngestionEvents)
    .where(eq(workspaceIngestionEvents.runId, run.id)).orderBy(asc(workspaceIngestionEvents.seq));
  return {
    ...run,
    result: run.resultJson ? JSON.parse(run.resultJson) as WorkspaceIngestionResult : null,
    alignment: run.alignmentJson ? JSON.parse(run.alignmentJson) as WorkspaceAlignmentReport : null,
    events: events.flatMap((event) => {
      try { return [JSON.parse(event.eventJson) as WorkspaceRunEvent]; }
      catch { return []; }
    }),
  };
}
