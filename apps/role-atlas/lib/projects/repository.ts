import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { ensureAppSchema, getD1, getDb } from "@/db";
import { loadLargeText, storeLargeText } from "@/db/large-text";
import { buildEvents, buildRuns, conversations, messages, projects, projectVersions, riskEvents, riskRuns } from "@/db/schema";
import type { AgentEvent } from "@/lib/agent/events";
import type { BuildEvent } from "@/lib/build/events";
import type { ColdStartBuildResult, ColdStartRequest } from "@/lib/build/types";
import type { SnapshotIterationResult } from "@/lib/iteration/types";
import { normalizeRolePackage } from "@/lib/packages/role-package-manifest";
import type { RiskEvent, RiskRunRequest, RiskRunResult } from "@/lib/risk/types";
import { commitProjectVersion } from "@/lib/versioning/commit";
import { assistantMessageFromEvents } from "./message-persistence";

export type StoredProjectSummary = {
  id: string;
  title: string;
  description: string;
  market: string;
  status: "draft" | "building" | "ready" | "failed";
  headVersionId: string | null;
  currentReleaseId: string | null;
  activeVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  conversations: Array<{ id: string; title: string; snapshotId: string | null; versionId: string | null; updatedAt: string; mode?: "explanation" | "iteration" }>;
};

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  reasoning: string;
  references: unknown[];
  activities: unknown[];
  citations: unknown[];
  status: "running" | "done" | "failed" | "cancelled";
  createdAt: string;
};

function safeArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function listProjects(ownerSubjectId?: string): Promise<StoredProjectSummary[]> {
  await ensureAppSchema();
  const db = getDb();
  const projectRows = await db.select().from(projects).where(ownerSubjectId
    ? and(isNull(projects.deletedAt), eq(projects.ownerSubjectId, ownerSubjectId))
    : isNull(projects.deletedAt)).orderBy(desc(projects.updatedAt));
  const conversationRows = projectRows.length ? await db.select().from(conversations)
    .where(inArray(conversations.projectId, projectRows.map(project => project.id))).orderBy(desc(conversations.updatedAt)) : [];
  return projectRows.map((project) => ({
    ...project,
    conversations: conversationRows.filter(conversation => conversation.projectId === project.id)
      .map(({ id, title, snapshotId, versionId, updatedAt, mode }) => ({ id, title, snapshotId, versionId, updatedAt, mode })),
  }));
}

export async function createProject(input: {
  id: string;
  title: string;
  description: string;
  market: string;
  conversationId: string;
  conversationTitle?: string;
  conversationMode?: "explanation" | "iteration";
  ownerSubjectId?: string;
}) {
  await ensureAppSchema();
  const d1 = getD1();
  await d1.batch([
    d1.prepare("INSERT INTO projects (id, title, description, market, status, owner_subject_id) VALUES (?, ?, ?, ?, 'draft', ?)")
      .bind(input.id, input.title, input.description, input.market, input.ownerSubjectId || null),
    d1.prepare("INSERT INTO conversations (id, project_id, title, mode) VALUES (?, ?, ?, ?)")
      .bind(input.conversationId, input.id, input.conversationTitle || "岗位理解与研究", input.conversationMode || "explanation"),
  ]);
  return { projectId: input.id, conversationId: input.conversationId };
}

export async function getProjectWorkspace(projectId: string, snapshotId?: string | null, versionId?: string | null) {
  await ensureAppSchema();
  const db = getDb();
  const [project] = await db.select().from(projects).where(and(eq(projects.id, projectId), isNull(projects.deletedAt))).limit(1);
  if (!project) return null;
  const conversationRows = await db.select().from(conversations)
    .where(eq(conversations.projectId, projectId))
    .orderBy(desc(conversations.updatedAt));
  const versionRows = versionId
    ? await db.select().from(projectVersions)
      .where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.id, versionId)))
      .limit(1)
    : snapshotId
    ? await db.select().from(projectVersions)
      .where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.snapshotId, snapshotId)))
      .orderBy(desc(projectVersions.createdAt))
      .limit(1)
    : project.headVersionId || project.activeVersionId
      ? await db.select().from(projectVersions)
        .where(eq(projectVersions.id, (project.headVersionId || project.activeVersionId)!))
        .limit(1)
      : await db.select().from(projectVersions)
        .where(eq(projectVersions.projectId, projectId))
        .orderBy(desc(projectVersions.createdAt))
        .limit(1);
  let result: ColdStartBuildResult | null = null;
  if (versionRows[0]) {
    const packageJson = await loadLargeText(getD1(), { table: "project_versions", id: versionRows[0].id, column: "package_json" }, versionRows[0].packageJson);
    try { result = packageJson ? normalizeRolePackage(JSON.parse(packageJson) as ColdStartBuildResult) : null; }
    catch { result = null; }
  }
  return { project, conversations: conversationRows, version: versionRows[0] || null, result };
}

export async function createConversation(input: { id: string; projectId: string; title: string; snapshotId?: string | null; versionId?: string | null; pinToActive?: boolean; mode?: "explanation" | "iteration" }) {
  await ensureAppSchema();
  const db = getDb();
  const [project] = await db.select({ id: projects.id, headVersionId: projects.headVersionId, activeVersionId: projects.activeVersionId })
    .from(projects).where(and(eq(projects.id, input.projectId), isNull(projects.deletedAt))).limit(1);
  if (!project) return null;
  const headVersionId = project.headVersionId || project.activeVersionId;
  const [activeVersion] = headVersionId
    ? await db.select({ id: projectVersions.id, snapshotId: projectVersions.snapshotId }).from(projectVersions).where(eq(projectVersions.id, headVersionId)).limit(1)
    : [];
  const snapshotId = input.pinToActive === false ? null : input.snapshotId || activeVersion?.snapshotId || null;
  const versionId = input.pinToActive === false ? null : input.versionId || activeVersion?.id || null;
  await db.insert(conversations).values({ id: input.id, projectId: input.projectId, title: input.title, snapshotId, versionId, mode: input.mode || "explanation" });
  return { id: input.id, projectId: input.projectId, title: input.title, snapshotId, versionId, mode: input.mode || "explanation" };
}

export async function setConversationMode(input: { projectId: string; conversationId: string; mode: "explanation" | "iteration" }) {
  await ensureAppSchema();
  const result = await getD1().prepare(`UPDATE conversations SET mode=?, updated_at=? WHERE id=? AND project_id=?
    AND NOT EXISTS (SELECT 1 FROM role_jobs WHERE conversation_id=? AND status IN ('queued','running','waiting_user'))`)
    .bind(input.mode, new Date().toISOString(), input.conversationId, input.projectId, input.conversationId).run();
  return Boolean(result.meta.changes);
}

export async function getConversation(conversationId: string) {
  await ensureAppSchema();
  const db = getDb();
  const [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (!conversation) return null;
  const workspace = await getProjectWorkspace(conversation.projectId, conversation.snapshotId, conversation.versionId);
  return workspace ? { conversation, workspace } : null;
}

export async function listMessages(conversationId: string): Promise<StoredMessage[]> {
  await ensureAppSchema();
  const db = getDb();
  const rows = await db.select().from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    text: row.text,
    reasoning: row.reasoning,
    references: safeArray(row.referencesJson),
    activities: safeArray(row.activitiesJson),
    citations: safeArray(row.citationsJson),
    status: row.status,
    createdAt: row.createdAt,
  }));
}

export async function conversationExists(conversationId: string) {
  await ensureAppSchema();
  const db = getDb();
  const rows = await db.select({ id: conversations.id }).from(conversations)
    .where(eq(conversations.id, conversationId)).limit(1);
  return rows.length > 0;
}

export async function saveMessage(input: {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  reasoning?: string;
  references?: unknown[];
  activities?: unknown[];
  citations?: unknown[];
  status?: "running" | "done" | "failed" | "cancelled";
}) {
  await ensureAppSchema();
  const db = getDb();
  await db.insert(messages).values({
    id: input.id,
    conversationId: input.conversationId,
    role: input.role,
    text: input.text,
    reasoning: input.reasoning || "",
    referencesJson: JSON.stringify(input.references || []),
    activitiesJson: JSON.stringify(input.activities || []),
    citationsJson: JSON.stringify(input.citations || []),
    status: input.status || "done",
    createdAt: new Date().toISOString(),
  }).onConflictDoUpdate({
    target: messages.id,
    set: {
      text: input.text,
      reasoning: input.reasoning || "",
      referencesJson: JSON.stringify(input.references || []),
      activitiesJson: JSON.stringify(input.activities || []),
      citationsJson: JSON.stringify(input.citations || []),
      status: input.status || "done",
    },
  });
  await db.update(conversations).set({ updatedAt: new Date().toISOString() }).where(eq(conversations.id, input.conversationId));
}

export async function startBuildRun(request: ColdStartRequest) {
  await ensureAppSchema();
  const db = getDb();
  const [project] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, request.projectId), isNull(projects.deletedAt))).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  await db.insert(buildRuns).values({ id: request.runId, projectId: request.projectId, inputJson: JSON.stringify(request), status: "running" })
    .onConflictDoUpdate({ target: buildRuns.id, set: { status: "running", inputJson: JSON.stringify(request), error: null, completedAt: null },
      setWhere: and(eq(buildRuns.projectId, request.projectId), ne(buildRuns.status, "cancelled")) });
  await db.update(projects).set({ status: "building", updatedAt: new Date().toISOString() }).where(and(eq(projects.id, request.projectId), isNull(projects.deletedAt)));
}

export async function appendBuildEvent(event: BuildEvent) {
  await ensureAppSchema();
  const db = getDb();
  await db.insert(buildEvents).values({
    runId: event.runId,
    projectId: event.projectId,
    seq: event.seq,
    kind: event.kind,
    eventJson: JSON.stringify(event),
  }).onConflictDoNothing();
}

export async function completeBuildRun(result: ColdStartBuildResult, conversationId?: string) {
  return commitProjectVersion({
    projectId: result.projectId,
    result,
    sourceRunId: result.runId,
    sourceKind: "cold_start",
    sourceInput: { kind: "cold_start", brief: result.brief },
    conversationId,
    message: `建立“${result.brief.roleTitle}”首个岗位快照`,
    authorKind: "agent",
  });
}

export async function completeFastBuildSnapshot(result: ColdStartBuildResult, conversationId?: string, execution?: { parentVersionId: string | null; jobId: string; jobOwner: string }) {
  return commitProjectVersion({
    projectId: result.projectId,
    result,
    sourceRunId: result.runId,
    sourceKind: "cold_start",
    sourceInput: { kind: "cold_start_fast_snapshot", brief: result.brief },
    conversationId,
    ...execution,
    message: `建立“${result.brief.roleTitle}”岗位内核快照`,
    authorKind: "agent",
  });
}

export async function completeBuildStageRun(runId: string, projectId: string, result: ColdStartBuildResult) {
  await ensureAppSchema();
  const stored = await storeLargeText(getD1(), { table: "build_runs", id: runId, column: "result_json" }, JSON.stringify(result));
  const db = getDb();
  await db.update(buildRuns).set({
    status: "completed",
    resultJson: stored,
    error: null,
    completedAt: new Date().toISOString(),
  }).where(and(eq(buildRuns.id, runId), eq(buildRuns.projectId, projectId), ne(buildRuns.status, "cancelled")));
}

export async function completeEnrichmentBuildSnapshot(
  result: ColdStartBuildResult,
  conversationId: string | undefined,
  stage: "semantic" | "full",
  execution?: { parentVersionId: string | null; jobId: string; jobOwner: string },
) {
  const committed = await commitProjectVersion({
    projectId: result.projectId,
    result,
    sourceRunId: result.runId,
    sourceKind: "cold_start",
    sourceInput: { kind: stage === "semantic" ? "cold_start_semantic_enrichment" : "cold_start_full_enrichment", brief: result.brief },
    conversationId,
    ...execution,
    message: stage === "semantic"
      ? `增量形成“${result.brief.roleTitle}”知识技能与依赖版本`
      : `完成“${result.brief.roleTitle}”事理森林与结构检查版本`,
    authorKind: "agent",
  });
  if (stage === "semantic" && committed.appliedToHead) {
    await getDb().update(projects).set({ status: "building", updatedAt: new Date().toISOString() }).where(and(eq(projects.id, result.projectId), eq(projects.headVersionId, committed.id), isNull(projects.deletedAt)));
  }
  return committed;
}

export async function failBuildRun(runId: string, projectId: string, error: string, cancelled = false) {
  await ensureAppSchema();
  const d1 = getD1();
  await d1.batch([
    d1.prepare("UPDATE build_runs SET status = ?, error = ?, completed_at = ? WHERE id = ? AND project_id=? AND status!='cancelled'")
      .bind(cancelled ? "cancelled" : "failed", error, new Date().toISOString(), runId, projectId),
    d1.prepare("UPDATE projects SET status = CASE WHEN active_version_id IS NOT NULL THEN 'draft' ELSE ? END, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .bind(cancelled ? "draft" : "failed", new Date().toISOString(), projectId),
  ]);
}

export async function saveAssistantFromEvents(input: {
  conversationId: string;
  messageId: string;
  references: unknown[];
  events: AgentEvent[];
}) {
  const message = assistantMessageFromEvents(input);
  await saveMessage({
    id: input.messageId,
    conversationId: input.conversationId,
    role: "assistant",
    ...message,
  });
}

export async function buildRunExists(projectId: string, runId: string) {
  await ensureAppSchema();
  const db = getDb();
  const rows = await db.select({ id: buildRuns.id }).from(buildRuns)
    .where(and(eq(buildRuns.projectId, projectId), eq(buildRuns.id, runId))).limit(1);
  return rows.length > 0;
}

export async function getBuildRunStatus(projectId: string, runId: string) {
  await ensureAppSchema();
  const rows = await getDb().select({
    id: buildRuns.id,
    status: buildRuns.status,
    error: buildRuns.error,
    completedAt: buildRuns.completedAt,
  }).from(buildRuns)
    .where(and(eq(buildRuns.projectId, projectId), eq(buildRuns.id, runId))).limit(1);
  return rows[0] || null;
}

export async function getProjectVersion(projectId: string, versionId?: string | null) {
  await ensureAppSchema();
  const db = getDb();
  const [project] = await db.select({ id: projects.id, headVersionId: projects.headVersionId, activeVersionId: projects.activeVersionId })
    .from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return null;
  const targetId = versionId || project.headVersionId || project.activeVersionId;
  const rows = targetId
    ? await db.select().from(projectVersions).where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.id, targetId))).limit(1)
    : await db.select().from(projectVersions).where(eq(projectVersions.projectId, projectId)).orderBy(desc(projectVersions.createdAt)).limit(1);
  const version = rows[0];
  if (!version) return null;
  const packageJson = await loadLargeText(getD1(), { table: "project_versions", id: version.id, column: "package_json" }, version.packageJson);
  if (!packageJson) return null;
  try {
    return { version, result: normalizeRolePackage(JSON.parse(packageJson) as ColdStartBuildResult) };
  } catch {
    return null;
  }
}

export async function startRiskRun(request: RiskRunRequest & { projectId: string }, baseVersionId: string) {
  await ensureAppSchema();
  const d1 = getD1();
  const now = new Date().toISOString();
  await d1.batch([
    d1.prepare(`INSERT INTO risk_runs (id, project_id, base_version_id, status, mode, phase, input_json, started_at)
      VALUES (?, ?, ?, 'running', ?, 'baseline', ?, ?)
      ON CONFLICT(id) DO UPDATE SET status='running', mode=excluded.mode, phase='baseline', input_json=excluded.input_json, checkpoint_json=NULL, result_json=NULL, error=NULL, completed_at=NULL`)
      .bind(request.runId, request.projectId, baseVersionId, request.mode, JSON.stringify(request), now),
    d1.prepare(`INSERT INTO build_runs (id, project_id, status, input_json, started_at)
      VALUES (?, ?, 'running', ?, ?)
      ON CONFLICT(id) DO UPDATE SET status='running', input_json=excluded.input_json, result_json=NULL, error=NULL, completed_at=NULL`)
      .bind(request.runId, request.projectId, JSON.stringify({ kind: "risk_repair", ...request }), now),
  ]);
}

export async function appendRiskEvent(event: RiskEvent & { projectId: string }) {
  await ensureAppSchema();
  const db = getDb();
  await db.insert(riskEvents).values({
    runId: event.runId,
    projectId: event.projectId,
    seq: event.seq,
    kind: event.kind,
    eventJson: JSON.stringify(event),
  }).onConflictDoNothing();
}

export async function saveRiskCheckpoint(runId: string, phase: string, checkpoint: unknown) {
  await ensureAppSchema();
  const stored = await storeLargeText(getD1(), { table: "risk_runs", id: runId, column: "checkpoint_json" }, JSON.stringify(checkpoint));
  const db = getDb();
  await db.update(riskRuns).set({ phase, checkpointJson: stored }).where(eq(riskRuns.id, runId));
}

export async function completeRiskRun(result: RiskRunResult & { projectId: string }, conversationId?: string) {
  await ensureAppSchema();
  const d1 = getD1();
  const now = new Date().toISOString();
  const committed = result.improved
    ? await commitProjectVersion({
      projectId: result.projectId,
      result: result.candidate,
      sourceRunId: result.runId,
      sourceKind: "iteration",
      sourceInput: { kind: "risk_repair", mode: result.mode },
      conversationId,
      message: `完成岗位风险研究与修复`,
      authorKind: "agent",
    })
    : null;
  const versionId = committed?.id || null;
  if (result.improved && versionId) result.candidateVersionId = versionId;
  const storedResult = await storeLargeText(d1, { table: "risk_runs", id: result.runId, column: "result_json" }, JSON.stringify(result));
  const storedCandidate = await storeLargeText(d1, { table: "build_runs", id: result.runId, column: "result_json" }, JSON.stringify(result.candidate));
  const statements = [
    d1.prepare("UPDATE risk_runs SET status=?, phase='version', candidate_version_id=?, result_json=?, completed_at=? WHERE id=?")
      .bind(result.status === "no_improvement" ? "no_improvement" : "completed", result.improved ? versionId : null, storedResult, now, result.runId),
    d1.prepare("UPDATE build_runs SET status='completed', result_json=?, completed_at=? WHERE id=?")
      .bind(storedCandidate, now, result.runId),
    d1.prepare("DELETE FROM risk_issues WHERE run_id=?").bind(result.runId),
    d1.prepare("DELETE FROM risk_patches WHERE run_id=?").bind(result.runId),
  ];
  for (const issue of result.auditAfter.issues) {
    statements.push(d1.prepare(`INSERT INTO risk_issues (id, project_id, run_id, fingerprint, profile, severity, status, issue_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(issue.id, result.projectId, result.runId, issue.fingerprint, issue.profile, issue.severity, issue.status, JSON.stringify(issue)));
  }
  for (const patch of result.patches) {
    statements.push(d1.prepare(`INSERT INTO risk_patches (id, project_id, run_id, iteration, status, patch_json)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(patch.id, result.projectId, result.runId, patch.iteration, patch.status, JSON.stringify(patch)));
  }
  await d1.batch(statements);
  return versionId;
}

/** Mirror a storage-neutral snapshot candidate into a project timeline. */
export async function saveProjectCandidateFromSnapshotRisk(
  result: RiskRunResult,
  projectId: string,
  conversationId?: string,
) {
  if (!result.improved) return null;
  const request = { kind: "snapshot_risk_repair", ...result.snapshotRef, mode: result.mode };
  const committed = await commitProjectVersion({
    projectId,
    result: result.candidate,
    sourceRunId: result.runId,
    sourceKind: "iteration",
    sourceInput: request,
    conversationId,
    parentVersionId: result.snapshotRef.versionId || null,
    message: "完成岗位风险研究与修复",
    authorKind: "agent",
  });
  return committed.id;
}

/** Mirror a unified iteration result into the owning project's version tree. */
export async function saveProjectCandidateFromIteration(
  result: SnapshotIterationResult,
  projectId: string,
  conversationId?: string,
  execution?: { jobId: string; jobOwner: string },
) {
  const request = {
    kind: "snapshot_iteration",
    ...result.snapshotRef,
    initiativeProfile: result.contract.initiativeProfile,
    objective: result.contract.objective,
  };
  const committed = await commitProjectVersion({
    projectId,
    result: result.candidate,
    sourceRunId: result.runId,
    sourceKind: result.workItems.some((item) => item.origin === "workspace" || item.kind === "instantiate") ? "workspace" : "iteration",
    sourceInput: request,
    conversationId,
    parentVersionId: result.snapshotRef.versionId || null,
    ...execution,
    message: result.createdSnapshot ? result.contract.objective || "迭代岗位快照" : `${result.contract.objective || "迭代岗位快照"}（未改变岗位事实）`,
    authorKind: "agent",
    reuseSnapshotId: result.createdSnapshot ? undefined : result.baseSnapshotId,
  });
  return committed.id;
}

export async function failRiskRun(runId: string, projectId: string, error: string, cancelled = false) {
  await ensureAppSchema();
  const d1 = getD1();
  const status = cancelled ? "cancelled" : "failed";
  const now = new Date().toISOString();
  await d1.batch([
    d1.prepare("UPDATE risk_runs SET status=?, error=?, completed_at=? WHERE id=? AND project_id=? AND status!='cancelled'").bind(status, error, now, runId, projectId),
    d1.prepare("UPDATE build_runs SET status=?, error=?, completed_at=? WHERE id=? AND project_id=? AND status!='cancelled'").bind(status, error, now, runId, projectId),
  ]);
}

export async function getLatestRiskRun(projectId: string) {
  await ensureAppSchema();
  const db = getDb();
  const [run] = await db.select().from(riskRuns).where(eq(riskRuns.projectId, projectId)).orderBy(desc(riskRuns.startedAt)).limit(1);
  if (!run) return null;
  const resultJson = await loadLargeText(getD1(), { table: "risk_runs", id: run.id, column: "result_json" }, run.resultJson);
  const events = await db.select().from(riskEvents).where(eq(riskEvents.runId, run.id)).orderBy(asc(riskEvents.seq));
  return {
    ...run,
    result: resultJson ? JSON.parse(resultJson) as RiskRunResult : null,
    events: events.map((event) => JSON.parse(event.eventJson) as RiskEvent),
  };
}
