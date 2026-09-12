import type { ColdStartBuildResult } from "@/lib/build/types";
import type { StaticRolePackageManifest } from "@/lib/packages/types";
import { refreshRolePackageManifest } from "@/lib/packages/role-package-manifest";
import { canonicalStringify, sha256Hex } from "@/lib/versioning/canonical";

export type ForkOrigin = { packageLineId: string; releaseId: string; packageId: string; packageVersion: string; snapshotId: string; rootHash: string; title: string; license: string };
export async function planHubFork(input: { ownerSubjectId: string; releaseId: string; packageLineId: string; license: string; manifest: StaticRolePackageManifest; result: ColdStartBuildResult }) {
  if (!input.ownerSubjectId || input.manifest.visibility !== "public") throw new Error("PUBLIC_RELEASE_REQUIRED");
  const key = await sha256Hex(canonicalStringify(["hub-fork-v1", input.ownerSubjectId, input.releaseId]));
  const projectId = `fork:${key}`;
  const runId = `fork-run:${key}`;
  const conversationId = `fork-chat:${key}`;
  const packageId = `role-package:project:${projectId}`;
  let result = structuredClone(input.result);
  result.runId = runId;
  result.projectId = projectId;
  result.brief.projectId = projectId;
  result.snapshot.id = `snapshot:fork:${key}`;
  result = refreshRolePackageManifest(result, { packageId, packageVersion: "1.0.0" });
  const upstream: ForkOrigin = { packageLineId: input.packageLineId, releaseId: input.releaseId,
    packageId: input.manifest.packageId, packageVersion: input.manifest.packageVersion,
    snapshotId: input.manifest.snapshotId, rootHash: input.manifest.rootHash,
    title: input.manifest.roleTitle, license: input.license };
  return { projectId, conversationId, runId, packageId, result, upstream };
}

/** Resumable, owner-scoped creation. No overwrite of an existing fork or its conversation. */
export function forkProjectStatements(d1: D1Database, plan: Awaited<ReturnType<typeof planHubFork>>, owner: string) {
  return [
    d1.prepare(`INSERT INTO projects(id,title,description,market,status,owner_subject_id)
      VALUES(?,?,?,?,'draft',?) ON CONFLICT(id) DO NOTHING`)
      .bind(plan.projectId,plan.result.brief.roleTitle,plan.result.brief.roleDescription,plan.result.brief.market,owner),
    d1.prepare(`INSERT INTO conversations(id,project_id,title,mode)
      SELECT ?,?,'Fork 岗位维护','explanation' WHERE EXISTS(SELECT 1 FROM projects WHERE id=? AND owner_subject_id=? AND deleted_at IS NULL)
      ON CONFLICT(id) DO NOTHING`).bind(plan.conversationId,plan.projectId,plan.projectId,owner),
  ];
}
