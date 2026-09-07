"use client";

import { useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";

type TrashedProject = { id: string; title: string; deletedAt: string };

export default function ProjectManagement({ projectId, title, variant = "both" }: { projectId?: string; title: string; variant?: "both" | "delete" | "trash" }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleted, setDeleted] = useState<TrashedProject[]>([]);
  const loadTrash = async () => {
    setOpen(true); setBusy(true); setError("");
    try {
      const response = await fetch("/api/projects/trash");
      const payload = await response.json() as { projects?: TrashedProject[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "回收站读取失败。");
      setDeleted(payload.projects || []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "回收站读取失败。"); }
    finally { setBusy(false); }
  };
  const change = async (id: string, action: "delete" | "restore") => {
    if (action === "delete" && !window.confirm(`将“${title}”移入回收站？后台任务将标记取消并禁止提交新版本，已发出的模型请求可能稍后结束。项目可以恢复，已发布岗位包不会被删除。`)) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: action === "delete" ? "DELETE" : "PATCH",
        ...(action === "restore" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) } : {}) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "操作失败。");
      window.location.assign(action === "delete" ? "/" : `/projects/${encodeURIComponent(id)}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败。"); }
    finally { setBusy(false); }
  };
  return <div className="project-management">
    <div className="project-actions">
      {projectId && variant !== "trash" && <button type="button" className="project-new-chat" disabled={busy} onClick={() => void change(projectId, "delete")}><Trash2 size={13} /> 删除当前项目</button>}
      {variant !== "delete" && <button type="button" className="project-new-chat" disabled={busy} onClick={() => open ? setOpen(false) : void loadTrash()} aria-expanded={open}><RotateCcw size={13} /> 回收站</button>}
    </div>
    {error && <p role="alert" className="project-empty">{error}</p>}
    {open && <section aria-label="项目回收站">
      {busy && <p role="status">正在读取…</p>}
      {!busy && !error && !deleted.length && <p className="project-empty">没有可恢复的项目。</p>}
      {deleted.map(project => <div className="project-row" key={project.id}><span><b>{project.title}</b><small>{new Date(project.deletedAt).toLocaleDateString()}</small></span><button type="button" disabled={busy} onClick={() => void change(project.id, "restore")} aria-label={`恢复${project.title}`}>恢复</button></div>)}
    </section>}
  </div>;
}
