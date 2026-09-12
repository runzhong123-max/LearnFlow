import type { ColdStartBuildResult, SourceAsset, SourceSegment } from "@/lib/build/types";
import { canonicalStringify, sha256Hex } from "@/lib/versioning/canonical";
import type { CompiledRolePackage, EvidencePolicy, PackageValidationReport, PackageVisibility, StaticRolePackageBundle, StaticRolePackageManifest } from "./types";
import { normalizeRolePackage, refreshRolePackageManifest } from "./role-package-manifest";
import { publicationBlockers, validateBuildResult, validatePackageBundle } from "./validator";

const entrypoints = {
  snapshot: "snapshot.json",
  sources: "sources.json",
  semanticGraph: "semantic-graph.json",
  workProcessForest: "work-process-forest.json",
  views: "views.json",
  objectIndex: "object-index.json",
  retrieval: "retrieval-index.json",
  validation: "validation-report.json",
  referenceMigrations: "reference-migrations.json",
};

function projectSources(input: ColdStartBuildResult, visibility: PackageVisibility, policy: EvidencePolicy) {
  if (visibility !== "public" || policy === "full") return input.sources;
  const privateSourceIds = new Set(input.sources.assets.filter((asset) => asset.visibility === "project_private").map((asset) => asset.id));
  const privateSegmentIds = new Set(input.sources.segments.filter((segment) => privateSourceIds.has(segment.sourceId)).map((segment) => segment.id));
  const assets: SourceAsset[] = input.sources.assets.map((asset) => privateSourceIds.has(asset.id)
    ? {
      ...asset,
      title: policy === "redacted" ? "非公开工作区证据" : asset.title,
      locator: undefined,
      publisher: policy === "redacted" ? undefined : asset.publisher,
      domain: undefined,
      workspaceEvidence: undefined,
    }
    : asset);
  const segments: SourceSegment[] = input.sources.segments.map((segment) => privateSourceIds.has(segment.sourceId)
    ? { ...segment, text: "[非公开证据内容未随公开岗位包分发]", locator: undefined, section: undefined, paragraph: undefined }
    : segment);
  return { ...input.sources, assets, segments,
    mentions: input.sources.mentions?.filter((mention) => !privateSegmentIds.has(mention.sourceSegmentId)),
    relationPropositions: input.sources.relationPropositions?.filter((proposition) => !privateSegmentIds.has(proposition.sourceSegmentId)),
  };
}

function redactPrivateQuotes(value: unknown, privateSegmentIds: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach((item) => redactPrivateQuotes(item, privateSegmentIds)); return; }
  const item = value as Record<string, unknown>;
  if (typeof item.segmentId === "string" && privateSegmentIds.has(item.segmentId) && typeof item.quote === "string") {
    item.quote = "[非公开证据原文未随公开岗位包分发]";
    delete item.start; delete item.end;
  }
  Object.values(item).forEach((child) => redactPrivateQuotes(child, privateSegmentIds));
}

function objectIndex(result: ColdStartBuildResult) {
  return [
    ...result.semantic.nodes.map((item) => ({ id: item.id, kind: "semantic_node", type: item.type, label: item.label, summary: item.summary })),
    ...result.semantic.edges.map((item) => ({ id: item.id, kind: "semantic_edge", type: item.type, source: item.source, target: item.target })),
    ...result.process.scenarios.map((item) => ({ id: item.id, kind: "process_scenario", label: item.label, summary: item.summary })),
    ...result.process.nodes.map((item) => ({ id: item.id, kind: "process_node", type: item.kind, label: item.label, summary: item.summary })),
  ];
}

function retrievalIndex(result: ColdStartBuildResult) {
  return objectIndex(result).flatMap((item) => "label" in item
    ? [{ id: `retrieval:${item.id}`, targetId: item.id, text: `${item.label}\n${item.summary || ""}`, snapshotId: result.snapshot.id }]
    : []);
}

export async function compileStaticRolePackage(input: {
  result: ColdStartBuildResult;
  packageId: string;
  packageVersion: string;
  sourceProjectVersionId?: string;
  sourceRootHash?: string;
  visibility: PackageVisibility;
  evidencePolicy: EvidencePolicy;
  referenceMigrations?: unknown[];
}): Promise<CompiledRolePackage> {
  const result = normalizeRolePackage(structuredClone(input.result));
  result.sources = projectSources(result, input.visibility, input.evidencePolicy);
  if (input.visibility === "public" && input.evidencePolicy !== "full") {
    const privateSources = new Set(result.sources.assets.filter((source) => source.visibility === "project_private").map((source) => source.id));
    redactPrivateQuotes(result, new Set(result.sources.segments.filter((segment) => privateSources.has(segment.sourceId)).map((segment) => segment.id)));
  }
  refreshRolePackageManifest(result, { packageId: input.packageId, packageVersion: input.packageVersion });

  const buildValidation = validateBuildResult(result);
  if (input.visibility === "public" && input.evidencePolicy === "full" && result.sources.assets.some((asset) => asset.visibility === "project_private")) {
    buildValidation.hardErrors.push("公开岗位包不能以 full 策略分发私有工作区证据。 ");
  }
  const blockers = publicationBlockers(result);
  const publishable = buildValidation.hardErrors.length === 0 && blockers.length === 0;
  refreshRolePackageManifest(result, { status: publishable ? "ready" : "candidate" });
  const preliminaryReport: PackageValidationReport = {
    protocolVersion: result.packages.rolePackage.protocolVersion,
    valid: buildValidation.hardErrors.length === 0,
    hardErrors: buildValidation.hardErrors,
    warnings: buildValidation.warnings,
    publishable,
    publicationBlockers: blockers,
    stats: {
      semanticNodes: result.semantic.nodes.length,
      semanticEdges: result.semantic.edges.length,
      processScenarios: result.process.scenarios.length,
      processNodes: result.process.nodes.length,
      sources: result.sources.assets.length,
      evidenceBindings: result.sources.evidenceBindings.length,
    },
  };
  const components: Record<string, string> = {
    [entrypoints.snapshot]: canonicalStringify({ runId: result.runId, projectId: result.projectId, brief: result.brief, snapshot: result.snapshot, packages: result.packages, validation: result.validation, deliveryReadiness: result.deliveryReadiness }),
    [entrypoints.sources]: canonicalStringify(result.sources),
    [entrypoints.semanticGraph]: canonicalStringify(result.semantic),
    [entrypoints.workProcessForest]: canonicalStringify(result.process),
    [entrypoints.views]: canonicalStringify({ sections: result.snapshot.sections }),
    [entrypoints.objectIndex]: canonicalStringify(objectIndex(result)),
    [entrypoints.retrieval]: canonicalStringify(retrievalIndex(result)),
    [entrypoints.validation]: canonicalStringify({ ...preliminaryReport, audit: result.audit }),
    [entrypoints.referenceMigrations]: canonicalStringify(input.referenceMigrations || []),
  };
  const hashes = Object.fromEntries(await Promise.all(Object.entries(components).map(async ([path, content]) => [path, await sha256Hex(content)])));
  const manifestCore: Omit<StaticRolePackageManifest, "rootHash"> = {
    packageProtocol: "static-role-package",
    protocolVersion: result.packages.rolePackage.protocolVersion,
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    snapshotId: result.snapshot.id,
    snapshotAsOf: result.snapshot.asOf,
    roleTitle: result.brief.roleTitle,
    sourceProjectVersionId: input.sourceProjectVersionId,
    sourceRootHash: input.sourceRootHash,
    visibility: input.visibility,
    evidencePolicy: input.evidencePolicy,
    entrypoints,
    hashes,
  };
  const rootHash = await sha256Hex(canonicalStringify({ ...manifestCore, rootHash: "" }));
  const bundle: StaticRolePackageBundle = { manifest: { ...manifestCore, rootHash }, components };
  const bundleValidation = await validatePackageBundle(bundle);
  const validation: PackageValidationReport = {
    ...preliminaryReport,
    valid: preliminaryReport.valid && bundleValidation.valid,
    hardErrors: [...new Set([...preliminaryReport.hardErrors, ...bundleValidation.hardErrors])],
    warnings: [...new Set([...preliminaryReport.warnings, ...bundleValidation.warnings])],
    stats: { ...preliminaryReport.stats, ...bundleValidation.stats },
  };
  validation.valid = validation.hardErrors.length === 0;
  validation.publishable = validation.valid && publishable;
  return { bundle, result, validation };
}

export function reconstructBuildResult(bundle: StaticRolePackageBundle): ColdStartBuildResult {
  const snapshot = JSON.parse(bundle.components[bundle.manifest.entrypoints.snapshot]) as Pick<ColdStartBuildResult, "runId" | "projectId" | "brief" | "snapshot" | "packages" | "validation">;
  const sources = JSON.parse(bundle.components[bundle.manifest.entrypoints.sources]) as ColdStartBuildResult["sources"];
  const semantic = JSON.parse(bundle.components[bundle.manifest.entrypoints.semanticGraph]) as ColdStartBuildResult["semantic"];
  const process = JSON.parse(bundle.components[bundle.manifest.entrypoints.workProcessForest]) as ColdStartBuildResult["process"];
  const validationComponent = JSON.parse(bundle.components[bundle.manifest.entrypoints.validation]) as { audit: ColdStartBuildResult["audit"] };
  const existingValidation = structuredClone(snapshot.validation);
  const validation = existingValidation || {
    publishable: true,
    structural: { passed: true, issues: [] },
    semantic: { passed: true, issues: [] },
    evidence: { passed: true, coverage: 1, issues: [] },
    temporal: { passed: true, issues: [] },
    process: { passed: true, coverage: 1, issues: [] },
  };
  return normalizeRolePackage({ ...snapshot, sources, semantic, process, audit: validationComponent.audit, validation } as ColdStartBuildResult);
}
