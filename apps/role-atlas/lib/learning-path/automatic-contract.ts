import type { RolePackageRef } from "./contract";

export const AUTOMATIC_MOUNT_POLICY = "role-learning-auto/v1" as const;
export type AutomaticMountPoint = {
  roleNodeId: string;
  status: "existing" | "created" | "needs_research";
  target?: { namespace: string; id: string; revision: number };
  course?: { title: string; kind: "course" };
  reason?: string;
  candidates?: Array<{ namespace: string; id: string; title: string; kind: string }>;
};
export type AutomaticMountResult = {
  status: "completed" | "partial" | "needs_research";
  packageRef: RolePackageRef;
  reason?: string;
  points: AutomaticMountPoint[];
  receipts: Array<{ receiptId: string; graphRef: { graphId: string; revision: string }; addedNodeIds: string[]; masteryUnchanged: true }>;
  unresolved: Array<{ roleNodeId: string; reason: string; candidates?: unknown[] }>;
};
export type AutomaticMountRecord = {
  id: string; projectVersionId: string; snapshotId: string;
  status: "queued" | "running" | "retry" | "completed" | "partial" | "needs_research" | "failed" | "superseded";
  result?: AutomaticMountResult; error?: string; attempt: number;
  repair?: { jobId: string; status: string; error?: string };
};

export const mountReason = (reason?: string) => ({
  needs_decomposition: "需要拆分为明确的知识点或技能点",
  needs_definition: "需要补充范围与可检查的验收要求",
  needs_evidence: "需要补充该点可追溯的来源证据",
  ambiguous_definition: "同名节点定义不同，需要明确语义边界",
  no_learning_points: "尚未形成可挂载的知识点或技能点，需要先完善岗位内容",
  needs_anchor: "需要明确学习内容归属",
}[reason || ""] || reason || "需要进一步核对");

export function learningMountFeedback(record: AutomaticMountRecord | null) {
  return record?.result?.unresolved.map(point => ({ roleNodeId: point.roleNodeId, reason: point.reason,
    researchGoal: mountReason(point.reason), candidates: point.candidates || [] })) || [];
}


export function needsAutomaticResearch(result?: AutomaticMountResult) {
  return result?.reason === "no_learning_points" || Boolean(result?.unresolved.some(point => ["needs_definition","needs_decomposition","needs_evidence"].includes(point.reason)));
}
