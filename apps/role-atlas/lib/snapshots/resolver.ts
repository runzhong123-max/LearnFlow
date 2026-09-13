import { getProjectWorkspace } from "@/lib/projects/repository";
import { rolePackageRuntime } from "@/lib/role-package/runtime";
import { bundledRoleSnapshot } from "./bundled-role-adapter";
import { getStoredSnapshot } from "./repository";
import { findReleaseBySnapshot } from "@/lib/releases/resolver";
import type { ResolvedSnapshot, SnapshotReference } from "./types";

export async function resolveSnapshot(input: Partial<SnapshotReference>): Promise<ResolvedSnapshot | null> {
  if (input.projectId) {
    const workspace = await getProjectWorkspace(input.projectId, input.snapshotId, input.versionId).catch(() => null);
    if (workspace?.version && workspace.result) {
      if (input.packageVersion && input.packageVersion !== workspace.result.packages.rolePackage.packageVersion) return null;
      return {
        reference: { snapshotId: workspace.version.snapshotId, packageVersion: workspace.result.packages.rolePackage.packageVersion, projectId: input.projectId, versionId: workspace.version.id },
        title: workspace.project.title,
        description: workspace.project.description,
        market: workspace.project.market,
        version: {
          id: workspace.version.id,
          version: workspace.version.version,
          status: workspace.version.status,
          snapshotId: workspace.version.snapshotId,
        },
        result: workspace.result,
        source: "project",
      };
    }
    return null; // Explicit project/version selectors must never fall through to another namespace.
  }
  if (input.versionId) return null;

  if (input.snapshotId === rolePackageRuntime.package.manifest.snapshot_id
    && (!input.packageVersion || input.packageVersion === bundledRoleSnapshot().packages.rolePackage.packageVersion)) {
    const result = bundledRoleSnapshot();
    if (input.packageVersion && input.packageVersion !== result.packages.rolePackage.packageVersion) return null;
    return {
      reference: { snapshotId: result.snapshot.id, packageVersion: result.packages.rolePackage.packageVersion },
      title: result.brief.roleTitle,
      description: result.brief.roleDescription,
      market: result.brief.market,
      version: {
        id: result.snapshot.id,
        version: result.packages.rolePackage.packageVersion,
        status: result.snapshot.status,
        snapshotId: result.snapshot.id,
      },
      result,
      source: "bundled",
    };
  }

  if (input.snapshotId) {
    const released = await findReleaseBySnapshot({ snapshotId: input.snapshotId, packageVersion: input.packageVersion }).catch(() => null);
    if (released) {
      return {
        reference: { snapshotId: released.result.snapshot.id, packageVersion: released.release.packageVersion },
        title: released.result.brief.roleTitle,
        description: released.result.brief.roleDescription,
        market: released.result.brief.market,
        version: {
          id: released.release.id,
          version: released.release.packageVersion,
          status: released.release.status,
          snapshotId: released.result.snapshot.id,
        },
        result: released.result,
        source: "registry",
      };
    }
    const stored = await getStoredSnapshot(input.snapshotId).catch(() => null);
    if (stored) {
      const result = stored.result;
      if (input.packageVersion && input.packageVersion !== result.packages.rolePackage.packageVersion) return null;
      return {
        reference: { snapshotId: result.snapshot.id, packageVersion: result.packages.rolePackage.packageVersion },
        title: result.brief.roleTitle,
        description: result.brief.roleDescription,
        market: result.brief.market,
        version: {
          id: result.snapshot.id,
          version: result.packages.rolePackage.packageVersion,
          status: result.snapshot.status,
          snapshotId: result.snapshot.id,
        },
        result,
        source: "snapshot-store",
      };
    }
  }

  return null;
}
