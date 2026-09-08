"use client";
import { useState } from "react";
import { readLearnFlowLaunchResponse } from "@/lib/integrations/learnflow/launch-response";

export default function TaskConversionButton({ releaseId, taskNodeId }: { releaseId: string; taskNodeId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function convert() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/integrations/learnflow/launch", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ releaseId, taskNodeId, source: "graph_hub", intent: "work_task_conversion" }),
        signal: AbortSignal.timeout(15_000),
      });
      window.location.assign(await readLearnFlowLaunchResponse(response));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "暂时无法转化，请重试。"); }
    finally { setBusy(false); }
  }
  return <span><button type="button" disabled={busy} onClick={() => void convert()}>{busy ? "正在准备…" : "转为学习项目"}</button>{error && <small role="alert">{error}</small>}</span>;
}
