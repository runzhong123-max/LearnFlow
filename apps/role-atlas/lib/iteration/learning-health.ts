import type { ColdStartBuildResult } from "@/lib/build/types";

export function learningCoverage(result: ColdStartBuildResult) {
  const tasks = result.semantic.nodes.filter(n => n.type === "task" && n.lifecycle !== "rejected");
  const skills = result.semantic.nodes.filter(n => n.type === "knowledge_skill" && n.lifecycle !== "rejected");
  const ids = new Set(skills.map(n => n.id));
  const covered = new Set(result.semantic.edges.filter(e => e.lifecycle !== "rejected" && ids.has(e.target) && /skill|knowledge/u.test(e.type)).map(e => e.source));
  return { tasks, skills, tasksWithoutSkills: tasks.filter(t => !covered.has(t.id)) };
}

export function snapshotQualitySummary(result: ColdStartBuildResult) {
  const coverage = learningCoverage(result);
  const gapCount = new Set(result.audit.issues.map(i => `${i.code}:${[...i.targetIds].sort().join("|")}`)).size;
  const missing = coverage.tasksWithoutSkills.length;
  return {
    gapCount,
    tasksWithoutSkills: missing,
    needsResearch: gapCount > 0 || missing > 0 || !result.validation.publishable,
    label: missing ? `本轮已结束，${missing} 个任务仍缺少知识技能支撑` : gapCount ? `本轮已结束，仍有 ${gapCount} 项待核对问题` : !result.validation.publishable ? "本轮已结束，岗位包仍待校验" : "本轮研究与校验已完成",
  };
}
