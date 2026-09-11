/**
 * Deterministic reaper for snapshot-iteration runs whose executor died.
 *
 * Iteration runs execute inside the role-atlas process (route handlers and the
 * job-worker's automatic follow-ups). A deploy or crash kills the executor but
 * leaves the run row in status='running' forever, so the UI keeps showing
 * "正在研究" for work nobody performs. Role jobs already carry leases and a
 * resumable/interrupted presentation; iteration runs have no lease column, so
 * this module derives liveness from two deterministic signals:
 *
 *   1. A valid lease on the run's own role job (route-driven runs use the run
 *      id as the job id) or on its parent job (automatic follow-ups derive
 *      their id as `<parentJobId>:deep` / `<parentJobId>:repair`) proves a live
 *      executor. Those runs are never reaped, however long they take.
 *   2. Without a live executor, a run is interrupted when its related job is
 *      terminal (failed/cancelled/completed) or when no iteration event has
 *      been appended for ITERATION_RUN_STALE_AFTER_MS (falling back to
 *      started_at for runs that never emitted an event).
 *
 * Reaped runs keep their events, checkpoint and partial results; the status
 * becomes 'interrupted' so startSnapshotIteration can revive them on retry.
 * The update is guarded by status='running', so repeated calls are idempotent.
 */

export const ITERATION_RUN_STALE_AFTER_MS = 90 * 60 * 1000;
export const ITERATION_INTERRUPTED_ERROR = "运行中断：执行进程已重启，已有成果已保留，可重试";

export type IterationRunLease = { status: string; leaseExpiresAt: string | null };
export const ITERATION_TERMINAL_JOB_STATUSES = new Set(["failed", "cancelled", "completed"]);

/** Automatic follow-up runs derive their id from the parent job: `<jobId>:deep` / `<jobId>:repair`. */
export function iterationParentRunId(runId: string): string | null {
  const index = runId.lastIndexOf(":");
  return index > 0 ? runId.slice(0, index) : null;
}

/** SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC) and ISO strings both appear in started_at/created_at. */
export function parseActivityTime(value: string): number | null {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasLiveExecutor(job: IterationRunLease | undefined, nowIso: string): boolean {
  return Boolean(job && job.status === "running" && job.leaseExpiresAt && job.leaseExpiresAt > nowIso);
}

export function interruptedIterationRunIds(input: {
  runs: { id: string; startedAt: string }[];
  jobs: Map<string, IterationRunLease>;
  lastEventAt: Map<string, string>;
  now?: Date;
  staleAfterMs?: number;
}): string[] {
  const now = input.now || new Date();
  const nowIso = now.toISOString();
  const staleAfterMs = input.staleAfterMs ?? ITERATION_RUN_STALE_AFTER_MS;
  const interrupted: string[] = [];
  for (const run of input.runs) {
    const ownJob = input.jobs.get(run.id);
    const parentId = iterationParentRunId(run.id);
    const parentJob = parentId ? input.jobs.get(parentId) : undefined;
    if (hasLiveExecutor(ownJob, nowIso) || hasLiveExecutor(parentJob, nowIso)) continue;
    const related = ownJob || parentJob;
    if (related && ITERATION_TERMINAL_JOB_STATUSES.has(related.status)) {
      interrupted.push(run.id);
      continue;
    }
    const activityMs = parseActivityTime(input.lastEventAt.get(run.id) || run.startedAt);
    if (activityMs !== null && now.getTime() - activityMs > staleAfterMs) interrupted.push(run.id);
  }
  return interrupted;
}

/**
 * Interrupt stale runs in place and return the affected ids. Safe to call on
 * any read path: runs with a live executor lease are untouched and the UPDATE
 * only matches rows still marked 'running'.
 */
export async function reapInterruptedSnapshotIterations(db: D1Database, now = new Date()): Promise<string[]> {
  const running = (await db.prepare("SELECT id, started_at FROM snapshot_iteration_runs WHERE status='running'")
    .all<{ id: string; started_at: string }>()).results;
  if (!running.length) return [];
  const related = new Set<string>();
  for (const run of running) {
    related.add(run.id);
    const parent = iterationParentRunId(run.id);
    if (parent) related.add(parent);
  }
  const relatedIds = [...related];
  const jobRows = (await db.prepare(
    `SELECT id, status, lease_expires_at AS leaseExpiresAt FROM role_jobs WHERE id IN (${relatedIds.map(() => "?").join(",")})`,
  ).bind(...relatedIds).all<{ id: string; status: string; leaseExpiresAt: string | null }>()).results;
  const jobs = new Map(jobRows.map((row) => [row.id, { status: row.status, leaseExpiresAt: row.leaseExpiresAt }]));
  const runIds = running.map((run) => run.id);
  const eventRows = (await db.prepare(
    `SELECT run_id AS runId, MAX(created_at) AS lastAt FROM snapshot_iteration_events WHERE run_id IN (${runIds.map(() => "?").join(",")}) GROUP BY run_id`,
  ).bind(...runIds).all<{ runId: string; lastAt: string }>()).results;
  const lastEventAt = new Map(eventRows.map((row) => [row.runId, row.lastAt]));
  const interrupted = interruptedIterationRunIds({
    runs: running.map((run) => ({ id: run.id, startedAt: run.started_at })),
    jobs,
    lastEventAt,
    now,
  });
  for (const id of interrupted) {
    await db.prepare("UPDATE snapshot_iteration_runs SET status='interrupted', error=?, completed_at=? WHERE id=? AND status='running'")
      .bind(ITERATION_INTERRUPTED_ERROR, now.toISOString(), id).run();
  }
  return interrupted;
}
