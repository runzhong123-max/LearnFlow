import { roleJobEventsQuery } from "./journal-query";
import { dispatchSchema } from "./dispatch-schema";
import { linkRunAttachments, archiveJobAttempt } from "@/lib/research-collection/store";
import { ensureAppSchema, getD1 } from "@/db";
import { loadLargeText, storeLargeText } from "@/db/large-text";
import { canonicalStringify } from "@/lib/versioning/canonical";
import { roleJobClaimStatements } from "./claim-transaction";
import { iterationRunBrief } from "@/lib/iteration/brief";
import { loadIterationOutcome, type IterationOutcome } from "./iteration-outcome";
import type { RoleJobCheckpoint, RoleJobDescriptor, RoleJobKind, RoleJobStatus } from "./runtime";

type RoleJobRow = {
  id: string;
  kind: RoleJobKind;
  thread_id: string;
  project_id: string | null;
  conversation_id: string | null;
  base_version_id: string | null;
  base_snapshot_id: string | null;
  status: RoleJobStatus;
  phase: string;
  attempt: number;
  input_json: string;
  checkpoint_json: string | null;
  result_json: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function isoAfter(milliseconds: number) {
  return new Date(Date.now() + milliseconds).toISOString();
}

function descriptor(row: RoleJobRow): RoleJobDescriptor {
  return {
    id: row.id,
    kind: row.kind,
    threadId: row.thread_id,
    projectId: row.project_id || undefined,
    conversationId: row.conversation_id || undefined,
    baseVersionId: row.base_version_id || undefined,
    baseSnapshotId: row.base_snapshot_id || undefined,
    status: row.status,
    phase: row.phase,
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as T; }
  catch { return undefined; }
}

export async function claimRoleJob(input: {
  id: string;
  kind: RoleJobKind;
  threadId: string;
  owner: string;
  projectId?: string;
  conversationId?: string;
  baseVersionId?: string;
  baseSnapshotId?: string;
  phase: string;
  payload?: unknown;
  leaseMs?: number;
}) {
  await ensureAppSchema();
  const d1 = getD1();
  const now = new Date().toISOString();
  const expiresAt = isoAfter(input.leaseMs || 45_000);
  if(input.projectId)await linkRunAttachments(input.projectId,input.id,input.payload,true);
  await archiveJobAttempt(input.id,input.projectId);
  await d1.batch(roleJobClaimStatements(d1, {
    ...input, now, expiresAt, payloadJson: canonicalStringify(input.payload || {}),
  }));
  const row = await d1.prepare("SELECT * FROM role_jobs WHERE id=?").bind(input.id).first<RoleJobRow>();
  const sameScope = row && row.project_id === (input.projectId || null) && row.conversation_id === (input.conversationId || null)
    && row.kind === input.kind && row.thread_id === input.threadId
    && row.base_snapshot_id === (input.baseSnapshotId || null) && row.base_version_id === (input.baseVersionId || null);
  if (row && !sameScope) throw new Error("JOB_SCOPE_CONFLICT");
  const claimed = Boolean(row && row.status === "running" && row.lease_owner === input.owner);
  if(claimed&&input.projectId){await linkRunAttachments(input.projectId,input.id,input.payload);await archiveJobAttempt(input.id,input.projectId);}
  const checkpointJson = row ? await loadLargeText(getD1(), { table: "role_jobs", id: row.id, column: "checkpoint_json" }, row.checkpoint_json) : null;
  return {
    claimed,
    job: row ? descriptor(row) : undefined,
    checkpoint: parseJson<RoleJobCheckpoint>(checkpointJson),
    leaseExpiresAt: row?.lease_expires_at || undefined,
  };
}

export async function renewRoleJobLease(jobId: string, owner: string, leaseMs = 45_000) {
  await ensureAppSchema();
  const now = new Date().toISOString();
  const expiresAt = isoAfter(leaseMs);
  await getD1().prepare(`UPDATE role_jobs SET lease_expires_at=?, updated_at=?
    WHERE id=? AND lease_owner=? AND status='running' AND lease_expires_at>?`).bind(expiresAt, now, jobId, owner, now).run();
  const row = await getD1().prepare("SELECT lease_owner, status FROM role_jobs WHERE id=? AND lease_expires_at>?").bind(jobId, now).first<{ lease_owner: string | null; status: RoleJobStatus }>();
  return Boolean(row?.lease_owner === owner && row.status === "running");
}

export async function checkpointRoleJob(input: {
  jobId: string;
  owner: string;
  kind: RoleJobKind;
  phase: string;
  state: unknown;
  leaseMs?: number;
}) {
  await ensureAppSchema();
  const now = new Date().toISOString();
  const row = await getD1().prepare("SELECT attempt FROM role_jobs WHERE id=? AND lease_owner=? AND status='running' AND lease_expires_at>?")
    .bind(input.jobId, input.owner, now).first<{ attempt: number }>();
  if (!row) return false;
  const savedAt = new Date().toISOString();
  const checkpoint: RoleJobCheckpoint = {
    jobId: input.jobId,
    kind: input.kind,
    phase: input.phase,
    attempt: row.attempt,
    state: input.state,
    savedAt,
  };
  const stored = await storeLargeText(getD1(), { table: "role_jobs", id: input.jobId, column: "checkpoint_json" }, JSON.stringify(checkpoint));
  const written = await getD1().prepare(`UPDATE role_jobs SET phase=?, checkpoint_json=?, lease_expires_at=?, updated_at=?
    WHERE id=? AND lease_owner=? AND status='running' AND lease_expires_at>?`)
    .bind(input.phase, stored, isoAfter(input.leaseMs || 45_000), savedAt, input.jobId, input.owner, savedAt).run();
  return Boolean(written.meta.changes);
}

export async function completeRoleJob(input: { jobId: string; owner: string; phase: string; result?: unknown }) {
  await ensureAppSchema();
  const now = new Date().toISOString();
  const stored = await storeLargeText(getD1(), { table: "role_jobs", id: input.jobId, column: "result_json" }, JSON.stringify(input.result || {}));
  await getD1().prepare(`UPDATE role_jobs SET status='completed', phase=?, result_json=?, lease_owner=NULL,
    lease_expires_at=NULL, error=NULL, completed_at=?, updated_at=?
    WHERE id=? AND lease_owner=? AND status='running' AND lease_expires_at>?`)
    .bind(input.phase, stored, now, now, input.jobId, input.owner, now).run();
  await archiveJobAttempt(input.jobId);
}

export async function failRoleJob(input: { jobId: string; owner: string; error: string; retryable: boolean; result?: unknown }) {
  await ensureAppSchema();
  const now = new Date().toISOString();
  const stored = input.result
    ? await storeLargeText(getD1(), { table: "role_jobs", id: input.jobId, column: "result_json" }, JSON.stringify(input.result))
    : null;
  await getD1().prepare(`UPDATE role_jobs SET status=?, lease_owner=NULL, lease_expires_at=NULL, error=?, result_json=COALESCE(?,result_json),
    completed_at=?, updated_at=? WHERE id=? AND lease_owner=? AND status='running'`)
    .bind("failed", input.error, stored, now, now, input.jobId, input.owner).run();
  await archiveJobAttempt(input.jobId);
}

export async function getRoleJob(jobId: string) {
  await ensureAppSchema();
  const row = await getD1().prepare("SELECT * FROM role_jobs WHERE id=?").bind(jobId).first<RoleJobRow>();
  if (!row) return null;
  await getD1().prepare(dispatchSchema).run();
  const recovery = await getD1().prepare("SELECT state,deliveries FROM role_job_dispatch WHERE job_id=?").bind(jobId).first<{ state: string; deliveries: number }>();
  const d1 = getD1();
  const jobOwner = { table: "role_jobs", id: row.id };
  const resultJson = await loadLargeText(d1, { ...jobOwner, column: "result_json" }, row.result_json);
  const checkpointJson = await loadLargeText(d1, { ...jobOwner, column: "checkpoint_json" }, row.checkpoint_json);
  const result = parseJson<{ outcome?: IterationOutcome }>(resultJson);
  const outcome = result?.outcome || await loadIterationOutcome({ id: row.id, projectId: row.project_id, kind: row.kind, status: row.status },
    async (id, projectId) => {
      const iteration = await d1.prepare("SELECT id,project_id,result_json FROM snapshot_iteration_runs WHERE id=? AND project_id=?")
        .bind(id, projectId).first<{ id: string; project_id: string | null; result_json: string | null }>();
      if (iteration) iteration.result_json = await loadLargeText(d1, { table: "snapshot_iteration_runs", id: iteration.id, column: "result_json" }, iteration.result_json);
      return iteration;
    });
  return {
    recovery: recovery || undefined,
    ...descriptor(row),
    iterationBrief: iterationRunBrief(parseJson<{ iteration?: unknown }>(row.input_json)?.iteration),
    checkpoint: parseJson<RoleJobCheckpoint>(checkpointJson),
    result: outcome ? { ...result, outcome } : result,
    leaseExpiresAt: row.lease_expires_at || undefined,
    error: row.error || undefined,
    completedAt: row.completed_at || undefined,
    resumable: row.status === "failed" || row.status === "queued" || (row.status === "running" && Boolean(row.lease_expires_at && row.lease_expires_at < new Date().toISOString())),
  };
}


export async function listRoleJobs(projectId: string, conversationId?: string) {
  await ensureAppSchema();
  const rows = await getD1().prepare(`SELECT id FROM role_jobs WHERE project_id=?
    AND (? IS NULL OR conversation_id=?) ORDER BY created_at DESC LIMIT 60`)
    .bind(projectId, conversationId || null, conversationId || null).all<{ id: string }>();
  return Promise.all(rows.results.map(row => getRoleJob(row.id)));
}

export async function appendRoleJobEvent(jobId: string, event: { runId: string; seq: number; kind: string }) {
  await ensureAppSchema();
  await getD1().prepare(`INSERT OR IGNORE INTO role_job_events(job_id,event_run_id,event_seq,kind,event_json)
    VALUES(?,?,?,?,?)`).bind(jobId, event.runId, event.seq, event.kind, JSON.stringify(event)).run();
}

export async function readRoleJobEvents(jobId: string, after = 0, progressOnly = false) {
  await ensureAppSchema();
  const rows = await getD1().prepare(roleJobEventsQuery(progressOnly)).bind(jobId, after).all<{ cursor: number; event_json: string }>();
  return { events: rows.results.flatMap(row => { const event = parseJson(row.event_json); return event ? [event] : []; }),
    cursor: rows.results.at(-1)?.cursor || after, hasMore: rows.results.length === 200 };
}

export async function cancelRoleJob(jobId: string, projectId: string) {
  await ensureAppSchema();
  const now = new Date().toISOString();
  await getD1().prepare(`UPDATE role_jobs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL,
    completed_at=?, updated_at=? WHERE id=? AND project_id=? AND status IN ('queued','running','waiting_user','failed')`)
    .bind(now, now, jobId, projectId).run();
  await archiveJobAttempt(jobId,projectId);
  return getRoleJob(jobId);
}

export async function assertRoleJobLease(jobId: string, owner: string) {
  await ensureAppSchema();
  const row = await getD1().prepare(`SELECT id FROM role_jobs WHERE id=? AND lease_owner=? AND status='running'
    AND lease_expires_at>?`).bind(jobId, owner, new Date().toISOString()).first();
  if (!row) throw new DOMException("任务已取消或执行租约失效", "AbortError");
}

export async function lastRoleEventSequence(jobId: string) {
  await ensureAppSchema();
  const row = await getD1().prepare(`SELECT MAX(event_seq) AS seq FROM role_job_events WHERE job_id=? AND event_seq<9007199254740991`).bind(jobId).first<{ seq: number | null }>();
  return row?.seq || 0;
}
