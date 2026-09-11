import type { IntakeView } from "./types";
/** Display-only formatting: never rewrite the confirmed description or its hash. */
export function formatIntakeDescription(description: string): string {
  return description.split("\n").map(line => {
    if (/^岗位说明（待确认）：/u.test(line)) return `## ${line.replace(/^岗位说明（待确认）：/u, "")}`;
    if (/^(岗位概述|相邻岗位边界（本岗位不包含）|主要任务|能力要求|典型工作场景|职责边界|资料索引)$/u.test(line.trim())) return `### ${line.trim()}`;
    return line;
  }).join("\n");
}
export function previousIntakeHistory(intake: IntakeView) {
  return intake.history.filter(item => item.text && item.id !== `intake:${intake.revisionId}:assistant`
    && item.text !== intake.description && item.text !== intake.assistantMessage).slice(-8);
}
