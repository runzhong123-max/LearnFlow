"use client";

import { useEffect, useRef, useState } from "react";
import type { ColdStartBuildResult } from "@/lib/build/types";
import { LearningReleaseRequired, learningMountUrl, learningPointPreview, readLearningMountPackage } from "@/lib/learning-path/presentation";
import "./learning-path-mapping.css";

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
    <summary>学习路径挂载 <span>{points.length} 个知识技能点 · 预览不等于已入库</span></summary>
    <p>下面是本快照与官方路径的匹配预览。实际已有节点、新节点和保存结果，以 LearnFlow 当前账号的正式挂载预览与回执为准。</p>
    {!points.length && <p>尚未形成知识技能点，需要先完善岗位内容。</p>}
    <ul>{rows.map(node => {
      const preview = learningPointPreview(node, result.semantic.learningPathProjection);
      return <li key={node.id}><div><strong>{node.label}</strong><span>{preview.label}</span></div><p>{preview.rationale}</p>{preview.needsDefinition && <p className="mapping-gap">{preview.needsDefinition}</p>}
        {projectId && <button type="button" disabled={!projectVersionId || Boolean(busy)} onClick={() => void open(node.id)}>{busy === node.id ? "读取固定版本…" : "在 LearnFlow 预览此点"}</button>}
      </li>;
    })}</ul>
    {points.length > 1 && projectId && <button type="button" disabled={!projectVersionId || Boolean(busy)} onClick={() => void open()}>{busy === "all" ? "读取固定版本…" : "在 LearnFlow 核对全部知识技能"}</button>}
    {error && <p role="alert">{error}</p>}
    {needsPackage && onPreparePackage && <button type="button" onClick={onPreparePackage}>准备当前版本的私有岗位包</button>}
    {projectId && !projectVersionId && <p>当前仍是运行预览，保存为项目版本后可进入正式挂载。</p>}
    <small>打开页面不会自动新增节点；请核对范围、验收条件和归属课程，再应用变更。</small>
  </details>;
}
