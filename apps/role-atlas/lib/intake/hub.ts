import { searchHub, type HubEntry } from "@/lib/hub/discovery";
import type { ForkOrigin } from "@/lib/hub/fork-plan";
import type { StaticRolePackageBundle } from "@/lib/packages/types";

/** Discovery context for role clarification, never independent research evidence. */
export type IntakeHubMatch = ForkOrigin & {
  summary: string;
  matchReasons: string[];
  tasks: string[];
  capabilities: string[];
  scenarios: string[];
  href: string;
};

type IntakeHubRelease = {
  line: { id: string; packageId: string; status: string; visibility: string; license: string } | null | undefined;
  release: { id: string; packageVersion: string; snapshotId: string; status: string; artifactRootHash: string | null; publishedAt: string | null };
  bundle: StaticRolePackageBundle;
};

export type IntakeHubDependencies = {
  listEntries: () => Promise<HubEntry[]>;
  requirePublicRelease: (releaseId: string) => Promise<unknown>;
  readRelease: (releaseId: string) => Promise<IntakeHubRelease | null>;
  validateBundle: (bundle: StaticRolePackageBundle) => Promise<{ valid: boolean }>;
};

async function productionDependencies(): Promise<IntakeHubDependencies> {
  // Loading the pure suggestion helper in tests must not require a Worker D1 binding.
  const [repository, access, resolver, validator] = await Promise.all([
    import("@/lib/hub/repository"), import("@/lib/access"),
    import("@/lib/releases/resolver"), import("@/lib/packages/validator"),
  ]);
  return {
    listEntries: repository.listPublicHubEntries,
    requirePublicRelease: releaseId => access.requireReleaseAccess(null, releaseId),
    readRelease: resolver.getReleaseWithArtifact,
    validateBundle: validator.validatePackageBundle,
  };
}

function text(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, maxLength) : "";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function component(bundle: StaticRolePackageBundle, name: string): Record<string, unknown> {
  return record(JSON.parse(bundle.components[bundle.manifest.entrypoints[name]]));
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function labels(nodes: Record<string, unknown>[], limit: number): string[] {
  return [...new Set(nodes.map(node => text(node.label, 160)).filter(Boolean))].slice(0, limit);
}

function matchesPin(entry: HubEntry, source: IntakeHubRelease): boolean {
  const { line, release, bundle: { manifest } } = source;
  return Boolean(line && line.status === "active" && line.visibility === "public"
    && release.status === "published" && release.publishedAt && manifest.visibility === "public"
    && entry.id && entry.packageId && entry.release.id && entry.release.packageVersion && entry.release.snapshotId
    && /^[a-f0-9]{64}$/u.test(entry.release.rootHash)
    && line.id === entry.id && line.packageId === entry.packageId
    && release.id === entry.release.id && release.packageVersion === entry.release.packageVersion
    && release.snapshotId === entry.release.snapshotId && release.artifactRootHash === entry.release.rootHash
    && manifest.packageId === entry.packageId && manifest.packageVersion === entry.release.packageVersion
    && manifest.snapshotId === entry.release.snapshotId && manifest.rootHash === entry.release.rootHash
    && manifest.protocolVersion === entry.release.protocolVersion);
}

/** Read at most three ranked, validated public artifacts without creating projects or forks. */
export async function suggestIntakeHubMatches(
  query: string,
  options: { dependencies?: IntakeHubDependencies } = {},
): Promise<IntakeHubMatch[]> {
  const dependencies = options.dependencies ?? await productionDependencies();
  // A catalog outage is different from no matches. Let the caller report the unavailable state.
  const entries = await dependencies.listEntries();
  const candidates = searchHub(entries, { query: text(query, 500), limit: 3 }).items;
  const matches: IntakeHubMatch[] = [];
  for (const { entry, reasons } of candidates) {
    try {
      await dependencies.requirePublicRelease(entry.release.id);
      const source = await dependencies.readRelease(entry.release.id);
      if (!source || !matchesPin(entry, source) || !(await dependencies.validateBundle(source.bundle)).valid) continue;
      const semantic = component(source.bundle, "semanticGraph");
      const process = component(source.bundle, "workProcessForest");
      const snapshot = component(source.bundle, "snapshot");
      const nodes = rows(semantic.nodes);
      matches.push({
        packageLineId: entry.id, releaseId: entry.release.id, packageId: entry.packageId,
        packageVersion: entry.release.packageVersion, snapshotId: entry.release.snapshotId, rootHash: entry.release.rootHash,
        title: text(source.bundle.manifest.roleTitle, 200), license: text(source.line!.license, 160),
        summary: text(record(snapshot.brief).roleDescription, 700),
        matchReasons: reasons.slice(0, 4).map(reason => text(reason, 200)),
        tasks: labels(nodes.filter(node => node.type === "typical_task" || node.type === "task"), 4),
        capabilities: labels(nodes.filter(node => node.type === "capability" || node.type === "capability_unit"), 4),
        scenarios: labels(rows(process.scenarios), 3),
        // The Hub page follows recommendations; the export endpoint actually pins this release.
        href: `/api/releases/${encodeURIComponent(entry.release.id)}/export?format=json`,
      });
    } catch {
      // An unavailable, withdrawn or invalid individual artifact is not a fabricated suggestion.
    }
  }
  if (candidates.length && !matches.length) throw new Error("INTAKE_HUB_ARTIFACTS_UNAVAILABLE");
  return matches;
}
