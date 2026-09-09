"use client";

import { useEffect, useRef, useState } from "react";
import type { ColdStartBuildResult } from "@/lib/build/types";
import { LearningReleaseRequired, learningMountUrl, learningPointPreview, readLearningMountPackage } from "@/lib/learning-path/presentation";
import "./learning-path-mapping.css";
import { mountReason, type AutomaticMountRecord } from "@/lib/learning-path/automatic-contract";

export default function LearningPathMapping({ result, projectId, projectVersionId, selectedNodeId, onPreparePackage, learnFlowBaseUrl }: {
  result: ColdStartBuildResult;
  projectId?: string;
  projectVersionId?: string;
  selectedNodeId?: string;
  onPreparePackage?: () => void;
  learnFlowBaseUrl?: string;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [needsPackage, setNeedsPackage] = useState(false);
  const request = useRef<AbortController | null>(null);
  const [mount, setMount] = useState<AutomaticMountRecord | null>(null);
  const [mountError, setMountError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const mountUrl = projectId && projectVersionId ? `/api/projects/${encodeURIComponent(projectId)}/learning-mounts?versionId=${encodeURIComponent(projectVersionId)}` : "";
  useEffect(() => {
    setMount(null); setMountError("");
    if (!mountUrl) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const response = await fetch(mountUrl, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("暂时无法读取自动挂载状态。");
        const payload = await response.json() as { mount: AutomaticMountRecord | null };
        if (controller.signal.aborted) return;
        if (payload.mount && payload.mount.snapshotId !== result.snapshot.id) throw new Error("正在展示运行预览，正式挂载对应已保存版本。");
        setMount(payload.mount); setMountError("");
        if (payload.mount && ["queued", "running", "retry"].includes(payload.mount.status)) timer = setTimeout(() => void read(), 4000);
      } catch (cause) {
        if (!controller.signal.aborted) { setMountError(cause instanceof Error ? cause.message : "挂载状态读取失败。"); timer = setTimeout(() => void read(), 8000); }
      }
    }
    void read(); return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [mountUrl, result.snapshot.id, refresh]);
  async function retry() {
    try { const response = await fetch(mountUrl, { method: "POST" }); if (!response.ok) throw new Error("自动挂载未能重新入队。"); setRefresh(value => value + 1); }
    catch (cause) { setMountError(cause instanceof Error ? cause.message : "请稍后重试。"); }
  }
  useEffect(() => {
    setError(""); setNeedsPackage(false); setBusy("");
    return () => { request.current?.abort(); request.current = null; };
  }, [result.snapshot.id, projectVersionId]);
  const points = result.semantic.nodes.filter(node => node.type === "knowledge_skill");
  const selected = points.find(node => node.id === selectedNodeId);
  const rows = selected ? [selected] : points;
  async function open(nodeId?: string) {
    if (!projectId || !projectVersionId || request.current) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(nodeId || "all"); setError(""); setNeedsPackage(false);
    try {
      const ref = await readLearningMountPackage({ projectId, projectVersionId, snapshotId: result.snapshot.id, fetcher: fetch, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      if (!controller.signal.aborted) window.location.assign(learningMountUrl(ref, nodeId, learnFlowBaseUrl));
    } catch (cause) {
      if (!controller.signal.aborted) {
        setNeedsPackage(cause instanceof LearningReleaseRequired);
        setError(cause instanceof Error && cause.name === "TimeoutError" ? "读取岗位包超时，请重试。" : cause instanceof Error ? cause.message : "暂时无法进入学习路径。");
      }
    } finally { if (request.current === controller) { request.current = null; setBusy(""); } }
  }
  return <details className="learning-path-mapping">
    <summary>学习路径挂载 <span>{mount?.result?.reason === "no_learning_points" ? "知识技能待补全" : mount?.result ? `已挂载 ${mount.result.points.filter(point => point.status !== "needs_research").length} / ${points.length} 个知识技能点` : mount && ["queued", "running", "retry"].includes(mount.status) ? "自动挂载中" : `${points.length} 个知识技能点`}</span></summary>
    <p>冷启动与迭代保存版本后，会自动复用已有知识技能节点，或创建当前账号的学习内容节点。挂载不会改变个人掌握状态。</p>
    {mount && ["queued", "running", "retry"].includes(mount.status) && <p role="status">{mount.status === "retry" ? "服务暂不可用，后台将继续重试。" : "后台正在核对并保存学习路径，关闭页面后仍会继续。"}</p>}
    {mount?.result && <p role="status">复用已有节点 {mount.result.points.filter(point => point.status === "existing").length} 个 · 新增知识技能节点 {mount.result.points.filter(point => point.status === "created").length} 个 · 待补全 {mount.result.unresolved.length} 个</p>}
    {mount?.result?.reason && <p role="status">{mountReason(mount.result.reason)}</p>}
    {mount?.status === "superseded" && <p>本轮后续研究已保存更新版本，自动挂载使用该对话的最终版本。</p>}
    {mount?.error && <p role="alert">{mount.error}</p>}
    {mountError && <p role="alert">{mountError}</p>}
    {mount?.status === "failed" && <button type="button" onClick={() => void retry()}>重试自动挂载</button>}
    {!mount && !mountError && <p>当前版本尚无自动挂载回执；下方仅为静态匹配预览。</p>}
    {!points.length && <p>尚未形成知识技能点，需要先完善岗位内容。</p>}
    <ul>{rows.map(node => {
      const preview = learningPointPreview(node, result.semantic.learningPathProjection);
      const point = mount?.result?.points.find(item => item.roleNodeId === node.id);
      return <li key={node.id}><div><strong>{node.label}</strong><span>{point ? point.status === "existing" ? "已挂载 · 已有节点" : point.status === "created" ? "已挂载 · 新建节点" : "待补全" : preview.label}</span></div>
        <p>{point ? point.status === "needs_research" ? mountReason(point.reason) : `路径节点：${point.target?.id || "见正式回执"}` : preview.rationale}</p>{!point && preview.needsDefinition && <p className="mapping-gap">{preview.needsDefinition}</p>}
        {projectId && <button type="button" disabled={!projectVersionId || Boolean(busy)} onClick={() => void open(node.id)}>{busy === node.id ? "读取固定版本…" : "在 LearnFlow 预览此点"}</button>}
      </li>;
    })}</ul>
    {points.length > 1 && projectId && <button type="button" disabled={!projectVersionId || Boolean(busy)} onClick={() => void open()}>{busy === "all" ? "读取固定版本…" : "在 LearnFlow 核对全部知识技能"}</button>}
    {error && <p role="alert">{error}</p>}
    {needsPackage && onPreparePackage && <button type="button" onClick={onPreparePackage}>准备当前版本的私有岗位包</button>}
    {mount?.result?.receipts.length ? <details><summary>正式保存回执 · {mount.result.receipts.length} 批</summary>{mount.result.receipts.map(receipt => <p key={receipt.receiptId}>回执 {receipt.receiptId} · 路径版本 {receipt.graphRef.revision}</p>)}</details> : null}
    {projectId && !projectVersionId && <p>当前仍是运行预览，保存为项目版本后可进入正式挂载。</p>}
    <small>手动预览入口保留；在 LearnFlow 可核对范围、验收条件、归属及正式路径版本。</small>
  </details>;
}
