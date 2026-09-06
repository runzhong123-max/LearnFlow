import { reconstructBuildResult } from "@/lib/packages/compiler";
import { validatePackageBundle } from "@/lib/packages/validator";
import { canonicalStringify } from "@/lib/versioning/canonical";
import { GatewayError, type Actor } from "./protocol";
import type { RolePackageRef } from "@/lib/learning-path/contract";
import type { AgentRun, GatewayRepository } from "./service";
// Unowned legacy projects remain private. Admins do not gain cross-owner package access here.
const visibility = `(p.deleted_at IS NULL AND ((l.visibility='public' AND l.status='active' AND r.status='published') OR (p.owner_subject_id=? AND r.status IN ('ready','published','deprecated'))))`;
const joins = `FROM package_releases r JOIN package_lines l ON l.id=r.package_line_id LEFT JOIN projects p ON p.id=r.project_id`;
type Row = { packageId: string; packageVersion: string; snapshotId: string; rootHash: string; title: string; visibility: string };
const columns = `l.package_id AS packageId, r.package_version AS packageVersion, r.snapshot_id AS snapshotId, r.artifact_root_hash AS rootHash, l.title AS title, l.visibility AS visibility`;
const ref = (r: Row): RolePackageRef => ({ packageId: r.packageId, packageVersion: r.packageVersion, snapshotId: r.snapshotId, rootHash: r.rootHash });
export function createEcosystemRepository(getDatabase: () => Promise<D1Database>, getPackageArtifact: (hash: string) => Promise<{ bundle: import("@/lib/packages/types").StaticRolePackageBundle } | null>): GatewayRepository {
async function ready() {
  const db = await getDatabase();
  await db.prepare(`CREATE TABLE IF NOT EXISTS ecosystem_agent_runs (id TEXT PRIMARY KEY, owner_subject_id TEXT NOT NULL, request_id TEXT NOT NULL, body_hash TEXT NOT NULL, run_json TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL, UNIQUE(owner_subject_id,request_id))`).run();
  return db;
}
return {
  async search(actor, input) {
    const db = await ready(), needle = `%${input.query.replace(/[\\%_]/g, "\\$&")}%`;
    const where = `${visibility} AND r.artifact_root_hash IS NOT NULL AND (l.title LIKE ? ESCAPE '\\' OR l.package_id LIKE ? ESCAPE '\\')`;
    const count = await db.prepare(`SELECT COUNT(*) AS total ${joins} WHERE ${where}`).bind(actor.sub, needle, needle).first<{ total: number }>();
    const rows = await db.prepare(`SELECT ${columns} ${joins} WHERE ${where} ORDER BY r.published_at DESC, r.id LIMIT ? OFFSET ?`).bind(actor.sub, needle, needle, input.limit, input.offset).all<Row>();
    return { items: rows.results.map(r => ({ packageRef: ref(r), title: r.title, summary: `已固定版本 ${r.packageVersion} 的岗位能力图谱`, visibility: r.visibility })), total: count?.total || 0, ...input, truncated: input.offset + rows.results.length < (count?.total || 0) };
  },
  async load(actor, requested) {
    const db = await ready();
    const row = await db.prepare(`SELECT ${columns} ${joins} WHERE ${visibility} AND l.package_id=? AND r.package_version=? AND r.snapshot_id=? AND r.artifact_root_hash=? LIMIT 1`).bind(actor.sub, requested.packageId, requested.packageVersion, requested.snapshotId, requested.rootHash).first<Row>();
    if (!row) throw new GatewayError("PACKAGE_NOT_FOUND", 404);
    const artifact = await getPackageArtifact(row.rootHash);
    if (!artifact) throw new GatewayError("PACKAGE_ARTIFACT_UNAVAILABLE", 502);
    const m = artifact.bundle.manifest;
    if (Object.values(m.entrypoints).some(path => !Object.hasOwn(m.hashes, path)) || Object.keys(artifact.bundle.components).some(path => !Object.hasOwn(m.hashes, path))) throw new GatewayError("PACKAGE_INTEGRITY_FAILED", 502);
    if (canonicalStringify({ packageId: m.packageId, packageVersion: m.packageVersion, snapshotId: m.snapshotId, rootHash: m.rootHash }) !== canonicalStringify(requested) || !(await validatePackageBundle(artifact.bundle)).valid) throw new GatewayError("PACKAGE_INTEGRITY_FAILED", 502);
    const result = reconstructBuildResult(artifact.bundle);
    if (result.packages.rolePackage.packageId !== requested.packageId || result.packages.rolePackage.packageVersion !== requested.packageVersion || result.snapshot.id !== requested.snapshotId) throw new GatewayError("PACKAGE_INTEGRITY_FAILED", 502);
    return { packageRef: requested, title: row.title, result };
  },
  async getRun(actor, id) {
    const db = await ready();
    const row = await db.prepare("SELECT run_json, status, expires_at FROM ecosystem_agent_runs WHERE id=? AND owner_subject_id=?").bind(id, actor.sub).first<{ run_json: string; status: string; expires_at: number }>();
    if (!row) return null;
    const run = JSON.parse(row.run_json) as AgentRun;
    if (row.status === "running" && row.expires_at < Date.now()) {
      const failed: AgentRun = { ...run, status: "failed", error: { code: "AGENT_RUN_INTERRUPTED" } };
      await this.finishRun(actor, failed); return failed;
    }
    return run;
  },
  async claimRun(actor, requestId, bodyHash, run) {
    const db = await ready();
    const inserted = await db.prepare("INSERT OR IGNORE INTO ecosystem_agent_runs (id,owner_subject_id,request_id,body_hash,run_json,status,expires_at) VALUES (?,?,?,?,?,'running',?)").bind(run.runId, actor.sub, requestId, bodyHash, JSON.stringify(run), Date.now() + 60_000).run();
    const row = await db.prepare("SELECT body_hash FROM ecosystem_agent_runs WHERE id=? AND owner_subject_id=?").bind(run.runId, actor.sub).first<{ body_hash: string }>();
    if (!row || row.body_hash !== bodyHash) throw new GatewayError("IDEMPOTENCY_CONFLICT", 409);
    return { created: inserted.meta.changes === 1, run: (await this.getRun(actor, run.runId))! };
  },
  async finishRun(actor: Actor, run: AgentRun) {
    const db = await ready();
    await db.prepare("UPDATE ecosystem_agent_runs SET run_json=?,status=? WHERE id=? AND owner_subject_id=? AND status='running'").bind(JSON.stringify(run), run.status, run.runId, actor.sub).run();
  },
};

}
