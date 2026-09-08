export const dispatchSchema = `CREATE TABLE IF NOT EXISTS role_job_dispatch (
  job_id TEXT PRIMARY KEY REFERENCES role_jobs(id),
  endpoint TEXT NOT NULL, actor_json TEXT NOT NULL, envelope TEXT,
  state TEXT NOT NULL DEFAULT 'ready', deliveries INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL, claimed_until TEXT, token TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT
)`;
/** Reclaim only lost executions. Normal domain failures require an explicit retry. */
export const eligibleDispatch = `d.envelope IS NOT NULL AND d.deliveries<3
  AND d.available_at<=? AND d.state IN ('ready','active')
  AND (d.state='ready' OR d.claimed_until<=?)
  AND (j.status='queued' OR (j.status='running' AND j.lease_expires_at<=?))
  AND p.deleted_at IS NULL AND p.owner_subject_id=json_extract(d.actor_json,'$.subjectId')
  AND c.mode='iteration' AND c.version_id IS j.base_version_id`;
