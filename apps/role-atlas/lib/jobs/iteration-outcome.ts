/** A bounded view of one iteration. Never expose its candidate, sources or model responses. */
export type IterationOutcome = {
  status: "completed" | "no_change" | "waiting_user";
  createdSnapshot: boolean;
  coverage?: { tasks: number; knowledgeSkills: number; tasksWithoutSkills: number; tasksWithoutProcess: number };
  summary: string[];
  reasons: string[];
  remainingGapCount: number;
  remainingGaps: Array<{ code: string; title: string }>;
  work: { total: number; completed: number; unresolved: number };
  research: { queries: number; selectedSources: number; failures: number };
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function count(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0; }
function text(value: unknown) { return typeof value === "string" ? value.slice(0, 600) : ""; }
function lines(value: unknown) { return [...new Set(list(value).map(text).filter(Boolean))].slice(0, 6); }

export function iterationOutcome(value: unknown): IterationOutcome | undefined {
  const result = record(value);
  if (!["completed", "no_change", "waiting_user"].includes(String(result.status))) return undefined;
  const createdSnapshot = result.createdSnapshot === true;
  // A rejected candidate is not the saved graph. Report the baseline's actual gaps.
  const inspection = record(createdSnapshot ? result.inspectionAfter : result.inspectionBefore);
  const coverage = record(inspection.coverage);
  const gaps = new Map<string, { code: string; title: string }>();
  for (const raw of list(inspection.findings)) {
    const finding = record(raw);
    if (finding.severity === "info" && finding.hardBlocker !== true) continue;
    const code = text(finding.code), title = text(finding.title);
    if (!code || !title) continue;
    const targets = [...new Set(list(finding.targetIds).map(text))].sort();
    const key = JSON.stringify([code, targets, targets.length ? "" : title, code === "LANE_FALLBACK" ? text(finding.detail) : ""]);
    if (!gaps.has(key)) gaps.set(key, { code, title });
  }
  const work = list(result.workItems).map(record);
  const reports = list(result.researchReports).map(record);
  return {
    status: result.status as IterationOutcome["status"], createdSnapshot,
    ...(Object.keys(coverage).length ? { coverage: {
      tasks: count(coverage.tasks), knowledgeSkills: count(coverage.knowledgeSkills),
      tasksWithoutSkills: count(coverage.tasksWithoutSkills), tasksWithoutProcess: count(coverage.tasksWithoutProcess),
    } } : {}),
    summary: lines(result.summary), reasons: lines(record(result.evaluation).reasons),
    remainingGapCount: gaps.size, remainingGaps: [...gaps.values()].slice(0, 8),
    // Older runs marked researched items completed before candidate acceptance.
    // No candidate saved means those statuses cannot claim a repair of the saved graph.
    work: { total: work.length, completed: createdSnapshot ? work.filter(item => item.status === "completed").length : 0,
      unresolved: createdSnapshot ? work.filter(item => item.status !== "completed").length : work.length },
    research: { queries: reports.reduce((sum, report) => sum + list(report.queries).length, 0),
      selectedSources: reports.reduce((sum, report) => sum + count(report.selectedSourceCount), 0),
      failures: reports.reduce((sum, report) => sum + list(report.failures).length, 0) },
  };
}

export type IterationOutcomeScope = { id: string; projectId?: string | null; kind: string; status: string };
type IterationRow = { id: string; project_id: string | null; result_json: string | null };

/** Legacy jobs saved only version IDs. Read the matching domain record; never infer from another run. */
export async function loadIterationOutcome(
  job: IterationOutcomeScope,
  lookup: (jobId: string, projectId: string) => Promise<IterationRow | null>,
): Promise<IterationOutcome | undefined> {
  if (job.status !== "completed" || !job.projectId || !["snapshot_iteration", "node_deepening"].includes(job.kind)) return undefined;
  const row = await lookup(job.id, job.projectId);
  if (!row?.result_json || row.id !== job.id || row.project_id !== job.projectId) return undefined;
  try {
    const result = record(JSON.parse(row.result_json));
    if (result.runId !== job.id || (result.projectId && result.projectId !== job.projectId)) return undefined;
    return iterationOutcome(result);
  } catch { return undefined; }
}

export function iterationOutcomePresentation(outcome?: IterationOutcome) {
  if (!outcome) return undefined;
  if (outcome.status === "waiting_user") return { tone: "partial", label: "需要补充资料", message: "本轮检查已结束，尚未生成新版本。请查看未解决的问题。" };
  if (!outcome.createdSnapshot || outcome.status === "no_change") return { tone: "no-change", label: "未生成新版本", message: "本轮没有可保存的有效更新，仍保留原版本。查看本轮结果可了解原因与剩余缺口。" };
  const hasGaps = outcome.remainingGapCount > 0 || outcome.work.unresolved > 0 || (outcome.coverage?.tasksWithoutSkills || 0) > 0 || (outcome.coverage?.tasksWithoutProcess || 0) > 0;
  return hasGaps
    ? { tone: "partial", label: "已更新 · 仍有缺口", message: "已保存新版本；部分问题仍待研究，请查看本轮结果。" }
    : { tone: "completed", label: "已生成新版本", message: "本轮更新已保存，结果固定到这次生成的版本。" };
}
