"use client";

import { ArrowLeft, Download, ExternalLink, MessageCircle, PackageOpen, Search, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { roleAtlasHref as publicHref } from "@/lib/public-links";

export type RegistryPackage = {
  id: string;
  packageId: string;
  title: string;
  maintenanceKind: string;
  hostingKind: string;
  visibility: string;
  registryVersion?: number;
  canManageHub?: boolean;
  forkOrigin?: import("@/lib/hub/fork-plan").ForkOrigin | null;
  evidencePolicy: string;
  license: string;
  protocolRange: string;
  maintenancePolicy: { reviewCadence?: string; updateTriggers?: string[] };
  status: string;
  recommendedReleaseId: string | null;
  scope: Record<string, unknown>;
  maintainer: { name: string; kind: string } | null;
  roleIdentity: { canonicalName: string; aliasesJson: string; description: string } | null;
  releases: Array<{ id: string; projectId: string | null; packageVersion: string; snapshotId: string; snapshotAsOf: string; protocolVersion: string; artifactRootHash: string | null; status: string; publishedAt: string | null }>;
};

function listValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0).join("、") : typeof value === "string" ? value : "";
}

function aliases(value?: string) {
  try { return listValue(JSON.parse(value || "[]")); }
  catch { return ""; }
}

export default function RegistryCatalog({ initialPackages, initialQuery = "", embedded = false, surface = "registry", roleAtlasBaseUrl = "", graphHubBaseUrl = "", onClose, onChanged }: { initialPackages: RegistryPackage[]; initialQuery?: string; embedded?: boolean; surface?: "registry" | "hub"; roleAtlasBaseUrl?: string; graphHubBaseUrl?: string; onClose?: () => void; onChanged?: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery.slice(0, 500));
  const [notice, setNotice] = useState("");
  const [publicationBusy, setPublicationBusy] = useState("");
  const [publicationOverrides, setPublicationOverrides] = useState<Record<string, { visibility: string; registryVersion: number }>>({});
  const [uploading, setUploading] = useState(false);
  const [launchingReleaseId, setLaunchingReleaseId] = useState("");
  const packages = useMemo(() => initialPackages.map(item => ({ ...item, ...publicationOverrides[item.id] })).filter((item) => `${item.title}${item.packageId}`.toLowerCase().includes(query.toLowerCase())), [initialPackages, query, publicationOverrides]);
  const roleAtlasHref = (path: string) => {
    return publicHref(roleAtlasBaseUrl, path);
  };
  const graphHubHref = (packageLineId: string) => {
    const path = `/hub/${encodeURIComponent(packageLineId)}`;
    try { return graphHubBaseUrl ? new URL(path, graphHubBaseUrl).toString() : path; }
    catch { return path; }
  };

  const upload = async (file?: File) => {
    if (!file) return;
    setUploading(true); setNotice("");
    try {
      const form = new FormData(); form.set("file", file);
      const response = await fetch("/api/packages/import", { method: "POST", body: form });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "导入失败");
      setNotice("岗位包已校验并登记为 ready Release；尚未自动设为推荐版本。");
      if (onChanged) onChanged(); else router.refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "导入失败"); }
    finally { setUploading(false); }
  };

  const launchLearnFlow = async (releaseId: string) => {
    setLaunchingReleaseId(releaseId); setNotice("");
    try {
      const response = await fetch("/api/integrations/learnflow/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ releaseId, source: surface === "hub" ? "graph_hub" : "role_atlas" }),
      });
      const payload = await response.json() as { launchUrl?: string; error?: string };
      if (!response.ok || !payload.launchUrl) throw new Error(payload.error || "无法进入 LearnFlow");
      window.location.assign(payload.launchUrl);
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法进入 LearnFlow"); }
    finally { setLaunchingReleaseId(""); }
  };

  const changePublication = async (item: RegistryPackage) => {
    if (publicationBusy || !item.recommendedReleaseId || item.registryVersion === undefined) return;
    const withdraw = item.visibility === "public";
    if (!window.confirm(withdraw
      ? `确定从 Graph Hub 撤回“${item.title}”？公开搜索、详情和下载将停止提供；个人岗位包与历史版本保留，已下载的副本无法追回。`
      : `确定将“${item.title}”的推荐版本重新公开到 Graph Hub？`)) return;
    setPublicationBusy(item.id); setNotice("");
    try {
      const response = await fetch("/api/releases", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        action: withdraw ? "withdraw_from_hub" : "restore_to_hub", packageLineId: item.id,
        expectedReleaseId: item.recommendedReleaseId, expectedRegistryVersion: item.registryVersion,
      }) });
      const payload = await response.json() as { publication?: { visibility: string; registry_version: number }; error?: string };
      if (!response.ok || !payload.publication) throw new Error(payload.error === "PUBLICATION_CONFLICT" ? "岗位包已被更新，请刷新后重试。" : "操作未完成，请刷新页面并确认你拥有此岗位包。");
      const result = payload.publication;
      setPublicationOverrides(previous => ({ ...previous, [item.id]: { visibility: result.visibility, registryVersion: result.registry_version } }));
      setNotice(withdraw ? "已从 Graph Hub 撤回。个人岗位包和历史版本仍保留，可随时重新公开。" : "已重新公开到 Graph Hub。");
      if (onChanged) onChanged(); else router.refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "发布状态更新失败。"); }
    finally { setPublicationBusy(""); }
  };

  const Shell = embedded ? "div" : "main";
  return <Shell className={`registry-shell${embedded ? " embedded-operation" : ""}`}>
    <header className="registry-topbar">{embedded && onClose ? <button type="button" onClick={onClose}><ArrowLeft size={14} /> 返回工作台</button> : <a href={roleAtlasHref("/")}><ArrowLeft size={14} /> 进入 Role Atlas</a>}<b>{surface === "hub" ? "GRAPH HUB · SHARED DISCOVERY" : "ROLE ATLAS PACKAGE REGISTRY"}</b><span>{initialPackages.length} 条岗位包线</span></header>
    <section className="registry-hero"><span>{surface === "hub" ? "DISCOVER · VERIFY · USE" : "OWNED · PULLED · LOCAL"}</span><h1>{surface === "hub" ? "图谱市场" : "我的岗位包"}</h1><p>{surface === "hub" ? "Graph Hub 展示所有已经公开发布的岗位包。检索可见图谱后，可以进入 Role Atlas 继续研究，也可以在 LearnFlow 中新建对话并固定引用所选岗位包。" : "这里只管理当前工作区自己创建、导入或从 Graph Hub 拉取的岗位包；公开发布与全站发现请前往 Graph Hub。"}</p><div><label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索岗位或 package ID" /></label>{surface === "registry" ? <label className="registry-upload"><Upload size={14} /> {uploading ? "正在校验…" : "导入岗位包"}<input disabled={uploading} type="file" accept=".zip,.json,application/zip,application/json" onChange={(event) => void upload(event.target.files?.[0])} /></label> : null}</div></section>
    {notice ? <div className="registry-notice">{notice}</div> : null}
    <section className="registry-grid">{packages.map((item) => {
      const recommended = item.releases.find((release) => release.id === item.recommendedReleaseId);
      const scope = [listValue(item.scope.industries), listValue(item.scope.region), listValue(item.scope.educationStages), listValue(item.scope.audiences)].filter(Boolean).join(" · ") || listValue(item.scope.market) || "未限定";
      const identityAliases = aliases(item.roleIdentity?.aliasesJson);
      return <article className="registry-card" key={item.id}>
        <header><PackageOpen size={18} /><span><b>{item.title}</b><code>{item.packageId}</code></span><i>{item.status}</i></header>
        <p>{item.roleIdentity?.description || "尚未填写岗位包简介。"}</p>
        {item.forkOrigin ? <p>Fork 自 <a href={graphHubHref(item.forkOrigin.packageLineId)}>{item.forkOrigin.title} · v{item.forkOrigin.packageVersion}</a> · 独立维护 · 许可：{item.forkOrigin.license}<br /><code>来源哈希 {item.forkOrigin.rootHash.slice(0, 12)}</code></p> : null}
        <dl>
          <div><dt>身份</dt><dd>{item.roleIdentity?.canonicalName || item.title}{identityAliases ? ` · ${identityAliases}` : ""}</dd></div>
          <div><dt>范围</dt><dd>{scope}</dd></div>
          <div><dt>维护</dt><dd>{item.maintainer?.name || "未登记"} · {item.maintenanceKind} · {item.maintenancePolicy.reviewCadence || "按需"}</dd></div>
          <div><dt>托管</dt><dd>{item.hostingKind} · {item.visibility}</dd></div>
          <div><dt>许可/证据</dt><dd>{item.license} · {item.evidencePolicy}</dd></div>
          <div><dt>兼容</dt><dd>{item.protocolRange}{recommended ? ` · 制品协议 ${recommended.protocolVersion}` : ""}</dd></div>
          <div><dt>推荐</dt><dd>{recommended ? `v${recommended.packageVersion} · ${recommended.snapshotAsOf || "时间未登记"}` : "尚未发布"}</dd></div>
          <div><dt>快照/哈希</dt><dd><code>{recommended ? `${recommended.snapshotId} · ${(recommended.artifactRootHash || "").slice(0, 12)}` : "—"}</code></dd></div>
        </dl>
        <details className="registry-history">
          <summary>查看全部 {item.releases.length} 个历史版本</summary>
          <div>{item.releases.map((release) => <span key={release.id}>
            <b>v{release.packageVersion}{release.id === item.recommendedReleaseId ? " · 推荐" : ""}</b>
            <small>{release.status} · {release.snapshotAsOf || "时间未登记"}</small>
            <code>{release.snapshotId}</code>
            {release.artifactRootHash && ["ready", "published", "deprecated"].includes(release.status) ? <a href={`/api/releases/${release.id}/export`}><Download size={11} /> 导出</a> : null}
          </span>)}</div>
        </details>
        <footer><span>{item.releases.length} 个 Release</span><div className="registry-card-actions">{surface === "registry" && recommended?.projectId ? <a href={roleAtlasHref(`/projects/${encodeURIComponent(recommended.projectId)}`)}>打开并维护</a> : null}{surface === "registry" && item.canManageHub && recommended?.status === "published" ? <button type="button" disabled={Boolean(publicationBusy)} onClick={() => void changePublication(item)}>{publicationBusy === item.id ? "正在更新…" : item.visibility === "public" ? "从 Graph Hub 撤回" : "重新公开到 Graph Hub"}</button> : null}{surface === "hub" && recommended ? <a href={roleAtlasHref(recommended.projectId ? `/projects/${recommended.projectId}` : `/snapshots/${encodeURIComponent(recommended.snapshotId)}/iterate`)}><ExternalLink size={12} /> 进入 Role Atlas</a> : recommended && item.visibility === "public" ? <a href={graphHubHref(item.id)}><ExternalLink size={12} /> 进入 Graph Hub</a> : <span>尚未发布到 Graph Hub</span>}{recommended ? <button type="button" disabled={launchingReleaseId === recommended.id} onClick={() => void launchLearnFlow(recommended.id)}><MessageCircle size={12} /> {launchingReleaseId === recommended.id ? "正在进入…" : "在 LearnFlow 中引用"}</button> : null}{recommended ? <a href={`/api/releases/${recommended.id}/export`}><Download size={12} /> 导出</a> : null}</div></footer>
      </article>;
    })}</section>
  </Shell>;
}
