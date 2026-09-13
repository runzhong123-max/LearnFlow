"use client";
import { projectRunStatus, type RunStatusInput } from "@/lib/jobs/run-status";
import "./research-stages.css";
export default function ResearchStages(input: RunStatusInput) {
  const status = projectRunStatus(input);
  if (!status) return null;
  return <section className="research-stages" aria-label="岗位研究阶段">
    <ol>{status.stages.map(stage => <li key={stage.label} className={stage.state} aria-current={stage.state === "active" ? "step" : undefined}><i>{stage.state === "done" ? "✓" : stage.index + 1}</i>{stage.label}</li>)}</ol>
    <p role="status" className={status.tone === "attention" ? "attention" : undefined}>{status.headline}</p>
  </section>;
}
