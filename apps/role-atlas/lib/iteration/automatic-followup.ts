import type { LearningPathGraphInput } from "@/lib/build/types";
import type { SnapshotIterationRequest } from "./types";

type FollowupInput = {
  runId: string;
  snapshotId: string;
  projectId: string;
  versionId?: string;
  conversationId?: string;
  learningPathGraph?: LearningPathGraphInput;
  /** Inherit the parent run; omitted by older callers means enabled. */
  webResearch?: boolean;
};

export function createColdStartDeepResearchRequest(input: FollowupInput): SnapshotIterationRequest {
  return {
    runId: `${input.runId.slice(0, 94)}:deep`,
    snapshotRef: { snapshotId: input.snapshotId, projectId: input.projectId, versionId: input.versionId },
    projectId: input.projectId,
    conversationId: input.conversationId,
    initiativeProfile: "autonomous",
    mode: "deep_research",
    prompt: "在完整岗位包中选择 3—5 个对岗位边界、任务骨架、能力抽象、日常培养、学习路径或事理森林影响最大的研究问题，进行多来源深度研究；优先解决能同时改善多个下游对象的问题。",
    targetIds: [],
    supplementalSources: [],
    learningPathGraph: input.learningPathGraph,
    webResearch: input.webResearch ?? true,
    maxRounds: 12,
    sourceLimit: 64,
    maxWorkItems: 32,
  };
}

export function createColdStartRiskRepairRequest(input: FollowupInput): SnapshotIterationRequest {
  return {
    runId: `${input.runId.slice(0, 92)}:repair`,
    snapshotRef: { snapshotId: input.snapshotId, projectId: input.projectId, versionId: input.versionId },
    projectId: input.projectId,
    conversationId: input.conversationId,
    initiativeProfile: "autonomous",
    mode: "risk_repair",
    prompt: "对深度研究后的完整岗位包执行全量风险修复：覆盖协议、同维度重复、维度污染、孤立与悬空关系、失证、任务覆盖、能力迁移、能力单元培养契约、学习路径映射和事理桥接；对可研究缺口先检索与交叉核验，再用已有或新增证据补齐知识、技能、能力单元及工作过程；重复检查直到缺口关闭或预算用尽，保留可验证的最小改进。",
    targetIds: [],
    supplementalSources: [],
    learningPathGraph: input.learningPathGraph,
    webResearch: input.webResearch ?? true,
    maxRounds: 12,
    sourceLimit: 64,
    maxWorkItems: 32,
  };
}
