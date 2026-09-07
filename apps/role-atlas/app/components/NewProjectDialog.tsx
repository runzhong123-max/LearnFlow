"use client";

import { useState } from "react";
import { ArrowRight, FolderPlus, LoaderCircle, X } from "lucide-react";

export default function NewProjectDialog({ onClose, initialTitle = "", initialDescription = "", initialMarket = "中国大陆" }: { onClose: () => void; initialTitle?: string; initialDescription?: string; initialMarket?: string }) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [market, setMarket] = useState(initialMarket);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create() {
    if (busy || title.trim().length < 2) return;
    setBusy(true); setError("");
    try {
      const id = crypto.randomUUID(); const conversationId = crypto.randomUUID();
      const response = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, conversationId, title: title.trim(), description: description.trim(), market: market.trim() || "中国大陆" }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "项目创建失败。");
      window.location.assign(`/projects/${encodeURIComponent(id)}?conversation=${encodeURIComponent(conversationId)}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "项目创建失败。"); setBusy(false); }
  }
  return <section className="new-project-dialog" role="dialog" aria-modal="true" aria-labelledby="new-project-title">
    <button className="dialog-close" type="button" onClick={onClose} disabled={busy} aria-label="关闭新建项目"><X size={18} /></button>
    <span className="dialog-symbol"><FolderPlus size={24} /></span>
    <h2 id="new-project-title">开始一个岗位项目</h2><p>先建立属于你的私有研究空间，再让助手逐步完善岗位图谱。</p>
    <form onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <label>岗位名称<input required autoFocus minLength={2} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} placeholder="例如：云运维工程师" /></label>
      <label>研究目标（可选）<textarea maxLength={8000} value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} placeholder="你想理解哪些任务、能力或工作场景？" /></label>
      <label>市场范围<input required maxLength={120} value={market} onChange={(e) => setMarket(e.target.value)} disabled={busy} /></label>
      {error && <p className="tool-error" role="alert">{error}</p>}
      <small>项目、对话和未发布的成果仅自己可见。创建项目不会自动调用模型或搜索。</small>
      <button className="tool-submit" disabled={busy || title.trim().length < 2} type="submit">{busy ? <LoaderCircle className="spin" size={15} /> : <ArrowRight size={15} />}创建并进入项目</button>
    </form>
  </section>;
}
