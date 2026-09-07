"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CircleX,
  Clock3,
  Database,
  FileSearch,
  GitCompareArrows,
  Globe2,
  ListChecks,
  LoaderCircle,
  Network,
  Play,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import SourceMaterials from "@/app/components/SourceMaterials";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ColdStartBuildResult, LearningPathGraphInput, SourceInput } from "@/lib/build/types";
import {
  buildIterationActivityFeed,
  currentIterationThinking,
  formatIterationElapsed,
  iterationRunElapsed,
  type IterationActivity,
} from "@/lib/iteration/activity-feed";
import type { InitiativeProfile, IterationEvent, IterationMode, SnapshotIterationResult } from "@/lib/iteration/types";
import { PROVIDER_SESSION_KEY, type ProviderConfig } from "@/lib/providers";
import { SEARCH_PROVIDER_SESSION_KEY, type SearchProviderConfig } from "@/lib/search/providers";

type WorkspaceEnvelope = {
  reference: { snapshotId: string; projectId?: string; versionId?: string };
  title: string;
  description: string;
  market: string;
  version: { id: string; version: string; status: string; snapshotId: string };
  result: ColdStartBuildResult;
  source: "bundled" | "project" | "snapshot-store";
};

type SubmittedBrief = {
  profile: InitiativeProfile;
  mode: IterationMode;
  objective: string;
  targetCount: number;
  webResearch: boolean;
  hasSupplement: boolean;
};

const modeOptions: Array<{ id: Exclude<IterationMode, "auto">; label: string; detail: string }> = [
  { id: "deep_research", label: "深度研究", detail: "补证据、理边界、深化能力与学习路径" },
  { id: "risk_repair", label: "风险修复", detail: "最小修复重复、失证、非法关系与错误映射" },
  { id: "freshness", label: "时效迭代", detail: "更新标准、技术环境与带日期的岗位事实" },
];

const profileOptions: Array<{ id: InitiativeProfile; label: string; detail: string }> = [
  { id: "co_guided", label: "目标增强", detail: "推荐：围绕你的目标，并自动处理关联问题" },
  { id: "autonomous", label: "自动发现", detail: "Agent 全局检查后选择价值最高的研究组合" },
  { id: "user_directed", label: "定向研究", detail: "只研究提示词和选中节点，协议错误除外" },
];

const axisLabels: Record<keyof SnapshotIterationResult["inspectionAfter"]["axes"], string> = {
  structuralValidity: "结构有效",
  semanticClarity: "语义清晰",
  evidenceReadiness: "证据准备",
  temporalIntegrity: "时点完整",
  processCoverage: "事理覆盖",
  agentUsability: "Agent 可用",
};

const phaseSteps = [
  { phase: "contract", label: "理解目标" },
  { phase: "inspect", label: "检查发现" },
  { phase: "research", label: "研究取证" },
  { phase: "rebuild", label: "重建整理" },
  { phase: "evaluate", label: "评估版本" },
] as const;

function readSession<T>(key: string) {
  try { return JSON.parse(sessionStorage.getItem(key) || "null") as T | null; }
  catch { return null; }
}

function profileLabel(profile: InitiativeProfile) {
  return profileOptions.find((option) => option.id === profile)?.label || profile;
}

function contractObjective(events: IterationEvent[]) {
  const event = events.find((item) => item.kind === "iteration.contract.created");
  const contract = event?.payload.contract;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return "";
  return typeof (contract as { objective?: unknown }).objective === "string" ? (contract as { objective: string }).objective : "";
}

function currentPhaseIndex(events: IterationEvent[], result: SnapshotIterationResult | null) {
  if (result) return phaseSteps.length;
  const phase = [...events].sort((a, b) => a.seq - b.seq).at(-1)?.phase;
  if (!phase) return -1;
  if (phase === "system" || phase === "snapshot") return phase === "snapshot" ? phaseSteps.length - 1 : 0;
  if (phase === "plan") return 1;
  if (phase === "consolidate") return 3;
  return phaseSteps.findIndex((step) => step.phase === phase);
}

function ActivityIcon({ activity }: { activity: IterationActivity }) {
  if (activity.status === "failed") return <CircleX size={15} />;
  if (activity.status === "running") return <LoaderCircle className="spin" size={15} />;
  if (activity.kind === "message") return <BrainCircuit size={15} />;
  if (activity.kind === "milestone") return <Check size={15} />;
  if (activity.toolName?.includes("search")) return <Search size={15} />;
  if (activity.toolName?.includes("read") || activity.toolName?.includes("write")) return <Database size={15} />;
  if (activity.toolName?.includes("inspect") || activity.toolName?.includes("evaluate")) return <ShieldCheck size={15} />;
  if (activity.toolName?.includes("plan")) return <ListChecks size={15} />;
  return <Wrench size={15} />;
}

function ActivityCard({ activity }: { activity: IterationActivity }) {
  if (activity.kind === "message") {
    return (
      <article className={`iteration-agent-message ${activity.status}`}>
        <div className="iteration-agent-avatar"><Bot size={15} /></div>
        <div>
          <span className="iteration-message-author">ROLE AGENT · 分析摘要</span>
          <h3>{activity.title}</h3>
          <p>{activity.summary}</p>
          {activity.details.length ? <details className="iteration-inline-details"><summary>查看判断依据</summary><dl>{activity.details.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl></details> : null}
        </div>
      </article>
    );
  }

  return (
    <article className={`iteration-tool-call ${activity.status} ${activity.kind}`}>
      <div className="iteration-tool-icon"><ActivityIcon activity={activity} /></div>
      <div className="iteration-tool-body">
        <header>
          <span><b>{activity.title}</b><code>{activity.toolName || "iteration.step"}</code></span>
          <em>{activity.status === "running" ? "运行中" : activity.status === "failed" ? "失败" : "完成"} · {formatIterationElapsed(activity.elapsedMs)}</em>
        </header>
        <p>{activity.summary}</p>
        {activity.details.length ? <details className="iteration-tool-details"><summary><ChevronDown size={12} /> 查看工具输入与输出</summary><dl>{activity.details.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl></details> : null}
      </div>
    </article>
  );
}

function DiffRow({ label, added, removed, updated }: { label: string; added: number; removed: number; updated: number }) {
  return <div className="risk-diff-row"><b>{label}</b><span className="add">+{added}</span><span className="remove">−{removed}</span><span>~{updated}</span></div>;
}

function FinalResultMessage({ result, resultHref, resultLinkLabel, onAccept }: { result: SnapshotIterationResult; resultHref: string; resultLinkLabel: string; onAccept?: () => void }) {
  const selectedSources = result.researchReports.reduce((sum, report) => sum + report.selectedSourceCount, 0);
  return (
    <article className={`iteration-final-message ${result.createdSnapshot ? "created" : "unchanged"}`}>
      <div className="iteration-agent-avatar"><Sparkles size={15} /></div>
      <div className="iteration-final-body">
        <span className="iteration-message-author">ROLE AGENT · 最终回答</span>
        <h3>{result.createdSnapshot ? "本轮迭代完成，已形成新的静态快照" : "本轮研究已完成，当前快照保持不变"}</h3>
        <p>{result.summary.slice(0, 3).join(" ")}</p>
        <div className="iteration-result-facts">
          <span><b>{result.evaluation.informationGain.score.toFixed(1)}</b><small>信息增量</small></span>
          <span><b>{selectedSources}</b><small>新增来源</small></span>
          <span><b>{result.workItems.filter((item) => item.status === "completed").length}</b><small>完成工作项</small></span>
          <span><b>{result.knownGaps.length}</b><small>保留缺口</small></span>
        </div>
        {result.candidateSnapshotId ? <div className="iteration-result-actions">{onAccept
          ? <button type="button" onClick={onAccept}>{resultLinkLabel}<ChevronRight size={13} /></button>
          : <Link href={resultHref}>{resultLinkLabel}<ChevronRight size={13} /></Link>}<code>{result.candidateSnapshotId}</code></div> : null}
        <div className="iteration-result-disclosures">
          <details>
            <summary><ShieldCheck size={14} /><span><b>结构体检</b><small>{result.inspectionAfter.findings.length} 项发现 · {result.inspectionAfter.hardBlockers.length} 个协议阻断</small></span><ChevronDown size={13} /></summary>
            <div className="iteration-axis-grid">{Object.entries(result.inspectionAfter.axes).map(([key, after]) => { const before = result.inspectionBefore.axes[key as keyof typeof result.inspectionBefore.axes]; return <article key={key}><span>{axisLabels[key as keyof typeof axisLabels]}</span><b>{Math.round(after)}</b><small>{Math.round(before)} <ChevronRight size={9} /> {Math.round(after)}</small></article>; })}</div>
            <div className="iteration-finding-list">{result.inspectionAfter.findings.slice(0, 10).map((finding) => <article key={finding.id} className={finding.severity}><span><b>{finding.title}</b><small>{finding.detail}</small></span><em>{finding.hardBlocker ? "协议阻断" : finding.suggestedAction === "research" ? "后续研究" : "已记录"}</em></article>)}</div>
          </details>
          <details>
            <summary><GitCompareArrows size={14} /><span><b>快照变更</b><small>{result.diff.summary}</small></span><ChevronDown size={13} /></summary>
            <div className="risk-diff iteration-result-diff"><DiffRow label="语义节点" added={result.diff.nodes.added.length} removed={result.diff.nodes.removed.length} updated={result.diff.nodes.updated.length} /><DiffRow label="语义关系" added={result.diff.edges.added.length} removed={result.diff.edges.removed.length} updated={result.diff.edges.updated.length} /><DiffRow label="事理场景" added={result.diff.process.scenariosAdded.length} removed={result.diff.process.scenariosRemoved.length} updated={0} /><DiffRow label="证据来源" added={result.diff.sources.added.length} removed={result.diff.sources.removed.length} updated={0} /></div>
          </details>
          <details>
            <summary><ListChecks size={14} /><span><b>工作项与已知缺口</b><small>{result.workItems.length} 个工作项 · {result.knownGaps.length} 个缺口</small></span><ChevronDown size={13} /></summary>
            <div className="iteration-result-work-items">{result.workItems.map((item) => <article key={item.id}><i className={item.status} /><span><b>{item.title}</b><small>{item.kind} · {item.status} · {item.detail}</small></span></article>)}</div>
          </details>
        </div>
      </div>
    </article>
  );
}

export default function IterationWorkspace({ snapshotId, projectId, versionId, conversationId, initialProfile = "co_guided", initialPrompt = "", initialTargetIds = "", embedded = false, onClose, onComplete, onSettingsRequest }: { snapshotId: string; projectId?: string; versionId?: string; conversationId?: string; initialProfile?: InitiativeProfile; initialPrompt?: string; initialTargetIds?: string; embedded?: boolean; onClose?: () => void; onComplete?: (result: SnapshotIterationResult) => void; onSettingsRequest?: () => void }) {
  const [workspace, setWorkspace] = useState<WorkspaceEnvelope | null>(null);
  const [initiativeProfile, setInitiativeProfile] = useState<InitiativeProfile>(initialProfile);
  const [mode, setMode] = useState<Exclude<IterationMode, "auto">>("deep_research");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [targetIds, setTargetIds] = useState(initialTargetIds);
  const [targetAsOf, setTargetAsOf] = useState("");
  const [webResearch, setWebResearch] = useState(true);
  const [materials, setMaterials] = useState<SourceInput[]>([]);
  const [materialsBusy, setMaterialsBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<IterationEvent[]>([]);
  const [result, setResult] = useState<SnapshotIterationResult | null>(null);
  const [submittedBrief, setSubmittedBrief] = useState<SubmittedBrief | null>(null);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ snapshotId });
    if (projectId) params.set("projectId", projectId);
    if (versionId) params.set("versionId", versionId);
    fetch(`/api/snapshots/resolve?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as WorkspaceEnvelope & { error?: string };
        if (!response.ok || payload.error) throw new Error(payload.error || "快照读取失败。");
        setWorkspace(payload);
        return fetch(`/api/snapshot-iterations?snapshotId=${encodeURIComponent(payload.reference.snapshotId)}`, { signal: controller.signal });
      })
      .then((response) => response.json() as Promise<{ run?: { events?: IterationEvent[]; result?: SnapshotIterationResult } }>)
      .then((payload) => {
        if (payload.run?.events) setEvents(payload.run.events);
        if (payload.run?.result) {
          setResult(payload.run.result);
          setSubmittedBrief({ profile: payload.run.result.contract.initiativeProfile, mode: payload.run.result.contract.mode, objective: payload.run.result.contract.objective, targetCount: payload.run.result.contract.targetIds.length, webResearch: payload.run.result.researchPlans.some((plan) => plan.queries.length > 0), hasSupplement: false });
        }
      })
      .catch((cause) => {
        if (!(cause instanceof Error && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "迭代工作区读取失败。");
      });
    return () => controller.abort();
  }, [snapshotId, projectId, versionId]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!running && !result) return;
    conversationEndRef.current?.scrollIntoView({ behavior: events.length > 2 ? "smooth" : "auto", block: "end" });
  }, [events.length, result, running]);

  const activities = useMemo(() => buildIterationActivityFeed(events, clock), [events, clock]);
  const elapsed = useMemo(() => iterationRunElapsed(events, clock), [events, clock]);
  const thinking = useMemo(() => currentIterationThinking(events), [events]);
  const phaseIndex = useMemo(() => currentPhaseIndex(events, result), [events, result]);

  function applyEvent(event: IterationEvent) {
    setClock(Date.now());
    setEvents((current) => [...current.filter((item) => !(item.runId === event.runId && item.seq === event.seq)), event].sort((a, b) => a.seq - b.seq));
    if (event.kind === "iteration.run.completed" && event.payload.result) {
      const completed = event.payload.result as SnapshotIterationResult;
      setResult(completed);
      onComplete?.(completed);
    }
    if (event.kind === "iteration.run.failed") setError(String(event.payload.message || "岗位快照迭代失败。"));
  }

  async function start() {
    if (running || materialsBusy || !workspace) return;
    const parsedTargetIds = targetIds.split(/[\s,，]+/u).map((value) => value.trim()).filter(Boolean);
    setSubmittedBrief({ profile: initiativeProfile, mode, objective: prompt.trim() || (initiativeProfile === "autonomous" ? "自动发现当前快照中信息价值最高的问题并研究" : "围绕选定范围深化岗位快照"), targetCount: parsedTargetIds.length, webResearch, hasSupplement: materials.length > 0 });
    setRunning(true);
    setError("");
    setEvents([]);
    setResult(null);
    setClock(Date.now());
    const controller = new AbortController();
    abortRef.current = controller;
    const providerConfig = readSession<ProviderConfig>(PROVIDER_SESSION_KEY) || undefined;
    const searchConfig = webResearch ? readSession<SearchProviderConfig>(SEARCH_PROVIDER_SESSION_KEY) || undefined : undefined;
    const supplementalSources = materials;
    try {
      const learningPathGraph = await fetch("/data/learnflow-learning-path.json", { signal: controller.signal })
        .then(async (pathResponse) => pathResponse.ok ? await pathResponse.json() as LearningPathGraphInput : undefined)
        .catch(() => undefined);
      const response = await fetch("/api/snapshot-iterations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ iteration: { runId: crypto.randomUUID(), snapshotRef: workspace.reference, projectId: workspace.reference.projectId, conversationId: workspace.reference.projectId ? conversationId : undefined, initiativeProfile, mode, prompt: prompt.trim(), targetIds: parsedTargetIds, targetAsOf: targetAsOf || undefined, supplementalSources, learningPathGraph, webResearch, maxRounds: 2, sourceLimit: 12, maxWorkItems: 10 }, providerConfig, searchConfig }),
      });
      if (!response.ok || !response.body) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || `请求失败（${response.status}）`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines.filter(Boolean)) applyEvent(JSON.parse(line) as IterationEvent);
        if (done) break;
      }
      if (buffer.trim()) applyEvent(JSON.parse(buffer) as IterationEvent);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "岗位快照迭代请求失败。");
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  const backHref = workspace?.reference.projectId ? `/projects/${workspace.reference.projectId}${conversationId ? `?conversation=${encodeURIComponent(conversationId)}` : ""}` : `/${conversationId ? `?conversation=${encodeURIComponent(conversationId)}` : ""}`;
  const resultHref = result?.candidateSnapshotId ? workspace?.reference.projectId ? backHref : `/snapshots/${encodeURIComponent(result.candidateSnapshotId)}/iterate?profile=co_guided` : backHref;
  const objective = result?.contract.objective || contractObjective(events) || submittedBrief?.objective || "";
  const hasRunConversation = Boolean(events.length || running || result || (error && submittedBrief));

  const Shell = embedded ? "div" : "main";
  return (
    <Shell className={`risk-shell iteration-shell iteration-chat-shell${embedded ? " embedded-operation" : ""}`}>
      <aside className="risk-controls">
        <header className="cold-brand"><span><Network size={16} /></span><div><b>Role Atlas</b><small>统一岗位快照迭代</small></div></header>
        {embedded && onClose
          ? <button type="button" className="cold-back" onClick={onClose}><ArrowLeft size={13} /> 返回岗位工作台</button>
          : <Link className="cold-back" href={backHref}><ArrowLeft size={13} /> 返回岗位工作台</Link>}
        <section className="risk-form">
          <span className="cold-kicker">ITERATION BRIEF</span>
          <h1>{workspace?.title || "岗位快照迭代"}</h1>
          <p>先在这里明确基本信息。开始后，右侧会像 Agent 工作会话一样实时展示分析、工具调用、耗时和最终产物。</p>
          <div className="iteration-profile-picker" role="radiogroup" aria-label="迭代功能类型">
            {modeOptions.map((option) => <button type="button" role="radio" aria-checked={mode === option.id} disabled={running} className={mode === option.id ? "active" : ""} key={option.id} onClick={() => setMode(option.id)}><span><strong>{option.label}</strong><small>{option.detail}</small></span>{mode === option.id ? <Check size={12} /> : null}</button>)}
          </div>
          <div className="iteration-profile-picker" role="radiogroup" aria-label="迭代发起方式">
            {profileOptions.map((profile) => <button type="button" role="radio" aria-checked={initiativeProfile === profile.id} disabled={running} className={initiativeProfile === profile.id ? "active" : ""} key={profile.id} onClick={() => setInitiativeProfile(profile.id)}><span><strong>{profile.label}</strong><small>{profile.detail}</small></span>{initiativeProfile === profile.id ? <Check size={12} /> : null}</button>)}
          </div>
          <label><span>本轮想获得什么</span><textarea value={prompt} disabled={running} onChange={(event) => setPrompt(event.target.value)} placeholder={initiativeProfile === "autonomous" ? "可以留空，Agent 会自动发现并研究" : "例如：重点研究 Agent 系统开发任务及其学习路径，同时检查相关节点是否重复"} /></label>
          <label><span>限定节点 ID（可选）</span><textarea value={targetIds} disabled={running} onChange={(event) => setTargetIds(event.target.value)} placeholder="拖入或粘贴节点 ID，逗号分隔" /></label>
          <label><span>更新到目标时点（可选）</span><input type="date" value={targetAsOf} disabled={running} onChange={(event) => setTargetAsOf(event.target.value)} /></label>
          <label className="cold-web-toggle"><span><Globe2 size={13} /><b>自主定向研究</b><small>按工作项并行检索、抽取与去重</small></span><input type="checkbox" checked={webResearch} disabled={running} onChange={(event) => setWebResearch(event.target.checked)} /></label>
          <details className="iteration-source-input"><summary>添加资料（附件、URL、文本）</summary><SourceMaterials value={materials} onChange={setMaterials} disabled={running} onBusyChange={setMaterialsBusy} /></details>
          <div className="risk-baseline"><span><RefreshCw size={13} /><b>当前不可变快照</b></span><small>{workspace?.version ? `${workspace.version.version} · ${workspace.version.snapshotId}` : "正在读取快照…"}</small></div>
          {error ? <div className="cold-error"><AlertTriangle size={13} />{error}{embedded && onSettingsRequest ? <button type="button" onClick={onSettingsRequest}>设置</button> : <Link href="/settings">设置</Link>}</div> : null}
          {running ? <button className="cold-start stop" onClick={() => abortRef.current?.abort()}><Square size={12} />停止并保留运行记录</button> : <button className="cold-start" disabled={materialsBusy || !workspace || (initiativeProfile === "user_directed" && !prompt.trim() && !targetIds.trim())} onClick={() => void start()}><Play size={13} />开始岗位快照迭代</button>}
        </section>
      </aside>

      <section className="iteration-conversation">
        <header className="iteration-conversation-header">
          <div className="iteration-run-title"><span><Sparkles size={15} /></span><div><b>岗位快照迭代</b><small>{workspace?.title || "正在读取岗位…"}</small></div></div>
          <div className="iteration-header-status"><span className={running ? "running" : result ? "completed" : "idle"}><i />{running ? "正在运行" : result ? "本轮已完成" : "等待开始"}</span><span><Clock3 size={12} />{events.length ? formatIterationElapsed(elapsed) : "0 秒"}</span>{embedded && onSettingsRequest ? <button type="button" onClick={onSettingsRequest} aria-label="模型与检索设置"><Settings size={14} /></button> : <Link href="/settings" aria-label="模型与检索设置"><Settings size={14} /></Link>}</div>
        </header>
        <nav className="iteration-phase-strip" aria-label="迭代阶段">{phaseSteps.map((step, index) => <span className={index < phaseIndex || result ? "completed" : index === phaseIndex ? "active" : ""} key={step.phase}><i>{index < phaseIndex || result ? <Check size={10} /> : index + 1}</i>{step.label}</span>)}</nav>
        <div className="iteration-chat-scroll" aria-live="polite">
          {!hasRunConversation ? <div className="iteration-chat-empty"><div><BrainCircuit size={25} /></div><h2>确认左侧信息后，我会在这里工作</h2><p>你会看到我正在理解什么、调用了哪个工具、每一步用了多久、产生了什么结果。结构指标和技术 Diff 会收在最终回答的展开项中。</p><ul><li>先固定当前静态快照和研究边界</li><li>再检查结构并生成有界工作计划</li><li>按需联网研究、重建、修复与回归</li></ul></div> : null}
          {hasRunConversation ? <div className="iteration-chat-thread">
            <article className="iteration-user-message"><span>你发起了 · {modeOptions.find(option => option.id === (result?.contract.mode || submittedBrief?.mode || mode))?.label || "岗位迭代"} · {profileLabel(result?.contract.initiativeProfile || submittedBrief?.profile || initiativeProfile)}</span><p>{objective || "自动发现当前快照中信息价值最高的问题并研究"}</p><small>{submittedBrief?.targetCount ? `限定 ${submittedBrief.targetCount} 个节点 · ` : ""}{submittedBrief?.webResearch ?? webResearch ? "允许联网研究" : "不联网"}{submittedBrief?.hasSupplement ? " · 已附加资料" : ""}</small></article>
            {activities.map((activity) => <ActivityCard activity={activity} key={activity.id} />)}
            {running ? <article className="iteration-thinking-message"><div className="iteration-agent-avatar"><LoaderCircle className="spin" size={15} /></div><div><span className="iteration-message-author">ROLE AGENT · 正在思考</span><h3>{thinking}</h3><p>运行仍在继续，新的工具动作和结果会自动出现在这里。</p><small><Clock3 size={11} /> 已运行 {formatIterationElapsed(elapsed)}</small></div></article> : null}
            {result ? <FinalResultMessage result={result} resultHref={resultHref} resultLinkLabel={embedded ? "应用新版本并返回工作台" : workspace?.reference.projectId ? "打开项目中的新版本" : "从新快照继续迭代"} onAccept={embedded ? onClose : undefined} /> : null}
            {error && !events.some((event) => event.kind === "iteration.run.failed") ? <article className="iteration-agent-message failed"><div className="iteration-agent-avatar"><CircleX size={15} /></div><div><span className="iteration-message-author">ROLE AGENT · 运行提示</span><h3>本轮没有继续执行</h3><p>{error}</p></div></article> : null}
            <div ref={conversationEndRef} />
          </div> : null}
        </div>
        <footer className="iteration-conversation-footer"><FileSearch size={12} /><span>显示的是可核验的分析摘要、工具调用和运行状态；原始事件与快照版本仍会持久化保存。</span></footer>
      </section>
    </Shell>
  );
}
