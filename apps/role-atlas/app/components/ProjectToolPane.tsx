"use client";

import { jobDisplayStatus, jobConnectionMessage } from "@/lib/jobs/presentation";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, LoaderCircle, Play, Square, Wrench, X } from "lucide-react";
import SourceMaterials from "./SourceMaterials";
import IterationOptions, { IterationBrief } from "./IterationOptions";
import { conversationIterationRequest, defaultIterationDraft, iterationBriefError, iterationRunBrief, parseIterationTargets, type IterationDraft, type IterationRunBrief } from "@/lib/iteration/brief";
import { readOfficialLearningPath } from "@/lib/learning-path/load";
import type { ColdStartBuildResult, SourceInput } from "@/lib/build/types";
import { PROVIDER_SESSION_KEY } from "@/lib/providers";
import { SEARCH_PROVIDER_SESSION_KEY } from "@/lib/search/providers";
import { roleSkillDefinitions, type RoleSkillId, type WorkspaceSkillContext } from "@/lib/skills/workspace";

type RunEvent = { kind: string; payload: Record<string, unknown> };
type Job = { id: string; kind: string; status: string; phase: string; updatedAt: string; error?: string; iterationBrief?: IterationRunBrief; result?: { candidateSnapshotId?: string; appliedToHead?: boolean }; resumable?: boolean; recovery?: { state: string; deliveries: number } };
const activeStatuses = new Set(["queued", "running", "cancelling", "waiting_user", "recovering"]);
const phaseLabels: Record<string, string> = { queued: "等待执行", recovering: "正在恢复", running: "正在研究", completed: "已完成", complete: "已完成", failed: "执行失败", cancelled: "已停止", interrupted: "运行已中断" };
function sessionValue(key: string) { try { return JSON.parse(sessionStorage.getItem(key) || "null") || undefined; } catch { return undefined; } }

/** One instance per conversation; hidden conversations keep their request and draft. */
export default function ProjectToolPane({ context, currentSelectedNodeIds, activeTool, promptSeed, targetSeed, onClose, onPreview, onComplete, onBusyChange }: {
  context: WorkspaceSkillContext; activeTool: RoleSkillId | null; promptSeed?: { text: string; nonce: number };
  currentSelectedNodeIds?: string[]; targetSeed?: { ids: string[]; nonce: number };
  onClose: () => void; onPreview: (result: ColdStartBuildResult) => void;
  onComplete: (conversationId: string) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [prompt, setPrompt] = useState(activeTool === "cold-start-role-package" ? context.roleDescription || "" : "");
  const [market, setMarket] = useState(context.market || "中国大陆");
  const [materials, setMaterials] = useState<SourceInput[]>([]);
  const [materialsBusy, setMaterialsBusy] = useState(false);
  const [webResearch, setWebResearch] = useState(true);
  const [iterationDrafts, setIterationDrafts] = useState<Partial<Record<RoleSkillId, IterationDraft>>>({});
  const [submittedBrief, setSubmittedBrief] = useState<IterationRunBrief>();
  const [workspaceJson, setWorkspaceJson] = useState("");
  const [adapterId, setAdapterId] = useState("event_log");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [progress, setProgress] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const submittedId = useRef("");
  const preparation = useRef<AbortController | null>(null);
  const cursors = useRef(new Map<string, number>());
  const [resuming, setResuming] = useState<string>();
  const completed = useRef(new Set<string>());
  const callbacks = useRef({ onPreview, onComplete, onBusyChange });
  callbacks.current = { onPreview, onComplete, onBusyChange };
  const definition = roleSkillDefinitions.find((skill) => skill.id === activeTool);
  const pending = jobs.some((job) => activeStatuses.has(job.status));
  const blocked = running || pending;
  const isIteration = activeTool === "snapshot-iteration" || activeTool === "node-deepening";
  const iterationDraft = (activeTool && iterationDrafts[activeTool]) || defaultIterationDraft(activeTool === "node-deepening", context.selectedNodeIds);
  const briefError = isIteration ? iterationBriefError({ ...iterationDraft, prompt, targetIds: parseIterationTargets(iterationDraft.targetIds) }) : "";

  useEffect(() => { if (targetSeed) setIterationDrafts((current) => ({ ...current, "node-deepening": { ...(current["node-deepening"] || defaultIterationDraft(true)), targetIds: targetSeed.ids.join(", ") } })); }, [targetSeed]);
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
        const list = (payload.jobs || []).map((job) => {
          const status = jobDisplayStatus(job);
          return { ...job, status, error: job.error || (status === "interrupted" ? "执行已中断，检查点与已有成果已保留。" : status === "recovering" ? "后台正在从已保存阶段恢复，无需重复提交。" : undefined) };
        });
        setJobs(list); setHistoryError("");
        if (list.some(job => job.id === submittedId.current && !["failed", "interrupted"].includes(job.status))) setError("");
        // Reconnect using the durable cursor, including events produced while this view was closed.
        const recent = list.slice(0, 1);
        for (const job of recent) {
          const after = cursors.current.get(job.id) || 0;
          const replay = await fetch(`/api/projects/${encodeURIComponent(context.projectId!)}/jobs/${encodeURIComponent(job.id)}?after=${after}`);
          if (!replay.ok) throw new Error("执行记录暂时无法读取，正在重连。");
          const saved = await replay.json() as { events: RunEvent[]; cursor: number };
          if (disposed) return;
          for (const event of saved.events) applyEvent(event);
          cursors.current.set(job.id, saved.cursor);
        }
        const latest = list.filter((job) => ["completed", "complete"].includes(job.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 1);
        for (const job of latest) {
          if (["completed", "complete"].includes(job.status) && !completed.current.has(job.id)) {
            completed.current.add(job.id);
            callbacks.current.onComplete(context.conversationId!);
          }
        }
      } catch (cause) { if (!disposed) setHistoryError(jobConnectionMessage(cause)); }
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
    if (briefError) { setError(briefError); return; }
    let parsedWorkspace: unknown;
    if (activeTool === "workspace-instantiation") {
      try { parsedWorkspace = JSON.parse(workspaceJson); } catch { setError("请添加有效的工作区 JSON 文件或粘贴导出内容。"); return; }
    }
    const id = crypto.randomUUID();
    submittedId.current = id;
    setRunning(true); setEvents([]); setSubmittedBrief(undefined); setProgress("正在提交任务…");
    const providerConfig = sessionValue(PROVIDER_SESSION_KEY);
    const searchConfig = webResearch ? sessionValue(SEARCH_PROVIDER_SESSION_KEY) : undefined;
    try {
      const snapshotRef = { snapshotId: context.snapshotId, projectId: context.projectId, versionId: context.versionId };
      const common = { providerConfig, searchConfig };
      let endpoint = "/api/snapshot-iterations";
      let body: Record<string, unknown>;
      let learningPathGraph;
      if (activeTool !== "workspace-instantiation") {
        const controller = new AbortController();
        preparation.current = controller;
        learningPathGraph = await readOfficialLearningPath(fetch, controller.signal);
        preparation.current = null;
      }
      if (activeTool === "cold-start-role-package") {
        endpoint = "/api/build-runs";
        body = { ...common, conversationId: context.conversationId, webResearch, build: { runId: id, projectId: context.projectId, roleTitle: context.roleTitle, roleDescription: prompt || context.roleDescription || "", market, audience: ["岗位研究者"], snapshotAsOf: new Date().toISOString().slice(0, 10), sources: materials, learningPathGraph } };
      } else if (activeTool === "workspace-instantiation") {
        endpoint = "/api/workspace-upgrades";
        body = { ...common, snapshotRef, conversationId: context.conversationId, workspace: { runId: id, projectId: context.projectId, connection: { adapterId, payload: parsedWorkspace, roleHint: context.roleTitle, visibility: "project_private", provenance: { capturedAt: new Date().toISOString() } }, maxObservations: 16, redactPersonalData: true }, iteration: { prompt, webResearch, maxRounds: 1, sourceLimit: 8, maxWorkItems: 10 } };
      } else {
        const iteration = conversationIterationRequest({ runId: id, context, draft: iterationDraft, prompt, materials, webResearch, learningPathGraph: learningPathGraph! });
        setSubmittedBrief(iterationRunBrief(iteration));
        body = { ...common, iteration };
      }
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", prefer: "respond-async" }, body: JSON.stringify(body) });
      if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || `提交失败（${response.status}）`);
      if (response.status === 202) {
        const accepted = await response.json() as { job: Job };
        setJobs(current => [accepted.job, ...current.filter(job => job.id !== accepted.job.id)]);
        setProgress("任务已提交，后台正在执行。");
        return;
      }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n"); buffer = lines.pop() || "";
        for (const line of lines.filter(Boolean)) applyEvent(JSON.parse(line) as RunEvent);
        if (done) break;
      }
      if (buffer.trim()) applyEvent(JSON.parse(buffer) as RunEvent);
      callbacks.current.onComplete(context.conversationId);
    } catch (cause) { setError(preparation.current?.signal.aborted ? "已取消准备，本轮未提交。" : jobConnectionMessage(cause)); }
    finally { preparation.current = null; setRunning(false); }
  }

  async function resume(id: string) {
    setResuming(id); setError("");
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(context.projectId!)}/jobs/${encodeURIComponent(id)}/resume`, { method: "POST" });
      const payload = await response.json() as { job?: Job; error?: string };
      if (!response.ok || !payload.job) throw new Error(payload.error || "恢复失败，请稍后再试。");
      setJobs(current => current.map(job => job.id === id ? payload.job! : job));
    } catch (cause) { setError(jobConnectionMessage(cause)); }
    finally { setResuming(undefined); }
  }

  async function cancel(id: string) {
    if (preparation.current) { preparation.current.abort(); return; }
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(context.projectId!)}/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error || "停止失败。");
      setProgress("已请求停止，正在保留结果与执行记录。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "停止失败。"); }
  }

  return <div className="project-tool-pane">
    {definition && <section className="chat-tool-form" aria-label={`${definition.label}工具`}>
      <header><Wrench size={14} /><b>{definition.label}</b><button type="button" onClick={onClose} aria-label="收起工具"><X size={14} /></button></header>
      <p>{activeTool === "node-deepening" ? "围绕指定节点和目标补充证据与结构，可在下方调整研究范围。" : activeTool === "cold-start-role-package" ? `为「${context.roleTitle}」建立首个岗位包。` : definition.description}</p>
      {isIteration && <IterationOptions value={iterationDraft} onChange={(draft) => setIterationDrafts((current) => ({ ...current, [activeTool!]: draft }))} disabled={blocked} nodes={context.availableNodes} selectedNodeIds={currentSelectedNodeIds || context.selectedNodeIds} />}
      {activeTool === "cold-start-role-package" && <label>市场范围<input value={market} onChange={(e) => setMarket(e.target.value)} disabled={blocked} /></label>}
      <label>{activeTool === "cold-start-role-package" ? "想重点了解什么" : "本次工作目标"}<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={blocked} maxLength={4000} placeholder={isIteration && iterationDraft.initiativeProfile === "autonomous" ? "可以留空，由 Agent 检查全岗位并发现研究机会" : "描述你希望补充、核实或修正的内容…"} /></label>
      {activeTool === "workspace-instantiation" ? <>
        <label>工作资料类型<select value={adapterId} disabled={blocked} onChange={(e) => setAdapterId(e.target.value)}>{[["event_log", "工单与过程日志"], ["github_trace", "GitHub 工作链"], ["telemetry_case", "可观测性案例"], ["soc_case", "安全运营案例"], ["generic_package", "标准工作区包"], ["devgpt", "AI 开发会话"], ["swebench", "SWE-bench 案例"], ["bug_benchmark", "缺陷基准案例"]].map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label>导入脱敏的 JSON 文件<input type="file" accept=".json,application/json" disabled={blocked} onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 5_000_000) { setError("文件不能超过 5 MB。"); return; } setWorkspaceJson(await file.text()); }} /></label>
        <details><summary>{workspaceJson ? "已添加资料 · 查看内容" : "或粘贴工作区导出内容"}</summary><textarea value={workspaceJson} onChange={(e) => setWorkspaceJson(e.target.value)} disabled={blocked} spellCheck={false} /></details>
        <small>原始资料保留为项目私有，仅提取可追溯的工作观察。</small>
      </> : <details><summary>添加资料（可选） · {materials.length} 份</summary><SourceMaterials value={materials} onChange={setMaterials} disabled={blocked} onBusyChange={setMaterialsBusy} /></details>}
      <label className="tool-checkbox"><input type="checkbox" checked={webResearch} disabled={blocked} onChange={(e) => setWebResearch(e.target.checked)} />联网研究与来源核对</label>
      {isIteration && <small>重建时会带入 LearnFlow 学习路径进行对齐。关闭联网且无附加资料时，仅做确定性检查与修复。</small>}
      <small>基于本对话固定版本。结果保存在本对话；与其他对话并行时会保留独立候选版本。</small>
      {briefError && <small role="status">{briefError}</small>}
      {!blocked && <button className="tool-submit" disabled={materialsBusy || Boolean(briefError)} onClick={() => void start()}><Play size={13} />开始执行</button>}
    </section>}
    {(error || historyError) && <div className="tool-error" role="alert"><AlertTriangle size={14} /><span>{error || historyError}</span></div>}
    {running && <article className="chat-job-card running" role="status"><header><LoaderCircle className="spin" size={14} /><b>{progress}</b></header><p>可以切换或新建对话，任务继续运行。</p>{submittedBrief && <IterationBrief brief={submittedBrief} />}<button onClick={() => void cancel(submittedId.current)}><Square size={12} />停止任务</button>{events.length > 0 && <details><summary>查看执行过程</summary>{events.map((event, index) => <p key={index}>{event}</p>)}</details>}</article>}
    {jobs.length > 0 && <section className="conversation-jobs" aria-label="当前对话的任务记录">{jobs.slice(0, 8).map((job) => <article key={job.id} className={`chat-job-card ${job.status}`}><header>{activeStatuses.has(job.status) ? <LoaderCircle size={13} className="spin" /> : ["failed", "interrupted"].includes(job.status) ? <AlertTriangle size={13} /> : job.status === "cancelled" ? <Square size={13} /> : <Check size={13} />}<b>{job.kind.includes("workspace") ? "工作区接入" : job.kind.includes("build") || job.kind.includes("cold") ? "岗位研究" : "岗位完善"}</b><span>{phaseLabels[job.status] || "已保存"}</span></header><p>{job.error || (job.result?.appliedToHead === false ? "已形成独立候选版本，可在版本历史比较与采用。" : activeStatuses.has(job.status) ? "正在后台执行，结果将自动更新展示台。" : "结果与执行记录已保存在本对话。")}</p>{job.iterationBrief && <IterationBrief brief={job.iterationBrief} />}{activeStatuses.has(job.status) ? <button onClick={() => void cancel(job.id)}><Square size={11} />停止</button> : ["failed", "interrupted"].includes(job.status) && job.resumable ? <button disabled={blocked || Boolean(resuming)} onClick={() => void resume(job.id)}><Play size={11} />{resuming === job.id ? "正在恢复…" : "从保存处继续"}</button> : job.result?.candidateSnapshotId && <button onClick={() => onComplete(context.conversationId!)}>查看本轮成果</button>}</article>)}</section>}
  </div>;
}
