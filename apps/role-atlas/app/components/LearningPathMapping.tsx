"use client";

import { useEffect, useRef, useState } from "react";
import type { ColdStartBuildResult } from "@/lib/build/types";
import { LearningReleaseRequired, learningMountUrl, learningPointPreview, readLearningMountPackage } from "@/lib/learning-path/presentation";
import "./learning-path-mapping.css";
import { courseGroups, mountedCourseCounts } from "@/lib/learning-path/course-presentation";
import { mountReason, needsAutomaticResearch, type AutomaticMountRecord } from "@/lib/learning-path/automatic-contract";

export default function LearningPathMapping({ result, projectId, projectVersionId, selectedNodeId, onPreparePackage, learnFlowBaseUrl, onMountChange }: {
  result: ColdStartBuildResult;
  onMountChange?: (mount: AutomaticMountRecord | null) => void;
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
  useEffect(() => { onMountChange?.(mount); }, [mount, onMountChange]);
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
        if (payload.mount && (["queued", "running", "retry"].includes(payload.mount.status) || (needsAutomaticResearch(payload.mount.result) && !payload.mount.repair) || ["pending", "preparing", "queued"].includes(payload.mount.repair?.status || ""))) timer = setTimeout(() => void read(), 4000);
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
  const groups = courseGroups(result, mount).filter(group => !selected && !selectedNodeId?.startsWith("course-") || group.id === selectedNodeId || group.members.some(member => member.node.id === selected?.id));
  const counts = mountedCourseCounts(mount);
  const hasLegacy = mount?.result?.points.some(point => point.target && !point.course);
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
    <summary>学习路径挂载 <span>{mount?.result?.reason === "no_learning_points" ? "知识技能待补全" : mount?.result ? hasLegacy ? `${courseGroups(result, mount).length} 个课程主题 · 历史细项挂载` : `${courseGroups(result, mount).filter(group => group.mounted).length} 门已挂载课程 · ${points.length} 条岗位要求` : mount && ["queued", "running", "retry"].includes(mount.status) ? "自动挂载中" : `${groups.length} 个课程主题 · ${points.length} 条岗位要求`}</span></summary>
    <p>优先复用已有课程，缺少时新建课程。具体操作、场景与验收要求在课程内展开，挂载不会改变掌握状态。</p>
    {mount && ["queued", "running", "retry"].includes(mount.status) && <p role="status">{mount.status === "retry" ? "服务暂不可用，后台将继续重试。" : "后台正在核对并保存学习路径，关闭页面后仍会继续。"}</p>}
    {mount?.result && <p role="status">复用已有{hasLegacy ? "路径节点" : "课程"} {counts.existing} 个 · 新增{hasLegacy ? "路径节点" : "课程"} {counts.created} 个 · 待补全 {mount.result.unresolved.length} 个</p>}
    {mount?.result?.reason && <p role="status">{mountReason(mount.result.reason)}</p>}
    {mount?.repair && <p role="status">{["pending", "preparing", "queued"].includes(mount.repair.status) ? "正在原对话中自动补研知识技能缺口；完成后会再核对新版本的挂载。" : mount.repair.status === "completed" ? "自动补研已完成，请查看本对话最新版本及其挂载结果。" : mount.repair.error || "本轮自动补研已停止，尚未解决的缺口已保留。"}</p>}
    {mount?.status === "superseded" && <p>本轮后续研究已保存更新版本，自动挂载使用该对话的最终版本。</p>}
    {mount?.error && <p role="alert">{mount.error}</p>}
    {mountError && <p role="alert">{mountError}</p>}
    {mount?.status === "failed" && <button type="button" onClick={() => void retry()}>重试自动挂载</button>}
    {!mount && !mountError && <p>当前版本尚无自动挂载回执；下方仅为静态匹配预览。</p>}
    {!points.length && <p>尚未形成知识技能点，需要先完善岗位内容。</p>}
    {hasLegacy && <p>此版本保留历史细项挂载。以下按课程主题整理展示；下一轮迭代使用课程挂载，历史节点和回执不删除。</p>}
    <ul>{groups.map(group => <li key={group.id}>
      <details><summary><strong>{group.title}</strong> · {group.members.length} 条岗位应用 · {group.mounted ? "已挂载课程" : "课程组织建议"}</summary>
        <p>{group.summary}</p>
        {group.members.map(({ node, mount: point }) => <section key={node.id}>
          <strong>{node.label}</strong><p>{node.learningDefinition?.scopeNote || node.summary}</p>
          {node.learningDefinition?.assessmentCriteria.length ? <p>验收：{node.learningDefinition.assessmentCriteria.join("；")}</p> : null}
          <small>{point?.target ? `路径：${point.target.id}` : learningPointPreview(node, result.semantic.learningPathProjection).label} · {node.evidenceBindingIds.length} 条证据</small>
          {projectId && <p><button type="button" disabled={!projectVersionId || Boolean(busy)} onClick={() => void open(node.id)}>{busy === node.id ? "读取固定版本…" : "在 LearnFlow 查看此项"}</button></p>}
        </section>)}
      </details>
    </li>)}</ul>
    {points.length > 1 && projectId && <button type="button" disabled={!projectVersionId || Boolean(busy)} onClick={() => void open()}>{busy === "all" ? "读取固定版本…" : "在 LearnFlow 核对全部知识技能"}</button>}
    {error && <p role="alert">{error}</p>}
    {needsPackage && onPreparePackage && <button type="button" onClick={onPreparePackage}>准备当前版本的私有岗位包</button>}
    {mount?.result?.receipts.length ? <details><summary>正式保存回执 · {mount.result.receipts.length} 批</summary>{mount.result.receipts.map(receipt => <p key={receipt.receiptId}>回执 {receipt.receiptId} · 路径版本 {receipt.graphRef.revision}</p>)}</details> : null}
    {projectId && !projectVersionId && <p>当前仍是运行预览，保存为项目版本后可进入正式挂载。</p>}
    <small>手动预览入口保留；在 LearnFlow 可核对范围、验收条件、归属及正式路径版本。</small>
  </details>;
}
