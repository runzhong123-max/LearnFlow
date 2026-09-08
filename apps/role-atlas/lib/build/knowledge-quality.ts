import type { ConceptMention, SourceSegment } from "./types";
import type { TaskGroup } from "./workflow";
import type { KnowledgeDerivationDraft } from "./workflow-model";

type Point = KnowledgeDerivationDraft["skills"][number];
export type KnowledgeQualityIssue = { taskTempIds: string[]; detail: string };

export function knowledgeTaskCoverage(taskIds: string[], skills: Point[]) {
  return taskIds.map(taskTempId => {
    const points = skills.filter(point => point.taskTempIds.includes(taskTempId));
    const knowledgeCount = points.filter(point => point.learningKind === "knowledge").length;
    const skillCount = points.filter(point => point.learningKind === "skill").length;
    const missingKinds = (["knowledge", "skill"] as const).filter(kind => !points.some(point => point.learningKind === kind));
    return { taskTempId, knowledgeCount, skillCount, missingKinds };
  });
}

/** Validate new detail output without guessing missing facts or promoting old hybrid nodes. */
export function inspectKnowledgeDerivation(input: {
  draft: KnowledgeDerivationDraft;
  group: TaskGroup;
  mentions: ConceptMention[];
  segments: Array<Pick<SourceSegment, "id" | "text">>;
}) {
  const tasks = new Set(input.group.tasks.map((task) => task.tempId));
  // One source segment may contribute several disjoint, verbatim context windows.
  // Never join windows: that could falsely validate a quote across an omitted gap.
  const containsQuote = (segmentId: string, quote: string) => Boolean(quote.trim()) && input.segments.some(segment => segment.id === segmentId && segment.text.includes(quote));
  const mentions = new Map(input.mentions.map((mention) => [mention.id, mention]));
  const issues: KnowledgeQualityIssue[] = [];
  const skills: Point[] = [];
  for (const point of input.draft.skills) {
    const taskTempIds = [...new Set(point.taskTempIds)].filter((id) => tasks.has(id));
    const reasons: string[] = [];
    if (!taskTempIds.length || point.taskTempIds.some((id) => !tasks.has(id))) reasons.push("必须引用本组真实任务 ID");
    if (point.learningKind !== "knowledge" && point.learningKind !== "skill") reasons.push("混合领域需要拆分为知识点或技能点");
    if (!point.learningDefinition?.scopeNote.trim() || !point.learningDefinition.assessmentCriteria.some(item => item.trim())) reasons.push("缺少适用边界或可检查的评价规格");
    if (/(?:能力|素养|素质|competenc(?:y|ies)|abilit(?:y|ies))$/iu.test(point.label.trim())) reasons.push("综合能力不能作为原子知识技能，需依据资料拆解具体组成");
    const evidenceSpans = point.evidenceSpans.filter((span) => containsQuote(span.segmentId, span.quote));
    const mentionIds = point.mentionIds.filter((id) => {
      const mention = mentions.get(id);
      if (!mention || mention.kind !== "knowledge_skill") return false;
      return mention.evidenceSpan
        ? mention.evidenceSpan.segmentId === mention.sourceSegmentId && containsQuote(mention.sourceSegmentId, mention.evidenceSpan.quote)
        : containsQuote(mention.sourceSegmentId, mention.surfaceForm);
    });
    if (!evidenceSpans.length && !mentionIds.length) reasons.push("没有可核对的原文引用，不能借用任务来源冒充该点证据");
    if (reasons.length) {
      issues.push({ taskTempIds, detail: `“${point.label}”：${reasons.join("；")}` });
      continue;
    }
    skills.push({ ...point, taskTempIds, evidenceSpans, mentionIds });
  }
  const coverage = knowledgeTaskCoverage([...tasks], skills);
  const uncoveredTaskIds = coverage.filter(item => !item.knowledgeCount && !item.skillCount).map(item => item.taskTempId);
  const incomplete = coverage.filter(item => item.missingKinds.length);
  const gaps = incomplete.map(({ taskTempId, missingKinds }) => ({
    taskTempId,
    reason: input.draft.gaps.find((gap) => gap.taskTempId === taskTempId)?.reason
      || `尚缺有原文依据与评价规格的${missingKinds.map(kind => kind === "knowledge" ? "知识点" : "技能点").join("、")}；需补充资料或说明不适用，不能用单一维度代表完整支撑。`,
  }));
  return { accepted: { skills, gaps } satisfies KnowledgeDerivationDraft, issues, uncoveredTaskIds, coverage, incompleteTaskIds: incomplete.map(item => item.taskTempId) };
}

/** Keep successful points when a bounded repair adds missing coverage. */
export function mergeKnowledgeDerivations(first: KnowledgeDerivationDraft, repair: KnowledgeDerivationDraft): KnowledgeDerivationDraft {
  const points = new Map<string, Point>();
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
  for (const point of [...first.skills, ...repair.skills]) {
    const key = JSON.stringify([point.learningKind, normalize(point.label), normalize(point.learningDefinition?.scopeNote || "")]);
    const old = points.get(key);
    points.set(key, old ? { ...old, taskTempIds: [...new Set([...old.taskTempIds, ...point.taskTempIds])],
      mentionIds: [...new Set([...old.mentionIds, ...point.mentionIds])], evidenceSpans: [...old.evidenceSpans, ...point.evidenceSpans] } : point);
  }
  const skills = [...points.values()].map((point, index) => ({ ...point, tempId: `point-${index + 1}` }));
  const reasons = new Map([...first.gaps, ...repair.gaps].map(gap => [gap.taskTempId, gap.reason]));
  const coverage = knowledgeTaskCoverage([...new Set([...reasons.keys(), ...skills.flatMap(point => point.taskTempIds)])], skills);
  const gaps = coverage.filter(item => item.missingKinds.length).map(item => ({ taskTempId: item.taskTempId, reason: reasons.get(item.taskTempId) || "知识与技能支撑仍需补充资料核对。" }));
  return { skills, gaps };
}
