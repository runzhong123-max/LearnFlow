import { AUTOMATIC_MOUNT_POLICY } from "./automatic-contract";

export const automaticMountSchema = `CREATE TABLE IF NOT EXISTS role_learning_mounts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_version_id TEXT NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  snapshot_id TEXT NOT NULL, owner_subject_id TEXT NOT NULL, source_run_id TEXT NOT NULL,
  policy_version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempt INTEGER NOT NULL DEFAULT 0,
  package_ref_json TEXT, result_json TEXT, error TEXT, lease_owner TEXT, lease_expires_at TEXT,
  available_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(project_version_id,policy_version)
)`;

/** Added to the same D1 batch as the immutable version, never from a browser completion callback. */
export function automaticMountEnqueueStatement(d1: D1Database, input: { versionId: string; projectId: string; conversationId?: string | null; now: string }) {
  return d1.prepare(`INSERT OR IGNORE INTO role_learning_mounts
    (id,project_id,project_version_id,conversation_id,snapshot_id,owner_subject_id,source_run_id,policy_version,available_at,created_at,updated_at)
    SELECT 'mount:'||v.id,v.project_id,v.id,?,v.snapshot_id,p.owner_subject_id,v.source_run_id,?,?,?,?
    FROM project_versions v JOIN projects p ON p.id=v.project_id
    WHERE v.id=? AND v.project_id=? AND p.deleted_at IS NULL AND p.owner_subject_id LIKE 'learnflow:learner:%'
      AND v.source_kind IN ('cold_start','iteration','workspace')`)
    .bind(input.conversationId || null, AUTOMATIC_MOUNT_POLICY, input.now, input.now, input.now, input.versionId, input.projectId);
}

export const eligibleAutomaticMount = `p.deleted_at IS NULL AND p.owner_subject_id=m.owner_subject_id
  AND v.project_id=m.project_id AND v.snapshot_id=m.snapshot_id AND m.attempt<8 AND m.available_at<=?
  AND (m.conversation_id IS NULL OR EXISTS(SELECT 1 FROM conversations c WHERE c.id=m.conversation_id AND c.project_id=m.project_id AND c.version_id=m.project_version_id))
  AND NOT EXISTS(SELECT 1 FROM role_jobs j WHERE j.project_id=m.project_id AND (m.conversation_id IS NULL OR j.conversation_id=m.conversation_id) AND j.status IN ('queued','running','waiting_user'))
  AND (m.status IN ('queued','retry') OR (m.status='running' AND m.lease_expires_at<=?))`;

/** Keep completed receipts; only pending intermediate versions collapse to the conversation's latest production. */
export const supersedeAutomaticMounts = `UPDATE role_learning_mounts SET status='superseded',updated_at=? WHERE status IN ('queued','retry') AND conversation_id IS NOT NULL
  AND EXISTS(SELECT 1 FROM conversations c JOIN role_learning_mounts next ON next.project_version_id=c.version_id AND next.conversation_id=c.id
    WHERE c.id=role_learning_mounts.conversation_id AND c.project_id=role_learning_mounts.project_id AND next.owner_subject_id=role_learning_mounts.owner_subject_id AND next.rowid>role_learning_mounts.rowid)`;
