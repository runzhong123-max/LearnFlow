"use client";
import { researchStages, type ResearchProgress } from "@/lib/jobs/research-progress";
import type { AutomaticMountRecord } from "@/lib/learning-path/automatic-contract";
import "./research-stages.css";
export default function ResearchStages({ progress, mount }: { progress?: ResearchProgress; mount?: AutomaticMountRecord | null }) {
  if (!progress) return null;
  if (!progress.active && progress.stage >= 4 && mount) {
    progress = { ...progress, stage: mount.status === "completed" ? 6 : 5,
      active: mount.status === "running" || mount.status === "retry",
      message: mount.status === "completed" ? "研究与课程挂载已完成" : mount.status === "queued" ? "研究已保存，等待课程匹配" : mount.status === "running" ? "正在匹配已有课程，并合并未覆盖的要求" : mount.status === "retry" ? "课程匹配正在重试，已有研究成果已保留" : "请查看学习路径挂载详情" };
  }
  return <section className="research-stages" aria-label="岗位研究阶段">
    <ol>{researchStages.map((label, index) => <li key={label} className={index < progress.stage ? "done" : index === progress.stage && progress.active ? "active" : "pending"} aria-current={index === progress.stage && progress.active ? "step" : undefined}><i>{index < progress.stage ? "✓" : index + 1}</i>{label}</li>)}</ol>
    <p role="status">{progress.message}</p>
  </section>;
}
