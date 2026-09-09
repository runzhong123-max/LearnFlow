import { automaticMountSchema } from "@/lib/learning-path/automatic-schema";
type ColumnInfo = { name: string };

type RuntimeMigration = {
  id: string;
  apply: (d1: D1Database) => Promise<void>;
};

async function columnNames(d1: D1Database, table: string) {
  const result = await d1.prepare(`PRAGMA table_info(${table})`).all<ColumnInfo>();
  return new Set(result.results.map((column) => column.name));
}

async function addColumns(d1: D1Database, table: string, definitions: Record<string, string>) {
  const existing = await columnNames(d1, table);
  const statements = Object.entries(definitions)
    .filter(([name]) => !existing.has(name))
    .map(([, definition]) => d1.prepare(`ALTER TABLE ${table} ADD COLUMN ${definition}`));
  if (statements.length > 0) await d1.batch(statements);
}

const versioningRegistryMigration: RuntimeMigration = {
  id: "2026-08-22-versioning-registry-v1",
  async apply(d1) {
    await addColumns(d1, "projects", {
      head_version_id: "head_version_id TEXT",
      current_release_id: "current_release_id TEXT",
    });
    await addColumns(d1, "project_versions", {
      parent_version_id: "parent_version_id TEXT",
      source_run_id: "source_run_id TEXT",
      source_kind: "source_kind TEXT NOT NULL DEFAULT 'legacy'",
      root_hash: "root_hash TEXT NOT NULL DEFAULT 'legacy'",
      message: "message TEXT NOT NULL DEFAULT ''",
      author_kind: "author_kind TEXT NOT NULL DEFAULT 'system'",
    });
    await addColumns(d1, "snapshot_versions", {
      content_hash: "content_hash TEXT NOT NULL DEFAULT 'legacy'",
      source_run_id: "source_run_id TEXT",
      protocol_version: "protocol_version TEXT NOT NULL DEFAULT '2.0.0'",
    });

    await d1.batch([
      d1.prepare(`CREATE TABLE IF NOT EXISTS package_artifacts (
        root_hash TEXT PRIMARY KEY NOT NULL,
        artifact_kind TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        content TEXT,
        storage_key TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS semantic_diffs (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        from_version_id TEXT NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
        to_version_id TEXT NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
        algorithm_version TEXT NOT NULL,
        diff_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS project_tags (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        target_version_id TEXT NOT NULL REFERENCES project_versions(id) ON DELETE CASCADE,
        description TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS project_version_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version_id TEXT REFERENCES project_versions(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        actor_kind TEXT NOT NULL DEFAULT 'user',
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS maintainers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        url TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS role_identities (
        id TEXT PRIMARY KEY NOT NULL,
        canonical_name TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        description TEXT NOT NULL DEFAULT '',
        occupation_codes_json TEXT NOT NULL DEFAULT '[]',
        industry_domains_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS package_lines (
        id TEXT PRIMARY KEY NOT NULL,
        role_identity_id TEXT NOT NULL REFERENCES role_identities(id) ON DELETE CASCADE,
        package_id TEXT NOT NULL,
        title TEXT NOT NULL,
        scope_json TEXT NOT NULL DEFAULT '{}',
        maintainer_id TEXT NOT NULL REFERENCES maintainers(id),
        maintenance_kind TEXT NOT NULL,
        hosting_kind TEXT NOT NULL DEFAULT 'hosted',
        visibility TEXT NOT NULL DEFAULT 'private',
        license TEXT NOT NULL DEFAULT 'unspecified',
        evidence_policy TEXT NOT NULL DEFAULT 'metadata',
        protocol_range TEXT NOT NULL DEFAULT '^2.0.0',
        status TEXT NOT NULL DEFAULT 'active',
        recommended_release_id TEXT,
        registry_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS package_releases (
        id TEXT PRIMARY KEY NOT NULL,
        package_line_id TEXT NOT NULL REFERENCES package_lines(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        source_project_version_id TEXT REFERENCES project_versions(id) ON DELETE SET NULL,
        snapshot_id TEXT NOT NULL,
        package_version TEXT NOT NULL,
        status TEXT NOT NULL,
        artifact_root_hash TEXT,
        validation_report_hash TEXT,
        supersedes_release_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        published_at TEXT
      )`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS release_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        release_id TEXT REFERENCES package_releases(id) ON DELETE SET NULL,
        package_line_id TEXT NOT NULL REFERENCES package_lines(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        actor_kind TEXT NOT NULL DEFAULT 'user',
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS reference_migrations (
        id TEXT PRIMARY KEY NOT NULL,
        from_snapshot_id TEXT NOT NULL,
        to_snapshot_id TEXT NOT NULL,
        from_target_id TEXT NOT NULL,
        to_target_ids_json TEXT NOT NULL,
        kind TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic_diffs_pair_algorithm ON semantic_diffs(from_version_id, to_version_id, algorithm_version)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_semantic_diffs_project_created ON semantic_diffs(project_id, created_at DESC)"),
      d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_project_tags_project_name ON project_tags(project_id, name)"),
      d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_project_versions_project_source_run ON project_versions(project_id, source_run_id)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_project_version_events_project_created ON project_version_events(project_id, created_at DESC)"),
      d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_role_identities_name ON role_identities(canonical_name)"),
      d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_package_lines_package_id ON package_lines(package_id)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_package_lines_role_identity ON package_lines(role_identity_id)"),
      d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_package_releases_line_version ON package_releases(package_line_id, package_version)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_package_releases_snapshot ON package_releases(snapshot_id)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_release_events_line_created ON release_events(package_line_id, created_at DESC)"),
      d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_reference_migrations_path ON reference_migrations(from_snapshot_id, to_snapshot_id, from_target_id)"),
      d1.prepare("UPDATE projects SET head_version_id=active_version_id WHERE head_version_id IS NULL AND active_version_id IS NOT NULL"),
      d1.prepare("UPDATE project_versions SET source_run_id=build_run_id WHERE source_run_id IS NULL"),
    ]);
  },
};

const pinLegacyConversationsMigration: RuntimeMigration = {
  id: "2026-08-22-pin-legacy-conversations-v1",
  async apply(d1) {
    await d1.prepare(`UPDATE conversations
      SET version_id=(
        SELECT pv.id FROM project_versions pv
        WHERE pv.project_id=conversations.project_id AND pv.snapshot_id=conversations.snapshot_id
        ORDER BY pv.created_at DESC LIMIT 1
      )
      WHERE version_id IS NULL AND snapshot_id IS NOT NULL`).run();
  },
};

const registryMetadataV2Migration: RuntimeMigration = {
  id: "2026-08-22-registry-metadata-v2",
  async apply(d1) {
    await addColumns(d1, "package_lines", {
      maintenance_policy_json: "maintenance_policy_json TEXT NOT NULL DEFAULT '{}'",
      superseded_by_package_line_id: "superseded_by_package_line_id TEXT",
    });
    await addColumns(d1, "package_releases", {
      snapshot_as_of: "snapshot_as_of TEXT NOT NULL DEFAULT ''",
      protocol_version: "protocol_version TEXT NOT NULL DEFAULT '2.0.0'",
    });
    await d1.batch([
      d1.prepare(`UPDATE package_releases SET snapshot_as_of=COALESCE(
        NULLIF(snapshot_as_of, ''),
        (SELECT json_extract(package_artifacts.content, '$.manifest.snapshotAsOf')
          FROM package_artifacts WHERE package_artifacts.root_hash=package_releases.artifact_root_hash),
        ''
      )`),
      d1.prepare(`UPDATE package_releases SET protocol_version=COALESCE(
        (SELECT json_extract(package_artifacts.content, '$.manifest.protocolVersion')
          FROM package_artifacts WHERE package_artifacts.root_hash=package_releases.artifact_root_hash),
        protocol_version,
        '2.0.0'
      )`),
    ]);
  },
};

const registryMaintenancePolicyBackfill: RuntimeMigration = {
  id: "2026-08-22-registry-maintenance-policy-v1",
  async apply(d1) {
    await d1.prepare(`UPDATE package_lines
      SET maintenance_policy_json='{"reviewCadence":"按需","updateTriggers":["重要来源变化","用户迭代"]}'
      WHERE maintenance_policy_json IS NULL OR maintenance_policy_json='' OR maintenance_policy_json='{}'`).run();
  },
};

const durableRoleJobsMigration: RuntimeMigration = {
  id: "2026-08-23-durable-role-jobs-v1",
  async apply(d1) {
    await d1.batch([
      d1.prepare(`CREATE TABLE IF NOT EXISTS role_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        base_snapshot_id TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        phase TEXT NOT NULL DEFAULT 'queued',
        attempt INTEGER NOT NULL DEFAULT 0,
        input_json TEXT NOT NULL DEFAULT '{}',
        checkpoint_json TEXT,
        result_json TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT
      )`),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_role_jobs_project_updated ON role_jobs(project_id, updated_at DESC)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_role_jobs_status_lease ON role_jobs(status, lease_expires_at)"),
    ]);
  },
};

const unifiedRolePackageProtocolMigration: RuntimeMigration = {
  id: "2026-08-23-unified-role-package-v3",
  async apply(d1) {
    await d1.prepare(`UPDATE package_lines SET protocol_range='>=2.0.0 <4.0.0', updated_at=CURRENT_TIMESTAMP
      WHERE protocol_range='^2.0.0' OR protocol_range='^3.0.0' OR protocol_range=''`).run();
  },
};

const projectLifecycleMigration: RuntimeMigration = {
  id: "2026-09-04-project-lifecycle-v1",
  async apply(d1) {
    await addColumns(d1, "projects", { owner_subject_id: "owner_subject_id TEXT", deleted_at: "deleted_at TEXT", deleted_by: "deleted_by TEXT" });
    await d1.prepare("CREATE INDEX IF NOT EXISTS idx_projects_owner_deleted ON projects(owner_subject_id, deleted_at)").run();
  },
};

export const conversationJobsMigration: RuntimeMigration = {
  id: "2026-09-07-conversation-jobs-v1",
  async apply(d1) {
    await addColumns(d1, "conversations", { mode: "mode TEXT NOT NULL DEFAULT 'explanation' CHECK(mode IN ('explanation','iteration'))" });
    await addColumns(d1, "role_jobs", {
      conversation_id: "conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE",
      base_version_id: "base_version_id TEXT",
    });
    // Legacy jobs remain unbound: never guess conversation ownership from run names.
    await d1.batch([
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_role_jobs_conversation ON role_jobs(conversation_id, updated_at DESC)"),
      d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_role_jobs_active_conversation ON role_jobs(conversation_id) WHERE conversation_id IS NOT NULL AND status IN ('running','waiting_user')"),
      d1.prepare(`CREATE TABLE IF NOT EXISTS role_job_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES role_jobs(id) ON DELETE CASCADE,
        event_run_id TEXT NOT NULL, event_seq INTEGER NOT NULL, kind TEXT NOT NULL, event_json TEXT NOT NULL,
        UNIQUE(job_id, event_run_id, event_seq, kind)
      )`),
    ]);
  },
};

const automaticLearningMountMigration: RuntimeMigration = {
  id: "2026-09-09-automatic-learning-mount-v1",
  async apply(d1) {
    await d1.batch([d1.prepare(automaticMountSchema), d1.prepare("CREATE INDEX IF NOT EXISTS idx_learning_mount_pending ON role_learning_mounts(status,available_at,lease_expires_at)")]);
  },
};
const runtimeMigrations: RuntimeMigration[] = [versioningRegistryMigration, pinLegacyConversationsMigration, registryMetadataV2Migration, registryMaintenancePolicyBackfill, durableRoleJobsMigration, unifiedRolePackageProtocolMigration, projectLifecycleMigration, conversationJobsMigration, automaticLearningMountMigration];

/**
 * Runtime migration runner for local/D1 preview environments. Production can
 * apply the equivalent numbered SQL migration ahead of deployment; the ledger
 * keeps this fallback idempotent and auditable.
 */
export async function applyRuntimeMigrations(d1: D1Database) {
  await d1.prepare(`CREATE TABLE IF NOT EXISTS app_schema_migrations (
    id TEXT PRIMARY KEY NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`).run();
  const applied = await d1.prepare("SELECT id FROM app_schema_migrations").all<{ id: string }>();
  const appliedIds = new Set(applied.results.map((row) => row.id));
  for (const migration of runtimeMigrations) {
    if (appliedIds.has(migration.id)) continue;
    await migration.apply(d1);
    await d1.prepare("INSERT OR IGNORE INTO app_schema_migrations (id) VALUES (?)").bind(migration.id).run();
  }
}
