import type { ColdStartBuildResult } from "@/lib/build/types";
import { inspectTaskDefinitions } from "./task-definition";
/** These checks describe expression defects, not measured student learning outcomes. */
export function researchQuality(result: ColdStartBuildResult) {
  const tasks = inspectTaskDefinitions(result);
  const active = result.semantic.nodes.filter(node => node.lifecycle !== "rejected");
  const expressionIssues = active.filter(node => !node.summary.trim() || node.summary.length > 1600 || /^(全面掌握|深入了解|熟悉相关知识)[。！]?$/u.test(node.summary)).map(node => node.id);
  return { taskGaps: tasks.reduce((sum, task) => sum + task.gaps.length, 0), readyTasks: tasks.filter(task => task.ready).length, expressionIssues, tasks };
}
export function compareResearchQuality(base: ColdStartBuildResult, candidate: ColdStartBuildResult) {
  const before = researchQuality(base), after = researchQuality(candidate);
  const byId = new Map(after.tasks.map(task => [task.taskId, task]));
  const regressed = before.tasks.filter(task => task.ready && byId.has(task.taskId) && !byId.get(task.taskId)!.ready).map(task => task.taskId);
  if (before.tasks.length > 0 && !after.tasks.length) regressed.push("all_core_tasks_removed");
  return { before, after, regressed, conversionImproved: after.taskGaps < before.taskGaps || after.readyTasks > before.readyTasks,
    expressionImproved: after.expressionIssues.length < before.expressionIssues.length };
}

/** Repeated wording with the same evidence is not progress; a changed review or scope can be. */
export function reviewedFindingKeys(run?: import("./protocol").ResearchRun) {
  return [...new Set((run?.findings || []).filter(finding => finding.review !== "undetermined").map(finding => JSON.stringify({ statement: finding.claim.statement, review: finding.review, applicability: finding.claim.applicability, evidence: finding.claim.evidenceSpans.map(span => [span.segmentId, span.quote]).sort() })))].sort();
}
