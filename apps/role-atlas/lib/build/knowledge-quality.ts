import type { ConceptMention, SourceSegment } from "./types";
import type { TaskGroup } from "./workflow";
import type { KnowledgeDerivationDraft } from "./workflow-model";

type Point = KnowledgeDerivationDraft["skills"][number];
export type KnowledgeQualityIssue = { taskTempIds: string[]; detail: string };

/** Validate new detail output without guessing missing facts or promoting old hybrid nodes. */
export function inspectKnowledgeDerivation(input: {
  draft: KnowledgeDerivationDraft;
  group: TaskGroup;
  mentions: ConceptMention[];
  segments: Array<Pick<SourceSegment, "id" | "text">>;
}) {
  const tasks = new Set(input.group.tasks.map((task) => task.tempId));
  const segments = new Map(input.segments.map((segment) => [segment.id, segment.text]));
  const mentions = new Map(input.mentions.map((mention) => [mention.id, mention]));
  const issues: KnowledgeQualityIssue[] = [];
  const skills: Point[] = [];
  for (const point of input.draft.skills) {
    const taskTempIds = [...new Set(point.taskTempIds)].filter((id) => tasks.has(id));
    const reasons: string[] = [];
    if (!taskTempIds.length || point.taskTempIds.some((id) => !tasks.has(id))) reasons.push("必须引用本组真实任务 ID");
    if (point.learningKind !== "knowledge" && point.learningKind !== "skill") reasons.push("混合领域需要拆分为知识点或技能点");
    if (!point.learningDefinition?.scopeNote.trim() || !point.learningDefinition.assessmentCriteria.length) reasons.push("缺少适用边界或可检查的评价规格");
    if (/(?:能力|素养|素质|competenc(?:y|ies)|abilit(?:y|ies))$/iu.test(point.label.trim())) reasons.push("综合能力不能作为原子知识技能，需依据资料拆解具体组成");
    const evidenceSpans = point.evidenceSpans.filter((span) => Boolean(span.quote.trim()) && segments.get(span.segmentId)?.includes(span.quote));
    const mentionIds = point.mentionIds.filter((id) => {
      const mention = mentions.get(id);
      if (!mention || mention.kind !== "knowledge_skill") return false;
      const text = segments.get(mention.sourceSegmentId);
      return Boolean(text && (mention.evidenceSpan
        ? mention.evidenceSpan.segmentId === mention.sourceSegmentId && text.includes(mention.evidenceSpan.quote)
        : text.includes(mention.surfaceForm)));
    });
    if (!evidenceSpans.length && !mentionIds.length) reasons.push("没有可核对的原文引用，不能借用任务来源冒充该点证据");
    if (reasons.length) {
      issues.push({ taskTempIds, detail: `“${point.label}”：${reasons.join("；")}` });
      continue;
    }
    skills.push({ ...point, taskTempIds, evidenceSpans, mentionIds });
  }
  const covered = new Set(skills.flatMap((point) => point.taskTempIds));
  const uncoveredTaskIds = [...tasks].filter((id) => !covered.has(id));
  const gaps = uncoveredTaskIds.map((taskTempId) => ({
    taskTempId,
    reason: input.draft.gaps.find((gap) => gap.taskTempId === taskTempId)?.reason
      || "现有输出尚未形成具有原文依据和评价规格的任务支撑知识技能。",
  }));
  return { accepted: { skills, gaps } satisfies KnowledgeDerivationDraft, issues, uncoveredTaskIds };
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
  const covered = new Set(skills.flatMap((point) => point.taskTempIds));
  const gaps = [...new Map([...first.gaps, ...repair.gaps].filter((gap) => !covered.has(gap.taskTempId)).map((gap) => [gap.taskTempId, gap])).values()];
  return { skills, gaps };
}
