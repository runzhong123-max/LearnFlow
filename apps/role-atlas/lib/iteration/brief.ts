import { snapshotIterationRequestSchema, type InitiativeProfile, type IterationMode, type SnapshotIterationRequest } from "./types";
import type { LearningPathGraphInput, SourceInput } from "@/lib/build/types";
import type { WorkspaceSkillContext } from "@/lib/skills/workspace";

export const iterationModeOptions = [
  { id: "deep_research", label: "深度研究", detail: "补充证据、明确边界、深化能力与学习路径" },
  { id: "risk_repair", label: "风险修复", detail: "检查并修复重复、失证、非法关系与错误映射" },
  { id: "freshness", label: "时效迭代", detail: "核对标准、技术环境与带日期的岗位事实" },
] as const;
export const iterationProfileOptions = [
  { id: "co_guided", label: "目标增强", detail: "围绕你的目标，兼顾关联问题和核心可用性" },
  { id: "autonomous", label: "自动发现", detail: "检查全岗位，选择值得研究的问题；目标可以留空" },
  { id: "user_directed", label: "定向研究", detail: "按目标和节点选择研究工作，协议错误仍会全局检查" },
] as const;
export type IterationDraft = { mode: Exclude<IterationMode, "auto">; initiativeProfile: InitiativeProfile; targetIds: string; targetAsOf: string };
export function defaultIterationDraft(deepening = false, selectedNodeIds: string[] = []): IterationDraft {
  return { mode: "deep_research", initiativeProfile: deepening ? "user_directed" : "co_guided", targetIds: deepening ? selectedNodeIds.join(", ") : "", targetAsOf: "" };
}
export function parseIterationTargets(value: string) { return [...new Set(value.split(/[\s,，]+/u).map((id) => id.trim()).filter(Boolean))]; }
export function iterationBriefError(input: { initiativeProfile: InitiativeProfile; prompt: string; targetIds: string[]; targetAsOf?: string }) {
  if (input.targetIds.length > 60) return "一次最多研究 60 个节点。";
  if (input.targetIds.some((id) => id.length > 220)) return "节点 ID 太长，请从当前岗位图谱选择。";
  if (input.initiativeProfile === "user_directed" && !input.prompt.trim() && !input.targetIds.length) return "定向研究需要填写目标或选择至少一个节点。";
  if (input.targetAsOf && (!/^\d{4}-\d{2}-\d{2}$/u.test(input.targetAsOf) || Number.isNaN(Date.parse(input.targetAsOf)) || new Date(input.targetAsOf).toISOString().slice(0, 10) !== input.targetAsOf)) return "目标时点必须是有效日期（年-月-日）。";
  return "";
}
export function conversationIterationRequest(input: {
  runId: string; context: WorkspaceSkillContext; draft: IterationDraft; prompt: string;
  materials: SourceInput[]; webResearch: boolean; learningPathGraph?: LearningPathGraphInput;
}) {
  const { context, draft } = input;
  if (!context.projectId || !context.conversationId || !context.snapshotId || !context.versionId) throw new Error("请等待当前对话的岗位版本加载完成。");
  const targetIds = parseIterationTargets(draft.targetIds);
  const error = iterationBriefError({ ...draft, prompt: input.prompt, targetIds });
  if (error) throw new Error(error);
  return snapshotIterationRequestSchema.parse({
    runId: input.runId, projectId: context.projectId, conversationId: context.conversationId,
    snapshotRef: { snapshotId: context.snapshotId, projectId: context.projectId, versionId: context.versionId },
    initiativeProfile: draft.initiativeProfile, mode: draft.mode, prompt: input.prompt.trim(), targetIds,
    targetAsOf: draft.targetAsOf || undefined, supplementalSources: input.materials,
    learningPathGraph: input.learningPathGraph, webResearch: input.webResearch,
    maxRounds: 4, sourceLimit: 20, maxWorkItems: 16,
  });
}

export type IterationRunBrief = Pick<SnapshotIterationRequest, "initiativeProfile" | "mode" | "prompt" | "targetIds" | "targetAsOf" | "webResearch"> & { sourceCount: number; learningPathProvided: boolean };
/** Explicit projection of the saved request; never return credentials or full source documents. */
export function iterationRunBrief(value: unknown): IterationRunBrief | undefined {
  const parsed = snapshotIterationRequestSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const request = parsed.data;
  return { initiativeProfile: request.initiativeProfile, mode: request.mode, prompt: request.prompt, targetIds: request.targetIds, targetAsOf: request.targetAsOf, webResearch: request.webResearch, sourceCount: request.supplementalSources.length, learningPathProvided: Boolean(request.learningPathGraph) };
}
