"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, LoaderCircle, Play, Square, Wrench, X } from "lucide-react";
import SourceMaterials from "./SourceMaterials";
import type { ColdStartBuildResult, SourceInput } from "@/lib/build/types";
import { PROVIDER_SESSION_KEY } from "@/lib/providers";
import { SEARCH_PROVIDER_SESSION_KEY } from "@/lib/search/providers";
import { roleSkillDefinitions, type RoleSkillId, type WorkspaceSkillContext } from "@/lib/skills/workspace";

type RunEvent = { kind: string; payload: Record<string, unknown> };
type Job = { id: string; kind: string; status: string; phase: string; updatedAt: string; error?: string; result?: { candidateSnapshotId?: string; appliedToHead?: boolean }; resumable?: boolean };
const activeStatuses = new Set(["queued", "running", "cancelling", "waiting_user"]);
const phaseLabels: Record<string, string> = { queued: "等待执行", running: "正在研究", completed: "已完成", complete: "已完成", failed: "执行失败", cancelled: "已停止", interrupted: "运行已中断" };
function sessionValue(key: string) { try { return JSON.parse(sessionStorage.getItem(key) || "null") || undefined; } catch { return undefined; } }

/** One instance per conversation; hidden conversations keep their request and draft. */
export default function ProjectToolPane({ context, activeTool, promptSeed, onClose, onPreview, onComplete, onBusyChange }: {
  context: WorkspaceSkillContext; activeTool: RoleSkillId | null; promptSeed?: { text: string; nonce: number };
  onClose: () => void; onPreview: (result: ColdStartBuildResult) => void;
  onComplete: (conversationId: string) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [prompt, setPrompt] = useState(activeTool === "cold-start-role-package" ? context.roleDescription || "" : "");
  const [market, setMarket] = useState(context.market || "中国大陆");
  const [materials, setMaterials] = useState<SourceInput[]>([]);
  const [materialsBusy, setMaterialsBusy] = useState(false);
  const [webResearch, setWebResearch] = useState(true);
  const [workspaceJson, setWorkspaceJson] = useState("");
  const [adapterId, setAdapterId] = useState("event_log");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [progress, setProgress] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const submittedId = useRef("");
  const completed = useRef(new Set<string>());
  const callbacks = useRef({ onPreview, onComplete, onBusyChange });
  callbacks.current = { onPreview, onComplete, onBusyChange };
  const definition = roleSkillDefinitions.find((skill) => skill.id === activeTool);
  const pending = jobs.some((job) => activeStatuses.has(job.status));
  const blocked = running || pending;

  useEffect(() => { if (promptSeed) setPrompt(promptSeed.text); }, [promptSeed]);
  useEffect(() => { if (activeTool === "cold-start-role-package" && context.roleDescription) setPrompt((current) => current || context.roleDescription!); }, [activeTool, context.roleDescription]);
  useEffect(() => { callbacks.current.onBusyChange(blocked); }, [blocked]);
  useEffect(() => {
    if (!context.projectId || !context.conversationId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(context.projectId!)}/jobs?conversationId=${encodeURIComponent(context.conversationId!)}`);
        const payload = await response.json() as { jobs?: Job[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "任务历史暂时无法读取。");
        if (disposed) return;
        const list = (payload.jobs || []).map((job) => job.status === "running" && job.resumable
          ? { ...job, status: "interrupted", error: job.error || "执行已中断，已保存的成果仍可查看。选择工具重新发起即可继续研究。" }
          : job);
        setJobs(list); setHistoryError("");
        const latest = list.filter((job) => ["completed", "complete"].includes(job.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 1);
        for (const job of latest) {
          if (["completed", "complete"].includes(job.status) && !completed.current.has(job.id)) {
            completed.current.add(job.id);
            callbacks.current.onComplete(context.conversationId!);
          }
        }
      } catch (cause) { if (!disposed) setHistoryError(cause instanceof Error ? cause.message : "任务历史读取失败。"); }
      finally { if (!disposed) timer = setTimeout(load, 6000); }
    };
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [context.projectId, context.conversationId]);

  function applyEvent(event: RunEvent) {
    if (event.kind.includes("reasoning.delta")) return;
    const summary = String(event.payload.message || event.payload.title || event.payload.phase || "");
    const label = event.kind.includes("search") ? "正在检索与核对来源" : event.kind.includes("semantic") ? "岗位结构正在更新" : event.kind.includes("process") ? "正在补充典型工作过程" : event.kind.includes("completed") ? "阶段结果已保存" : "正在分析并构建岗位内容";
    setProgress(summary || label);
    setEvents((current) => [...current.slice(-19), summary || label]);
    const result = event.payload.result as ColdStartBuildResult | undefined;
    if (result?.semantic && result?.snapshot && result?.packages) callbacks.current.onPreview(result);
    if (event.kind.endsWith("run.completed") || event.kind === "build.kernel.completed") callbacks.current.onComplete(context.conversationId!);
    if (event.kind.endsWith("run.failed")) setError(summary || "任务未完成，已有结果和记录已保留。");
  }

  async function start() {
    if (!activeTool || !context.projectId || !context.conversationId || blocked || materialsBusy) return;
    setError("");
    let parsedWorkspace: unknown;
    if (activeTool === "workspace-instantiation") {
      try { parsedWorkspace = JSON.parse(workspaceJson); } catch { setError("请添加有效的工作区 JSON 文件或粘贴导出内容。"); return; }
    }
    const id = crypto.randomUUID();
    submittedId.current = id;
    setRunning(true); setEvents([]); setProgress("正在提交任务…");
    const providerConfig = sessionValue(PROVIDER_SESSION_KEY);
    const searchConfig = webResearch ? sessionValue(SEARCH_PROVIDER_SESSION_KEY) : undefined;
    try {
      const snapshotRef = { snapshotId: context.snapshotId, projectId: context.projectId, versionId: context.versionId };
      const common = { providerConfig, searchConfig };
      let endpoint = "/api/snapshot-iterations";
      let body: Record<string, unknown>;
      if (activeTool === "cold-start-role-package") {
        endpoint = "/api/build-runs";
        body = { ...common, conversationId: context.conversationId, webResearch, build: { runId: id, projectId: context.projectId, roleTitle: context.roleTitle, roleDescription: prompt || context.roleDescription || "", market, audience: ["岗位研究者"], snapshotAsOf: new Date().toISOString().slice(0, 10), sources: materials } };
      } else if (activeTool === "workspace-instantiation") {
        endpoint = "/api/workspace-upgrades";
        body = { ...common, snapshotRef, conversationId: context.conversationId, workspace: { runId: id, projectId: context.projectId, connection: { adapterId, payload: parsedWorkspace, roleHint: context.roleTitle, visibility: "project_private", provenance: { capturedAt: new Date().toISOString() } }, maxObservations: 16, redactPersonalData: true }, iteration: { prompt, webResearch, maxRounds: 1, sourceLimit: 8, maxWorkItems: 10 } };
      } else {
        body = { ...common, iteration: { runId: id, snapshotRef, projectId: context.projectId, conversationId: context.conversationId, initiativeProfile: activeTool === "node-deepening" ? "user_directed" : "co_guided", mode: activeTool === "node-deepening" ? "deep_research" : "auto", prompt: prompt || (activeTool === "node-deepening" ? "围绕选中节点补充证据、任务关系、能力结构与学习依赖" : "发现并完善岗位包中需要研究的内容"), targetIds: activeTool === "node-deepening" ? context.selectedNodeIds || [] : [], supplementalSources: materials, webResearch, maxRounds: 2, sourceLimit: 12, maxWorkItems: 10 } };
      }
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || `提交失败（${response.status}）`);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n"); buffer = lines.pop() || "";
        for (const line of lines.filter(Boolean)) applyEvent(JSON.parse(line) as RunEvent);
        if (done) break;
      }
      if (buffer.trim()) applyEvent(JSON.parse(buffer) as RunEvent);
      callbacks.current.onComplete(context.conversationId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "连接暂时中断，请查看下方已保存任务状态。"); }
    finally { setRunning(false); }
  }

  async function cancel(id: string) {
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(context.projectId!)}/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error || "停止失败。");
      setProgress("已请求停止，正在保留结果与执行记录。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "停止失败。"); }
  }

  return <div className="project-tool-pane">
    {definition && <section className="chat-tool-form" aria-label={`${definition.label}工具`}>
      <header><Wrench size={14} /><b>{definition.label}</b><button type="button" onClick={onClose} aria-label="收起工具"><X size={14} /></button></header>
      <p>{activeTool === "node-deepening" ? `范围：选中节点（${context.selectedNodeIds?.length || 0} 个），及必要关联。` : activeTool === "cold-start-role-package" ? `为「${context.roleTitle}」建立首个岗位包。` : definition.description}</p>
      {activeTool === "cold-start-role-package" && <label>市场范围<input value={market} onChange={(e) => setMarket(e.target.value)} disabled={blocked} /></label>}
      <label>{activeTool === "cold-start-role-package" ? "想重点了解什么" : "本次工作目标"}<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={blocked} maxLength={4000} placeholder="描述你希望补充、核实或修正的内容…" /></label>
      {activeTool === "workspace-instantiation" ? <>
        <label>工作资料类型<select value={adapterId} disabled={blocked} onChange={(e) => setAdapterId(e.target.value)}>{[["event_log", "工单与过程日志"], ["github_trace", "GitHub 工作链"], ["telemetry_case", "可观测性案例"], ["soc_case", "安全运营案例"], ["generic_package", "标准工作区包"], ["devgpt", "AI 开发会话"], ["swebench", "SWE-bench 案例"], ["bug_benchmark", "缺陷基准案例"]].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label>导入脱敏的 JSON 文件<input type="file" accept=".json,application/json" disabled={blocked} onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 5_000_000) { setError("文件不能超过 5 MB。"); return; } setWorkspaceJson(await file.text()); }} /></label>
        <details><summary>{workspaceJson ? "已添加资料 · 查看内容" : "或粘贴工作区导出内容"}</summary><textarea value={workspaceJson} onChange={(e) => setWorkspaceJson(e.target.value)} disabled={blocked} spellCheck={false} /></details>
        <small>原始资料保留为项目私有，仅提取可追溯的工作观察。</small>
      </> : <details><summary>添加资料（可选） · {materials.length} 份</summary><SourceMaterials value={materials} onChange={setMaterials} disabled={blocked} onBusyChange={setMaterialsBusy} /></details>}
      <label className="tool-checkbox"><input type="checkbox" checked={webResearch} disabled={blocked} onChange={(e) => setWebResearch(e.target.checked)} />联网研究与来源核对</label>
      <small>基于本对话固定版本。结果保存在本对话；与其他对话并行时会保留独立候选版本。</small>
      {!blocked && <button className="tool-submit" disabled={materialsBusy || (activeTool === "node-deepening" && !context.selectedNodeIds?.length)} onClick={() => void start()}><Play size={13} />开始执行</button>}
    </section>}
    {(error || historyError) && <div className="tool-error" role="alert"><AlertTriangle size={14} /><span>{error || historyError}</span></div>}
    {running && <article className="chat-job-card running" role="status"><header><LoaderCircle className="spin" size={14} /><b>{progress}</b></header><p>可以切换或新建对话，任务继续运行。</p><button onClick={() => void cancel(submittedId.current)}><Square size={12} />停止任务</button>{events.length > 0 && <details><summary>查看执行过程</summary>{events.map((event, index) => <p key={index}>{event}</p>)}</details>}</article>}
    {jobs.length > 0 && <section className="conversation-jobs" aria-label="当前对话的任务记录">{jobs.slice(0, 8).map((job) => <article key={job.id} className={`chat-job-card ${job.status}`}><header>{activeStatuses.has(job.status) ? <LoaderCircle size={13} className="spin" /> : job.status === "failed" ? <AlertTriangle size={13} /> : <Check size={13} />}<b>{job.kind.includes("workspace") ? "工作区接入" : job.kind.includes("build") || job.kind.includes("cold") ? "岗位研究" : "岗位完善"}</b><span>{phaseLabels[job.status] || "已保存"}</span></header><p>{job.error || (job.result?.appliedToHead === false ? "已形成独立候选版本，可在版本历史比较与采用。" : activeStatuses.has(job.status) ? "正在后台执行，结果将自动更新展示台。" : "结果与执行记录已保存在本对话。")}</p>{activeStatuses.has(job.status) ? <button onClick={() => void cancel(job.id)}><Square size={11} />停止</button> : job.result?.candidateSnapshotId && <button onClick={() => onComplete(context.conversationId!)}>查看本轮成果</button>}</article>)}</section>}
  </div>;
}
