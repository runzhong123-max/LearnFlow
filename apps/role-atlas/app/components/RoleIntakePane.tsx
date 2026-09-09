"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Check, ChevronRight, LoaderCircle, Send, Sparkles, Wrench, X } from "lucide-react";
import SourceMaterials from "./SourceMaterials";
import MarkdownContent from "./MarkdownContent";
import { PROVIDER_SESSION_KEY } from "@/lib/providers";
import { SEARCH_PROVIDER_SESSION_KEY } from "@/lib/search/providers";
import { readOfficialLearningPath } from "@/lib/learning-path/load";
import type { SourceInput } from "@/lib/build/types";
import "./role-intake.css";
import type { IntakeTurnInput, IntakeView } from "@/lib/intake/types";

type Scope = { projectId: string; conversationId: string };
type Draft = { title: string; market: string; goal: string; materials: SourceInput[]; scope?: Scope; reply?: string; improving?: boolean };
function config(key: string) { try { return JSON.parse(sessionStorage.getItem(key) || "null") || undefined; } catch { return undefined; } }
async function json(response: Response) {
  const body = await response.json().catch(() => ({})) as { error?: string; intake?: IntakeView; projectUrl?: string };
  if (!response.ok) throw new Error(response.status === 401 ? "请重新登录。当前输入已保留，登录后可继续。" : body.error || "连接暂时不可用，请重试本次操作。");
  return body;
}

/** Cold start is a conversation with an explicit, immutable description checkpoint. */
export default function RoleIntakePane({ projectId, conversationId, actorSubjectId, initialTitle = "", initialDescription = "", initialMarket = "中国大陆", onClose, onBusyChange, onStarted }: {
  projectId?: string; conversationId?: string; actorSubjectId: string;
  initialTitle?: string; initialDescription?: string; initialMarket?: string;
  onClose?: () => void; onBusyChange?: (busy: boolean) => void;
  onStarted: (scope: Scope) => void;
}) {
  const storageKey = `role-atlas.intake-draft:${JSON.stringify([actorSubjectId, projectId || "new", conversationId || "new"])}`;
  const hasLocalDraft = useRef(false);
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const saved = actorSubjectId && sessionStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as Draft;
        if (projectId || !parsed.scope) { hasLocalDraft.current = true; return parsed; }
      }
    } catch { /* Storage may be unavailable. */ }
    return { title: initialTitle, market: initialMarket, goal: initialDescription, materials: [], ...(projectId && conversationId ? { scope: { projectId, conversationId } } : {}) };
  });
  const initialScope = useRef(draft.scope);
  const [intake, setIntake] = useState<IntakeView | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(draft.scope));
  const [materialsBusy, setMaterialsBusy] = useState(false);
  const [improving, setImproving] = useState(draft.improving || false);
  const [reply, setReply] = useState(draft.reply || "");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const operation = useRef<{ signature: string; id: string } | null>(null);
  const startingRun = useRef("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const callbacks = useRef({ onBusyChange, onStarted });
  callbacks.current = { onBusyChange, onStarted };
  const locked = busy || loading;
  const base = (scope: Scope) => `/api/projects/${encodeURIComponent(scope.projectId)}/conversations/${encodeURIComponent(scope.conversationId)}/intake`;
  useEffect(() => { callbacks.current.onBusyChange?.(busy); return () => callbacks.current.onBusyChange?.(false); }, [busy]);
  useEffect(() => {
    if (!actorSubjectId) return;
    try {
      const value = JSON.stringify({ ...draft, reply, improving });
      if (!draft.scope || projectId) sessionStorage.setItem(storageKey, value);
      else sessionStorage.removeItem(storageKey);
      if (draft.scope) sessionStorage.setItem(`role-atlas.intake-draft:${JSON.stringify([actorSubjectId, draft.scope.projectId, draft.scope.conversationId])}`, value);
    } catch { /* The server preserves submitted revisions. */ }
  }, [draft, reply, improving, storageKey, actorSubjectId]);
  useEffect(() => {
    if (!initialScope.current) return;
    const controller = new AbortController();
    void fetch(base(initialScope.current), { signal: controller.signal, cache: "no-store" }).then(json).then(payload => {
      if (!controller.signal.aborted) {
        setIntake(payload.intake || null);
        if (payload.intake && !hasLocalDraft.current) {
          const restored = payload.intake;
          setDraft(current => ({ ...current, title: restored.roleTitle || current.title, market: restored.market || current.market, goal: restored.goal ?? current.goal, materials: (restored.sources || []).filter(source => source.kind !== "public_document") }));
        }
      }
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "岗位说明暂时无法读取。"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  function operationId(signature: string) {
    if (operation.current?.signature !== signature) operation.current = { signature, id: crypto.randomUUID() };
    return operation.current.id;
  }
  async function ensureScope(): Promise<Scope> {
    if (draft.scope) return draft.scope;
    // Keep these IDs across an uncertain response; never create a second project on retry.
    const saved = config(`${storageKey}:creation`) as Scope | undefined;
    const scope = saved || { projectId: crypto.randomUUID(), conversationId: crypto.randomUUID() };
    try { sessionStorage.setItem(`${storageKey}:creation`, JSON.stringify(scope)); } catch { /* optional */ }
    const response = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: scope.projectId, conversationId: scope.conversationId, title: draft.title.trim() || "待明确的岗位", market: draft.market.trim() || "中国大陆", description: draft.goal, conversationMode: "explanation" }) });
    if (response.status === 409) await json(await fetch(`/api/projects/${encodeURIComponent(scope.projectId)}?conversation=${encodeURIComponent(scope.conversationId)}`));
    else await json(response);
    if (!alive.current) throw new Error("INTAKE_VIEW_CLOSED");
    setDraft(current => ({ ...current, scope }));
    if (!projectId) window.history.replaceState(null, "", `/projects/new?project=${encodeURIComponent(scope.projectId)}&conversation=${encodeURIComponent(scope.conversationId)}`);
    return scope;
  }
  async function turn(action: "clarify" | "draft" | "refine", message = reply, recovery?: Omit<IntakeTurnInput, "providerConfig" | "searchConfig">, roleTitle = draft.title) {
    if (locked || materialsBusy) return;
    setBusy(true); setError(""); setProgress(action === "clarify" ? "正在查找岗位方向与已有图谱…" : "正在检索并整理岗位任务、能力和工作场景…");
    try {
      const scope = await ensureScope();
      if (!alive.current) return;
      const input = recovery || { action, expectedRevisionId: intake?.revisionId || undefined, message, roleTitle, market: draft.market, goal: draft.goal, sources: draft.materials };
      const payload = await json(await fetch(`${base(scope)}/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, operationId: recovery?.operationId || operationId(JSON.stringify(input)), providerConfig: config(PROVIDER_SESSION_KEY), searchConfig: config(SEARCH_PROVIDER_SESSION_KEY) }) }));
      if (!alive.current) return;
      const next = payload.intake as IntakeView;
      setIntake(next); setReply(""); setImproving(false); operation.current = null; startingRun.current = "";
      setDraft(current => ({ ...current, title: next.roleTitle || current.title }));
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "本次整理未完成，输入已保留。请重试。"); }
    finally { if (alive.current) { setBusy(false); setProgress(""); } }
  }
  async function confirm() {
    if (locked || !intake?.revisionId || !intake.contentHash || !draft.scope) return;
    setBusy(true); setError(""); setProgress("正在确认岗位说明并提交深度研究…");
    try {
      const scope = draft.scope;
      startingRun.current ||= intake.buildRunId || crypto.randomUUID();
      const payload = await json(await fetch(`${base(scope)}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revisionId: intake.revisionId, contentHash: intake.contentHash, buildRunId: startingRun.current, operationId: operationId(`confirm:${intake.revisionId}:${intake.contentHash}`) }) }));
      if (!alive.current) return;
      const confirmed = payload.intake as IntakeView;
      setIntake(confirmed);
      startingRun.current = confirmed.buildRunId || startingRun.current;
      await json(await fetch(`/api/projects/${encodeURIComponent(scope.projectId)}/conversations/${encodeURIComponent(scope.conversationId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "iteration" }) }));
      if (!alive.current) return;
      const learningPathGraph = await readOfficialLearningPath(fetch, AbortSignal.timeout(12_000));
      if (!alive.current) return;
      await json(await fetch("/api/build-runs", { method: "POST", headers: { "content-type": "application/json", prefer: "respond-async" }, body: JSON.stringify({
        conversationId: scope.conversationId, intakeConfirmation: { revisionId: confirmed.revisionId, contentHash: confirmed.contentHash },
        providerConfig: config(PROVIDER_SESSION_KEY), searchConfig: config(SEARCH_PROVIDER_SESSION_KEY), webResearch: true,
        build: { runId: startingRun.current, projectId: scope.projectId, roleTitle: confirmed.roleTitle, roleDescription: confirmed.description, market: confirmed.market, audience: ["岗位研究者"], snapshotAsOf: new Date().toISOString().slice(0, 10), sources: [], learningPathGraph },
      }) }));
      try { sessionStorage.removeItem(storageKey); sessionStorage.removeItem(`${storageKey}:creation`); sessionStorage.removeItem(`role-atlas.intake-draft:${JSON.stringify([actorSubjectId, scope.projectId, scope.conversationId])}`); } catch { /* optional */ }
      if (alive.current) callbacks.current.onStarted(scope);
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "提交暂未确认，请继续本次生成。"); }
    finally { if (alive.current) { setBusy(false); setProgress(""); } }
  }
  async function pull(releaseId: string) {
    if (locked) return;
    setBusy(true); setError(""); setProgress("正在拉取到你的岗位包…");
    try { const payload = await json(await fetch("/api/hub/fork", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ releaseId }) })); if (!alive.current) return; if (!payload.projectUrl) throw new Error("岗位包地址未返回，请重试拉取。"); window.location.assign(payload.projectUrl); }
    catch (cause) { if (alive.current) { setError(cause instanceof Error ? cause.message : "拉取未完成，请重试。"); setBusy(false); } }
  }

  const reviewing = Boolean(intake?.description && ["review", "confirmed"].includes(intake.phase));
  return <section className="role-intake" aria-label="冷启动岗位包对话">
    <div className="chat-tool-form">
      <header><Wrench size={15} /><b>冷启动岗位包</b>{onClose && <button type="button" onClick={onClose} disabled={busy} aria-label="收起冷启动工具"><X size={15} /></button>}</header>
      {!intake?.revisionId ? <>
        <p>先明确岗位，再确认任务、能力与工作场景。</p>
        <label>岗位名称<div className="intake-role-input"><input value={draft.title} maxLength={120} disabled={locked} placeholder="例如：云计算工程师（实施与运维方向）" onChange={event => setDraft(current => ({ ...current, title: event.target.value }))} /><button className="intake-unclear" disabled={locked || materialsBusy} onClick={() => void turn("clarify", draft.goal)}>我还不明确</button></div></label>
        <label>市场范围<input value={draft.market} maxLength={120} disabled={locked} onChange={event => setDraft(current => ({ ...current, market: event.target.value }))} /></label>
        <label>想重点了解什么<textarea value={draft.goal} maxLength={4000} disabled={locked} onChange={event => setDraft(current => ({ ...current, goal: event.target.value }))} placeholder="可填写专业背景、行业、经验范围或想做的工作" /></label>
        <details><summary>添加资料（可选） · {draft.materials.length} 份</summary><SourceMaterials value={draft.materials} onChange={materials => setDraft(current => ({ ...current, materials }))} disabled={locked} onBusyChange={setMaterialsBusy} /></details>
        <small>资料会作为初步来源，助手仍会联网检索与核对。</small>
        <button className="tool-submit" disabled={locked || materialsBusy || draft.title.trim().length < 2} onClick={() => void turn("draft", draft.goal)}><Sparkles size={14} />生成岗位说明</button>
      </> : <p>{reviewing ? "确认下面的岗位说明后，开始深度研究、生成图谱并挂载学习路径。" : "说说你感兴趣或想从事的工作，我会帮你缩小范围。"}</p>}
    </div>
    {intake?.history.filter(item => item.text && item.text !== intake.description && item.text !== intake.assistantMessage).slice(-8).map(item => <div key={item.id} className={`message ${item.role}`}><MarkdownContent text={item.text} /></div>)}
    {intake?.assistantMessage && intake.assistantMessage !== intake.description && <div className="message assistant"><MarkdownContent text={intake.assistantMessage} /></div>}
    {intake?.hubMatches?.length ? <div className="intake-hub-matches"><small>Graph Hub 中已有相关岗位</small>{intake.hubMatches.map(match => <article key={match.releaseId}><b>{match.title}</b><p>{match.summary}</p><details><summary>查看岗位内容</summary>{[["工作任务", match.tasks], ["工作能力", match.capabilities], ["工作场景", match.scenarios]].map(([label, values]) => <div key={String(label)}><b>{String(label)}</b><ul>{(values as string[]).map((text, index) => <li key={index}>{text}</li>)}</ul></div>)}</details><button disabled={locked} onClick={() => void pull(match.releaseId)}><ArrowDownToLine size={13} />拉取并查看</button></article>)}</div> : null}
    {reviewing && <article className="intake-description"><div className="assistant-label"><Sparkles size={14} /> 岗位说明</div><MarkdownContent text={intake!.description} />
      {!improving && <div className="intake-actions"><button className="tool-submit" disabled={locked} onClick={() => void confirm()}><Check size={14} />{intake?.phase === "confirmed" ? "继续生成图谱" : "确定，生成图谱"}</button><button disabled={locked} onClick={() => setImproving(true)}>改进</button></div>}
    </article>}
    {intake?.revisionId && (!reviewing || improving) && <div className="chat-tool-form intake-reply">
      {improving && <header><b>改进岗位说明</b><button aria-label="取消改进" onClick={() => setImproving(false)} disabled={locked}><X size={14} /></button></header>}
      {!reviewing && <>
        {intake.roleCandidates?.map(candidate => <button className="intake-role-candidate" key={candidate.title} disabled={locked || materialsBusy} onClick={() => void turn("draft", reply, undefined, candidate.title)}><b>{candidate.title}</b><small>{candidate.reason}</small><span>按此岗位整理说明 <ChevronRight size={12} /></span></button>)}
        <label>或填写岗位方向<div className="intake-role-input"><input value={draft.title} maxLength={120} disabled={locked} placeholder="例如：云平台实施运维工程师" onChange={event => setDraft(current => ({ ...current, title: event.target.value }))} /><button disabled={locked || materialsBusy || draft.title.trim().length < 2 || draft.title === "待明确的岗位"} onClick={() => void turn("draft")}>整理说明</button></div></label>
      </>}
      <label>{improving ? "希望调整哪些内容" : "你的想法"}<textarea value={reply} onChange={event => setReply(event.target.value)} disabled={locked} maxLength={4000} placeholder={improving ? "例如：面向高职毕业生，侧重实施交付，补充真实工作场景…" : "例如：我学的是计算机网络，想做云平台部署和故障处理…"} /></label>
      <details><summary>补充资料 · {draft.materials.length} 份</summary><SourceMaterials value={draft.materials} onChange={materials => setDraft(current => ({ ...current, materials }))} disabled={locked} onBusyChange={setMaterialsBusy} /></details>
      <button className="tool-submit" disabled={locked || materialsBusy || (!reply.trim() && !draft.materials.length)} onClick={() => void turn(improving ? "refine" : "clarify")}><Send size={13} />{improving ? "更新岗位说明" : "继续明确岗位"}</button>
      {!improving && !intake.assistantMessage && intake.questions?.map((question, index) => <small key={index}><ChevronRight size={10} />{question}</small>)}
    </div>}
    {(busy || loading) && <p className="intake-progress" role="status"><LoaderCircle size={14} className="spin" />{progress || "正在恢复岗位说明…"}</p>}
    {error && <p className="intake-notice" role="alert">{error}</p>}
    {intake?.recovery && <div className="intake-notice"><p>{intake.recovery.message}</p><button disabled={locked || materialsBusy} onClick={() => { const recovery = intake.recovery!.input; void turn(recovery.action, recovery.message, recovery); }}>继续整理</button></div>}
    {intake?.warnings?.length ? <details className="intake-notes"><summary>资料读取情况</summary>{intake.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details> : null}
  </section>;
}
