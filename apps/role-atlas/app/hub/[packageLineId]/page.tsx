import TaskConversionButton from "./TaskConversionButton";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, BadgeCheck, Box, CalendarClock, CheckCircle2, ChevronRight, CircleDot, FileCode2, GitBranch, Network, PackageOpen, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { bootstrapBundledRegistryPackage } from "@/lib/registry/bootstrap";
import { getPublicHubRepository } from "@/lib/hub/repository";
import { roleAtlasHref as publicHref } from "@/lib/public-links";
import HubRepositoryActions from "./HubRepositoryActions";

function text(value: unknown, fallback = "") { return typeof value === "string" ? value : fallback; }
function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`; }
function routeId(value: string) { try { return decodeURIComponent(value); } catch { return value; } }

export async function generateMetadata({ params }: { params: Promise<{ packageLineId: string }> }): Promise<Metadata> {
  await bootstrapBundledRegistryPackage().catch(() => null);
  const repository = await getPublicHubRepository(routeId((await params).packageLineId));
  if (!repository) return { title: "图谱仓库不存在 · Graph Hub" };
  const description = repository.item.roleIdentity?.description || `${repository.item.title} 的版本化岗位图谱仓库。`;
  return { title: `${repository.item.title} · Graph Hub`, description, openGraph: { title: `${repository.item.title} · Graph Hub`, description, images: [] }, twitter: { title: `${repository.item.title} · Graph Hub`, description, images: [] } };
}

export default async function HubRepositoryPage({ params }: { params: Promise<{ packageLineId: string }> }) {
  await bootstrapBundledRegistryPackage().catch(() => null);
  const repository = await getPublicHubRepository(routeId((await params).packageLineId));
  if (!repository) notFound();
  const { item, release, bundle, overview } = repository;
  const aliases = (() => { try { return JSON.parse(item.roleIdentity?.aliasesJson || "[]") as string[]; } catch { return []; } })();
  const registryScope = item.scope as Record<string, unknown>;
  const scope = [registryScope.industries, registryScope.audiences, registryScope.region].flat().filter((value): value is string => typeof value === "string");

  return <main className="hub-repository-shell">
    <header className="hub-nav hub-repo-nav"><Link className="hub-brand" href="/hub"><span><Network size={18} /></span><b>Graph Hub</b><i>Repositories</i></Link><nav><Link href="/hub">探索</Link><Link href="/registry">Registry</Link></nav><div><a className="hub-ghost" href={publicHref(process.env.ROLE_ATLAS_PUBLIC_URL, "/")}><ArrowLeft size={13} /> Role Atlas</a></div></header>
    <div className="hub-repo-breadcrumb"><Link href="/hub">graph-hub</Link><ChevronRight size={13} /><b>{item.packageId}</b><span>{item.visibility}</span></div>
    <section className="hub-repo-heading">
      <div className="hub-repo-title"><span><PackageOpen size={24} /></span><div><h1>{item.title}</h1><code>{item.packageId}</code></div></div>
      {release ? <HubRepositoryActions releaseId={release.id} /> : null}
    </section>
    <div className="hub-repo-tabs"><a className="active" href="#readme"><FileCode2 size={14} /> 概览</a><a href="#graph"><Network size={14} /> 图谱结构</a><a href="#files"><Box size={14} /> 文件</a><a href="#versions"><GitBranch size={14} /> 版本</a></div>

    <div className="hub-repository-layout">
      <section className="hub-repo-main">
        {release && overview && bundle ? <>
          <div className="hub-commit-bar"><span className="hub-avatar">RA</span><b>{item.maintainer?.name || "Role Atlas"}</b><span>发布了 v{release.packageVersion}</span><code>{release.artifactRootHash?.slice(0, 9)}</code><time>{release.publishedAt ? new Date(release.publishedAt).toLocaleDateString("zh-CN") : release.snapshotAsOf}</time></div>
          <article className="hub-file-browser" id="files"><header><b>文件</b><span>{overview.files.length} 个协议组件</span></header>{overview.files.map((file) => <div key={file.path}><FileCode2 size={14} /><b>{file.path}</b><code>{file.hash.slice(0, 12)}</code><span>{formatBytes(file.bytes)}</span></div>)}</article>
          <article className="hub-readme" id="readme">
            <header><FileCode2 size={15} /><b>README</b></header>
            <div><span className="hub-readme-kicker">ROLE GRAPH REPOSITORY</span><h2>{item.title}</h2><p>{item.roleIdentity?.description || "这是一个由 Role Atlas 生成并托管的岗位图谱仓库。"}</p>
              <div className="hub-readme-badges"><span><BadgeCheck size={12} /> 已验证</span><span><ShieldCheck size={12} /> {bundle.manifest.evidencePolicy} evidence</span><span>protocol {bundle.manifest.protocolVersion}</span></div>
              <h3 id="graph">图谱包含什么</h3>
              <div className="hub-graph-summary"><span><b>{overview.tasks.length}</b>典型任务</span><span><b>{overview.capabilities.length}</b>能力节点</span><span><b>{overview.knowledge.length}</b>知识技能</span><span><b>{overview.scenarios.length}</b>工作场景</span><span><b>{overview.assets.length}</b>证据来源</span></div>
              {overview.tasks.length ? <><h3>典型任务</h3><ul>{overview.tasks.slice(0, 8).map((node) => <li key={text(node.id)}><CircleDot size={13} /><span><b>{text(node.label, text(node.id))}</b>{text(node.summary) ? <small>{text(node.summary)}</small> : null}</span>{release && <TaskConversionButton releaseId={release.id} taskNodeId={text(node.id)} />}</li>)}</ul></> : null}
              {overview.scenarios.length ? <><h3>工作场景</h3><ul>{overview.scenarios.slice(0, 6).map((node) => <li key={text(node.id)}><GitBranch size={13} /><span><b>{text(node.label, text(node.id))}</b>{text(node.summary) ? <small>{text(node.summary)}</small> : null}</span>{release && <TaskConversionButton releaseId={release.id} taskNodeId={text(node.id)} />}</li>)}</ul></> : null}
              <h3>不可变身份</h3><pre><code>{`package:  ${bundle.manifest.packageId}@${bundle.manifest.packageVersion}\nsnapshot: ${bundle.manifest.snapshotId}\nroot:     ${bundle.manifest.rootHash}`}</code></pre>
            </div>
          </article>
          <article className="hub-release-history" id="versions"><header><GitBranch size={15} /><b>版本历史</b></header>{item.releases.map((version) => <div key={version.id}><span className={version.id === item.recommendedReleaseId ? "recommended" : ""}><CheckCircle2 size={13} /> v{version.packageVersion}</span><code>{version.snapshotId}</code><small>{version.status} · {version.publishedAt ? new Date(version.publishedAt).toLocaleDateString("zh-CN") : version.snapshotAsOf}</small></div>)}</article>
        </> : <div className="hub-empty"><Box size={26} /><b>这个仓库还没有可浏览的公开制品</b><span>维护者发布首个有效版本后，文件和图谱概览会显示在这里。</span></div>}
      </section>
      <aside className="hub-repo-sidebar">
        <section><h3>关于</h3><p>{item.roleIdentity?.description || "版本化岗位图谱仓库"}</p>{aliases.length ? <div className="hub-aliases">{aliases.slice(0, 5).map((alias) => <span key={alias}>{alias}</span>)}</div> : null}</section>
        <section><h3>仓库信息</h3><dl><div><dt><BadgeCheck size={13} /> 维护者</dt><dd>{item.maintainer?.name || "未登记"}</dd></div><div><dt><ShieldCheck size={13} /> 证据策略</dt><dd>{item.evidencePolicy}</dd></div><div><dt><CalendarClock size={13} /> 快照时间</dt><dd>{release?.snapshotAsOf || "—"}</dd></div><div><dt><Box size={13} /> 许可</dt><dd>{item.license}</dd></div></dl></section>
        <section><h3>适用范围</h3><div className="hub-topic-list">{scope.length ? scope.slice(0, 8).map((value) => <span key={value}>{value}</span>) : <span>通用</span>}</div></section>
        {overview ? <section><h3>图谱统计</h3><dl><div><dt>语义关系</dt><dd>{overview.semanticEdges}</dd></div><div><dt>事理节点</dt><dd>{overview.processNodes.length}</dd></div><div><dt>事理关系</dt><dd>{overview.processEdges}</dd></div><div><dt>证据绑定</dt><dd>{overview.bindings.length}</dd></div></dl></section> : null}
      </aside>
    </div>
  </main>;
}
