import { projectReleasePackageId } from "./package-identity";
import { assertReleaseQuality, validateReleaseArtifact } from "./quality";
import { and, desc, eq } from "drizzle-orm";
import { ensureAppSchema, getD1, getDb } from "@/db";
import { packageLines, packageReleases, releaseEvents } from "@/db/schema";
import { getPackageArtifact, putPackageArtifact } from "@/lib/packages/artifact-store";
import { compileStaticRolePackage } from "@/lib/packages/compiler";
import type { EvidencePolicy, PackageVisibility } from "@/lib/packages/types";
import { ensureRegistryPackageLine } from "@/lib/registry/repository";
import type { RegistryMetadata } from "@/lib/registry/types";
import { canonicalStringify, domainId, sha256Hex } from "@/lib/versioning/canonical";
import { getProjectVersionRecord } from "@/lib/versioning/commit";
import { createSemanticDiff } from "@/lib/versioning/diff";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export async function listProjectReleases(projectId: string) {
  await ensureAppSchema();
  const releases = await getDb().select().from(packageReleases).where(eq(packageReleases.projectId, projectId)).orderBy(desc(packageReleases.createdAt));
  return Promise.all(releases.map(describeRelease));
}

export async function describeRelease(release: typeof packageReleases.$inferSelect) {
  const artifact = release.artifactRootHash ? await getPackageArtifact(release.artifactRootHash) : null;
  const validation = artifact ? await validateReleaseArtifact(artifact.bundle) : null;
  return { ...release, visibility: artifact?.bundle.manifest.visibility ?? null, evidencePolicy: artifact?.bundle.manifest.evidencePolicy ?? null,
    validation, canPublish: release.status === "ready" && validation?.publishable === true };
}

export async function prepareRelease(input: {
  projectId: string;
  projectVersionId: string;
  packageVersion: string;
  packageId?: string;
  visibility?: PackageVisibility;
  evidencePolicy?: EvidencePolicy;
  registry?: RegistryMetadata;
  /** Internal learning-source preparation remains private and cannot bypass publication checks. */
  sourceUse?: "learning_path";
}) {
  if (!SEMVER.test(input.packageVersion)) throw new Error("INVALID_SEMVER");
  const version = await getProjectVersionRecord(input.projectId, input.projectVersionId);
  if (!version) throw new Error("VERSION_NOT_FOUND");
  const metadata: RegistryMetadata = {
    ...input.registry,
    visibility: input.visibility || input.registry?.visibility || "private",
    evidencePolicy: input.evidencePolicy || input.registry?.evidencePolicy || "metadata",
  };
  if (input.sourceUse && (metadata.visibility !== "private" || metadata.evidencePolicy !== "metadata")) throw new Error("LEARNING_SOURCE_MUST_BE_PRIVATE");
  const packageId = await projectReleasePackageId(getD1(), input);
  const line = await ensureRegistryPackageLine({ result: version.result, packageId, metadata });
  const db = getDb();
  const [duplicate] = await db.select().from(packageReleases).where(and(
    eq(packageReleases.packageLineId, line.id),
    eq(packageReleases.packageVersion, input.packageVersion),
  )).limit(1);
  if (duplicate) {
    // A package version is immutable. Reusing its number must identify exactly the
    // same source and disclosure policy, even when the mutable line has changed.
    const artifact = duplicate.artifactRootHash ? await getPackageArtifact(duplicate.artifactRootHash) : null;
    const manifest = artifact?.bundle.manifest;
    if (duplicate.projectId !== input.projectId || duplicate.sourceProjectVersionId !== input.projectVersionId || duplicate.snapshotId !== version.snapshotId) throw new Error("RELEASE_VERSION_CONFLICT");
    // A terminated private source compiler may leave its claim without an artifact. Recompile only that exact source.
    const resumableSource = input.sourceUse === "learning_path" && !manifest && ["compiling", "validating", "failed"].includes(duplicate.status);
    if (!resumableSource && (!manifest || manifest.rootHash !== duplicate.artifactRootHash
      || manifest.packageId !== line.packageId || manifest.packageVersion !== input.packageVersion
      || manifest.sourceProjectVersionId !== input.projectVersionId || manifest.sourceRootHash !== version.rootHash
      || manifest.snapshotId !== version.snapshotId || duplicate.snapshotId !== version.snapshotId
      || manifest.visibility !== metadata.visibility || manifest.evidencePolicy !== metadata.evidencePolicy)) {
      throw new Error("RELEASE_VERSION_CONFLICT");
    }
    if (!resumableSource) return duplicate;
  }

  const id = duplicate?.id || domainId("release");
  if (!duplicate) await db.insert(packageReleases).values({
    id,
    packageLineId: line.id,
    projectId: input.projectId,
    sourceProjectVersionId: input.projectVersionId,
    snapshotId: version.snapshotId,
    snapshotAsOf: version.result.snapshot.asOf,
    packageVersion: input.packageVersion,
    protocolVersion: "3.0.0",
    status: "compiling",
    supersedesReleaseId: line.recommendedReleaseId,
  });
  try {
    let migrations: unknown[] = [];
    if (version.parentVersionId) {
      const diff = await createSemanticDiff({ projectId: input.projectId, fromVersionId: version.parentVersionId, toVersionId: version.id });
      migrations = diff.migrations;
    }
    await db.update(packageReleases).set({ status: "validating" }).where(eq(packageReleases.id, id));
    const compiled = await compileStaticRolePackage({
      result: version.result,
      packageId: line.packageId,
      packageVersion: input.packageVersion,
      sourceProjectVersionId: version.id,
      sourceRootHash: version.rootHash,
      visibility: metadata.visibility || "private",
      evidencePolicy: metadata.evidencePolicy || "metadata",
      referenceMigrations: migrations,
    });
    await putPackageArtifact(compiled.bundle);
    const validationReportHash = await sha256Hex(canonicalStringify(compiled.validation));
    if (!compiled.validation.valid || (!compiled.validation.publishable && input.sourceUse !== "learning_path")) {
      await db.update(packageReleases).set({
        status: "failed",
        artifactRootHash: compiled.bundle.manifest.rootHash,
        validationReportHash,
        error: [...compiled.validation.hardErrors, ...(compiled.validation.publicationBlockers || [])].join("\n"),
      }).where(eq(packageReleases.id, id));
    } else {
      await db.update(packageReleases).set({
        status: "ready",
        artifactRootHash: compiled.bundle.manifest.rootHash,
        validationReportHash,
      }).where(eq(packageReleases.id, id));
    }
  } catch (error) {
    await db.update(packageReleases).set({ status: "failed", error: error instanceof Error ? error.message : String(error) }).where(eq(packageReleases.id, id));
  }
  const [release] = await db.select().from(packageReleases).where(eq(packageReleases.id, id)).limit(1);
  return release;
}

export async function publishRelease(input: { releaseId: string; expectedVisibility?: PackageVisibility; actorKind?: "user" | "agent" | "system" }) {
  await ensureAppSchema();
  const db = getDb();
  const [release] = await db.select().from(packageReleases).where(eq(packageReleases.id, input.releaseId)).limit(1);
  if (!release) throw new Error("RELEASE_NOT_FOUND");
  const [line] = await db.select().from(packageLines).where(eq(packageLines.id, release.packageLineId)).limit(1);
  if (!line) throw new Error("PACKAGE_LINE_NOT_FOUND");
  const completed = release.status === "published" && line.recommendedReleaseId === release.id;
  if (release.status !== "ready" && !completed) throw new Error("RELEASE_NOT_READY");
  const artifact = release.artifactRootHash ? await getPackageArtifact(release.artifactRootHash) : null;
  if (!artifact) throw new Error("RELEASE_ARTIFACT_NOT_FOUND");
  const visibility = artifact.bundle.manifest.visibility;
  const evidencePolicy = artifact.bundle.manifest.evidencePolicy;
  if (input.expectedVisibility && input.expectedVisibility !== visibility) throw new Error("RELEASE_VISIBILITY_CONFLICT");
  assertReleaseQuality(await validateReleaseArtifact(artifact.bundle));
  if (completed) return release;
  const now = new Date().toISOString();
  const expected = line.recommendedReleaseId || "";
  const d1 = getD1();
  const results = await d1.batch([
    d1.prepare(`UPDATE package_releases SET status='published', published_at=?
      WHERE id=? AND status='ready' AND EXISTS (
        SELECT 1 FROM package_lines WHERE id=? AND COALESCE(recommended_release_id, '')=?
      )`).bind(now, release.id, line.id, expected),
    d1.prepare(`UPDATE package_lines SET recommended_release_id=?, visibility=?, evidence_policy=?,
      hosting_kind=CASE WHEN hosting_kind='bundled' THEN hosting_kind ELSE 'hosted' END,
      registry_version=registry_version+1, updated_at=?
      WHERE id=? AND COALESCE(recommended_release_id, '')=? AND EXISTS (
        SELECT 1 FROM package_releases WHERE id=? AND status='published'
      )`).bind(release.id, visibility, evidencePolicy, now, line.id, expected, release.id),
    d1.prepare(`UPDATE projects SET current_release_id=?, updated_at=?
      WHERE id=? AND EXISTS (SELECT 1 FROM package_releases WHERE id=? AND status='published')`)
      .bind(release.id, now, release.projectId, release.id),
    d1.prepare(`UPDATE project_versions SET status='published'
      WHERE id=? AND EXISTS (SELECT 1 FROM package_releases WHERE id=? AND status='published')`)
      .bind(release.sourceProjectVersionId, release.id),
    d1.prepare(`INSERT INTO release_events (release_id, package_line_id, project_id, action, actor_kind, detail_json, created_at)
      SELECT ?, ?, ?, 'release.published', ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM package_lines WHERE id=? AND recommended_release_id=?
      )`).bind(release.id, line.id, release.projectId, input.actorKind || "user", JSON.stringify({ previousReleaseId: line.recommendedReleaseId }), now, line.id, release.id),
  ]);
  if ((results[0].meta.changes || 0) === 0) throw new Error("PUBLISH_CONFLICT");
  const [published] = await db.select().from(packageReleases).where(eq(packageReleases.id, release.id)).limit(1);
  return published;
}

/** Compile, validate and publish one immutable project version to the public Hub. */
export async function publishProjectVersionToHub(input: {
  projectId: string;
  projectVersionId: string;
  packageVersion: string;
  packageId?: string;
  evidencePolicy?: EvidencePolicy;
  registry?: RegistryMetadata;
}) {
  const release = await prepareRelease({
    ...input,
    visibility: "public",
    evidencePolicy: input.evidencePolicy || "metadata",
    registry: {
      ...input.registry,
      hostingKind: "hosted",
      visibility: "public",
      evidencePolicy: input.evidencePolicy || "metadata",
    },
  });
  if (release.status === "failed") return release;
  if (release.status === "published") {
    const artifact = release.artifactRootHash ? await getPackageArtifact(release.artifactRootHash) : null;
    if (!artifact) throw new Error("RELEASE_ARTIFACT_NOT_FOUND");
    assertReleaseQuality(await validateReleaseArtifact(artifact.bundle));
    return release;
  }
  if (release.status !== "ready") throw new Error("RELEASE_NOT_READY");
  return publishRelease({ releaseId: release.id, actorKind: "user" });
}

export async function rollbackRelease(input: {
  packageLineId: string;
  targetReleaseId: string;
  expectedCurrentReleaseId?: string | null;
  actorKind?: "user" | "agent" | "system";
}) {
  await ensureAppSchema();
  const db = getDb();
  const [line] = await db.select().from(packageLines).where(eq(packageLines.id, input.packageLineId)).limit(1);
  const [target] = await db.select().from(packageReleases).where(and(eq(packageReleases.id, input.targetReleaseId), eq(packageReleases.packageLineId, input.packageLineId))).limit(1);
  if (!line || !target) throw new Error("RELEASE_NOT_FOUND");
  if (target.status !== "published") throw new Error("TARGET_RELEASE_NOT_PUBLISHED");
  const artifact = target.artifactRootHash ? await getPackageArtifact(target.artifactRootHash) : null;
  if (!artifact) throw new Error("RELEASE_ARTIFACT_NOT_FOUND");
  assertReleaseQuality(await validateReleaseArtifact(artifact.bundle));
  // Changing the recommended version must not undo an owner's withdrawal.
  const visibilityRank = { private: 0, unlisted: 1, public: 2 } as const;
  const rollbackVisibility = visibilityRank[line.visibility] < visibilityRank[artifact.bundle.manifest.visibility]
    ? line.visibility : artifact.bundle.manifest.visibility;
  const expected = input.expectedCurrentReleaseId === undefined ? line.recommendedReleaseId || "" : input.expectedCurrentReleaseId || "";
  const now = new Date().toISOString();
  const d1 = getD1();
  const results = await d1.batch([
    d1.prepare(`UPDATE package_lines SET recommended_release_id=?, visibility=?, evidence_policy=?, registry_version=registry_version+1, updated_at=?
      WHERE id=? AND COALESCE(recommended_release_id, '')=?`).bind(target.id, rollbackVisibility, artifact.bundle.manifest.evidencePolicy, now, line.id, expected),
    d1.prepare(`UPDATE projects SET current_release_id=?, updated_at=? WHERE id=? AND EXISTS (
      SELECT 1 FROM package_lines WHERE id=? AND recommended_release_id=? AND updated_at=?
    )`).bind(target.id, now, target.projectId, line.id, target.id, now),
    d1.prepare(`INSERT INTO release_events (release_id, package_line_id, project_id, action, actor_kind, detail_json, created_at)
      SELECT ?, ?, ?, 'release.rolled_back', ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM package_lines WHERE id=? AND recommended_release_id=? AND updated_at=?
      )`).bind(target.id, line.id, target.projectId, input.actorKind || "user", JSON.stringify({ previousReleaseId: line.recommendedReleaseId }), now, line.id, target.id, now),
  ]);
  if ((results[0].meta.changes || 0) === 0) throw new Error("ROLLBACK_CONFLICT");
  return target;
}

export async function deprecateRelease(input: { releaseId: string; reason?: string }) {
  await ensureAppSchema();
  const db = getDb();
  const [release] = await db.select().from(packageReleases).where(eq(packageReleases.id, input.releaseId)).limit(1);
  if (!release) throw new Error("RELEASE_NOT_FOUND");
  const [line] = await db.select().from(packageLines).where(eq(packageLines.id, release.packageLineId)).limit(1);
  if (line?.recommendedReleaseId === release.id) throw new Error("CURRENT_RELEASE_CANNOT_DEPRECATE");
  await db.update(packageReleases).set({ status: "deprecated", error: input.reason || release.error }).where(eq(packageReleases.id, input.releaseId));
  await db.insert(releaseEvents).values({ releaseId: release.id, packageLineId: release.packageLineId, projectId: release.projectId, action: "release.deprecated", detailJson: JSON.stringify({ reason: input.reason || "" }) });
  return { ...release, status: "deprecated" as const };
}
