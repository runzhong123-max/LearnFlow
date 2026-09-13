import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  ownerSubjectId: text("owner_subject_id"),
  deletedAt: text("deleted_at"),
  deletedBy: text("deleted_by"),
  description: text("description").notNull().default(""),
  market: text("market").notNull().default("中国大陆"),
  status: text("status", { enum: ["draft", "building", "ready", "failed"] }).notNull().default("draft"),
  /** Latest immutable project-history commit. It is not a published release pointer. */
  headVersionId: text("head_version_id"),
  /** Release currently used by default for public/maintained consumption. */
  currentReleaseId: text("current_release_id"),
  /** Legacy compatibility pointer; new code mirrors headVersionId here during migration. */
  activeVersionId: text("active_version_id"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const conversations = sqliteTable("conversations", {
  mode: text("mode", { enum: ["explanation", "iteration"] }).notNull().default("explanation"),
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  snapshotId: text("snapshot_id"),
  versionId: text("version_id"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_conversations_project_updated").on(table.projectId, table.updatedAt)]);

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  text: text("text").notNull().default(""),
  reasoning: text("reasoning").notNull().default(""),
  referencesJson: text("references_json").notNull().default("[]"),
  activitiesJson: text("activities_json").notNull().default("[]"),
  citationsJson: text("citations_json").notNull().default("[]"),
  status: text("status", { enum: ["running", "done", "failed", "cancelled"] }).notNull().default("done"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_messages_conversation_created").on(table.conversationId, table.createdAt)]);

export const buildRuns = sqliteTable("build_runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["running", "completed", "failed", "cancelled"] }).notNull().default("running"),
  inputJson: text("input_json").notNull(),
  resultJson: text("result_json"),
  error: text("error"),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
}, (table) => [index("idx_build_runs_project_started").on(table.projectId, table.startedAt)]);

export const buildEvents = sqliteTable("build_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull().references(() => buildRuns.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  kind: text("kind").notNull(),
  eventJson: text("event_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("idx_build_events_run_seq").on(table.runId, table.seq)]);

/** Cross-skill lease and stage checkpoint. Domain run tables remain the audit source. */
export const roleJobs = sqliteTable("role_jobs", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["cold_start", "snapshot_iteration", "node_deepening", "workspace_instantiation"] }).notNull(),
  threadId: text("thread_id").notNull(),
  conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
  baseVersionId: text("base_version_id"),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  baseSnapshotId: text("base_snapshot_id"),
  status: text("status", { enum: ["queued", "running", "waiting_user", "completed", "failed", "cancelled"] }).notNull().default("queued"),
  phase: text("phase").notNull().default("queued"),
  attempt: integer("attempt").notNull().default(0),
  inputJson: text("input_json").notNull().default("{}"),
  checkpointJson: text("checkpoint_json"),
  resultJson: text("result_json"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: text("lease_expires_at"),
  error: text("error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
}, (table) => [
  index("idx_role_jobs_project_updated").on(table.projectId, table.updatedAt),
  index("idx_role_jobs_status_lease").on(table.status, table.leaseExpiresAt),
]);

export const projectVersions = sqliteTable("project_versions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  buildRunId: text("build_run_id").notNull().references(() => buildRuns.id, { onDelete: "cascade" }),
  parentVersionId: text("parent_version_id"),
  sourceRunId: text("source_run_id"),
  sourceKind: text("source_kind", { enum: ["cold_start", "iteration", "workspace", "restore", "import", "legacy"] }).notNull().default("legacy"),
  version: text("version").notNull(),
  snapshotId: text("snapshot_id").notNull(),
  status: text("status", { enum: ["candidate", "ready", "published"] }).notNull().default("candidate"),
  rootHash: text("root_hash").notNull().default("legacy"),
  message: text("message").notNull().default(""),
  authorKind: text("author_kind", { enum: ["user", "agent", "system"] }).notNull().default("system"),
  packageJson: text("package_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_project_versions_project_version").on(table.projectId, table.version),
  uniqueIndex("idx_project_versions_project_source_run").on(table.projectId, table.sourceRunId),
]);

/** Storage-neutral snapshot history used by skills outside a project tree. */
export const snapshotVersions = sqliteTable("snapshot_versions", {
  snapshotId: text("snapshot_id").primaryKey(),
  parentSnapshotId: text("parent_snapshot_id"),
  packageId: text("package_id").notNull(),
  packageVersion: text("package_version").notNull(),
  status: text("status").notNull().default("candidate"),
  contentHash: text("content_hash").notNull().default("legacy"),
  sourceRunId: text("source_run_id"),
  protocolVersion: text("protocol_version").notNull().default("2.0.0"),
  packageJson: text("package_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** Durable runs for the unified discover/research/repair/expand iteration skill. */
export const snapshotIterationRuns = sqliteTable("snapshot_iteration_runs", {
  id: text("id").primaryKey(),
  baseSnapshotId: text("base_snapshot_id").notNull(),
  candidateSnapshotId: text("candidate_snapshot_id"),
  projectId: text("project_id"),
  projectVersionId: text("project_version_id"),
  status: text("status").notNull().default("running"),
  initiativeProfile: text("initiative_profile").notNull(),
  phase: text("phase").notNull().default("contract"),
  inputJson: text("input_json").notNull(),
  checkpointJson: text("checkpoint_json"),
  resultJson: text("result_json"),
  error: text("error"),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
}, (table) => [index("idx_snapshot_iteration_runs_base_started").on(table.baseSnapshotId, table.startedAt)]);

export const snapshotIterationEvents = sqliteTable("snapshot_iteration_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull().references(() => snapshotIterationRuns.id, { onDelete: "cascade" }),
  snapshotId: text("snapshot_id").notNull(),
  seq: integer("seq").notNull(),
  kind: text("kind").notNull(),
  eventJson: text("event_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("idx_snapshot_iteration_events_run_seq").on(table.runId, table.seq)]);

/** Durable normalization, safety scan, extraction and snapshot-alignment runs for real workspaces. */
export const workspaceIngestionRuns = sqliteTable("workspace_ingestion_runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  baseSnapshotId: text("base_snapshot_id"),
  iterationRunId: text("iteration_run_id"),
  adapterId: text("adapter_id").notNull(),
  packageId: text("package_id"),
  status: text("status").notNull().default("running"),
  phase: text("phase").notNull().default("register"),
  inputJson: text("input_json").notNull(),
  checkpointJson: text("checkpoint_json"),
  resultJson: text("result_json"),
  alignmentJson: text("alignment_json"),
  error: text("error"),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
}, (table) => [index("idx_workspace_ingestion_runs_project_started").on(table.projectId, table.startedAt)]);

export const workspaceIngestionEvents = sqliteTable("workspace_ingestion_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull().references(() => workspaceIngestionRuns.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  kind: text("kind").notNull(),
  eventJson: text("event_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("idx_workspace_ingestion_events_run_seq").on(table.runId, table.seq)]);

/** Content-addressed compiled package artifacts. Large payloads can move to R2 without changing references. */
export const packageArtifacts = sqliteTable("package_artifacts", {
  rootHash: text("root_hash").primaryKey(),
  artifactKind: text("artifact_kind").notNull(),
  mediaType: text("media_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  content: text("content"),
  storageKey: text("storage_key"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const semanticDiffs = sqliteTable("semantic_diffs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  fromVersionId: text("from_version_id").notNull().references(() => projectVersions.id, { onDelete: "cascade" }),
  toVersionId: text("to_version_id").notNull().references(() => projectVersions.id, { onDelete: "cascade" }),
  algorithmVersion: text("algorithm_version").notNull(),
  diffJson: text("diff_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_semantic_diffs_pair_algorithm").on(table.fromVersionId, table.toVersionId, table.algorithmVersion),
  index("idx_semantic_diffs_project_created").on(table.projectId, table.createdAt),
]);

export const projectTags = sqliteTable("project_tags", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  targetVersionId: text("target_version_id").notNull().references(() => projectVersions.id, { onDelete: "cascade" }),
  description: text("description").notNull().default(""),
  createdBy: text("created_by").notNull().default("user"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("idx_project_tags_project_name").on(table.projectId, table.name)]);

export const projectVersionEvents = sqliteTable("project_version_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  versionId: text("version_id").references(() => projectVersions.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  actorKind: text("actor_kind").notNull().default("user"),
  detailJson: text("detail_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_project_version_events_project_created").on(table.projectId, table.createdAt)]);

export const maintainers = sqliteTable("maintainers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["role_atlas", "source_organization", "community", "organization", "individual"] }).notNull(),
  description: text("description").notNull().default(""),
  url: text("url"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const roleIdentities = sqliteTable("role_identities", {
  id: text("id").primaryKey(),
  canonicalName: text("canonical_name").notNull(),
  aliasesJson: text("aliases_json").notNull().default("[]"),
  description: text("description").notNull().default(""),
  occupationCodesJson: text("occupation_codes_json").notNull().default("[]"),
  industryDomainsJson: text("industry_domains_json").notNull().default("[]"),
  status: text("status", { enum: ["active", "disputed", "deprecated"] }).notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("idx_role_identities_name").on(table.canonicalName)]);

export const packageLines = sqliteTable("package_lines", {
  id: text("id").primaryKey(),
  roleIdentityId: text("role_identity_id").notNull().references(() => roleIdentities.id, { onDelete: "cascade" }),
  packageId: text("package_id").notNull(),
  title: text("title").notNull(),
  scopeJson: text("scope_json").notNull().default("{}"),
  maintainerId: text("maintainer_id").notNull().references(() => maintainers.id),
  maintenanceKind: text("maintenance_kind", { enum: ["role_atlas", "source_official", "community", "private"] }).notNull(),
  maintenancePolicyJson: text("maintenance_policy_json").notNull().default("{}"),
  hostingKind: text("hosting_kind", { enum: ["bundled", "hosted", "remote"] }).notNull().default("hosted"),
  visibility: text("visibility", { enum: ["private", "unlisted", "public"] }).notNull().default("private"),
  license: text("license").notNull().default("unspecified"),
  evidencePolicy: text("evidence_policy", { enum: ["full", "metadata", "redacted"] }).notNull().default("metadata"),
  protocolRange: text("protocol_range").notNull().default("^2.0.0"),
  status: text("status", { enum: ["active", "disputed", "deprecated", "superseded"] }).notNull().default("active"),
  supersededByPackageLineId: text("superseded_by_package_line_id"),
  recommendedReleaseId: text("recommended_release_id"),
  registryVersion: integer("registry_version").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_package_lines_package_id").on(table.packageId),
  index("idx_package_lines_role_identity").on(table.roleIdentityId),
]);

export const packageReleases = sqliteTable("package_releases", {
  id: text("id").primaryKey(),
  packageLineId: text("package_line_id").notNull().references(() => packageLines.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  sourceProjectVersionId: text("source_project_version_id").references(() => projectVersions.id, { onDelete: "set null" }),
  snapshotId: text("snapshot_id").notNull(),
  snapshotAsOf: text("snapshot_as_of").notNull().default(""),
  packageVersion: text("package_version").notNull(),
  protocolVersion: text("protocol_version").notNull().default("2.0.0"),
  status: text("status", { enum: ["compiling", "validating", "ready", "published", "failed", "deprecated"] }).notNull(),
  artifactRootHash: text("artifact_root_hash"),
  validationReportHash: text("validation_report_hash"),
  supersedesReleaseId: text("supersedes_release_id"),
  error: text("error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  publishedAt: text("published_at"),
}, (table) => [
  uniqueIndex("idx_package_releases_line_version").on(table.packageLineId, table.packageVersion),
  index("idx_package_releases_snapshot").on(table.snapshotId),
]);

export const releaseEvents = sqliteTable("release_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  releaseId: text("release_id").references(() => packageReleases.id, { onDelete: "set null" }),
  packageLineId: text("package_line_id").notNull().references(() => packageLines.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  actorKind: text("actor_kind").notNull().default("user"),
  detailJson: text("detail_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_release_events_line_created").on(table.packageLineId, table.createdAt)]);

export const referenceMigrations = sqliteTable("reference_migrations", {
  id: text("id").primaryKey(),
  fromSnapshotId: text("from_snapshot_id").notNull(),
  toSnapshotId: text("to_snapshot_id").notNull(),
  fromTargetId: text("from_target_id").notNull(),
  toTargetIdsJson: text("to_target_ids_json").notNull(),
  kind: text("kind", { enum: ["rename", "merge", "split", "replacement", "removed"] }).notNull(),
  confidence: integer("confidence").notNull(),
  reason: text("reason").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_reference_migrations_path").on(table.fromSnapshotId, table.toSnapshotId, table.fromTargetId),
]);
