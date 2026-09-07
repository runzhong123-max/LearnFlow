import type { RoleLearningProjection, SemanticNode } from "@/lib/build/types";
import type { RolePackageRef } from "./contract";

export function learningPointPreview(node: SemanticNode, projection?: RoleLearningProjection) {
  const binding = projection?.bindings.find(item => item.semanticNodeId === node.id);
  const label = !binding ? "尚未生成路径预览"
    : binding.mappingMode === "exact" ? "名称匹配 · 待正式核对"
      : binding.mappingMode === "fuzzy_resolved" ? "相近节点 · 待正式核对"
        : binding.mappingMode === "ambiguous" ? "需要消歧" : "尚无路径锚点";
  const needsDefinition = !["knowledge", "skill"].includes(node.learningKind || "")
    ? "需要拆分为具体知识点或技能点。"
    : !node.learningDefinition?.scopeNote.trim() || !node.learningDefinition.assessmentCriteria.length
      ? "需要补充适用范围与可检查的验收要求。" : "";
  return { label, rationale: binding?.rationale || "本快照没有这个节点的学习路径匹配结果。", needsDefinition };
}

export function learningMountUrl(packageRef: RolePackageRef, nodeId?: string, baseUrl = "https://learnflow.club") {
  const url = new URL("/ecosystem", baseUrl);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("LearnFlow 入口地址无效。");
  if (!packageRef.packageId || !packageRef.packageVersion || !packageRef.snapshotId || !/^[a-f0-9]{64}$/.test(packageRef.rootHash)) throw new Error("岗位包固定版本标识不完整。");
  for (const field of ["packageId", "packageVersion", "snapshotId", "rootHash"] as const) url.searchParams.set(field, packageRef[field]);
  if (nodeId) url.searchParams.set("nodeId", nodeId);
  return url.toString();
}

type Release = { id: string; sourceProjectVersionId: string | null; snapshotId: string; status: string; artifactRootHash: string | null; packageVersion: string };
export class LearningReleaseRequired extends Error {
  constructor() { super("当前快照还没有可供 LearnFlow 读取的固定岗位包。请先准备当前版本的私有岗位包，再回来预览挂载。"); }
}

/** Never substitute another snapshot or create/publish a package as a side effect of navigation. */
export async function readLearningMountPackage(input: { projectId: string; projectVersionId: string; snapshotId: string; fetcher: typeof fetch; signal: AbortSignal }): Promise<RolePackageRef> {
  const { fetcher } = input;
  const response = await fetcher(`/api/releases?projectId=${encodeURIComponent(input.projectId)}`, { signal: input.signal, cache: "no-store" });
  if (!response.ok) throw new Error("当前岗位包版本读取失败，请重试。");
  const payload = await response.json() as { releases?: Release[] };
  if (!Array.isArray(payload.releases)) throw new Error("岗位包版本列表格式无效。");
  const release = payload.releases.find(item => item.sourceProjectVersionId === input.projectVersionId && item.snapshotId === input.snapshotId && ["ready", "published"].includes(item.status) && item.artifactRootHash);
  if (!release) throw new LearningReleaseRequired();
  const artifact = await fetcher(`/api/releases/${encodeURIComponent(release.id)}/export?format=json`, { signal: input.signal, cache: "no-store" });
  if (!artifact.ok) throw new Error("当前岗位包制品暂时无法读取，请重试。");
  const { manifest } = await artifact.json() as { manifest?: RolePackageRef & { sourceProjectVersionId?: string } };
  if (!manifest || manifest.sourceProjectVersionId !== input.projectVersionId || manifest.snapshotId !== input.snapshotId || manifest.rootHash !== release.artifactRootHash || manifest.packageVersion !== release.packageVersion) throw new Error("岗位包制品与当前快照不一致，未跳转到其他版本。");
  const ref = { packageId: manifest.packageId, packageVersion: manifest.packageVersion, snapshotId: manifest.snapshotId, rootHash: manifest.rootHash };
  learningMountUrl(ref);
  input.signal.throwIfAborted();
  return ref;
}
