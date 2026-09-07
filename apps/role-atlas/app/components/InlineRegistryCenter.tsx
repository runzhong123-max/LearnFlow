"use client";

import { AlertTriangle, FolderKanban, LoaderCircle, LockKeyhole, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import RegistryCatalog, { type RegistryPackage } from "@/app/registry/RegistryCatalog";

export default function InlineRegistryCenter({ onClose }: { onClose: () => void }) {
  const [packages, setPackages] = useState<RegistryPackage[] | null>(null);
  const [projects, setProjects] = useState<Array<{ id: string; title: string; status: string; headVersionId?: string | null; activeVersionId?: string | null }>>([]);
  const [tab, setTab] = useState<"projects" | "packages">("projects");
  const [graphHubBaseUrl, setGraphHubBaseUrl] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/registry");
      const payload = await response.json() as { packages?: RegistryPackage[]; projects?: typeof projects; graphHubBaseUrl?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || "岗位包中心读取失败。");
      setPackages(payload.packages || []);
      setProjects(payload.projects || []);
      setGraphHubBaseUrl(payload.graphHubBaseUrl || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "岗位包中心读取失败。");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  if (error) return <div className="inline-operation-state error"><AlertTriangle size={17} /><b>{error}</b><button onClick={() => void load()}>重试</button><button onClick={onClose}>返回工作台</button></div>;
  if (!packages) return <div className="inline-operation-state"><LoaderCircle className="spin" size={18} /><b>正在读取岗位包中心…</b></div>;
  return <section className="personal-assets-center" aria-label="我的岗位包">
    <header><div><span>PERSONAL LIBRARY</span><h2>我的岗位包</h2><p>研究中的项目和已保存的成果，都属于你的个人空间。</p></div><button type="button" onClick={onClose} aria-label="关闭我的岗位包"><X size={18} /></button></header>
    <nav><button aria-pressed={tab === "projects"} onClick={() => setTab("projects")}>我创建的 · {projects.length}</button><button aria-pressed={tab === "packages"} onClick={() => setTab("packages")}>已保存岗位包 · {packages.length}</button><Link href={graphHubBaseUrl || "/hub"}>浏览公开图谱市场 ↗</Link></nav>
    {tab === "projects" ? <div className="personal-project-grid">{projects.map((project) => <Link className="personal-project-card" key={project.id} href={`/projects/${encodeURIComponent(project.id)}`}><FolderKanban size={23} /><h3>{project.title}</h3><p>{project.status === "building" ? "正在研究" : project.headVersionId || project.activeVersionId ? "已有岗位成果，继续完善" : "项目草稿 · 等待首次研究"}</p><small><LockKeyhole size={11} />个人项目</small></Link>)}{!projects.length && <div className="personal-empty"><FolderKanban size={28} /><h3>你的岗位研究，从第一个项目开始</h3><p>无需发布，项目与研究成果就会保存在这里。</p><Link href="/projects/new">新建项目</Link></div>}</div>
      : <RegistryCatalog initialPackages={packages} graphHubBaseUrl={graphHubBaseUrl} embedded onChanged={() => void load()} />}
  </section>;
}
