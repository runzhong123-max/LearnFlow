import { ensureAppSchema, getD1 } from "@/db";
import { prepareRelease } from "@/lib/releases/service";
import { getPackageArtifact } from "@/lib/packages/artifact-store";
import { AUTOMATIC_MOUNT_POLICY, learningMountFeedback, type AutomaticMountRecord, type AutomaticMountResult } from "./automatic-contract";
import { automaticMountEnqueueStatement, eligibleAutomaticMount, supersedeAutomaticMounts } from "./automatic-schema";
import { AutomaticMountError, requestAutomaticMount } from "./automatic-client";
import type { RolePackageRef } from "./contract";
import { sha256Hex } from "@/lib/versioning/canonical";

type MountRow = { id: string; conversation_id: string | null; project_id: string; project_version_id: string; snapshot_id: string; owner_subject_id: string; source_run_id: string; status: AutomaticMountRecord["status"]; attempt: number; package_ref_json: string | null; result_json: string | null; error: string | null };
const toRecord = (row: MountRow): AutomaticMountRecord => ({ id: row.id, projectVersionId: row.project_version_id, snapshotId: row.snapshot_id,
  status: row.status, attempt: row.attempt, ...(row.result_json ? { result: JSON.parse(row.result_json) as AutomaticMountResult } : {}), ...(row.error ? { error: row.error } : {}) });

export async function readAutomaticMount(projectId: string, projectVersionId: string): Promise<AutomaticMountRecord | null> {
  await ensureAppSchema();
  const row = await getD1().prepare("SELECT m.* FROM role_learning_mounts m JOIN projects p ON p.id=m.project_id WHERE m.project_id=? AND m.project_version_id=? AND m.policy_version=? AND p.owner_subject_id=m.owner_subject_id AND p.deleted_at IS NULL")
    .bind(projectId, projectVersionId, AUTOMATIC_MOUNT_POLICY).first<MountRow>();
  return row ? toRecord(row) : null;
}
/** Consumed by the next research run; only operational gaps, never learner evidence. */
export async function readAutomaticMountResearchFeedback(projectId: string, versionId: string) {
  return learningMountFeedback(await readAutomaticMount(projectId, versionId));
}
export async function retryAutomaticMount(projectId: string, projectVersionId: string) {
  await ensureAppSchema(); const now = new Date().toISOString();
  await getD1().batch([automaticMountEnqueueStatement(getD1(), { projectId, versionId: projectVersionId, now }),
    getD1().prepare("UPDATE role_learning_mounts SET status='queued',attempt=0,error=NULL,available_at=?,updated_at=? WHERE project_id=? AND project_version_id=? AND status IN ('failed','retry')")
      .bind(now, now, projectId, projectVersionId)]);
  return readAutomaticMount(projectId, projectVersionId);
}
export async function listAutomaticMounts() {
  await ensureAppSchema(); const now = new Date().toISOString();
  await getD1().prepare(supersedeAutomaticMounts).bind(now).run();
  const rows = await getD1().prepare(`SELECT m.id FROM role_learning_mounts m JOIN projects p ON p.id=m.project_id JOIN project_versions v ON v.id=m.project_version_id
    WHERE ${eligibleAutomaticMount} ORDER BY m.created_at,m.id LIMIT 8`).bind(now, now).all<{ id: string }>();
  return rows.results.map(row => row.id);
}

export async function executeAutomaticMount(id: string) {
  await ensureAppSchema(); const d1 = getD1(), lease = crypto.randomUUID(), now = new Date().toISOString();
  const claim = await d1.prepare(`UPDATE role_learning_mounts SET status='running',attempt=attempt+1,lease_owner=?,lease_expires_at=?,updated_at=?,error=NULL
    WHERE id=? AND id IN (SELECT m.id FROM role_learning_mounts m JOIN projects p ON p.id=m.project_id JOIN project_versions v ON v.id=m.project_version_id WHERE ${eligibleAutomaticMount})
    AND NOT EXISTS(SELECT 1 FROM role_learning_mounts other WHERE other.owner_subject_id=role_learning_mounts.owner_subject_id AND other.id!=role_learning_mounts.id AND other.status='running' AND other.lease_expires_at>?)`)
    .bind(lease, new Date(Date.now() + 120_000).toISOString(), now, id, now, now, now).run();
  if (!claim.meta.changes) return { skipped: true };
  const row = await d1.prepare("SELECT * FROM role_learning_mounts WHERE id=? AND lease_owner=?").bind(id, lease).first<MountRow>();
  if (!row) return { skipped: true };
  try {
    let ref = row.package_ref_json ? JSON.parse(row.package_ref_json) as RolePackageRef : undefined;
    if (!ref) {
      const versionHash = await sha256Hex(JSON.stringify([row.project_id, row.project_version_id, row.snapshot_id]));
      const release = await prepareRelease({ projectId: row.project_id, projectVersionId: row.project_version_id,
        packageVersion: `0.0.0-learning.${versionHash}`, visibility: "private", evidencePolicy: "metadata", sourceUse: "learning_path" });
      if (release.status !== "ready" || !release.artifactRootHash) {
        throw new AutomaticMountError("当前岗位版本尚未通过制品校验，需要先补全岗位内容。");
      }
      const artifact = await getPackageArtifact(release.artifactRootHash);
      const manifest = artifact?.bundle.manifest;
      if (!manifest || manifest.snapshotId !== row.snapshot_id || manifest.sourceProjectVersionId !== row.project_version_id || manifest.visibility !== "private") throw new AutomaticMountError("私有岗位包制品与待挂载版本不一致。");
      ref = { packageId: manifest.packageId, packageVersion: manifest.packageVersion, snapshotId: manifest.snapshotId, rootHash: manifest.rootHash };
      await d1.prepare("UPDATE role_learning_mounts SET package_ref_json=? WHERE id=? AND lease_owner=?").bind(JSON.stringify(ref), id, lease).run();
    }
    // Recheck project ownership immediately before delegation; queued identity cannot survive transfer/deletion.
    const owned = await d1.prepare("SELECT id FROM projects WHERE id=? AND owner_subject_id=? AND deleted_at IS NULL").bind(row.project_id, row.owner_subject_id).first();
    if (!owned) throw new AutomaticMountError("项目已删除或归属发生变化，自动挂载已停止。");
    // Compilation may take time. Recheck the final conversation version and idle producer before source writes.
    const producerActive = await d1.prepare(`SELECT id FROM role_jobs WHERE project_id=? AND (? IS NULL OR conversation_id=?) AND status IN ('queued','running','waiting_user') LIMIT 1`)
      .bind(row.project_id, row.conversation_id, row.conversation_id).first();
    const current = row.conversation_id ? await d1.prepare("SELECT version_id FROM conversations WHERE id=? AND project_id=?").bind(row.conversation_id, row.project_id).first<{version_id: string}>() : null;
    if (producerActive || (row.conversation_id && current?.version_id !== row.project_version_id)) {
      await d1.prepare("UPDATE role_learning_mounts SET status='queued',attempt=MAX(0,attempt-1),lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_owner=?")
        .bind(new Date().toISOString(), id, lease).run();
      return { status: "queued" };
    }
    const result = await requestAutomaticMount({ requestId: row.id, packageRef: ref, projectId: row.project_id, projectVersionId: row.project_version_id,
      sourceRunId: row.source_run_id, policyVersion: AUTOMATIC_MOUNT_POLICY }, { baseUrl: process.env.LEARNFLOW_BASE_URL || "", secret: process.env.ROLE_ATLAS_GATEWAY_SECRET || "", subject: row.owner_subject_id });
    await d1.prepare("UPDATE role_learning_mounts SET status=?,result_json=?,lease_owner=NULL,lease_expires_at=NULL,error=NULL,updated_at=? WHERE id=? AND lease_owner=?")
      .bind(result.status, JSON.stringify(result), new Date().toISOString(), id, lease).run();
    return { status: result.status };
  } catch (error) {
    const retryable = !(error instanceof AutomaticMountError) || error.retryable;
    const status = retryable && row.attempt < 8 ? "retry" : "failed";
    const message = error instanceof AutomaticMountError ? error.message : "自动挂载服务暂时不可用，已有岗位版本已保留。";
    await d1.prepare("UPDATE role_learning_mounts SET status=?,error=?,available_at=?,updated_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=? AND lease_owner=?")
      .bind(status, message, new Date(Date.now() + Math.min(300_000, 5000 * 2 ** row.attempt)).toISOString(), new Date().toISOString(), id, lease).run();
    return { status };
  }
}
