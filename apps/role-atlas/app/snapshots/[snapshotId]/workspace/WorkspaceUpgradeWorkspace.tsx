"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleX,
  Clock3,
  FileJson,
  FileUp,
  FolderKanban,
  GitBranch,
  Globe2,
  LoaderCircle,
  Network,
  Play,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import langGraphTrace from "@/fixtures/workspaces/langgraph-pr-8053.json";
import type { ColdStartBuildResult } from "@/lib/build/types";
import type { IterationEvent, SnapshotIterationResult } from "@/lib/iteration/types";
import { PROVIDER_SESSION_KEY, type ProviderConfig } from "@/lib/providers";
import { SEARCH_PROVIDER_SESSION_KEY, type SearchProviderConfig } from "@/lib/search/providers";
import type { WorkspaceRunEvent } from "@/lib/workspaces/events";
import type { WorkspaceAdapterId, WorkspaceEvidenceClass } from "@/lib/workspaces/types";

type WorkspaceEnvelope = {
  reference: { snapshotId: string; projectId?: string; versionId?: string };
  title: string;
  version: { id: string; version: string; status: string; snapshotId: string };
  result: ColdStartBuildResult;
};

const adapters: Array<{ id: WorkspaceAdapterId; label: string; detail: string }> = [
  { id: "generic_package", label: "标准 Workspace Package", detail: "已经按 1.0 协议整理的资源、对象与事件" },
  { id: "github_trace", label: "GitHub 工作链", detail: "Issue、PR、Commit、Review、CI 与 Release" },
  { id: "devgpt", label: "DevGPT 会话", detail: "AI 辅助开发对话与关联代码产物" },
  { id: "swebench", label: "SWE-bench 案例", detail: "真实问题、基线代码、人工 Patch 与测试" },
  { id: "bug_benchmark", label: "缺陷基准案例", detail: "Defects4J、BugsInPy 等可复现修复链" },
  { id: "event_log", label: "过程事件日志", detail: "工单、运维或业务流程 case event log" },
  { id: "telemetry_case", label: "可观测性案例", detail: "Metric、Log、Trace、Incident 与修复结果" },
  { id: "soc_case", label: "安全运营案例", detail: "告警调查、分诊、处置与关闭事件链" },
];

const examplePayloads: Partial<Record<WorkspaceAdapterId, unknown>> = {
  github_trace: langGraphTrace,
};

const phaseSteps = [
  ["register", "识别资料"], ["scan", "安全扫描"], ["extract", "提取工作链"],
  ["align", "对齐快照"], ["iterate", "实例化重建"], ["snapshot", "形成版本"],
] as const;

function readSession<T>(key: string) {
  try { return JSON.parse(sessionStorage.getItem(key) || "null") as T | null; }
  catch { return null; }
}

function eventTitle(event: WorkspaceRunEvent | IterationEvent) {
  const titles: Record<string, string> = {
    "workspace.run.started": "登记工作区连接",
    "workspace.package.normalized": "归一化为 Workspace Package",
    "workspace.scan.started": "扫描敏感内容与重复资源",
    "workspace.resource.accepted": "资源进入抽取队列",
    "workspace.resource.quarantined": "隔离不可用资源",
    "workspace.scan.completed": "资源扫描完成",
    "workspace.episode.extracted": "提取工作 episode",
    "workspace.alignment.started": "对齐典型任务与事理场景",
    "workspace.alignment.completed": "完成任务对齐",
    "workspace.iteration.prepared": "准备岗位快照实例化",
    "workspace.run.completed": "工作区蒸馏完成",
    "iteration.contract.created": "建立实例化边界",
    "iteration.inspection.started": "检查现有快照结构",
    "iteration.research.plan.created": "规划外部补证",
    "iteration.search.started": "检索外部岗位证据",
    "iteration.search.completed": "外部检索返回",
    "iteration.candidate.rebuild.started": "重建岗位快照与事理森林",
    "iteration.candidate.rebuilt": "候选快照已重建",
    "iteration.evaluation.completed": "评估信息增量与回退",
    "iteration.snapshot.created": "形成新的静态快照版本",
    "iteration.run.completed": "工作区驱动迭代完成",
  };
  return titles[event.kind] || event.kind.replaceAll(".", " · ");
}

function eventSummary(event: WorkspaceRunEvent | IterationEvent) {
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.title === "string") return payload.title;
  if (typeof payload.summary === "string") return payload.summary;
  if (payload.inventory && typeof payload.inventory === "object") {
    const inventory = payload.inventory as { acceptedResourceCount?: number; eventCount?: number; caseCount?: number };
    return `${inventory.acceptedResourceCount || 0} 项资源 · ${inventory.eventCount || 0} 个事件 · ${inventory.caseCount || 0} 条工作链`;
  }
  if (typeof payload.alignedCount === "number") return `对齐 ${payload.alignedCount} 条观察 · 候选新任务 ${String(payload.candidateTaskCount || 0)} 条`;
  if (typeof payload.observationId === "string") return `${String(payload.lane || "episode")} · ${String(payload.episodeId || "独立产物")}`;
  if (typeof payload.resourceId === "string") return `${String(payload.kind || "resource")} · ${String(payload.resourceId)}`;
  return "运行记录已保存，可展开查看结构化输入与输出。";
}

function currentPhase(events: Array<WorkspaceRunEvent | IterationEvent>, result: SnapshotIterationResult | null) {
  if (result?.candidateSnapshotId) return 5;
  const last = events.at(-1);
  if (!last) return -1;
  if (last.kind.startsWith("iteration.")) {
    if (last.phase === "snapshot") return 5;
    return 4;
  }
  return phaseSteps.findIndex(([phase]) => phase === last.phase);
}

export default function WorkspaceUpgradeWorkspace({ snapshotId, projectId, versionId, conversationId, embedded = false, onClose, onComplete, onSettingsRequest }: { snapshotId: string; projectId?: string; versionId?: string; conversationId?: string; embedded?: boolean; onClose?: () => void; onComplete?: (result: SnapshotIterationResult) => void; onSettingsRequest?: () => void }) {
  const [workspace, setWorkspace] = useState<WorkspaceEnvelope | null>(null);
  const [adapterId, setAdapterId] = useState<WorkspaceAdapterId>("github_trace");
  const [evidenceClass, setEvidenceClass] = useState<WorkspaceEvidenceClass | "">("");
  const [title, setTitle] = useState("");
  const [roleHint, setRoleHint] = useState("");
  const [locator, setLocator] = useState("https://github.com/langchain-ai/langgraph/pull/8053");
  const [payload, setPayload] = useState(() => JSON.stringify(examplePayloads.github_trace, null, 2));
  const [prompt, setPrompt] = useState("");
  const [webResearch, setWebResearch] = useState(true);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<Array<WorkspaceRunEvent | IterationEvent>>([]);
  const [result, setResult] = useState<SnapshotIterationResult | null>(null);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ snapshotId });
    if (projectId) params.set("projectId", projectId);
    if (versionId) params.set("versionId", versionId);
    fetch(`/api/snapshots/resolve?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const value = await response.json() as WorkspaceEnvelope & { error?: string };
        if (!response.ok) throw new Error(value.error || "快照读取失败。");
        setWorkspace(value);
        setRoleHint(value.title);
        const [workspaceResponse, iterationResponse] = await Promise.all([
          fetch(`/api/workspaces/ingest?snapshotId=${encodeURIComponent(value.reference.snapshotId)}`, { signal: controller.signal }),
          fetch(`/api/snapshot-iterations?snapshotId=${encodeURIComponent(value.reference.snapshotId)}`, { signal: controller.signal }),
        ]);
        const workspaceHistory = await workspaceResponse.json() as { run?: { status?: string; error?: string; iterationRunId?: string; events?: WorkspaceRunEvent[] } };
        const iterationHistory = await iterationResponse.json() as { run?: { id?: string; events?: IterationEvent[]; result?: SnapshotIterationResult } };
        const workspaceEvents = workspaceHistory.run?.events || [];
        const iterationMatches = Boolean(workspaceHistory.run?.iterationRunId && workspaceHistory.run.iterationRunId === iterationHistory.run?.id);
        setEvents(iterationMatches ? [...workspaceEvents, ...(iterationHistory.run?.events || [])] : workspaceEvents);
        if (iterationMatches && iterationHistory.run?.result) setResult(iterationHistory.run.result);
        if (workspaceHistory.run?.status === "failed" && workspaceHistory.run.error) setError(workspaceHistory.run.error);
      })
      .catch((cause) => {
        if (!(cause instanceof Error && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "快照读取失败。");
      });
    return () => controller.abort();
  }, [snapshotId, projectId, versionId]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  useEffect(() => { if (events.length) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [events.length]);

  const phase = useMemo(() => currentPhase(events, result), [events, result]);
  const startedAt = events[0]?.time ? Date.parse(events[0].time) : 0;
  const elapsed = startedAt ? Math.max(0, clock - startedAt) : 0;
  const backHref = workspace?.reference.projectId ? `/projects/${workspace.reference.projectId}${conversationId ? `?conversation=${encodeURIComponent(conversationId)}` : ""}` : "/";

  function changeAdapter(next: WorkspaceAdapterId) {
    setAdapterId(next);
    const sample = examplePayloads[next];
    setPayload(JSON.stringify(sample || {}, null, 2));
    setLocator(next === "github_trace" && sample ? "https://github.com/langchain-ai/langgraph/pull/8053" : "");
  }

  async function readFile(file?: File) {
    if (!file) return;
    if (file.size > 5_000_000) return setError("当前浏览器导入单文件上限为 5 MB；大工作区应先通过适配器分片导出。" );
    setPayload(await file.text());
    setLocator("");
    if (!title) setTitle(file.name.replace(/\.json$/iu, ""));
    setError("");
  }

  async function start() {
    if (!workspace || running) return;
    let parsedPayload: unknown;
    try { parsedPayload = JSON.parse(payload); }
    catch { return setError("工作区 JSON 无法解析，请检查逗号、引号和括号。" ); }
    setEvents([]);
    setResult(null);
    setError("");
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const providerConfig = readSession<ProviderConfig>(PROVIDER_SESSION_KEY) || undefined;
    const searchConfig = webResearch ? readSession<SearchProviderConfig>(SEARCH_PROVIDER_SESSION_KEY) || undefined : undefined;
    try {
      const response = await fetch("/api/workspace-upgrades", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          snapshotRef: workspace.reference,
          conversationId: workspace.reference.projectId ? conversationId : undefined,
          workspace: {
            runId: crypto.randomUUID(),
            projectId: workspace.reference.projectId,
            connection: {
              adapterId,
              payload: parsedPayload,
              title: title.trim() || undefined,
              roleHint: roleHint.trim() || workspace.title,
              visibility: locator.trim() ? "publishable_metadata" : "project_private",
              evidenceClass: evidenceClass || undefined,
              provenance: { locator: locator.trim() || undefined, capturedAt: new Date().toISOString() },
            },
            maxObservations: 16,
            redactPersonalData: true,
          },
          iteration: { prompt: prompt.trim(), webResearch, maxRounds: 4, sourceLimit: 20, maxWorkItems: 16 },
          providerConfig,
          searchConfig,
        }),
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
        for (const line of lines.filter(Boolean)) applyEvent(JSON.parse(line) as WorkspaceRunEvent | IterationEvent);
        if (done) break;
      }
      if (buffer.trim()) applyEvent(JSON.parse(buffer) as WorkspaceRunEvent | IterationEvent);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "工作区升级失败。" );
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  function applyEvent(event: WorkspaceRunEvent | IterationEvent) {
    setClock(Date.now());
    setEvents((current) => [...current, event]);
    if (event.kind === "iteration.run.completed" && event.payload.result) {
      const completed = event.payload.result as SnapshotIterationResult;
      setResult(completed);
      onComplete?.(completed);
    }
    if (event.kind.endsWith("run.failed")) setError(String(event.payload.message || "工作区升级失败。"));
  }

  const Shell = embedded ? "div" : "main";
  return <Shell className={`risk-shell iteration-shell iteration-chat-shell workspace-upgrade-shell${embedded ? " embedded-operation" : ""}`}>
    <aside className="risk-controls">
      <header className="cold-brand"><span><Network size={16} /></span><div><b>Role Atlas</b><small>真实工作区实例化</small></div></header>
      {embedded && onClose
        ? <button type="button" className="cold-back" onClick={onClose}><ArrowLeft size={13} /> 返回岗位工作台</button>
        : <Link className="cold-back" href={backHref}><ArrowLeft size={13} /> 返回岗位工作台</Link>}
      <section className="risk-form">
        <span className="cold-kicker">WORKSPACE BRIEF</span>
        <h1>{workspace?.title || "接入真实工作区"}</h1>
        <p>导入工作资源后，Agent 会先重建事件与交付物，再对齐岗位任务；原始资料不会直接覆盖岗位共性。</p>
        <label><span>资料适配器</span><select value={adapterId} disabled={running} onChange={(event) => changeAdapter(event.target.value as WorkspaceAdapterId)}>{adapters.map((adapter) => <option value={adapter.id} key={adapter.id}>{adapter.label}</option>)}</select><small>{adapters.find((item) => item.id === adapterId)?.detail}</small></label>
        <label className="workspace-file-input"><span>导入 JSON 导出文件</span><i><FileUp size={14} />选择本地文件<input type="file" accept="application/json,.json" disabled={running} onChange={(event) => void readFile(event.target.files?.[0])} /></i></label>
        <label><span>资料标题（可选）</span><input value={title} disabled={running} onChange={(event) => setTitle(event.target.value)} placeholder="如：Agent 服务幂等性修复工作链" /></label>
        <label><span>岗位提示</span><input value={roleHint} disabled={running} onChange={(event) => setRoleHint(event.target.value)} /></label>
        <label><span>真实性等级（留空由适配器判断）</span><select value={evidenceClass} disabled={running} onChange={(event) => setEvidenceClass(event.target.value as WorkspaceEvidenceClass | "")}><option value="">自动判断</option><option value="real_work_activity">真实工作活动</option><option value="curated_real_case">精选真实案例</option><option value="production_trace">生产运行轨迹</option><option value="controlled_experiment">受控实验</option><option value="teaching_simulation">教学仿真</option><option value="synthetic_fixture">合成测试样例</option></select></label>
        <label><span>公开来源 URL（可选）</span><input value={locator} disabled={running} onChange={(event) => setLocator(event.target.value)} placeholder="填写后可作为公开元数据定位，不上传私有路径" /></label>
        <details className="workspace-json-input" open><summary><FileJson size={13} />查看或编辑适配器 JSON</summary><textarea value={payload} disabled={running} spellCheck={false} onChange={(event) => setPayload(event.target.value)} /></details>
        <label><span>本轮实例化重点（可选）</span><textarea value={prompt} disabled={running} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：重点核实 Agent 系统开发中的评审、测试和发布责任" /></label>
        <label className="cold-web-toggle"><span><Globe2 size={13} /><b>联网交叉验证</b><small>检索行业共性，避免把一个实例误写成整个岗位</small></span><input type="checkbox" checked={webResearch} disabled={running} onChange={(event) => setWebResearch(event.target.checked)} /></label>
        <div className="risk-baseline"><span><GitBranch size={13} /><b>基于当前静态快照</b></span><small>{workspace?.version ? `${workspace.version.version} · ${workspace.version.snapshotId}` : "正在读取…"}</small></div>
        {error ? <div className="cold-error"><AlertTriangle size={13} />{error}{embedded && onSettingsRequest ? <button type="button" onClick={onSettingsRequest}>设置</button> : <Link href="/settings">设置</Link>}</div> : null}
        {running ? <button className="cold-start stop" onClick={() => abortRef.current?.abort()}><Square size={12} />停止并保留记录</button> : <button className="cold-start" disabled={!workspace || !payload.trim()} onClick={() => void start()}><Play size={13} />接入并升级岗位快照</button>}
      </section>
    </aside>
    <section className="iteration-conversation">
      <header className="iteration-conversation-header"><div className="iteration-run-title"><span><FolderKanban size={15} /></span><div><b>真实工作区实例化</b><small>{workspace?.title || "正在读取岗位…"}</small></div></div><div className="iteration-header-status"><span className={running ? "running" : result ? "completed" : "idle"}><i />{running ? "正在运行" : result ? "已形成候选版本" : "等待开始"}</span><span><Clock3 size={12} />{Math.round(elapsed / 1000)} 秒</span>{embedded && onSettingsRequest ? <button type="button" onClick={onSettingsRequest} aria-label="模型与检索设置"><Settings size={14} /></button> : <Link href="/settings"><Settings size={14} /></Link>}</div></header>
      <nav className="iteration-phase-strip">{phaseSteps.map(([id, label], index) => <span className={index < phase || result ? "completed" : index === phase ? "active" : ""} key={id}><i>{index < phase || result ? <Check size={10} /> : index + 1}</i>{label}</span>)}</nav>
      <div className="iteration-chat-scroll" aria-live="polite">
        {!events.length && !running ? <div className="iteration-chat-empty"><div><FolderKanban size={25} /></div><h2>从工作实例理解岗位，而不是从文件名猜岗位</h2><p>系统会区分原始资源、工作事件、对象、交付物、组织实例和岗位共性，并把每项结论绑定回可读取的观察。</p><ul><li>并行提取事件链和独立工作产物</li><li>聚类后对齐典型任务与事理森林</li><li>结构检查只报告缺口，不把候选内容拦空</li></ul></div> : null}
        {events.length || running ? <div className="iteration-chat-thread">
          <article className="iteration-user-message"><span>你接入了 · {adapters.find((item) => item.id === adapterId)?.label}</span><p>{title || "未命名工作区资料"}</p><small>{webResearch ? "允许联网交叉验证" : "只使用本轮资料"} · 自动遮蔽密钥与个人联系方式</small></article>
          {events.filter((event) => !["workspace.resource.accepted"].includes(event.kind)).map((event, index) => {
            const failed = event.kind.endsWith("failed");
            const runningEvent = running && index === events.length - 1;
            return <article className={`iteration-tool-call ${failed ? "failed" : runningEvent ? "running" : "completed"}`} key={`${event.kind}:${index}`}><div className="iteration-tool-icon">{failed ? <CircleX size={15} /> : event.kind.includes("search") ? <Search size={15} /> : event.kind.includes("scan") ? <ShieldCheck size={15} /> : event.kind.includes("completed") || event.kind.includes("created") ? <Check size={15} /> : <Wrench size={15} />}</div><div className="iteration-tool-body"><header><span><b>{eventTitle(event)}</b><code>{event.kind}</code></span><em>{failed ? "失败" : "完成"}</em></header><p>{eventSummary(event)}</p><details className="iteration-tool-details"><summary><ChevronDown size={12} /> 查看结构化输出</summary><pre>{JSON.stringify(event.payload, null, 2).slice(0, 12_000)}</pre></details></div></article>;
          })}
          {running ? <article className="iteration-thinking-message"><div className="iteration-agent-avatar"><LoaderCircle className="spin" size={15} /></div><div><span className="iteration-message-author">ROLE AGENT · 正在工作</span><h3>{phase < 2 ? "正在读取、扫描和重建工作事件" : phase < 4 ? "正在对齐岗位任务与实例证据" : "正在重建并评估候选岗位快照"}</h3><p>事件与结果会继续追加到这里，原快照在候选版本完成前不会改变。</p></div></article> : null}
          {result ? <article className="iteration-final-message created"><div className="iteration-agent-avatar"><Sparkles size={15} /></div><div className="iteration-final-body"><span className="iteration-message-author">ROLE AGENT · 最终回答</span><h3>{result.createdSnapshot ? "真实工作区已蒸馏，并形成新的静态候选快照" : "工作区已研究，当前快照保持不变"}</h3><p>{result.summary.slice(0, 3).join(" ")}</p><div className="iteration-result-facts"><span><b>{result.evaluation.informationGain.newSources}</b><small>新增观察来源</small></span><span><b>{result.evaluation.informationGain.newProcessScenarios}</b><small>新增事理场景</small></span><span><b>{result.diff.nodes.added.length}</b><small>新增语义节点</small></span><span><b>{result.knownGaps.length}</b><small>保留缺口</small></span></div>{result.candidateSnapshotId ? <div className="iteration-result-actions">{embedded && onClose ? <button type="button" onClick={onClose}>应用新版本并返回工作台<ChevronRight size={13} /></button> : <Link href={backHref}>打开项目中的候选版本<ChevronRight size={13} /></Link>}<code>{result.candidateSnapshotId}</code></div> : null}</div></article> : null}
          {error ? <article className="iteration-agent-message failed"><div className="iteration-agent-avatar"><Bot size={15} /></div><div><span className="iteration-message-author">ROLE AGENT · 运行提示</span><h3>本轮没有完整完成</h3><p>{error}</p></div></article> : null}
          <div ref={endRef} />
        </div> : null}
      </div>
      <footer className="iteration-conversation-footer"><ShieldCheck size={12} /><span>原始资源保留在工作区包；进入快照的是脱敏、可回溯的观察，真实性等级不会被模型自行抬高。</span></footer>
    </section>
  </Shell>;
}
