import type { ColdStartBuildResult } from "@/lib/build/types";
import { canonicalStringify, sha256Hex } from "@/lib/versioning/canonical";
import type { PackageValidationReport, StaticRolePackageBundle } from "./types";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function duplicates(values: string[]) {
  const seen = new Set<string>();
  return [...new Set(values.filter((value) => seen.has(value) || !seen.add(value)))];
}

/** A syntactically valid candidate is not necessarily a complete role package. */
export function publicationBlockers(result: ColdStartBuildResult): string[] {
  const blockers: string[] = [...(result.deliveryReadiness?.blockers || [])];
  const nodes = result.semantic.nodes.filter((node) => node.lifecycle !== "rejected");
  const required = [["market_role", "岗位定义"], ["task", "典型任务"], ["capability", "能力"], ["knowledge_skill", "知识技能"]] as const;
  for (const [type, label] of required) if (!nodes.some((node) => node.type === type)) blockers.push(`缺少${label}，请先继续完善岗位包。`);
  if (!result.semantic.edges.length) blockers.push("缺少岗位结构关系。");
  if (!result.process.scenarios.length || !result.process.nodes.length || !result.process.bridges.length) blockers.push("缺少完整工作场景及任务关联。");
  if (!result.sources.evidenceBindings.length) blockers.push("缺少实际绑定的来源证据。");
  for (const [key, label] of [["structural", "结构"], ["semantic", "语义"], ["evidence", "证据"], ["temporal", "时间边界"], ["process", "工作过程"]] as const) {
    const report = result.validation?.[key];
    if (!report?.passed) blockers.push(...(report?.issues.length ? report.issues : [`${label}校验尚未通过。`]));
  }
  if (!result.validation?.publishable) blockers.push("当前项目版本尚未通过发布质量校验，请先迭代解决阻塞问题。");
  blockers.push(...result.audit.issues.filter((issue) => issue.severity === "error").map((issue) => `${issue.title}：${issue.detail}`));
  if (result.audit.inspection && (!result.audit.inspection.protocolValid || result.audit.inspection.hardBlockerIds.length)) blockers.push("岗位包检查仍存在阻塞问题。");
  const excluded = new Set(result.sources.assets.filter((source) => ["quarantined", "rejected"].includes(source.qualification?.status || "")).map((source) => source.id));
  if (result.sources.evidenceBindings.some((binding) => excluded.has(binding.sourceId))) blockers.push("已排除的来源仍被用作证据，请先修复证据绑定。");
  return [...new Set(blockers)];
}

export function validateBuildResult(result: ColdStartBuildResult) {
  const hardErrors: string[] = [];
  const warnings: string[] = [];
  const semanticIds = result.semantic.nodes.map((item) => item.id);
  const semanticEdgeIds = result.semantic.edges.map((item) => item.id);
  const processIds = [...result.process.scenarios, ...result.process.nodes].map((item) => item.id);
  const objectIdList = [
    ...semanticIds,
    ...semanticEdgeIds,
    ...result.semantic.claims.map((item) => item.id),
    ...processIds,
    ...result.process.edges.map((item) => item.id),
    ...result.process.bridges.map((item) => item.id),
    ...result.snapshot.sections.map((item) => item.id),
  ];
  const allObjectIds = new Set(objectIdList);
  const duplicateIds = duplicates(objectIdList);
  if (duplicateIds.length > 0) hardErrors.push(`存在重复对象 ID：${duplicateIds.slice(0, 8).join("、")}`);
  if (!result.snapshot.id || !result.snapshot.asOf) hardErrors.push("快照缺少 snapshot_id 或 as_of。 ");
  const rolePackage = result.packages.rolePackage;
  if (!["3.0.0", "3.1.0"].includes(rolePackage.protocolVersion)) hardErrors.push("岗位包协议版本不是 3.0.0。 ");
  if (rolePackage.snapshotId !== result.snapshot.id) hardErrors.push("岗位包与快照 ID 不一致。 ");
  if (rolePackage.snapshotAsOf !== result.snapshot.asOf) hardErrors.push("岗位包与快照时间边界不一致。 ");
  const expectedNamespaceCounts = {
    evidence: result.sources.assets.length + result.sources.segments.length + result.sources.evidenceBindings.length,
    semantic: result.semantic.nodes.length + result.semantic.edges.length + result.semantic.claims.length,
    process: result.process.scenarios.length + result.process.nodes.length + result.process.edges.length + result.process.bridges.length,
  };
  for (const namespaceId of ["evidence", "semantic", "process"] as const) {
    const namespace = rolePackage.namespaces[namespaceId];
    if (namespace.id !== namespaceId) hardErrors.push(`岗位包 ${namespaceId} 命名空间标识不一致。`);
    if (namespace.objectCount !== expectedNamespaceCounts[namespaceId]) hardErrors.push(`岗位包 ${namespaceId} 命名空间对象计数不一致。`);
    if (!namespace.fingerprint) hardErrors.push(`岗位包 ${namespaceId} 命名空间缺少指纹。`);
  }

  for (const edge of result.semantic.edges) {
    if (!allObjectIds.has(edge.source) || !allObjectIds.has(edge.target)) hardErrors.push(`语义关系 ${edge.id} 存在悬空端点。`);
  }
  for (const edge of result.process.edges) {
    if (!allObjectIds.has(edge.source) || !allObjectIds.has(edge.target)) hardErrors.push(`事理关系 ${edge.id} 存在悬空端点。`);
  }
  for (const bridge of result.process.bridges) {
    if (!allObjectIds.has(bridge.processNodeId) || !allObjectIds.has(bridge.semanticNodeId)) hardErrors.push(`任务—事理桥 ${bridge.id} 存在悬空端点。`);
  }
  const sourceIds = new Set(result.sources.assets.map((item) => item.id));
  const segmentIds = new Set(result.sources.segments.map((item) => item.id));
  for (const segment of result.sources.segments) if (!sourceIds.has(segment.sourceId)) hardErrors.push(`证据分段 ${segment.id} 引用了不存在的来源。`);
  for (const binding of result.sources.evidenceBindings) {
    if (!sourceIds.has(binding.sourceId) || !segmentIds.has(binding.segmentId)) hardErrors.push(`证据绑定 ${binding.id} 的来源或分段不存在。`);
    if (!allObjectIds.has(binding.targetId)) warnings.push(`证据绑定 ${binding.id} 的目标未进入公开对象索引。`);
  }
  const qualityGroups = [
    result.validation.structural.issues,
    result.validation.semantic.issues,
    result.validation.evidence.issues,
    result.validation.temporal.issues,
    result.validation.process.issues,
  ];
  warnings.push(...qualityGroups.flat().filter(Boolean));
  warnings.push(...result.audit.issues.map((issue) => `${issue.title}：${issue.detail}`));
  return { hardErrors: [...new Set(hardErrors)], warnings: [...new Set(warnings)] };
}

export async function validatePackageBundle(bundle: StaticRolePackageBundle): Promise<PackageValidationReport> {
  const hardErrors: string[] = [];
  const warnings: string[] = [];
  if (bundle.manifest.packageProtocol !== "static-role-package") hardErrors.push("不支持的 packageProtocol。 ");
  if (!["2.0.0", "3.0.0", "3.1.0"].includes(bundle.manifest.protocolVersion)) hardErrors.push("不支持的协议版本。 ");
  if (!SEMVER.test(bundle.manifest.packageVersion)) hardErrors.push("packageVersion 不是合法 SemVer。 ");
  for (const [path, expected] of Object.entries(bundle.manifest.hashes)) {
    const content = bundle.components[path];
    if (content === undefined) {
      hardErrors.push(`manifest 引用的组件不存在：${path}`);
      continue;
    }
    const actual = await sha256Hex(content);
    if (actual !== expected) hardErrors.push(`组件哈希不一致：${path}`);
  }
  const manifestCore = { ...bundle.manifest, rootHash: "" };
  const actualRoot = await sha256Hex(canonicalStringify(manifestCore));
  if (actualRoot !== bundle.manifest.rootHash) hardErrors.push("岗位包 root hash 不一致。 ");
  const snapshotPath = bundle.manifest.entrypoints.snapshot;
  try {
    const snapshot = JSON.parse(bundle.components[snapshotPath]) as { snapshot?: { id?: string } };
    if (snapshot.snapshot?.id !== bundle.manifest.snapshotId) hardErrors.push("snapshot 组件与 manifest 的 snapshotId 不一致。 ");
  } catch {
    hardErrors.push("snapshot 组件不是合法 JSON。 ");
  }
  return {
    protocolVersion: bundle.manifest.protocolVersion,
    valid: hardErrors.length === 0,
    hardErrors,
    warnings,
    stats: { components: Object.keys(bundle.components).length, bytes: Object.values(bundle.components).reduce((sum, value) => sum + new TextEncoder().encode(value).byteLength, 0) },
  };
}
