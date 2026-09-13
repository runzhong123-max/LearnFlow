import { snapshotIterationRequestSchema } from '@/lib/iteration/types';
import { sourceInputSchema, type ColdStartBuildResult } from '@/lib/build/types';
import { mountReason, needsAutomaticResearch, type AutomaticMountResult } from './automatic-contract';
import { sha256Hex } from '@/lib/versioning/canonical';

export const automaticRepairReasons = new Set(['needs_definition', 'needs_decomposition', 'needs_evidence']);
export function repairableMount(result: AutomaticMountResult) {
  return needsAutomaticResearch(result);
}
export async function automaticRepairJobId(mountId: string) { return `learning-repair:${(await sha256Hex(mountId)).slice(0, 48)}`; }

/** Scope and budgets come from the saved production and receipt, never caller-supplied headers. */
export function automaticRepairPlan(input: {
  mountId: string; jobId: string; projectId: string; versionId: string; conversationId: string;
  result: ColdStartBuildResult; mount: AutomaticMountResult; sourcePayload: Record<string, unknown>;
}) {
  const original = (input.sourcePayload.iteration || input.sourcePayload.build || {}) as Record<string, unknown>;
  const webResearch = input.sourcePayload.webResearch === true || original.webResearch === true;
  const nodeIds = new Set(input.result.semantic.nodes.map(node => node.id));
  const feedback = input.mount.unresolved.filter(point => automaticRepairReasons.has(point.reason) && nodeIds.has(point.roleNodeId))
    .map(point => ({ roleNodeId: point.roleNodeId, reason: point.reason, researchGoal: mountReason(point.reason) }));
  const noPoints = input.mount.reason === 'no_learning_points';
  if (!feedback.length && !noPoints) return null;
  // Missing points are derived from real tasks, never an empty or fabricated learning-point ID.
  const researchIds = noPoints ? input.result.semantic.nodes.filter(node => node.type === 'task').map(node => node.id)
    : [...new Set(feedback.map(point => point.roleNodeId))];
  // Empty/large scopes use autonomous inspection; user_directed with no targets excludes inspector findings.
  const targetIds = researchIds.length <= 60 ? researchIds : [];
  const initiativeProfile = targetIds.length ? 'user_directed' : 'autonomous';
  const prompt = [
    '本轮是已授权岗位生产的学习路径挂载补研，仅接续一次。请补全真实知识点/技能点的分类、范围、可检查验收要求与直接来源证据，保留已有岗位事实及已可用节点。',
    noPoints ? '当前尚无可挂载知识技能点：从典型任务与已核验来源中提取具体知识点和可观察技能，不能把泛化能力换名充数。' : feedback.map(point => `${point.roleNodeId}：${point.researchGoal}`).join('\n'),
    '不伪造来源、引用或掌握状态。无法证实的内容保留明确缺口；不要为消除缺口而删除原节点。',
  ].join('\n').slice(0, 4000);
  // Reuse source text already in this version. This enables offline definition repair without switching on web research.
  const supplementalSources = input.result.sources.assets.filter(asset => asset.kind !== 'user_brief').flatMap(asset => {
    const content = input.result.sources.segments.filter(segment => segment.sourceId === asset.id).sort((a, b) => a.ordinal - b.ordinal).map(segment => segment.text).join('\n').slice(0, 60_000);
    const checked = sourceInputSchema.safeParse({ ...asset, content });
    return checked.success ? [checked.data] : [];
  }).slice(0, 64);
  const iteration = snapshotIterationRequestSchema.parse({
    runId: input.jobId, projectId: input.projectId, conversationId: input.conversationId,
    snapshotRef: { snapshotId: input.result.snapshot.id, packageVersion: input.result.packages.rolePackage.packageVersion, projectId: input.projectId, versionId: input.versionId },
    initiativeProfile, mode: 'deep_research', prompt, targetIds,
    targetAsOf: input.result.snapshot.asOf, webResearch, supplementalSources,
    learningPathGraph: original.learningPathGraph,
    learningMountFeedback: feedback.slice(0,40),
    maxRounds: 12, sourceLimit: 64, maxWorkItems: 32,
  });
  return { iteration };
}
