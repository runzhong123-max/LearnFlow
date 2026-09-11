import { and, sql, asc, desc, eq } from "drizzle-orm";
import { ensureAppSchema, getD1, getDb } from "@/db";
import { loadLargeText, storeLargeText } from "@/db/large-text";
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
  const stored = await storeLargeText(getD1(), { table: "workspace_ingestion_runs", id: runId, column: "checkpoint_json" }, JSON.stringify(checkpoint));
  await db.update(workspaceIngestionRuns).set({
    phase,
    checkpointJson: stored,
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
  const d1 = getD1();
  const storedResult = await storeLargeText(d1, { table: "workspace_ingestion_runs", id: input.runId, column: "result_json" }, JSON.stringify(input.result));
  const storedAlignment = input.alignment
    ? await storeLargeText(d1, { table: "workspace_ingestion_runs", id: input.runId, column: "alignment_json" }, JSON.stringify(input.alignment))
    : null;
  const db = getDb();
  await db.update(workspaceIngestionRuns).set({
    status: "completed",
    phase: input.iterationRunId ? "iterate" : "complete",
    packageId: input.result.package.id,
    iterationRunId: input.iterationRunId,
    resultJson: storedResult,
    alignmentJson: storedAlignment,
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
  const d1 = getD1();
  const resultJson = await loadLargeText(d1, { table: "workspace_ingestion_runs", id: run.id, column: "result_json" }, run.resultJson);
  const alignmentJson = await loadLargeText(d1, { table: "workspace_ingestion_runs", id: run.id, column: "alignment_json" }, run.alignmentJson);
  const events = await db.select().from(workspaceIngestionEvents)
    .where(eq(workspaceIngestionEvents.runId, run.id)).orderBy(asc(workspaceIngestionEvents.seq));
  return {
    ...run,
    result: resultJson ? JSON.parse(resultJson) as WorkspaceIngestionResult : null,
    alignment: alignmentJson ? JSON.parse(alignmentJson) as WorkspaceAlignmentReport : null,
    events: events.flatMap((event) => {
      try { return [JSON.parse(event.eventJson) as WorkspaceRunEvent]; }
      catch { return []; }
    }),
  };
}
