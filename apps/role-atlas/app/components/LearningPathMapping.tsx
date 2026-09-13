"use client";

import { useEffect, useState } from "react";
import type { AutomaticMountRecord } from "@/lib/learning-path/automatic-contract";
import { needsAutomaticResearch } from "@/lib/learning-path/automatic-contract";

/** Read the automatic production receipt. No browser-triggered source writes. */
export function useAutomaticLearningConnection(projectId?: string, versionId?: string, snapshotId?: string) {
  const [saved, setSaved] = useState<{ key: string; mount: AutomaticMountRecord | null; error?: string }>();
  const key = JSON.stringify([projectId, versionId, snapshotId]);
  useEffect(() => {
    if (!projectId || !versionId || !snapshotId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId!)}/learning-mounts?versionId=${encodeURIComponent(versionId!)}`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("学习节点连接状态暂时无法读取");
        const payload = await response.json() as { mount: AutomaticMountRecord | null };
        if (controller.signal.aborted) return;
        const mount = payload.mount?.snapshotId === snapshotId ? payload.mount : null;
        setSaved({ key, mount });
        if (!mount || ["queued", "running", "retry"].includes(mount.status) || needsAutomaticResearch(mount.result) && !mount.repair || ["pending", "preparing", "queued"].includes(mount.repair?.status || "")) timer = setTimeout(() => void read(), 4000);
      } catch {
        if (!controller.signal.aborted) {
          setSaved(previous => ({ key, mount: previous?.key === key ? previous.mount : null, error: "学习节点连接状态暂时无法读取，正在重试" }));
          timer = setTimeout(() => void read(), 8000);
        }
      }
    }
    void read();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [projectId, versionId, snapshotId, key]);
  return saved?.key === key ? saved : { key, mount: null };
}

/** Learning-path identity is part of the selected knowledge/skill, not a separate workbench. */
export function LearningNodeConnection({ mount, nodeIds }: { mount?: AutomaticMountRecord | null; nodeIds: string[] }) {
  const points = (mount?.result?.points || []).filter(point => nodeIds.includes(point.roleNodeId) && point.target && point.status !== "needs_research");
  const targets = [...new Map(points.map(point => [JSON.stringify(point.target), point])).values()];
  if (!targets.length) return null;
  return <div className="node-learning-connection">{targets.map(point => <p key={JSON.stringify(point.target)}>
    <strong>{point.course?.title || "学习路径节点"}</strong> · {point.status === "created" ? "已新建并连接" : "已复用"}
    <small> {point.target!.namespace} / {point.target!.id} · v{point.target!.revision}</small>
  </p>)}</div>;
}

export function LearningNodeSemantics({ nodes }: { nodes: import("@/lib/build/types").SemanticNode[] }) {
  const points = nodes.filter(node => node.type === "knowledge_skill");
  if (!points.length) return null;
  return <details className="node-technical"><summary>岗位知识与技能 · {points.length} 项</summary>
    {points.map(node => <section key={node.id}>
      <strong>{node.label}</strong><small> · {node.learningKind === "knowledge" ? "知识" : node.learningKind === "skill" ? "技能" : "待细化"}</small>
      <p>{node.learningDefinition?.scopeNote || node.summary}</p>
      {node.learningDefinition?.assessmentCriteria.length ? <ul>{node.learningDefinition.assessmentCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul> : null}
    </section>)}
  </details>;
}
