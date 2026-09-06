import { classifyHubEntry } from "./taxonomy";
import { getPackageArtifact } from "@/lib/packages/artifact-store";
import { getRegistryPackage, listRegistryPackages } from "@/lib/registry/repository";
import { hubStrings, type HubEntry } from "./discovery";

type JsonRecord = Record<string, unknown>;

function json<T>(value: string | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; }
  catch { return fallback; }
}

function array(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export async function listPublicHubRepositories(query?: string) {
  const packages = await listRegistryPackages({ query, visibility: "public", status: "active" });
  return packages.filter((item) => item.releases.some((release) => release.id === item.recommendedReleaseId && release.status === "published"));
}

export async function getPublicHubRepository(packageLineId: string) {
  const item = await getRegistryPackage(packageLineId);
  if (!item || item.visibility !== "public" || item.status !== "active") return null;
  const release = item.releases.find((candidate) => candidate.id === item.recommendedReleaseId && candidate.status === "published");
  if (!release?.artifactRootHash) return { item, release: null, bundle: null, overview: null };
  const artifact = await getPackageArtifact(release.artifactRootHash);
  if (!artifact) return { item, release, bundle: null, overview: null };

  const { bundle } = artifact;
  const semantic = json<JsonRecord>(bundle.components[bundle.manifest.entrypoints.semanticGraph], {});
  const process = json<JsonRecord>(bundle.components[bundle.manifest.entrypoints.workProcessForest], {});
  const sources = json<JsonRecord>(bundle.components[bundle.manifest.entrypoints.sources], {});
  const validation = json<JsonRecord>(bundle.components[bundle.manifest.entrypoints.validation], {});
  const nodes = array(semantic.nodes) as JsonRecord[];
  const tasks = nodes.filter((node) => node.type === "typical_task" || node.type === "task");
  const capabilities = nodes.filter((node) => node.type === "capability" || node.type === "capability_unit");
  const knowledge = nodes.filter((node) => node.type === "knowledge_skill");
  const scenarios = array(process.scenarios) as JsonRecord[];
  const processNodes = array(process.nodes) as JsonRecord[];
  const assets = array(sources.assets) as JsonRecord[];
  const bindings = array(sources.evidenceBindings) as JsonRecord[];
  const warnings = array(validation.warnings).filter((value): value is string => typeof value === "string");
  const files = Object.entries(bundle.manifest.hashes).map(([path, hash]) => ({
    path,
    hash,
    bytes: new TextEncoder().encode(bundle.components[path] || "").byteLength,
  }));
  return {
    item,
    release,
    bundle,
    overview: {
      tasks,
      capabilities,
      knowledge,
      scenarios,
      processNodes,
      assets,
      bindings,
      warnings,
      files,
      semanticEdges: array(semantic.edges).length,
      processEdges: array(process.edges).length,
    },
  };
}

/** Both the Hub page and the read-only plugin endpoint consume this published Registry projection. */
export async function listPublicHubEntries(): Promise<HubEntry[]> {
  const packages = await listPublicHubRepositories();
  const entries: HubEntry[] = [];
  // Bound artifact reads; do not launch an unbounded database fan-out as the catalog grows.
  for (let start = 0; start < packages.length; start += 4) {
    const batch = await Promise.all(packages.slice(start, start + 4).map(async item => {
      const release = item.releases.find(candidate => candidate.id === item.recommendedReleaseId && candidate.status === "published")!;
      if (!release.artifactRootHash) return null;
      const artifact = await getPackageArtifact(release.artifactRootHash);
      if (!artifact || artifact.bundle.manifest.rootHash !== release.artifactRootHash) throw new Error("HUB_RELEASE_ARTIFACT_UNAVAILABLE");
      const semantic = json<JsonRecord>(artifact.bundle.components[artifact.bundle.manifest.entrypoints.semanticGraph], {});
      const scope = item.scope as JsonRecord;
      return {
        id: item.id, packageId: item.packageId, title: item.title, summary: item.roleIdentity?.description || "",
        aliases: hubStrings(json<unknown>(item.roleIdentity?.aliasesJson, [])),
        categories: hubStrings(scope.industries), audiences: hubStrings(scope.audiences),
        maintainerName: item.maintainer?.name || "", maintenanceKind: item.maintenanceKind,
        protocolRange: item.protocolRange, evidencePolicy: item.evidencePolicy,
        release: { id: release.id, packageVersion: release.packageVersion, snapshotId: release.snapshotId,
          rootHash: release.artifactRootHash, protocolVersion: release.protocolVersion,
          snapshotAsOf: release.snapshotAsOf, publishedAt: release.publishedAt },
        nodeIndex: (array(semantic.nodes) as JsonRecord[]).flatMap(node => typeof node.id === "string" && typeof node.label === "string"
          ? [{ id: node.id, label: node.label, type: String(node.type || "object"), aliases: hubStrings(node.aliases) }] : []),
      } satisfies HubEntry;
    }));
    for (const entry of batch) if (entry) entries.push({ ...entry, sourceCategories: entry.categories, categories: classifyHubEntry(entry) });
  }
  return entries;
}
