import type { ResearchRun } from "./protocol";
/** Views contain references into the run; they do not own a second fact lifecycle. */
export function researchViews(run: ResearchRun) {
  const risks = run.findings.filter(finding => finding.nextQuestion || finding.claim.kind === "absence" || finding.review !== "supported").map(finding => ({
    findingId: finding.id, axis: finding.axis, affectedIds: finding.claim.affectedNodeIds,
    missingConcept: finding.claim.affectedNodeIds.length ? undefined : finding.claim.statement,
    consequence: finding.consequence, nextQuestion: finding.nextQuestion || `需要哪些材料核对：${finding.claim.statement}`, review: finding.review,
  }));
  const selected = new Set(run.intent.targetIds);
  const radar = risks.map(risk => {
    const finding = run.findings.find(finding => finding.id === risk.findingId)!;
    const text = `${risk.nextQuestion} ${risk.consequence}`;
    const qualityTarget = /交付|输入|质量|过程|任务转换|项目/u.test(text) ? "project_conversion" : /理解|术语|表达|学生/u.test(text) ? "student_understanding" : "coverage";
    const matchesUser = finding.claim.affectedNodeIds.some(id => selected.has(id));
    return { findingId: finding.id, question: risk.nextQuestion, qualityTarget, priority: (matchesUser ? 1000 : 0) + ({ project_conversion: 300, student_understanding: 200, coverage: 100 }[qualityTarget]), expectedValue: risk.consequence, cost: "尚未估算", unresolved: finding.review, reopenWhen: finding.claim.falsifier };
  }).sort((a, b) => b.priority - a.priority || a.findingId.localeCompare(b.findingId));
  return { risks, radar, policy: "明确选择优先，其后按项目转换、学生理解、重要覆盖排序；不按影响节点数量计分" };
}
