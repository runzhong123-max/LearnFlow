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

const terminalAttention = new Set(["failed", "cancelled", "interrupted"]);

function mountHeadline(mount: AutomaticMountRecord): { stage: number; active: boolean; blocked: boolean; headline: string; tone: RunStatusTone } {
  switch (mount.status) {
    case "completed":
      return { stage: researchStages.length, active: false, blocked: false, headline: "研究与课程挂载已完成", tone: "done" };
    case "queued":
      return { stage: researchStages.length - 1, active: true, blocked: false, headline: "研究已保存，等待课程匹配", tone: "active" };
    case "running":
      return { stage: researchStages.length - 1, active: true, blocked: false, headline: "正在匹配已有课程，并合并未覆盖的要求", tone: "active" };
    case "retry":
      return { stage: researchStages.length - 1, active: true, blocked: false, headline: "课程匹配正在重试，已有研究成果已保留", tone: "active" };
    case "failed":
      return { stage: researchStages.length - 1, active: false, blocked: true, headline: mount.error || "课程挂载未完成，已有研究成果已保留", tone: "attention" };
    default:
      // partial / needs_research / superseded: research itself is saved, the mount
      // needs more evidence or a newer version instead of looking stuck.
      return { stage: researchStages.length - 1, active: false, blocked: true, headline: "课程挂载仍有待补全项，请查看学习路径挂载详情", tone: "attention" };
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
export function projectRunStatus(input: { progress?: ResearchProgress; mount?: AutomaticMountRecord | null }): RunStatusView | null {
  const { progress, mount } = input;
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

  const stages: RunStageView[] = researchStages.map((label, index) => ({
    index,
    label,
    state: index < stage ? "done" : index === stage ? (blocked ? "blocked" : active ? "active" : "pending") : "pending",
  }));
  return { stages, headline, tone, activeIndex: stage };
}
