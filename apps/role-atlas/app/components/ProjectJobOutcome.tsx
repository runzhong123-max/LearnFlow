import { draftGapLabel, draftStopLabels } from "@/lib/jobs/draft-presentation";
import { iterationOutcomePresentation, normalizeIterationOutcome } from "@/lib/jobs/iteration-outcome";

type JobResult = { outcome?: unknown; outcomeUnavailable?: boolean; draft?: boolean; stopReason?: string; blockers?: unknown };
export function projectJobResultPresentation(result?: JobResult) {
  if (result?.draft === true) return { tone: "partial", label: "草稿已保存 · 待完善", message: "已有岗位内容已保留，可继续完善。引用或转换任务时，将校验所选内容。" };
  const display = iterationOutcomePresentation(result?.outcome);
  if (display) return display;
  if (result?.outcome != null || result?.outcomeUnavailable === true) return { tone: "partial", label: "结果摘要不完整", message: "此记录缺少可用的结果摘要，请查看已保存的版本或执行记录。" };
  return undefined;
}
export default function ProjectJobOutcome({ result }: { result?: JobResult }) {
  if (result?.draft === true) {
    const stopReason = typeof result.stopReason === "string" ? result.stopReason : (typeof result.outcome === "string" ? result.outcome : "");
    const blockers = Array.isArray(result.blockers) ? result.blockers.filter((line): line is string => typeof line === "string" && Boolean(line)) : [];
    return <details><summary>待完善内容{blockers.length ? ` · ${blockers.length} 项` : ""}</summary>
      {Object.hasOwn(draftStopLabels, stopReason) ? <p>{draftStopLabels[stopReason]}</p> : null}
      {blockers.length ? <ul>{blockers.slice(0, 20).map((line, index) => <li key={index}>{draftGapLabel(line).slice(0, 1000)}</li>)}</ul> : <p>此记录没有提供具体待完善项，请查看研究记录。</p>}
      {blockers.length > 20 && <p>仅展示前 20 项，其余请查看研究记录。</p>}
    </details>;
  }
  const outcome = normalizeIterationOutcome(result?.outcome);
  if (!outcome) return null;
  return <details><summary>本轮结果 · {outcome.work.completed}/{outcome.work.total} 个工作项完成</summary>
    {outcome.coverage ? <p>当前保存版本：{outcome.coverage.knowledgeSkills} 个知识技能点；{outcome.coverage.tasksWithoutSkills}/{outcome.coverage.tasks} 个任务缺少知识技能支撑，{outcome.coverage.tasksWithoutProcess} 个任务缺少过程。</p> : null}
    <p>已尝试 {outcome.research.queries} 个检索查询 · 选用 {outcome.research.selectedSources} 份来源{outcome.research.failures > 0 ? ` · ${outcome.research.failures} 个查询失败` : ""}。{outcome.work.total === 0 ? "本轮未选出可执行工作项。" : `仍有 ${outcome.work.unresolved} 个工作项未解决。`}</p>
    {[...new Set([...outcome.summary, ...outcome.reasons])].map((line, index) => <p key={index}>{line}</p>)}
    {outcome.remainingGapCount > 0 ? <><p>当前仍有 {outcome.remainingGapCount} 项问题{outcome.remainingGapCount > outcome.remainingGaps.length ? "（展示前 8 项）" : ""}：</p><ul>{outcome.remainingGaps.map((gap, index) => <li key={index}>{gap.title}</li>)}</ul></> : null}
  </details>;
}
