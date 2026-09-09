"use client";

import { Download, MessageCircle, GitFork } from "lucide-react";
import { useState } from "react";

export default function HubRepositoryActions({ releaseId }: { releaseId: string }) {
  const [busy, setBusy] = useState(false);
  const [forking, setForking] = useState(false);
  const [error, setError] = useState("");
  const launch = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/integrations/learnflow/launch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ releaseId, source: "graph_hub" }) });
      const payload = await response.json() as { launchUrl?: string; error?: string };
      if (!response.ok || !payload.launchUrl) throw new Error(payload.error || "无法进入 LearnFlow");
      window.location.assign(payload.launchUrl);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法进入 LearnFlow"); }
    finally { setBusy(false); }
  };
  const fork = async () => {
    if (forking || busy) return;
    setForking(true); setError("");
    try {
      const response = await fetch("/api/hub/fork", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ releaseId }) });
      const payload = await response.json() as { projectUrl?: string; error?: string };
      if (!response.ok || !payload.projectUrl) throw new Error(response.status === 401 ? "请先登录，再 Fork 到自己的岗位包。" : payload.error === "PUBLIC_RELEASE_NOT_FOUND" ? "此版本已不再公开，请刷新仓库页面。" : payload.error || "Fork 失败");
      window.location.assign(payload.projectUrl);
    } catch(cause) { setError(cause instanceof Error ? cause.message : "Fork 失败"); }
    finally { setForking(false); }
  };
  return <div className="hub-repo-actions"><button type="button" onClick={() => void fork()} disabled={busy || forking}><GitFork size={14} />{forking ? "正在创建个人副本…" : "Fork 到我的岗位包"}</button><button type="button" onClick={() => void launch()} disabled={busy || forking}><MessageCircle size={14} /> {busy ? "正在连接…" : "在 LearnFlow 中使用"}</button><a href={`/api/releases/${releaseId}/export`}><Download size={14} /> 下载岗位包</a>{error ? <small>{error}</small> : null}</div>;
}
