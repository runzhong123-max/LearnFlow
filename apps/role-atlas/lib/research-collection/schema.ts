/** Additive operational audit only: no learner state, credentials or model authority. */
export const collectionSchema = [
  `CREATE TABLE IF NOT EXISTS research_testers (subject_id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS research_run_attempts (run_id TEXT NOT NULL, attempt INTEGER NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL, input_json TEXT NOT NULL, base_version_id TEXT, base_snapshot_id TEXT, status TEXT NOT NULL, phase TEXT NOT NULL, checkpoint_json TEXT, result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, PRIMARY KEY(run_id,attempt))`,
  `CREATE TABLE IF NOT EXISTS research_attachments (id TEXT PRIMARY KEY, owner_subject_id TEXT NOT NULL, filename TEXT NOT NULL, media_type TEXT NOT NULL, byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, extraction_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_research_attachments_owner ON research_attachments(owner_subject_id,created_at)`,
  `CREATE TABLE IF NOT EXISTS research_attachment_chunks (sha256 TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(sha256,part))`,
  `CREATE TABLE IF NOT EXISTS research_run_attachments (run_id TEXT NOT NULL, project_id TEXT NOT NULL, attachment_id TEXT NOT NULL, PRIMARY KEY(run_id,attachment_id))`,
  `CREATE TABLE IF NOT EXISTS research_model_calls (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, request_json TEXT NOT NULL, response_json TEXT, status TEXT NOT NULL, error TEXT, started_at TEXT NOT NULL, completed_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_research_calls_run ON research_model_calls(run_id,started_at)`,
  `CREATE TABLE IF NOT EXISTS research_admin_events (id TEXT PRIMARY KEY, actor_subject_id TEXT NOT NULL, action TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
];
