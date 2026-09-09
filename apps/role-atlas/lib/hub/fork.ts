import { ensureAppSchema, getD1 } from "@/db";
import { AccessError, isPublicRelease } from "@/lib/access";
import { getReleaseWithArtifact } from "@/lib/releases/resolver";
import { prepareRelease, publishRelease } from "@/lib/releases/service";
import { validatePackageBundle } from "@/lib/packages/validator";
import { commitProjectVersion } from "@/lib/versioning/commit";
import { forkProjectStatements, planHubFork } from "./fork-plan";

export async function forkPublicRelease(input: { ownerSubjectId: string; releaseId: string }) {
  await ensureAppSchema();
  const source = await getReleaseWithArtifact(input.releaseId);
  if (!source?.line || source.line.status !== "active" || source.release.status !== "published" || !isPublicRelease({
    visibility: source.line.visibility, artifact_visibility: source.bundle.manifest.visibility,
    status: source.release.status, artifact_root_hash: source.release.artifactRootHash, published_at: source.release.publishedAt,
  })) throw new AccessError(404, "PUBLIC_RELEASE_NOT_FOUND");
  const validation = await validatePackageBundle(source.bundle);
  if (!validation.valid || source.bundle.manifest.rootHash !== source.release.artifactRootHash
    || source.bundle.manifest.packageId !== source.line.packageId
    || source.bundle.manifest.packageVersion !== source.release.packageVersion
    || source.bundle.manifest.snapshotId !== source.release.snapshotId) throw new Error("UPSTREAM_ARTIFACT_INVALID");
  const plan = await planHubFork({ ...input, packageLineId: source.line.id, license: source.line.license, manifest: source.bundle.manifest, result: source.result });
  const d1 = getD1();
  await d1.batch(forkProjectStatements(d1, plan, input.ownerSubjectId));
  const project = await d1.prepare("SELECT owner_subject_id,deleted_at FROM projects WHERE id=?").bind(plan.projectId)
    .first<{ owner_subject_id: string; deleted_at: string | null }>();
  if (!project || project.owner_subject_id !== input.ownerSubjectId) throw new AccessError(404,"PROJECT_NOT_FOUND");
  if (project.deleted_at) throw new Error("FORK_IN_RECYCLE_BIN");
  // Preserve provenance in the existing import run and immutable version history.
  const version = await commitProjectVersion({ projectId: plan.projectId, result: plan.result, sourceRunId: plan.runId,
    sourceKind: "import", sourceInput: { kind: "hub_fork", upstream: plan.upstream }, conversationId: plan.conversationId,
    message: `Fork 自 ${plan.upstream.title} · ${plan.upstream.packageId}@${plan.upstream.packageVersion} · ${plan.upstream.rootHash}`,
    authorKind: "user" });
  // A retry after later user iterations must not move their current recommendation back to the fork baseline.
  let release = await d1.prepare("SELECT id,status FROM package_releases WHERE project_id=? AND source_project_version_id=? AND package_version='1.0.0'")
    .bind(plan.projectId,version.id).first<{ id: string; status: string }>();
  if (!release) {
    try {
      release = await prepareRelease({ projectId: plan.projectId, projectVersionId: version.id, packageId: plan.packageId,
        packageVersion: "1.0.0", visibility: "private", evidencePolicy: source.bundle.manifest.evidencePolicy,
        registry: { maintainerName: "个人 Fork", maintainerKind: "individual", maintenanceKind: "private", license: source.line.license,
          maintenancePolicy: { reviewCadence: "由本人维护", notes: `Fork 自 ${plan.upstream.packageId}@${plan.upstream.packageVersion}` } } });
    } catch(error) {
      if (!(error instanceof Error) || !/UNIQUE/.test(error.message)) throw error;
      throw new Error("FORK_RETRY_REQUIRED");
    }
  }
  if (release.status === "ready") await publishRelease({ releaseId: release.id, actorKind: "user" });
  else if (release.status !== "published") throw new Error("FORK_PACKAGE_NOT_READY");
  return { projectId: plan.projectId, conversationId: plan.conversationId, releaseId: release.id, upstream: plan.upstream };
}
