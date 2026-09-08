/** Atomic lease claims and scope fences; kept independent of Worker bindings for SQLite tests. */
export type JobClaim = {
  id: string; kind: string; threadId: string; owner: string; projectId?: string;
  conversationId?: string; baseSnapshotId?: string; baseVersionId?: string;
  phase: string; payloadJson: string; now: string; expiresAt: string;
};

export function roleJobClaimStatements(d1: D1Database, input: JobClaim) {
  const scope = [input.projectId || null, input.conversationId || null, input.baseSnapshotId || null, input.baseVersionId || null];
  return [
    // Expired workers must lose their lease before another job in the conversation starts.
    d1.prepare(`UPDATE role_jobs SET status='failed', lease_owner=NULL, lease_expires_at=NULL,
      error='执行器租约已过期；已保存的结果可查看，请重新发起或继续本次任务。', updated_at=?
      WHERE conversation_id IS ? AND status='running' AND lease_expires_at<=?`)
      .bind(input.now, input.conversationId || null, input.now),
    d1.prepare(`INSERT OR IGNORE INTO role_jobs
      (id,kind,thread_id,project_id,conversation_id,base_snapshot_id,base_version_id,status,phase,attempt,input_json,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,'queued',?,0,?,?,?
      WHERE (? IS NULL OR EXISTS(SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL))
        AND (? IS NULL OR EXISTS(SELECT 1 FROM conversations WHERE id=? AND project_id=? AND mode='iteration' AND version_id IS ?))
        AND NOT EXISTS(SELECT 1 FROM role_jobs WHERE conversation_id=? AND id!=? AND status IN ('queued','running','waiting_user'))`)
      .bind(input.id, input.kind, input.threadId, ...scope, input.phase, input.payloadJson, input.now, input.now,
        input.projectId || null, input.projectId || null, input.conversationId || null, input.conversationId || null, input.projectId || null, input.baseVersionId || null, input.conversationId || null, input.id),
    d1.prepare(`UPDATE role_jobs SET status='running', attempt=attempt+1, lease_owner=?, lease_expires_at=?,
      error=NULL, completed_at=NULL, updated_at=?
      WHERE id=? AND kind=? AND thread_id=? AND project_id IS ? AND conversation_id IS ? AND base_snapshot_id IS ? AND base_version_id IS ?
        AND input_json=? AND status IN ('queued','failed','running')
        AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=?)
        AND (? IS NULL OR EXISTS(SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL))
        AND (? IS NULL OR EXISTS(SELECT 1 FROM conversations WHERE id=? AND project_id=? AND mode='iteration' AND version_id IS ?))
        AND NOT EXISTS(SELECT 1 FROM role_jobs other WHERE other.conversation_id=role_jobs.conversation_id
          AND other.id!=role_jobs.id AND other.status IN ('queued','running','waiting_user'))`)
      .bind(input.owner, input.expiresAt, input.now, input.id, input.kind, input.threadId, ...scope, input.payloadJson,
        input.now, input.projectId || null, input.projectId || null, input.conversationId || null, input.conversationId || null, input.projectId || null, input.baseVersionId || null),
  ];
}
