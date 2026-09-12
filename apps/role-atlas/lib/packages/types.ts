import type { ColdStartBuildResult } from "@/lib/build/types";

export type PackageVisibility = "private" | "unlisted" | "public";
export type EvidencePolicy = "full" | "metadata" | "redacted";

export type PackageValidationReport = {
  protocolVersion: "2.0.0" | "3.0.0" | "3.1.0";
  valid: boolean;
  hardErrors: string[];
  warnings: string[];
  /** File integrity and content readiness are separate checks. */
  publishable?: boolean;
  publicationBlockers?: string[];
  stats: Record<string, number | string>;
};

export type StaticRolePackageManifest = {
  packageProtocol: "static-role-package";
  protocolVersion: "2.0.0" | "3.0.0" | "3.1.0";
  packageId: string;
  packageVersion: string;
  snapshotId: string;
  snapshotAsOf: string;
  roleTitle: string;
  sourceProjectVersionId?: string;
  sourceRootHash?: string;
  visibility: PackageVisibility;
  evidencePolicy: EvidencePolicy;
  entrypoints: Record<string, string>;
  hashes: Record<string, string>;
  rootHash: string;
};

export type StaticRolePackageBundle = {
  manifest: StaticRolePackageManifest;
  components: Record<string, string>;
};

export type CompiledRolePackage = {
  bundle: StaticRolePackageBundle;
  result: ColdStartBuildResult;
  validation: PackageValidationReport;
};
