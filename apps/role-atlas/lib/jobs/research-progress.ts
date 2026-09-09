export const researchStages = ["搜集扩大资料", "确定岗位边界", "梳理任务与能力", "展开工作过程", "深度研究与完善", "匹配学习课程"] as const;
export type ResearchProgress = { active: boolean; stage: number; message: string; status: string };
export function researchStage(kind: string, payload: Record<string, unknown> = {}): number | undefined {
  if (/followup|inspection|risk_repair/.test(kind)) return 4;
  if (/process/.test(kind)) return 3;
  if (/semantic|enrichment|kernel.completed|task_barrier/.test(kind)) return 2;
  if (/boundary/.test(kind)) return 1;
  if (/search|source|research/.test(kind)) return 0;
  if (kind.includes("work_item")) return researchStage(String((payload.workItem as { stage?: string })?.stage || ""));
  return undefined;
}
export function progressForJob(job: { status: string; phase: string }, previous?: ResearchProgress): ResearchProgress {
  const active = ["queued", "running", "recovering", "cancelling", "waiting_user"].includes(job.status);
  const stage = Math.max(previous?.stage || 0, researchStage(job.phase) || 0);
  return { active, stage, status: job.status, message: job.status === "queued" ? "任务已接收，等待后台执行" : job.status === "recovering" ? "正在从保存处继续研究" : active ? previous?.message || researchStages[stage] : job.status === "completed" ? job.phase === "kernel.completed" ? "岗位骨架已保存，后台将继续展开研究" : "研究结果已保存，学习课程由后台继续核对" : "已有成果已保留，请查看任务记录" };
}
