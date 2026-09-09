/** Private operational drafts. These are not RolePackage snapshots or learner evidence. */
export const intakeSchema = [
  `CREATE TABLE IF NOT EXISTS role_intakes (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    head_revision_id TEXT, pending_revision_id TEXT, confirmed_revision_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS role_intake_revisions (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL, input_hash TEXT NOT NULL, input_json TEXT NOT NULL,
    base_revision_id TEXT, state TEXT NOT NULL CHECK(state IN ('running','ready','failed')),
    lease_owner TEXT, lease_expires_at TEXT, result_json TEXT, content_hash TEXT, error TEXT,
    confirmed_by TEXT, confirmed_at TEXT, confirmation_operation_id TEXT, build_run_id TEXT UNIQUE,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(conversation_id, operation_id), UNIQUE(conversation_id, confirmation_operation_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_role_intake_revisions_conversation ON role_intake_revisions(conversation_id, created_at)`,
];
