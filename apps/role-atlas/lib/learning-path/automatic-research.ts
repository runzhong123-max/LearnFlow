import { ensureAppSchema, getD1 } from '@/db';
import { getProjectVersionRecord } from '@/lib/versioning/commit';
import { bindJobActor } from '@/lib/access';
import type { LearnFlowIdentity } from '@/lib/integrations/learnflow/auth';
import { enqueueRoleJob, jobWorkerSecret } from '@/lib/jobs/dispatch';
import { openJobEnvelope } from '@/lib/jobs/dispatch-protocol';
import { AUTOMATIC_MOUNT_POLICY, type AutomaticMountResult } from './automatic-contract';
import { AutomaticMountError, requestAutomaticMount } from './automatic-client';
import { automaticRepairJobId, automaticRepairPlan, repairableMount } from './automatic-research-plan';
import { eligibleAutomaticRepair } from './automatic-schema';
import type { RolePackageRef } from './contract';

type MountSource = { id: string; project_id: string; conversation_id: string; project_version_id: string; snapshot_id: string;
  owner_subject_id: string; source_run_id: string; package_ref_json: string; result_json: string };
const joinMount = 'FROM role_learning_mounts m JOIN projects p ON p.id=m.project_id JOIN conversations c ON c.id=m.conversation_id';

/** Existing dispatcher invokes this after completing producers; no browser polling is required. */
export async function listPendingAutomaticMountResearch() {
  await ensureAppSchema(); const d1 = getD1(), now = new Date().toISOString();
  await d1.prepare(`UPDATE role_learning_repairs SET status=CASE WHEN (SELECT status FROM role_jobs j WHERE j.id=job_id)='completed' THEN 'completed' ELSE 'stopped' END,updated_at=?
    WHERE status IN ('queued','preparing') AND EXISTS(SELECT 1 FROM role_jobs j WHERE j.id=job_id AND j.status IN ('completed','failed','cancelled'))`).bind(now).run();
  await d1.prepare(`UPDATE role_learning_repairs SET status='stopped',error='对话版本、模式或项目归属已改变，自动补研已停止。',updated_at=?
    WHERE status IN ('pending','preparing') AND NOT EXISTS(SELECT 1 ${joinMount} WHERE m.id=origin_mount_id AND p.owner_subject_id=m.owner_subject_id AND p.deleted_at IS NULL AND c.version_id=m.project_version_id AND c.mode='iteration')`).bind(now).run();
  await d1.prepare(`UPDATE role_learning_repairs SET status='stopped',error='自动补研多次接续失败，已有岗位与挂载结果已保留。',lease_owner=NULL,lease_expires_at=NULL,updated_at=?
    WHERE attempt>=3 AND (status='pending' OR (status='preparing' AND lease_expires_at<=?))`).bind(now,now).run();
  const rows = await d1.prepare(`SELECT m.id,m.result_json ${joinMount} LEFT JOIN role_learning_repairs r ON r.origin_mount_id=m.id
    WHERE ${eligibleAutomaticRepair} AND (r.origin_mount_id IS NULL OR (r.attempt<3 AND (r.status='pending' OR (r.status='preparing' AND r.lease_expires_at<=?))))
    ORDER BY m.created_at LIMIT 4`).bind(now).all<{id: string; result_json: string}>();
  return rows.results.filter(row => {
    try { return repairableMount(JSON.parse(row.result_json) as AutomaticMountResult); } catch { return false; }
  }).map(row => row.id);
}

/** Only a mount ID is accepted. The actor, scope, targets, endpoint and provider inputs are read server-side. */
export async function enqueueLearningMountResearch(mountId: string) {
  await ensureAppSchema(); const d1 = getD1(), now = new Date().toISOString(), token = crypto.randomUUID();
  const mount = await d1.prepare(`SELECT m.* ${joinMount} WHERE m.id=? AND ${eligibleAutomaticRepair}`).bind(mountId).first<MountSource>();
  if (!mount || !repairableMount(JSON.parse(mount.result_json))) return { skipped: true };
  const jobId = await automaticRepairJobId(mountId);
  await d1.prepare(`INSERT OR IGNORE INTO role_learning_repairs(origin_mount_id,job_id,created_at,updated_at)
    SELECT m.id,?,?,? ${joinMount} WHERE m.id=? AND ${eligibleAutomaticRepair}`).bind(jobId,now,now,mountId).run();
  // A dropped response after enqueue is recovered from the one stable child job, not by starting another.
  const existing = await d1.prepare('SELECT id,status FROM role_jobs WHERE id=?').bind(jobId).first<{id:string;status:string}>();
  if (existing) {
    await d1.prepare("UPDATE role_learning_repairs SET status=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE origin_mount_id=?")
      .bind(existing.status === 'completed' ? 'completed' : ['failed','cancelled'].includes(existing.status) ? 'stopped' : 'queued',now,mountId).run();
    return { jobId, replay: true };
  }
  const claim = await d1.prepare(`UPDATE role_learning_repairs SET status='preparing',attempt=attempt+1,lease_owner=?,lease_expires_at=?,updated_at=?
    WHERE origin_mount_id=? AND attempt<3 AND (status='pending' OR (status='preparing' AND lease_expires_at<=?))
    AND EXISTS(SELECT 1 ${joinMount} WHERE m.id=origin_mount_id AND ${eligibleAutomaticRepair})`)
    .bind(token,new Date(Date.now()+90_000).toISOString(),now,mountId,now).run();
  if (!claim.meta.changes) return { skipped: true };
  try {
    const version = await getProjectVersionRecord(mount.project_id,mount.project_version_id);
    if (!version || version.snapshotId !== mount.snapshot_id) throw new AutomaticMountError('补研基线版本不一致。');
    const source = await d1.prepare(`SELECT j.id,j.input_json,d.actor_json,d.envelope FROM role_jobs j JOIN role_job_dispatch d ON d.job_id=j.id
      WHERE j.project_id=? AND j.conversation_id=? AND json_valid(d.actor_json) AND json_extract(d.actor_json,'$.subjectId')=?
      AND ((j.status='completed' AND (j.id=? OR (json_valid(j.result_json) AND json_extract(j.result_json,'$.projectVersionId')=?)))
        OR (j.status='failed' AND json_valid(j.result_json) AND json_type(j.result_json,'$.partial')='true'
          AND json_extract(j.result_json,'$.projectVersionId')=? AND json_extract(j.result_json,'$.snapshotId')=?))
      ORDER BY j.updated_at DESC LIMIT 1`)
      .bind(mount.project_id,mount.conversation_id,mount.owner_subject_id,mount.source_run_id,mount.project_version_id,mount.project_version_id,mount.snapshot_id)
      .first<{id:string;input_json:string;actor_json:string;envelope:string|null}>();
    if (!source) throw new AutomaticMountError('原生产任务的授权记录不可用，无法自动接续补研。');
    const actor = JSON.parse(source.actor_json) as LearnFlowIdentity;
    if (actor.issuer !== 'learnflow' || actor.subjectId !== mount.owner_subject_id || actor.subjectId !== `learnflow:learner:${actor.learnerId}`
      || !Number.isInteger(actor.accountId) || actor.accountId <= 0 || !['user','admin'].includes(actor.role)) throw new AutomaticMountError('原生产任务的身份记录无效。');
    // This replays the parent receipt while rechecking the real active central account and current private package permission.
    await requestAutomaticMount({ requestId:mount.id,packageRef:JSON.parse(mount.package_ref_json) as RolePackageRef,projectId:mount.project_id,
      projectVersionId:mount.project_version_id,sourceRunId:mount.source_run_id,policyVersion:AUTOMATIC_MOUNT_POLICY },
      {baseUrl:process.env.LEARNFLOW_BASE_URL || '',secret:jobWorkerSecret(),subject:mount.owner_subject_id});
    const body = automaticRepairPlan({mountId,jobId,projectId:mount.project_id,versionId:mount.project_version_id,conversationId:mount.conversation_id,
      result:version.result,mount:JSON.parse(mount.result_json),sourcePayload:JSON.parse(source.input_json)});
    if (!body) throw new AutomaticMountError('本轮没有可自动补研的缺口。');
    // Completed producers may have cleared their envelope. Existing routes resolve server-side configured providers in that case.
    const original = source.envelope ? await openJobEnvelope<Record<string,unknown>>(source.envelope,jobWorkerSecret(),source.id) : {};
    const executionBody = {...body,...(original.providerConfig ? {providerConfig:original.providerConfig} : {}),...(original.searchConfig ? {searchConfig:original.searchConfig} : {})};
    const request = new Request('http://localhost/api/snapshot-iterations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(executionBody)});
    bindJobActor(request,actor);
    const iteration = body.iteration;
    const response = await enqueueRoleJob(request,{id:jobId,projectId:mount.project_id,conversationId:mount.conversation_id,
      baseVersionId:mount.project_version_id,baseSnapshotId:mount.snapshot_id,kind:iteration.targetIds.length ? 'node_deepening' : 'snapshot_iteration',
      threadId:`${mount.snapshot_id}:${jobId}`,owner:token,phase:'contract',payload:{iteration}},executionBody,
      {forceDurable:true,insertionFence:{sql:`EXISTS(SELECT 1 FROM role_learning_repairs r JOIN role_learning_mounts m ON m.id=r.origin_mount_id
        JOIN projects p ON p.id=m.project_id JOIN conversations c ON c.id=m.conversation_id WHERE r.origin_mount_id=? AND r.lease_owner=? AND r.status='preparing' AND ${eligibleAutomaticRepair})`,bindings:[mountId,token]}});
    if (!response?.ok) throw new AutomaticMountError(response?.status === 409 ? '对话基线已改变或已有任务，自动补研已停止。' : '自动补研暂时无法入队。',Boolean(response && response.status>=500));
    await d1.prepare("UPDATE role_learning_repairs SET status='queued',source_job_id=?,lease_owner=NULL,lease_expires_at=NULL,error=NULL,updated_at=? WHERE origin_mount_id=? AND lease_owner=?")
      .bind(source.id,new Date().toISOString(),mountId,token).run();
    return {jobId};
  } catch (error) {
    const transient = !(error instanceof AutomaticMountError) || error.retryable;
    await d1.prepare("UPDATE role_learning_repairs SET status=CASE WHEN ?='pending' AND attempt>=3 THEN 'stopped' ELSE ? END,error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE origin_mount_id=? AND lease_owner=?")
      .bind(transient ? 'pending' : 'stopped', transient ? 'pending' : 'stopped', error instanceof AutomaticMountError ? error.message : '自动补研暂不可用，已有岗位与挂载回执已保留。',new Date().toISOString(),mountId,token).run();
    return {stopped:!transient};
  }
}
