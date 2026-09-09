import { and, eq } from "drizzle-orm";
import { ensureAppSchema, getDb } from "@/db";
import { packageReleases } from "@/db/schema";
import { ensureRegistryPackageLine } from "@/lib/registry/repository";
import type { RegistryMetadata } from "@/lib/registry/types";
import { canonicalStringify, domainId, sha256Hex } from "@/lib/versioning/canonical";
import { commitStaticSnapshot } from "@/lib/versioning/commit";
import { snapshotDomainHash } from "@/lib/versioning/snapshot-hash";
import { getStoredSnapshot } from "@/lib/snapshots/repository";
import { bundleFromJson, bundleFromZip } from "./archive";
import { putPackageArtifact } from "./artifact-store";
import { reconstructBuildResult } from "./compiler";
import type { StaticRolePackageBundle } from "./types";
import { validateReleaseArtifact } from "@/lib/releases/quality";

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export async function importStaticRolePackage(input: {
  bytes: Uint8Array;
  format: "json" | "zip";
  registry?: RegistryMetadata;
}) {
  if (input.bytes.byteLength > MAX_IMPORT_BYTES) throw new Error("PACKAGE_TOO_LARGE");
  const bundle = input.format === "zip" ? bundleFromZip(input.bytes) : bundleFromJson(input.bytes);
  const validation = await validateReleaseArtifact(bundle);
  if (!validation.valid) throw new Error(`PACKAGE_INVALID:${validation.hardErrors.join("|")}`);
  const result = reconstructBuildResult(bundle);
  const stored = await getStoredSnapshot(result.snapshot.id);
  if (stored && await snapshotDomainHash(stored.result) !== await snapshotDomainHash(result)) throw new Error("SNAPSHOT_SEMANTIC_CONFLICT");
  const buildValidation = stored
    ? { snapshotId: stored.result.snapshot.id, contentHash: stored.row.contentHash, created: false }
    : await commitStaticSnapshot({ result, sourceRunId: `import:${bundle.manifest.rootHash}` });
  const artifact = await putPackageArtifact(bundle);
  const line = await ensureRegistryPackageLine({
    result,
    packageId: bundle.manifest.packageId,
    metadata: {
      ...input.registry,
      visibility: input.registry?.visibility || bundle.manifest.visibility,
      evidencePolicy: input.registry?.evidencePolicy || bundle.manifest.evidencePolicy,
      hostingKind: input.registry?.hostingKind || "hosted",
      maintenanceKind: input.registry?.maintenanceKind || "community",
    },
  });
  await ensureAppSchema();
  const db = getDb();
  const [existing] = await db.select().from(packageReleases).where(and(
    eq(packageReleases.packageLineId, line.id),
    eq(packageReleases.packageVersion, bundle.manifest.packageVersion),
  )).limit(1);
  if (existing) {
    if (existing.artifactRootHash !== artifact.rootHash) throw new Error("PACKAGE_VERSION_CONFLICT");
    return { release: existing, line, validation, snapshot: buildValidation, imported: false };
  }
  const validationReportHash = await sha256Hex(canonicalStringify(validation));
  const release = {
    id: domainId("release"),
    packageLineId: line.id,
    snapshotId: bundle.manifest.snapshotId,
    snapshotAsOf: bundle.manifest.snapshotAsOf,
    packageVersion: bundle.manifest.packageVersion,
    protocolVersion: bundle.manifest.protocolVersion,
    status: validation.publishable ? "ready" as const : "failed" as const,
    error: validation.publishable ? null : (validation.publicationBlockers || []).join("\n"),
    artifactRootHash: artifact.rootHash,
    validationReportHash,
  };
  await db.insert(packageReleases).values(release);
  return { release, line, validation, snapshot: buildValidation, imported: true };
}

export function parsePackageBundle(value: string | Uint8Array, format: "json" | "zip"): StaticRolePackageBundle {
  return format === "zip"
    ? bundleFromZip(typeof value === "string" ? new TextEncoder().encode(value) : value)
    : bundleFromJson(value);
}
