import { and, desc, eq, isNull } from "drizzle-orm";
import { ensureAppSchema, getD1, getDb } from "@/db";
import { buildRuns, projectVersions, projects, snapshotVersions } from "@/db/schema";
import type { ColdStartBuildResult } from "@/lib/build/types";
import { normalizeRolePackage } from "@/lib/packages/role-package-manifest";
import { canonicalStringify, domainId, projectVersionLabel, sha256Hex } from "./canonical";
import { preserveStableIdentities } from "./identity";
import type { ProjectVersionRecord, ProjectVersionSourceKind } from "./types";
import { versionAdoptionStatements, versionCommitStatements } from "./commit-transaction";

function parseResult(value: string) {
  return normalizeRolePackage(JSON.parse(value) as ColdStartBuildResult);
}

async function backfillLegacyProjectVersions(projectId: string) {
  const db = getDb();
  const rows = await db.select().from(projectVersions).where(eq(projectVersions.projectId, projectId)).orderBy(projectVersions.createdAt);
  let parentVersionId: string | null = null;
  for (const row of rows) {
    if (row.rootHash !== "legacy" && row.sourceKind !== "legacy") {
      parentVersionId = row.id;
      continue;
    }
    let result: ColdStartBuildResult;
    try { result = parseResult(row.packageJson); }
    catch { parentVersionId = row.id; continue; }
    const rootHash = await sha256Hex(canonicalStringify(result));
    let sourceKind: ProjectVersionSourceKind = row.sourceKind as ProjectVersionSourceKind;
    const [run] = await db.select({ inputJson: buildRuns.inputJson }).from(buildRuns).where(eq(buildRuns.id, row.buildRunId)).limit(1);
    if (sourceKind === "legacy" && run) {
      try {
        const kind = String((JSON.parse(run.inputJson) as { kind?: unknown }).kind || "");
        sourceKind = kind.includes("workspace") ? "workspace" : kind.includes("iteration") || kind.includes("risk") ? "iteration" : "cold_start";
      } catch { sourceKind = "legacy"; }
    }
    await commitStaticSnapshot({ result, parentSnapshotId: parentVersionId ? rows.find((item) => item.id === parentVersionId)?.snapshotId : null, sourceRunId: row.buildRunId });
    await db.update(projectVersions).set({
      parentVersionId,
      sourceRunId: row.sourceRunId || row.buildRunId,
      sourceKind,
      rootHash,
      message: row.message || (sourceKind === "cold_start" ? `建立“${result.brief.roleTitle}”岗位快照` : sourceKind === "workspace" ? "根据真实工作区实例化岗位快照" : "迭代岗位快照"),
    }).where(eq(projectVersions.id, row.id));
    parentVersionId = row.id;
  }
}

export async function commitStaticSnapshot(input: {
  result: ColdStartBuildResult;
  parentSnapshotId?: string | null;
  sourceRunId?: string | null;
}) {
  await ensureAppSchema();
  const db = getDb();
  const packageJson = canonicalStringify(input.result);
  const contentHash = await sha256Hex(packageJson);
  const [existing] = await db.select().from(snapshotVersions)
    .where(eq(snapshotVersions.snapshotId, input.result.snapshot.id)).limit(1);
  if (existing) {
    const existingHash = existing.contentHash === "legacy"
      ? await sha256Hex(canonicalStringify(parseResult(existing.packageJson)))
      : existing.contentHash;
    if (existingHash !== contentHash) throw new Error("IMMUTABLE_SNAPSHOT_CONFLICT");
    if (existing.contentHash === "legacy") {
      await db.update(snapshotVersions).set({ contentHash: existingHash }).where(eq(snapshotVersions.snapshotId, existing.snapshotId));
    }
    return { snapshotId: existing.snapshotId, contentHash: existingHash, created: false };
  }
  const inserted = await db.insert(snapshotVersions).values({
    snapshotId: input.result.snapshot.id,
    parentSnapshotId: input.parentSnapshotId || null,
    packageId: input.result.packages.rolePackage.packageId,
    packageVersion: input.result.packages.rolePackage.packageVersion,
    status: input.result.snapshot.status,
    contentHash,
    sourceRunId: input.sourceRunId || input.result.runId,
    protocolVersion: input.result.packages.rolePackage.protocolVersion,
    packageJson,
  }).onConflictDoNothing().returning({ snapshotId: snapshotVersions.snapshotId });
  if (!inserted.length) {
    // Another worker can win between the lookup and insert. Reuse only byte-identical immutable content.
    const [stored] = await db.select().from(snapshotVersions).where(eq(snapshotVersions.snapshotId, input.result.snapshot.id)).limit(1);
    const storedHash = stored?.contentHash === "legacy" ? await sha256Hex(canonicalStringify(parseResult(stored.packageJson))) : stored?.contentHash;
    if (storedHash !== contentHash) throw new Error("IMMUTABLE_SNAPSHOT_CONFLICT");
  }
  return { snapshotId: input.result.snapshot.id, contentHash, created: inserted.length > 0 };
}

export async function projectVersionHeadState(projectId: string, versionId: string) {
  const row = await getD1().prepare("SELECT COALESCE(head_version_id,active_version_id) AS head FROM projects WHERE id=?")
    .bind(projectId).first<{ head: string | null }>();
  return { appliedToHead: row?.head === versionId, currentHeadVersionId: row?.head || null };
}

export async function commitProjectVersion(input: {
  projectId: string;
  result: ColdStartBuildResult;
  sourceRunId: string;
  sourceKind: Exclude<ProjectVersionSourceKind, "legacy">;
  sourceInput?: unknown;
  parentVersionId?: string | null;
  conversationId?: string | null;
  jobId?: string;
  jobOwner?: string;
  message: string;
  authorKind?: "user" | "agent" | "system";
  /** Reuse an already committed immutable artifact while still recording a new timeline event. */
  reuseSnapshotId?: string;
}) {
  await ensureAppSchema();
  const db = getDb();
  const [project] = await db.select().from(projects).where(and(eq(projects.id, input.projectId), isNull(projects.deletedAt))).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  if (input.conversationId) {
    const conversation = await getD1().prepare("SELECT id FROM conversations WHERE id=? AND project_id=?")
      .bind(input.conversationId, input.projectId).first();
    if (!conversation) throw new Error("CONVERSATION_PROJECT_CONFLICT");
  }
  const [existingVersion] = await db.select().from(projectVersions).where(and(
    eq(projectVersions.projectId, input.projectId),
    eq(projectVersions.sourceRunId, input.sourceRunId),
  )).limit(1);
  if (existingVersion) {
    return {
      id: existingVersion.id,
      version: existingVersion.version,
      snapshotId: existingVersion.snapshotId,
      rootHash: existingVersion.rootHash,
      parentVersionId: existingVersion.parentVersionId,
      status: existingVersion.status,
      ...await projectVersionHeadState(input.projectId, existingVersion.id),
    };
  }
  const parentVersionId = input.parentVersionId === undefined
    ? project.headVersionId || project.activeVersionId || null
    : input.parentVersionId;
  const [parentVersion] = parentVersionId
    ? await db.select().from(projectVersions).where(and(eq(projectVersions.id, parentVersionId), eq(projectVersions.projectId, input.projectId))).limit(1)
    : [];
  if (parentVersionId && !parentVersion) throw new Error("PARENT_VERSION_NOT_FOUND");
  const [alreadyStoredSnapshot] = await db.select({ snapshotId: snapshotVersions.snapshotId }).from(snapshotVersions)
    .where(eq(snapshotVersions.snapshotId, input.result.snapshot.id)).limit(1);
  let result = structuredClone(input.result);
  if (input.reuseSnapshotId) {
    const [stored] = await db.select({ packageJson: snapshotVersions.packageJson }).from(snapshotVersions)
      .where(eq(snapshotVersions.snapshotId, input.reuseSnapshotId)).limit(1);
    if (!stored) throw new Error("SNAPSHOT_NOT_FOUND");
    result = parseResult(stored.packageJson);
  }
  if (parentVersion && !alreadyStoredSnapshot) {
    try { result = preserveStableIdentities(parseResult(parentVersion.packageJson), result).result; }
    catch { /* Keep generated IDs; semantic diff will expose uncertainty. */ }
  }
  const snapshot = await commitStaticSnapshot({ result, parentSnapshotId: parentVersion?.snapshotId, sourceRunId: input.sourceRunId });
  const now = new Date().toISOString();
  const commitIdentity = await sha256Hex(canonicalStringify([input.projectId, input.sourceRunId]));
  const id = `pv:${commitIdentity}`;
  const version = projectVersionLabel(now, snapshot.contentHash, commitIdentity);
  const status = result.snapshot.status === "ready" ? "ready" : "candidate";
  const d1 = getD1();
  try {
    const committed = await d1.batch(versionCommitStatements(d1, {
      id, projectId: input.projectId, sourceRunId: input.sourceRunId, sourceKind: input.sourceKind,
      sourceInput: JSON.stringify(input.sourceInput || { kind: input.sourceKind }), parentVersionId,
      expectedHeadId: parentVersionId, version, snapshotId: result.snapshot.id,
      rootHash: snapshot.contentHash, status, message: input.message, authorKind: input.authorKind || "agent",
      packageJson: canonicalStringify(result), now, conversationId: input.conversationId, jobId: input.jobId, jobOwner: input.jobOwner,
    }));
    if (!committed[1].meta.changes) throw new Error("BUILD_RUN_PROJECT_CONFLICT");
  } catch (error) {
    // The unique project/source-run constraint is the idempotency authority, not the earlier read.
    const [winner] = await db.select().from(projectVersions).where(and(
      eq(projectVersions.projectId, input.projectId), eq(projectVersions.sourceRunId, input.sourceRunId),
    )).limit(1);
    if (!winner) throw error;
    return { id: winner.id, version: winner.version, snapshotId: winner.snapshotId, rootHash: winner.rootHash,
      parentVersionId: winner.parentVersionId, status: winner.status, ...await projectVersionHeadState(input.projectId, winner.id) };
  }
  return { id, version, snapshotId: result.snapshot.id, rootHash: snapshot.contentHash, parentVersionId, status, ...await projectVersionHeadState(input.projectId, id) };
}

export async function listProjectVersions(projectId: string): Promise<ProjectVersionRecord[]> {
  await ensureAppSchema();
  await backfillLegacyProjectVersions(projectId);
  const db = getDb();
  const rows = await db.select().from(projectVersions)
    .where(eq(projectVersions.projectId, projectId)).orderBy(desc(projectVersions.createdAt));
  return rows.flatMap((row) => {
    try {
      return [{
        id: row.id,
        projectId: row.projectId,
        parentVersionId: row.parentVersionId,
        sourceRunId: row.sourceRunId || row.buildRunId,
        sourceKind: row.sourceKind as ProjectVersionSourceKind,
        version: row.version,
        snapshotId: row.snapshotId,
        status: row.status,
        rootHash: row.rootHash,
        message: row.message,
        authorKind: row.authorKind,
        createdAt: row.createdAt,
        result: parseResult(row.packageJson),
      } satisfies ProjectVersionRecord];
    } catch {
      return [];
    }
  });
}

export async function getProjectVersionRecord(projectId: string, versionId: string) {
  await ensureAppSchema();
  await backfillLegacyProjectVersions(projectId);
  const db = getDb();
  const [row] = await db.select().from(projectVersions)
    .where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.id, versionId))).limit(1);
  if (!row) return null;
  return {
    ...row,
    parentVersionId: row.parentVersionId,
    sourceRunId: row.sourceRunId || row.buildRunId,
    sourceKind: row.sourceKind as ProjectVersionSourceKind,
    result: parseResult(row.packageJson),
  };
}

export async function restoreProjectVersion(input: {
  projectId: string;
  targetVersionId: string;
  message?: string;
  actorKind?: "user" | "agent" | "system";
}) {
  const target = await getProjectVersionRecord(input.projectId, input.targetVersionId);
  if (!target) throw new Error("VERSION_NOT_FOUND");
  await ensureAppSchema();
  const runId = domainId("restore-run");
  const now = new Date().toISOString();
  const db = getDb();
  await db.insert(buildRuns).values({
    id: runId,
    projectId: input.projectId,
    status: "completed",
    inputJson: JSON.stringify({ kind: "restore", targetVersionId: input.targetVersionId }),
    resultJson: canonicalStringify(target.result),
    startedAt: now,
    completedAt: now,
  });
  return commitProjectVersion({
    projectId: input.projectId,
    result: target.result,
    sourceRunId: runId,
    sourceKind: "restore",
    message: input.message || `恢复到 ${target.message || target.version}`,
    authorKind: input.actorKind || "user",
  });
}


/** Explicitly adopt an already retained conversation candidate; never merge its facts implicitly. */
export async function adoptProjectVersion(input: {
  projectId: string; versionId: string; expectedHeadVersionId: string | null; conversationId?: string;
}) {
  await ensureAppSchema();
  const version = await getProjectVersionRecord(input.projectId, input.versionId);
  if (!version) throw new Error("VERSION_NOT_FOUND");
  if (input.conversationId) {
    const conversation = await getD1().prepare("SELECT id FROM conversations WHERE id=? AND project_id=?")
      .bind(input.conversationId, input.projectId).first();
    if (!conversation) throw new Error("CONVERSATION_NOT_FOUND");
  }
  const batch = await getD1().batch(versionAdoptionStatements(getD1(), {
    ...input, operationId: crypto.randomUUID(), now: new Date().toISOString(),
  }));
  const state = await projectVersionHeadState(input.projectId, input.versionId);
  const conversationSwitched = Boolean(input.conversationId && batch[2]?.meta.changes);
  const adopted = (Boolean(batch[0].meta.changes) || (state.appliedToHead && input.expectedHeadVersionId === input.versionId))
    && (!input.conversationId || conversationSwitched);
  return { adopted, conversationSwitched, ...state };
}
