import { researchStages, type ResearchProgress } from "./research-progress";
import type { AutomaticMountRecord } from "@/lib/learning-path/automatic-contract";

export type RunStageState = "done" | "active" | "blocked" | "pending";
export type RunStageView = { index: number; label: string; state: RunStageState };
export type RunStatusTone = "idle" | "active" | "done" | "attention";
export type RunStatusView = {
  /** Canonical ordered pipeline. UI must render this list, never compose its own stage text. */
  stages: RunStageView[];
  /** Exactly one headline describing what the system is doing right now. */
  headline: string;
  tone: RunStatusTone;
  activeIndex: number;
};

const terminalAttention = new Set(["failed", "cancelled", "interrupted", "draft"]);

function mountHeadline(mount: AutomaticMountRecord): { stage: number; active: boolean; blocked: boolean; headline: string; tone: RunStatusTone } {
  switch (mount.status) {
    case "completed":
      if (!mount.result?.points.length || mount.result.unresolved.length || mount.result.points.some(point => !point.target || point.status === "needs_research")) return { stage: researchStages.length - 1, active: false, blocked: true, headline: "学习节点连接尚未完整，已有成果已保留", tone: "attention" };
      return { stage: researchStages.length, active: false, blocked: false, headline: "岗位图谱与学习节点连接已完成", tone: "done" };
    case "queued":
      return { stage: researchStages.length - 1, active: true, blocked: false, headline: "正在准备连接学习路径节点", tone: "active" };
    case "running":
      return { stage: researchStages.length - 1, active: true, blocked: false, headline: "正在复用学习路径节点，并为缺少的内容建立节点", tone: "active" };
    case "retry":
      return { stage: researchStages.length - 1, active: true, blocked: false, headline: "学习节点连接正在重试，已有研究成果已保留", tone: "active" };
    case "failed":
      return { stage: researchStages.length - 1, active: false, blocked: true, headline: mount.error || "学习节点连接未完成，已有研究成果已保留", tone: "attention" };
    default:
      // partial / needs_research / superseded: research itself is saved, the mount
      // needs more evidence or a newer version instead of looking stuck.
      return { stage: researchStages.length - 1, active: false, blocked: true, headline: "学习节点连接仍有缺口，尚未完成首版", tone: "attention" };
  }
}

/**
 * Single source of truth for "what is the system doing" on the research pipeline.
 *
 * Research progress events, background enrichment and the automatic learning-path
 * mount previously each produced their own status copy, so the page could show
 * "后台增量中"、"自动挂载中" and "已完成" at the same time. Every surface derives
 * its headline and stage list from this projection instead.
 */
export type RunStatusInput = { progress?: ResearchProgress; mount?: AutomaticMountRecord | null; readiness?: { ready: boolean; blockers: string[] }; connectionError?: string };
export function projectRunStatus(input: RunStatusInput): RunStatusView | null {
  const { mount, readiness } = input;
  let progress = input.progress;
  if (readiness && !progress?.active && !["failed", "cancelled", "interrupted"].includes(progress?.status || "")) progress = readiness.ready
    ? { active: false, stage: 5, status: "completed", message: "岗位内容已保存，等待自动连接学习节点" }
    : { active: false, stage: 4, status: "draft", message: "首版仍有缺口，研究草稿已保存" };
  if (!progress) return null;

  let stage = Math.max(0, Math.min(progress.stage, researchStages.length));
  let active = progress.active;
  let blocked = false;
  let headline = progress.message;
  let tone: RunStatusTone = active ? "active" : stage >= researchStages.length ? "done" : "idle";

  if (terminalAttention.has(progress.status)) {
    active = false;
    blocked = true;
    tone = "attention";
  }

  // After the research stages finish, the learning-course mount is the only
  // remaining stage. Its record — not a second banner — decides the headline.
  // A failed or cancelled run keeps its own headline; a healthy mount record
  // must not paint over an unresolved failure.
  if (!active && !blocked && stage >= researchStages.length - 2 && mount) {
    const mounted = mountHeadline(mount);
    stage = Math.max(stage, mounted.stage);
    active = mounted.active;
    blocked = mounted.blocked;
    headline = mounted.headline;
    tone = mounted.tone;
  }

  if (!active && !blocked && input.connectionError) { headline = input.connectionError; tone = "attention"; blocked = true; }

  if (!active && !blocked && readiness?.ready && !mount) { stage = 5; tone = "attention"; headline = input.connectionError || "岗位内容已保存，学习节点尚未完成连接"; blocked = true; }
  const stages: RunStageView[] = researchStages.map((label, index) => ({
    index,
    label,
    state: index < stage ? "done" : index === stage ? (blocked ? "blocked" : active ? "active" : "pending") : "pending",
  }));
  return { stages, headline, tone, activeIndex: stage };
}
