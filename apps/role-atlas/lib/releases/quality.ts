import { reconstructBuildResult } from "@/lib/packages/compiler";
import type { PackageValidationReport, StaticRolePackageBundle } from "@/lib/packages/types";
import { publicationBlockers, validateBuildResult, validatePackageBundle } from "@/lib/packages/validator";

/** Recheck immutable content at the write boundary, including releases prepared before this gate existed. */
export async function validateReleaseArtifact(bundle: StaticRolePackageBundle): Promise<PackageValidationReport> {
  let integrity: PackageValidationReport;
  try { integrity = await validatePackageBundle(bundle); }
  catch { return { protocolVersion: "3.0.0", valid: false, publishable: false, hardErrors: ["岗位包清单或组件不完整。"], publicationBlockers: [], warnings: [], stats: {} }; }
  const hardErrors = [...integrity.hardErrors];
  const blockers: string[] = [];
  try {
    const snapshot = JSON.parse(bundle.components[bundle.manifest.entrypoints.snapshot]);
    if (!snapshot.validation) blockers.push("岗位包缺少原始发布质量校验记录。");
    const result = reconstructBuildResult(bundle);
    hardErrors.push(...validateBuildResult(result).hardErrors);
    blockers.push(...publicationBlockers(result));
    if (bundle.manifest.visibility === "public" && bundle.manifest.evidencePolicy === "full"
      && result.sources.assets.some((source) => source.visibility === "project_private")) blockers.push("公开岗位包不能以 full 策略分发私有工作区证据。");
    if (bundle.manifest.visibility === "public" && bundle.manifest.evidencePolicy !== "full") {
      const privateSources = new Set(result.sources.assets.filter((source) => source.visibility === "project_private").map((source) => source.id));
      const privateSegments = new Set(result.sources.segments.filter((segment) => privateSources.has(segment.sourceId)).map((segment) => segment.id));
      let rawPrivateQuote = false;
      const inspect = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        const item = value as Record<string, unknown>;
        if (typeof item.segmentId === "string" && privateSegments.has(item.segmentId) && typeof item.quote === "string"
          && item.quote !== "[非公开证据原文未随公开岗位包分发]") rawPrivateQuote = true;
        Object.values(item).forEach(inspect);
      };
      inspect(result);
      if (rawPrivateQuote || result.sources.segments.some((segment) => privateSegments.has(segment.id) && segment.text !== "[非公开证据内容未随公开岗位包分发]")) blockers.push("公开制品仍包含私有证据原文，请按当前证据策略重新编译。");
    }
  } catch {
    hardErrors.push("岗位包组件不完整，无法校验发布内容。");
  }
  return { ...integrity, valid: hardErrors.length === 0, hardErrors: [...new Set(hardErrors)], publicationBlockers: [...new Set(blockers)], publishable: hardErrors.length === 0 && blockers.length === 0 };
}

export function assertReleaseQuality(report: PackageValidationReport) {
  if (!report.valid || !report.publishable) throw new Error(`RELEASE_QUALITY_BLOCKED: ${[...report.hardErrors, ...(report.publicationBlockers || [])].join("\n")}`);
}
