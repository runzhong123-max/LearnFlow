import { projectReleasePackageId } from "@/lib/releases/package-identity";
import { resolveLearnFlowIdentity, type LearnFlowIdentity } from "@/lib/integrations/learnflow/auth";
import type { ProjectActor } from "@/lib/projects/lifecycle";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";

// The identity-only routes remain usable without loading the Worker database binding.
let database: typeof import("@/db") | undefined;
async function ensureAppSchema() { database ||= await import("@/db"); await database.ensureAppSchema(); }
function getD1() { if (!database) throw new Error("DATABASE_NOT_READY"); return database.getD1(); }

export class AccessError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export type AccessActor = ProjectActor;
type ProjectRow = { id: string; owner_subject_id: string | null; deleted_at: string | null };
const actorCache = new WeakMap<Request, Promise<LearnFlowIdentity>>();

export function accessErrorResponse(error: unknown) {
  const known = error instanceof AccessError;
  return Response.json({ error: known ? error.code : "IDENTITY_SERVICE_UNAVAILABLE" }, {
    status: known ? error.status : 503, headers: { "Cache-Control": "private, no-store" },
  });
}

/** Only the verified identity bridge establishes an actor. Names and request body IDs never do. */
export function requestActor(request: Request): Promise<LearnFlowIdentity> {
  let pending = actorCache.get(request);
  if (!pending) {
    pending = (async () => {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        const origin = request.headers.get("origin");
        const allowed = [new URL(request.url).origin];
        for (const configured of [process.env.ROLE_ATLAS_PUBLIC_URL, process.env.GRAPH_HUB_PUBLIC_URL]) {
          if (configured) allowed.push(new URL(configured).origin);
        }
        if (origin && !allowed.includes(origin)) throw new AccessError(403, "CROSS_ORIGIN_WRITE_REJECTED");
      }
      const baseUrl = process.env.LEARNFLOW_BASE_URL;
      if (!baseUrl) throw new AccessError(503, "IDENTITY_SERVICE_NOT_CONFIGURED");
      const actor = await resolveLearnFlowIdentity({ request, baseUrl });
      if (!actor) throw new AccessError(401, "LOGIN_REQUIRED");
      return actor;
    })();
    actorCache.set(request, pending);
  }
  return pending;
}

export function mayAccessOwnedProject(owner: string | null, actor: AccessActor, maintenance = false) {
  return Boolean(owner && owner === actor.subjectId) || (maintenance && actor.role === "admin");
}

export async function requireProjectAccess(actor: AccessActor | null, projectId: string, options: { includeDeleted?: boolean; maintenance?: boolean } = {}) {
  if (!actor) throw new AccessError(401, "LOGIN_REQUIRED");
  await ensureAppSchema();
  const row = await getD1().prepare("SELECT id, owner_subject_id, deleted_at FROM projects WHERE id=?").bind(projectId).first<ProjectRow>();
  if (!row || (row.deleted_at && !options.includeDeleted)) throw new AccessError(404, "PROJECT_NOT_FOUND");
  if (!mayAccessOwnedProject(row.owner_subject_id, actor, options.maintenance)) throw new AccessError(404, "PROJECT_NOT_FOUND");
  return row;
}

async function projectForVersion(id: string) {
  await ensureAppSchema();
  const row = await getD1().prepare("SELECT project_id, snapshot_id FROM project_versions WHERE id=?").bind(id).first<{ project_id: string; snapshot_id: string }>();
  if (!row) throw new AccessError(404, "VERSION_NOT_FOUND");
  return row;
}

export async function requireConversationAccess(actor: AccessActor, conversationId: string, projectId?: string) {
  await ensureAppSchema();
  const row = await getD1().prepare("SELECT id, project_id FROM conversations WHERE id=?").bind(conversationId).first<{ id: string; project_id: string }>();
  if (!row) throw new AccessError(404, "CONVERSATION_NOT_FOUND");
  if (projectId && row.project_id !== projectId) throw new AccessError(403, "CONVERSATION_PROJECT_MISMATCH");
  await requireProjectAccess(actor, row.project_id);
  return row;
}

type ReleaseRow = { id: string; project_id: string | null; package_line_id: string; snapshot_id: string; status: string; visibility: string; artifact_root_hash: string | null; published_at: string | null; artifact_visibility?: string | null };
export function isPublicRelease(row: Pick<ReleaseRow, "visibility" | "status" | "artifact_root_hash" | "published_at" | "artifact_visibility">) {
  return row.visibility === "public" && row.artifact_visibility === "public" && ["published", "deprecated"].includes(row.status) && Boolean(row.artifact_root_hash && row.published_at);
}
export async function requireReleaseAccess(actor: AccessActor | null, releaseId: string, write = false) {
  await ensureAppSchema();
  const row = await getD1().prepare(`SELECT r.*, l.visibility, json_extract(a.content, '$.manifest.visibility') AS artifact_visibility FROM package_releases r JOIN package_lines l ON l.id=r.package_line_id LEFT JOIN package_artifacts a ON a.root_hash=r.artifact_root_hash WHERE r.id=?`).bind(releaseId).first<ReleaseRow>();
  if (!row) throw new AccessError(404, "RELEASE_NOT_FOUND");
  if (!write && isPublicRelease(row)) return row;
  if (!actor) throw new AccessError(401, "LOGIN_REQUIRED");
  if (!row.project_id) throw new AccessError(404, "RELEASE_NOT_FOUND");
  await requireProjectAccess(actor, row.project_id);
  return row;
}

export async function requirePackageLineAccess(actor: AccessActor | null, id: string, write = false) {
  await ensureAppSchema();
  const line = await getD1().prepare("SELECT id FROM package_lines WHERE id=? OR package_id=?").bind(id, id).first<{ id: string }>();
  if (!line) throw new AccessError(404, "PACKAGE_NOT_FOUND");
  const releases = await getD1().prepare(`SELECT r.*, l.visibility, json_extract(a.content, '$.manifest.visibility') AS artifact_visibility FROM package_releases r JOIN package_lines l ON l.id=r.package_line_id LEFT JOIN package_artifacts a ON a.root_hash=r.artifact_root_hash WHERE l.id=?`).bind(line.id).all<ReleaseRow>();
  if (!write && releases.results.some(isPublicRelease)) return line;
  if (!actor) throw new AccessError(401, "LOGIN_REQUIRED");
  // One owner's release cannot grant control of a shared or historical package line.
  if (!releases.results.length || releases.results.some(row => !row.project_id)) throw new AccessError(404, "PACKAGE_NOT_FOUND");
  for (const row of releases.results) await requireProjectAccess(actor, row.project_id!);
  return line;
}

export async function requireSnapshotAccess(actor: AccessActor | null, input: { snapshotId?: string; projectId?: string; versionId?: string; packageVersion?: string }, write = false) {
  await ensureAppSchema();
  if (input.projectId) {
    if (!actor) throw new AccessError(401, "LOGIN_REQUIRED");
    await requireProjectAccess(actor, input.projectId);
    if (input.versionId) {
      const version = await projectForVersion(input.versionId);
      if (version.project_id !== input.projectId || (input.snapshotId && version.snapshot_id !== input.snapshotId)) throw new AccessError(403, "VERSION_PROJECT_MISMATCH");
    }
    if (input.snapshotId) {
      const version = await getD1().prepare("SELECT id FROM project_versions WHERE project_id=? AND snapshot_id=? LIMIT 1").bind(input.projectId, input.snapshotId).first();
      if (!version) throw new AccessError(403, "SNAPSHOT_PROJECT_MISMATCH");
    }
    return input.projectId;
  }
  if (!input.snapshotId) throw new AccessError(400, "SNAPSHOT_REQUIRED");
  if (!write && input.snapshotId === bundledRoleSnapshot().snapshot.id) return undefined;
  const versions = await getD1().prepare("SELECT project_id FROM project_versions WHERE snapshot_id=?").bind(input.snapshotId).all<{ project_id: string }>();
  if (actor) {
    for (const version of versions.results) {
      try { await requireProjectAccess(actor, version.project_id); return version.project_id; }
      catch (error) { if (!(error instanceof AccessError)) throw error; }
    }
  }
  if (!write) {
    const releases = await getD1().prepare(`SELECT r.*, l.visibility, json_extract(a.content, '$.manifest.visibility') AS artifact_visibility FROM package_releases r JOIN package_lines l ON l.id=r.package_line_id LEFT JOIN package_artifacts a ON a.root_hash=r.artifact_root_hash
      WHERE r.snapshot_id=? AND (? IS NULL OR r.package_version=?)`).bind(input.snapshotId, input.packageVersion || null, input.packageVersion || null).all<ReleaseRow>();
    if (releases.results.some(isPublicRelease)) return undefined;
  }
  throw new AccessError(actor ? 404 : 401, "SNAPSHOT_NOT_FOUND");
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown) { return typeof value === "string" && value.length ? value : undefined; }
async function optionalActor(request: Request) {
  try { return await requestActor(request); } catch (error) { if (error instanceof AccessError && [401, 503].includes(error.status)) return null; throw error; }
}

/** Explicitly invoked by route handlers before any reads, writes, or provider calls. */
export async function authorizeApiRequest(request: Request): Promise<Response | undefined> {
  try {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const read = ["GET", "HEAD"].includes(request.method);
    const publicRead = read && (path === "/api/snapshots/resolve" || path === "/api/reference-migrations" || /^\/api\/(registry\/[^/]+|releases\/[^/]+\/export)$/u.test(path) || (path === "/api/registry" && url.searchParams.get("scope") === "public"));
    const actor = publicRead ? await optionalActor(request) : await requestActor(request);
    const body = read || path === "/api/packages/import" ? {} : object(await request.clone().json().catch(() => ({})));
    const params = Object.fromEntries(url.searchParams);
    if (path === "/api/packages/import") {
      // Legacy imports write the global registry without ownership. Only an explicit maintenance request may do so.
      if (actor?.role !== "admin" || url.searchParams.get("scope") !== "maintenance") throw new AccessError(403, "PERSONAL_IMPORT_REQUIRES_OWNED_PROJECT");
      return;
    }
    await ensureAppSchema();
    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(?:\/|$)/u);
    let projectId = string(body.projectId) || string(params.projectId);
    if (projectMatch && projectMatch[1] !== "trash") {
      projectId = projectMatch[1];
      const maintenance = url.searchParams.get("scope") === "maintenance";
      await requireProjectAccess(actor!, projectId, { includeDeleted: request.method === "PATCH", maintenance });
    }
    const build = object(body.build), iteration = object(body.iteration), risk = object(body.risk), workspace = object(body.workspace);
    const snapshotRef = object(body.snapshotRef || iteration.snapshotRef || risk.snapshotRef);
    const nestedProjects = [projectId, string(build.projectId), string(iteration.projectId), string(risk.projectId), string(workspace.projectId), string(snapshotRef.projectId)].filter(Boolean) as string[];
    if (new Set(nestedProjects).size > 1) throw new AccessError(403, "PROJECT_SCOPE_MISMATCH");
    projectId = nestedProjects[0];
    if (projectId && !projectMatch) await requireProjectAccess(actor!, projectId);
    const conversationMatch = path.match(/^\/api\/conversations\/([^/]+)/u) || path.match(/^\/api\/projects\/[^/]+\/conversations\/([^/]+)/u);
    const conversationId = conversationMatch?.[1] || (path === "/api/projects" ? undefined : string(body.conversationId)) || string(iteration.conversationId) || string(params.conversationId) || string(params.conversation) || (path === "/api/agent" && projectId ? string(body.sessionId) : undefined);
    if (conversationId) {
      const conversation = await requireConversationAccess(actor!, conversationId, projectId);
      projectId ||= conversation.project_id;
    }
    if (path === "/api/agent" && !projectId) {
      // Arbitrary sample sessions cannot impersonate an existing private conversation.
      const sessionId = string(body.sessionId);
      if (sessionId) {
        await ensureAppSchema();
        const existing = await getD1().prepare("SELECT project_id FROM conversations WHERE id=?").bind(sessionId).first();
        if (existing) throw new AccessError(403, "PROJECT_SCOPE_REQUIRED");
      }
    }
    if (path === "/api/agent" && projectId) {
      const messageId = string(body.messageId) || string(body.runId);
      for (const id of messageId ? [messageId, `${messageId}:user`] : []) {
        const existing = await getD1().prepare("SELECT conversation_id FROM messages WHERE id=?").bind(id).first<{ conversation_id: string }>();
        if (existing && existing.conversation_id !== conversationId) throw new AccessError(403, "MESSAGE_CONVERSATION_MISMATCH");
      }
    }
    const versionIds = [body.projectVersionId, body.targetVersionId, body.versionId, body.expectedHeadVersionId, params.from, params.to, params.versionId, path.match(/^\/api\/projects\/[^/]+\/versions\/([^/]+)\/adopt$/u)?.[1]].map(string).filter(Boolean) as string[];
    for (const id of versionIds) {
      const version = await projectForVersion(id);
      await requireProjectAccess(actor!, version.project_id);
      if (projectId && version.project_id !== projectId) throw new AccessError(403, "VERSION_PROJECT_MISMATCH");
    }
    const snapshotIds = [params.snapshotId, params.fromSnapshotId, params.toSnapshotId, body.baseSnapshotId, snapshotRef.snapshotId].map(string).filter(Boolean) as string[];
    const mutatingSnapshot = !read && ["/api/snapshot-iterations", "/api/workspace-upgrades", "/api/risk-runs", "/api/workspaces/ingest"].includes(path);
    for (const snapshotId of snapshotIds) {
      const target = await requireSnapshotAccess(actor, { snapshotId, projectId: string(snapshotRef.projectId) || projectId, versionId: string(snapshotRef.versionId) || string(params.versionId), packageVersion: string(snapshotRef.packageVersion) || string(params.packageVersion) }, mutatingSnapshot);
      if (mutatingSnapshot && !projectId && target) throw new AccessError(400, "PROJECT_SCOPE_REQUIRED");
    }
    if (mutatingSnapshot && !projectId) throw new AccessError(400, "OWNED_PROJECT_REQUIRED");
    // Run IDs are global primary keys. A replay may not take over another project's journal or lease.
    const runIds = [body.runId, build.runId, iteration.runId, risk.runId, workspace.runId].map(string).filter(Boolean) as string[];
    for (const runId of runIds) {
      for (const table of ["build_runs", "risk_runs", "snapshot_risk_runs", "snapshot_iteration_runs", "workspace_ingestion_runs", "role_jobs"]) {
        const existing = await getD1().prepare(`SELECT project_id FROM ${table} WHERE id=?`).bind(runId).first<{ project_id: string | null }>();
        if (existing && (!existing.project_id || existing.project_id !== projectId)) throw new AccessError(403, "RUN_SCOPE_MISMATCH");
      }
    }
    const jobId = path.match(/^\/api\/jobs\/([^/]+)/u)?.[1] || path.match(/^\/api\/projects\/[^/]+\/jobs\/([^/]+)/u)?.[1];
    if (jobId) {
      const job = await getD1().prepare("SELECT project_id FROM role_jobs WHERE id=?").bind(jobId).first<{ project_id: string | null }>();
      if (!job?.project_id) throw new AccessError(404, "JOB_NOT_FOUND");
      await requireProjectAccess(actor!, job.project_id);
      if (projectId && projectId !== job.project_id) throw new AccessError(403, "JOB_PROJECT_MISMATCH");
    }
    const releaseIds = [body.releaseId, body.targetReleaseId, body.expectedCurrentReleaseId, path.match(/^\/api\/releases\/([^/]+)\/export$/u)?.[1]].map(string).filter(Boolean) as string[];
    for (const releaseId of releaseIds) {
      const release = await requireReleaseAccess(actor, releaseId, !read);
      if (!read) await requirePackageLineAccess(actor, release.package_line_id, true);
      if (projectId && release.project_id !== projectId) throw new AccessError(403, "RELEASE_PROJECT_MISMATCH");
      if (body.packageLineId && body.packageLineId !== release.package_line_id) throw new AccessError(403, "RELEASE_PACKAGE_MISMATCH");
    }
    const lineIds = [body.packageLineId, body.supersededByPackageLineId, path.match(/^\/api\/registry\/([^/]+)$/u)?.[1]].map(string).filter(Boolean) as string[];
    for (const id of lineIds) await requirePackageLineAccess(actor, id, !read);
    if (path === "/api/releases" && request.method === "POST") {
      if (!projectId) throw new AccessError(400, "PROJECT_SCOPE_REQUIRED");
      let packageId: string;
      try { packageId = await projectReleasePackageId(getD1(), { projectId, packageId: string(body.packageId) }); }
      catch (error) {
        if (error instanceof Error && error.message === "PACKAGE_ID_PROJECT_MISMATCH") throw new AccessError(403, error.message);
        throw error;
      }
      if (packageId) {
        const existing = await getD1().prepare("SELECT id FROM package_lines WHERE package_id=?").bind(packageId).first<{ id: string }>();
        if (existing) await requirePackageLineAccess(actor, existing.id, true);
      }
    }
    // References are immutable but still private. Never disclose another account's snapshot through an agent tool.
    for (const raw of Array.isArray(body.references) ? body.references : []) {
      const ref = object(raw);
      if (string(ref.snapshotId)) await requireSnapshotAccess(actor, { snapshotId: string(ref.snapshotId), packageVersion: string(ref.packageVersion) });
    }
    return;
  } catch (error) { return accessErrorResponse(error); }
}

/** Resolve only a selected owner's project version or a specifically public immutable artifact. */
export async function resolveAccessibleSnapshot(actor: AccessActor | null, input: { snapshotId?: string; projectId?: string; versionId?: string; packageVersion?: string }) {
  const projectId = await requireSnapshotAccess(actor, input);
  const { resolveSnapshot } = await import("@/lib/snapshots/resolver");
  if (projectId) return resolveSnapshot({ ...input, projectId });
  if (input.snapshotId === bundledRoleSnapshot().snapshot.id) return resolveSnapshot(input);
  const candidates = await getD1().prepare(`SELECT r.id FROM package_releases r JOIN package_lines l ON l.id=r.package_line_id
    JOIN package_artifacts a ON a.root_hash=r.artifact_root_hash WHERE r.snapshot_id=? AND (? IS NULL OR r.package_version=?)
    AND l.visibility='public' AND r.status IN ('published','deprecated') AND r.published_at IS NOT NULL
    AND json_extract(a.content, '$.manifest.visibility')='public' ORDER BY r.published_at DESC`).bind(input.snapshotId || "", input.packageVersion || null, input.packageVersion || null).all<{ id: string }>();
  const { getReleaseWithArtifact } = await import("@/lib/releases/resolver");
  const released = candidates.results[0] ? await getReleaseWithArtifact(candidates.results[0].id) : null;
  if (!released) return null;
  return {
    reference: { snapshotId: released.result.snapshot.id, packageVersion: released.release.packageVersion },
    title: released.result.brief.roleTitle, description: released.result.brief.roleDescription, market: released.result.brief.market,
    version: { id: released.release.id, version: released.release.packageVersion, status: released.release.status, snapshotId: released.result.snapshot.id },
    result: released.result, source: "registry" as const,
  };
}
