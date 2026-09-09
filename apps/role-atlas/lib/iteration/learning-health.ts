import type { ColdStartBuildResult } from "@/lib/build/types";

/** A task needs distinct, assessable knowledge and practice support. */
export function learningCoverage(result: ColdStartBuildResult) {
  const tasks = result.semantic.nodes.filter(n => n.type === "task" && n.lifecycle !== "rejected");
  const skills = result.semantic.nodes.filter(n => n.type === "knowledge_skill" && n.lifecycle !== "rejected");
  const usable = skills.filter(point => (point.learningKind === "knowledge" || point.learningKind === "skill")
    && point.learningDefinition?.scopeNote.trim() && point.learningDefinition.assessmentCriteria.some(item => item.trim())
    && !/(?:能力|素养|素质|competenc(?:y|ies)|abilit(?:y|ies))$/iu.test(point.label.trim())
    && result.sources.evidenceBindings.some(binding => binding.targetId === point.id && binding.supportRole !== "contradicts"
      && result.sources.assets.some(asset => asset.id === binding.sourceId && asset.kind !== "user_brief" && asset.qualification?.status !== "quarantined")
      && result.sources.segments.some(segment => segment.id === binding.segmentId && segment.sourceId === binding.sourceId && segment.text.trim())));
  const taskCoverage = tasks.map(task => {
    const linkedIds = new Set(result.semantic.edges.filter(edge => edge.lifecycle !== "rejected" && edge.source === task.id && edge.type === "requires_skill").map(edge => edge.target));
    const points = usable.filter(point => linkedIds.has(point.id));
    return { taskId: task.id, linkedPointCount: skills.filter(point => linkedIds.has(point.id)).length,
      missingKinds: (["knowledge", "skill"] as const).filter(kind => !points.some(point => point.learningKind === kind)) };
  });
  return { tasks, skills, taskCoverage, tasksWithoutSkills: tasks.filter(task => taskCoverage.some(item => item.taskId === task.id && item.missingKinds.length > 0)) };
}

/** A bridge alone is not an executable work process. */
export function processCoverage(result: ColdStartBuildResult) {
  const tasks = result.semantic.nodes.filter(node => node.type === "task" && node.lifecycle !== "rejected");
  return tasks.map(task => {
    const bridges = result.process.bridges.filter(bridge => bridge.type === "realizes_task" && bridge.semanticNodeId === task.id);
    const complete = bridges.some(bridge => {
      const scenario = result.process.scenarios.find(item => item.id === bridge.processNodeId
        || item.id === result.process.nodes.find(node => node.id === bridge.processNodeId)?.scenarioId);
      if (!scenario?.trigger.trim() || !scenario.outcome.trim()) return false;
      const nodes = result.process.nodes.filter(node => node.scenarioId === scenario.id);
      const actions = nodes.filter(node => node.kind === "event" || node.kind === "decision");
      const ids = new Set(actions.map(node => node.id));
      const flow = result.process.edges.some(edge => ids.has(edge.source) && ids.has(edge.target)
        && ["directly_follows", "branches_to", "loops_to"].includes(edge.type));
      return actions.length >= 2 && flow && nodes.some(node => node.kind === "artifact");
    });
    return { taskId: task.id, hasBridge: bridges.length > 0, complete };
  });
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
