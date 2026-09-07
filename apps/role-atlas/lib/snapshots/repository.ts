import { and, sql, asc, desc, eq } from "drizzle-orm";
import { ensureAppSchema, getD1, getDb } from "@/db";
import { snapshotRiskEvents, snapshotRiskRuns, snapshotVersions } from "@/db/schema";
import type { ColdStartBuildResult } from "@/lib/build/types";
import { normalizeRolePackage } from "@/lib/packages/role-package-manifest";
import type { RiskEvent, RiskRunRequest, RiskRunResult } from "@/lib/risk/types";
import { commitStaticSnapshot } from "@/lib/versioning/commit";

export async function getStoredSnapshot(snapshotId: string) {
  await ensureAppSchema();
  const db = getDb();
  const [row] = await db.select().from(snapshotVersions).where(eq(snapshotVersions.snapshotId, snapshotId)).limit(1);
  if (!row) return null;
  try { return { row, result: normalizeRolePackage(JSON.parse(row.packageJson) as ColdStartBuildResult) }; }
  catch { return null; }
}

export async function startSnapshotRiskRun(request: RiskRunRequest) {
  await ensureAppSchema();
  const db = getDb();
  await db.insert(snapshotRiskRuns).values({
    id: request.runId,
    baseSnapshotId: request.snapshotRef.snapshotId,
    projectId: request.snapshotRef.projectId || request.projectId,
    projectVersionId: request.snapshotRef.versionId,
    status: "running",
    mode: request.mode,
    phase: "snapshot",
    inputJson: JSON.stringify(request),
  }).onConflictDoUpdate({
    target: snapshotRiskRuns.id,
    set: {
      status: "running",
      mode: request.mode,
      phase: "snapshot",
      inputJson: JSON.stringify(request),
      checkpointJson: null,
      resultJson: null,
      error: null,
      completedAt: null,
    },
  });
}

export async function appendSnapshotRiskEvent(event: RiskEvent) {
  await ensureAppSchema();
  const db = getDb();
  await db.insert(snapshotRiskEvents).values({
    runId: event.runId,
    snapshotId: event.snapshotId,
    seq: event.seq,
    kind: event.kind,
    eventJson: JSON.stringify(event),
  }).onConflictDoNothing();
}

export async function saveSnapshotRiskCheckpoint(runId: string, phase: string, checkpoint: unknown) {
  await ensureAppSchema();
  const db = getDb();
  await db.update(snapshotRiskRuns).set({ phase, checkpointJson: JSON.stringify(checkpoint) }).where(eq(snapshotRiskRuns.id, runId));
}

export async function completeSnapshotRiskRun(result: RiskRunResult) {
  await ensureAppSchema();
  const d1 = getD1();
  const now = new Date().toISOString();
  if (result.improved) result.candidateVersionId = result.candidate.snapshot.id;
  const statements = [
    d1.prepare("UPDATE snapshot_risk_runs SET status=?, phase='version', candidate_snapshot_id=?, result_json=?, completed_at=? WHERE id=?")
      .bind(result.status === "no_improvement" ? "no_improvement" : "completed", result.improved ? result.candidate.snapshot.id : null, JSON.stringify(result), now, result.runId),
  ];
  if (result.improved) {
    await commitStaticSnapshot({ result: result.candidate, parentSnapshotId: result.baseSnapshotId, sourceRunId: result.runId });
  }
  await d1.batch(statements);
  return result.improved ? result.candidate.snapshot.id : null;
}

export async function failSnapshotRiskRun(runId: string, error: string, cancelled = false) {
  await ensureAppSchema();
  const db = getDb();
  await db.update(snapshotRiskRuns).set({
    status: cancelled ? "cancelled" : "failed",
    error,
    completedAt: new Date().toISOString(),
  }).where(eq(snapshotRiskRuns.id, runId));
}

export async function getLatestSnapshotRiskRun(snapshotId: string, ownerSubjectId?: string) {
  await ensureAppSchema();
  const db = getDb();
  const [run] = await db.select().from(snapshotRiskRuns)
    .where(and(eq(snapshotRiskRuns.baseSnapshotId, snapshotId), ownerSubjectId ? sql`EXISTS (SELECT 1 FROM projects p WHERE p.id=${snapshotRiskRuns.projectId} AND p.owner_subject_id=${ownerSubjectId} AND p.deleted_at IS NULL)` : undefined))
    .orderBy(desc(snapshotRiskRuns.startedAt)).limit(1);
  if (!run) return null;
  const events = await db.select().from(snapshotRiskEvents)
    .where(eq(snapshotRiskEvents.runId, run.id)).orderBy(asc(snapshotRiskEvents.seq));
  return {
    ...run,
    result: run.resultJson ? JSON.parse(run.resultJson) as RiskRunResult : null,
    events: events.flatMap((event) => {
      try { return [JSON.parse(event.eventJson) as RiskEvent]; }
      catch { return []; }
    }),
  };
}
