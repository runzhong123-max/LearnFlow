import { ensureAppSchema, getD1 } from "@/db";
import { bindJobActor, requestActor } from "@/lib/access";
import type { LearnFlowIdentity } from "@/lib/integrations/learnflow/auth";
import { canonicalStringify } from "@/lib/versioning/canonical";
import { roleJobClaimStatements } from "./claim-transaction";
import { dispatchSchema, eligibleDispatch } from "./dispatch-schema";
import { openJobEnvelope, sealJobEnvelope } from "./dispatch-protocol";
import { getRoleJob, type claimRoleJob } from "./repository";

type Claim = Parameters<typeof claimRoleJob>[0];
const executing = new WeakSet<Request>();
/** Internal identity is established by dispatchRequest, never by a caller-supplied header. */
export function isDispatchedRoleJob(request: Request) { return executing.has(request); }
export const jobWorkerSecret = () => process.env.ROLE_ATLAS_GATEWAY_SECRET || "";
export async function ensureJobDispatch() {
  await ensureAppSchema();
  await getD1().prepare(dispatchSchema).run();
}

/** Existing streaming API stays compatible; the workbench explicitly requests durable delivery. */
export async function enqueueRoleJob(request: Request, claim: Claim, body: unknown, options: { forceDurable?: boolean; insertionFence?: { sql: string; bindings: string[] } } = {}): Promise<Response | undefined> {
  if (executing.has(request) || (!options.forceDurable && request.headers.get("prefer") !== "respond-async")) return;
  if (jobWorkerSecret().length < 32) return Response.json({ error: "后台执行服务尚未配置，请联系管理员。" }, { status: 503 });
  await ensureJobDispatch();
  const actor = await requestActor(request);
  const now = new Date().toISOString();
  const payloadJson = canonicalStringify(claim.payload || {});
  const envelope = await sealJobEnvelope(body, jobWorkerSecret(), claim.id);
  const d1 = getD1();
  // Insert-only claim statement: keep the job queued until an independent consumer claims it.
  const insert = roleJobClaimStatements(d1, { ...claim, now, expiresAt: now, payloadJson, insertionFence: options.insertionFence })[1];
  await d1.batch([insert,
    d1.prepare(`INSERT OR IGNORE INTO role_job_dispatch(job_id,endpoint,actor_json,envelope,available_at,created_at,updated_at)
      SELECT id,?,?,?,?,?,? FROM role_jobs WHERE id=? AND project_id=? AND conversation_id=? AND input_json=? AND status='queued'`)
      .bind(new URL(request.url).pathname, JSON.stringify(actor), envelope, now, now, now, claim.id, claim.projectId, claim.conversationId, payloadJson),
  ]);
  const row = await d1.prepare(`SELECT j.id FROM role_jobs j JOIN role_job_dispatch d ON d.job_id=j.id
    WHERE j.id=? AND j.project_id=? AND j.conversation_id=? AND j.input_json=?`).bind(claim.id, claim.projectId, claim.conversationId, payloadJson).first();
  if (!row) return Response.json({ error: "当前对话已有任务，或任务基线已改变。请查看任务状态。" }, { status: 409 });
  return Response.json({ accepted: true, job: await getRoleJob(claim.id) }, { status: 202, headers: { "cache-control": "no-store" } });
}

export async function listDispatchableJobs() {
  await ensureJobDispatch();
  const now = new Date().toISOString();
  await queueCompletedBuildFollowups();
  // Clear credentials after terminal state and stop bounded recovery after repeated executor loss.
  await getD1().batch([
    // Reconcile a completed version write after worker loss instead of regenerating it.
    getD1().prepare(`UPDATE role_jobs SET status='completed',phase='completed',lease_owner=NULL,lease_expires_at=NULL,error=NULL,completed_at=?,updated_at=?,
      result_json=(SELECT json_object('candidateSnapshotId',v.snapshot_id,'projectVersionId',v.id,'appliedToHead',CASE WHEN p.head_version_id=v.id THEN json('true') ELSE json('false') END)
        FROM project_versions v JOIN projects p ON p.id=v.project_id WHERE v.project_id=role_jobs.project_id AND v.source_run_id=role_jobs.id ORDER BY v.created_at DESC LIMIT 1)
      WHERE kind IN ('snapshot_iteration','node_deepening') AND (status='failed' OR (status='running' AND lease_expires_at<=?))
      AND EXISTS(SELECT 1 FROM project_versions v WHERE v.project_id=role_jobs.project_id AND v.source_run_id=role_jobs.id)`)
      .bind(now,now,now),
    getD1().prepare(`UPDATE role_jobs SET status='failed',error='项目已删除或对话基线已改变，自动恢复已停止；已有版本保留。',lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE id IN (SELECT job_id FROM role_job_dispatch) AND (status='queued' OR (status='running' AND lease_expires_at<=?))
      AND NOT EXISTS(SELECT 1 FROM projects p JOIN conversations c ON c.project_id=p.id WHERE p.id=role_jobs.project_id AND c.id=role_jobs.conversation_id AND p.deleted_at IS NULL AND c.mode='iteration' AND c.version_id IS role_jobs.base_version_id AND p.owner_subject_id=(SELECT json_extract(actor_json,'$.subjectId') FROM role_job_dispatch WHERE job_id=role_jobs.id))`)
      .bind(now,now),
    getD1().prepare(`UPDATE role_jobs SET status='failed',error='后台执行多次中断，已保留检查点；请查看记录后继续。',lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE id IN (SELECT job_id FROM role_job_dispatch WHERE deliveries>=3 AND claimed_until<=?) AND (status='queued' OR (status='running' AND lease_expires_at<=?))`).bind(now, now, now),
    getD1().prepare(`UPDATE role_job_dispatch SET state='failed',updated_at=? WHERE state!='failed' AND job_id IN (SELECT id FROM role_jobs WHERE status='failed')`).bind(now),
    getD1().prepare(`UPDATE role_job_dispatch SET envelope=NULL WHERE state='failed' AND updated_at<?`).bind(new Date(Date.now()-86_400_000).toISOString()),
    getD1().prepare(`UPDATE role_job_dispatch SET state='done',envelope=NULL,updated_at=? WHERE job_id IN
      (SELECT id FROM role_jobs WHERE status IN ('completed','cancelled'))`).bind(now),
  ]);
  const rows = await getD1().prepare(`SELECT d.job_id FROM role_job_dispatch d JOIN role_jobs j ON j.id=d.job_id
    JOIN projects p ON p.id=j.project_id JOIN conversations c ON c.id=j.conversation_id
    WHERE ${eligibleDispatch} ORDER BY d.created_at LIMIT 8`).bind(now, now, now).all<{ job_id: string }>();
  return rows.results.map(row => row.job_id);
}

export async function claimDispatch(jobId: string) {
  await ensureJobDispatch();
  const now = new Date().toISOString(), token = crypto.randomUUID();
  await getD1().prepare(`UPDATE role_job_dispatch SET state='active',deliveries=deliveries+1,token=?,claimed_until=?,updated_at=?
    WHERE job_id=? AND job_id IN (SELECT d.job_id FROM role_job_dispatch d JOIN role_jobs j ON j.id=d.job_id
      JOIN projects p ON p.id=j.project_id JOIN conversations c ON c.id=j.conversation_id WHERE ${eligibleDispatch})`)
    .bind(token, new Date(Date.now()+120_000).toISOString(), now, jobId, now, now, now).run();
  const row = await getD1().prepare(`SELECT * FROM role_job_dispatch WHERE job_id=? AND token=?`).bind(jobId, token)
    .first<{ endpoint: string; actor_json: string; envelope: string }>();
  if (!row) return null;
  return { ...row, token };
}

export async function dispatchRequest(jobId: string, row: { endpoint: string; actor_json: string; envelope: string }) {
  const body = await openJobEnvelope<unknown>(row.envelope, jobWorkerSecret(), jobId);
  const request = new Request(`http://localhost${row.endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  bindJobActor(request, JSON.parse(row.actor_json) as LearnFlowIdentity);
  executing.add(request);
  return request;
}

export async function settleDispatch(jobId: string, token: string, error?: string) {
  const now = new Date().toISOString();
  // A response rejected before acquiring the job lease must not leave an eternal queued record.
  if (error) await getD1().prepare(`UPDATE role_jobs SET status='failed',error=?,updated_at=? WHERE id=? AND (status='queued' OR (status='running' AND lease_expires_at<=?))
    AND EXISTS(SELECT 1 FROM role_job_dispatch WHERE job_id=? AND token=?)`).bind(error,now,jobId,now,jobId,token).run();
  await getD1().prepare(`UPDATE role_job_dispatch SET claimed_until=?,updated_at=?,error=? WHERE job_id=? AND token=?`)
    .bind(new Date(Date.now()+20_000).toISOString(),now,error || null,jobId,token).run();
}

/** Explicit recovery also covers legacy jobs created before the durable queue existed. */
export async function resumeRoleJob(request: Request, jobId: string, projectId: string) {
  await ensureJobDispatch();
  if (jobWorkerSecret().length < 32) return Response.json({ error: "后台执行服务尚未配置。" }, { status: 503 });
  const job = await getRoleJob(jobId);
  if (!job || job.projectId !== projectId || !job.resumable) return Response.json({ error: "此任务不可恢复，或仍在运行。" }, { status: 409 });
  const row = await getD1().prepare("SELECT input_json,kind FROM role_jobs WHERE id=?").bind(jobId).first<{ input_json: string; kind: string }>();
  if (!row) return Response.json({ error: "任务不存在。" }, { status: 404 });
  const payload = JSON.parse(row.input_json) as Record<string, unknown>;
  const endpoint = row.kind === "cold_start" ? (payload.baseSnapshotId ? "/api/build-runs/enrich" : "/api/build-runs")
    : row.kind === "workspace_instantiation" ? "/api/workspace-upgrades" : "/api/snapshot-iterations";
  const actor = await requestActor(request), now = new Date().toISOString();
  // Legacy records contain no keys. Explicit retry uses the currently configured server providers.
  const stored = await getD1().prepare("SELECT envelope FROM role_job_dispatch WHERE job_id=?").bind(jobId).first<{ envelope: string | null }>();
  const envelope = stored?.envelope || await sealJobEnvelope(payload, jobWorkerSecret(), jobId);
  const token = crypto.randomUUID();
  await getD1().batch([
    getD1().prepare(`UPDATE role_jobs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,error=NULL,completed_at=NULL,updated_at=? WHERE id=? AND project_id=?
      AND (status='failed' OR (status='running' AND lease_expires_at<=?))
      AND EXISTS(SELECT 1 FROM conversations c WHERE c.id=role_jobs.conversation_id AND c.mode='iteration' AND c.version_id IS role_jobs.base_version_id)
      AND NOT EXISTS(SELECT 1 FROM role_jobs other WHERE other.conversation_id=role_jobs.conversation_id AND other.id!=role_jobs.id AND other.status IN ('running','queued','waiting_user'))`)
      .bind(now,jobId,projectId,now),
    getD1().prepare(`INSERT INTO role_job_dispatch(job_id,endpoint,actor_json,envelope,available_at,created_at,updated_at,token)
      SELECT id,?,?,?,?,?,?,? FROM role_jobs WHERE id=? AND status='queued' AND updated_at=?
      ON CONFLICT(job_id) DO UPDATE SET envelope=excluded.envelope,actor_json=excluded.actor_json,state='ready',deliveries=0,claimed_until=NULL,available_at=excluded.available_at,updated_at=excluded.updated_at,token=excluded.token`)
      .bind(endpoint,JSON.stringify(actor),envelope,now,now,now,token,jobId,now),
  ]);
  const accepted = await getD1().prepare("SELECT job_id FROM role_job_dispatch WHERE job_id=? AND token=?").bind(jobId,token).first();
  return Response.json(accepted ? { accepted: true, job: await getRoleJob(jobId) } : { error: "对话基线已改变或已有任务运行，请在新对话中继续研究。" }, { status: accepted ? 202 : 409 });
}

async function queueCompletedBuildFollowups() {
  const rows = await getD1().prepare(`SELECT d.*,j.project_id,j.conversation_id,j.result_json FROM role_job_dispatch d JOIN role_jobs j ON j.id=d.job_id
    WHERE d.endpoint='/api/build-runs' AND d.envelope IS NOT NULL AND j.status='completed' LIMIT 8`)
    .all<{ job_id: string; actor_json: string; envelope: string; project_id: string; conversation_id: string; result_json: string }>();
  for (const row of rows.results) {
    try {
    const result = JSON.parse(row.result_json) as { candidateSnapshotId?: string };
    if (!result.candidateSnapshotId) continue;
    const body = await openJobEnvelope<Record<string, unknown>>(row.envelope,jobWorkerSecret(),row.job_id);
    const build = body.build as Record<string, unknown>;
    const replay = new Request("http://localhost/api/build-runs/enrich", { method: "POST", headers: { "content-type": "application/json", prefer: "respond-async" }, body: JSON.stringify({
      ...body, build: { ...build, runId: `${row.job_id}:enrichment`, sources: [] }, baseSnapshotId: result.candidateSnapshotId,
    }) });
    bindJobActor(replay,JSON.parse(row.actor_json) as LearnFlowIdentity);
    const response = await (await import("@/app/api/build-runs/enrich/route")).POST(replay);
    if (response.status >= 500) throw new Error("BUILD_FOLLOWUP_UNAVAILABLE");
    // A changed/closed conversation is a real stop condition; don't silently move its baseline.
    if (!response.ok) await getD1().prepare("UPDATE role_job_dispatch SET error=? WHERE job_id=?")
      .bind("岗位内核已保存；后续研究未接续，请核对对话版本与配置。",row.job_id).run();
    } catch {
      await getD1().prepare("UPDATE role_job_dispatch SET error=? WHERE job_id=?").bind("后续研究接续失败，请检查后台配置。",row.job_id).run();
    }
  }
}
