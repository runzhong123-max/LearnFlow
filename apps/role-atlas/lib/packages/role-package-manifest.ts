import type { ColdStartBuildResult, RolePackageManifest } from "@/lib/build/types";

function stableFingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function ids(values: Array<{ id: string }>) {
  return values.map((item) => item.id).sort().join("|");
}

export function createRolePackageManifest(input: {
  result: Pick<ColdStartBuildResult, "sources" | "semantic" | "process" | "snapshot">;
  packageId: string;
  packageVersion: string;
  status?: "candidate" | "ready";
}): RolePackageManifest {
  const evidenceObjects = [
    ...input.result.sources.assets,
    ...input.result.sources.segments,
    ...input.result.sources.evidenceBindings,
  ];
  const semanticObjects = [
    ...input.result.semantic.nodes,
    ...input.result.semantic.edges,
    ...input.result.semantic.claims,
  ];
  const processObjects = [
    ...input.result.process.scenarios,
    ...input.result.process.nodes,
    ...input.result.process.edges,
    ...input.result.process.bridges,
  ];
  const namespace = <T extends "evidence" | "semantic" | "process">(id: T, objects: Array<{ id: string }>) => ({
    id,
    schemaVersion: "2.0.0",
    objectCount: objects.length,
    fingerprint: stableFingerprint(ids(objects)),
  });
  return {
    protocolVersion: input.result.semantic.nodes.some(node => node.taskDefinition) ? "3.1.0" : "3.0.0",
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    snapshotId: input.result.snapshot.id,
    snapshotAsOf: input.result.snapshot.asOf,
    status: input.status || input.result.snapshot.status,
    namespaces: {
      evidence: namespace("evidence", evidenceObjects),
      semantic: namespace("semantic", semanticObjects),
      process: namespace("process", processObjects),
    },
  };
}

/** Upgrade persisted v2 composite packages at the read boundary. */
export function normalizeRolePackage(result: ColdStartBuildResult): ColdStartBuildResult {
  const legacy = result as unknown as ColdStartBuildResult & {
    packages: {
      rolePackage?: Partial<RolePackageManifest> & { packageId?: string; packageVersion?: string };
      compositeSnapshot?: { version?: string };
    };
  };
  const current = legacy.packages?.rolePackage;
  if (current && ["3.0.0", "3.1.0"].includes(current.protocolVersion || "") && current.namespaces) return result;
  const packageId = current?.packageId || `role-package:${stableFingerprint(result.brief.roleTitle)}`;
  const packageVersion = legacy.packages?.compositeSnapshot?.version || current?.packageVersion || "0.1.0-candidate.legacy";
  return {
    ...result,
    packages: {
      rolePackage: createRolePackageManifest({ result, packageId, packageVersion, status: result.snapshot.status }),
    },
  };
}

export function refreshRolePackageManifest(
  result: ColdStartBuildResult,
  update: { packageId?: string; packageVersion?: string; status?: "candidate" | "ready" } = {},
) {
  const normalized = normalizeRolePackage(result);
  normalized.packages = {
    rolePackage: createRolePackageManifest({
      result: normalized,
      packageId: update.packageId || normalized.packages.rolePackage.packageId,
      packageVersion: update.packageVersion || normalized.packages.rolePackage.packageVersion,
      status: update.status || normalized.packages.rolePackage.status,
    }),
  };
  return normalized;
}
