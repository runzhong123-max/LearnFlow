import { stableHash } from "@/lib/build/compiler";
import type { ColdStartBuildResult, ColdStartRequest, SourceInput, WebSearchCategory } from "@/lib/build/types";
import type { PlannedQuery } from "@/lib/search/web-research";
import type { RiskAuditReport, RiskCluster, RiskResearchPlan, RiskRunRequest } from "./types";

const CATEGORY_BY_PROFILE: Record<RiskCluster["profile"], WebSearchCategory[]> = {
  structural: ["official_standard", "job_market"],
  semantic: ["official_standard", "job_market", "education"],
  task_quality: ["work_practice", "job_market"],
  capability_skill: ["work_practice", "education", "technology"],
  evidence: ["official_standard", "work_practice", "job_market"],
  temporal: ["technology", "future_signal", "job_market"],
  process: ["work_practice", "official_standard"],
  effectiveness: ["education", "work_practice"],
};

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function nodeLabels(result: ColdStartBuildResult, ids: string[]) {
  const labels = new Map<string, string>([
    ...result.semantic.nodes.map((node) => [node.id, node.label] as const),
    ...result.semantic.edges.map((edge) => [edge.id, `${edge.source} ${edge.type} ${edge.target}`] as const),
    ...result.process.scenarios.map((scenario) => [scenario.id, scenario.label] as const),
    ...result.process.nodes.map((node) => [node.id, node.label] as const),
    ...result.process.edges.map((edge) => [edge.id, `${edge.source} ${edge.type} ${edge.target}`] as const),
  ]);
  return unique(ids.map((id) => labels.get(id) || "").filter(Boolean)).slice(0, 5);
}

function queryForCategory(input: {
  category: WebSearchCategory;
  role: string;
  market: string;
  year: number;
  cluster: RiskCluster;
  labels: string[];
  question: string;
}) {
  const focus = input.labels.join(" ") || input.cluster.title;
  const years = `${input.year - 1} ${input.year}`;
  const templates: Record<WebSearchCategory, string> = {
    official_standard: `${input.market} ${input.role} ${focus} 国家职业标准 专业教学标准 职业分类 官方`,
    job_market: `${input.market} ${input.role} ${focus} 招聘 职责 任职要求 交付物`,
    work_practice: `${input.role} ${focus} 实际工作流程 项目复盘 操作步骤 交付物`,
    technology: `${input.role} ${focus} 官方文档 最佳实践 版本变化 ${years}`,
    education: `${input.role} ${focus} 课程标准 实训项目 学习成果 评价标准`,
    future_signal: `${input.role} ${focus} 行业趋势 技能变化 AI影响 ${years}`,
    user_focus: `${input.role} ${input.question || focus} ${input.market}`,
  };
  return templates[input.category].replace(/\s+/g, " ").trim();
}

/**
 * Build a cluster-level research plan. Queries intentionally cover a risk
 * family rather than one node each, preventing duplicated retrieval work when
 * several task branches share the same knowledge or evidence gap.
 */
export function planRiskResearch(input: {
  result: ColdStartBuildResult;
  audit: RiskAuditReport;
  request: RiskRunRequest;
  iteration: number;
}): RiskResearchPlan {
  const targetSet = new Set(input.request.scope.targetIds);
  const selected = input.audit.clusters
    .filter((cluster) => cluster.repairability.includes("research"))
    .filter((cluster) => !targetSet.size || cluster.targetIds.some((id) => targetSet.has(id)))
    .slice(0, 8);
  const snapshotYear = Number((input.request.targetAsOf || input.result.snapshot.asOf).slice(0, 4));
  const year = Number.isFinite(snapshotYear) ? snapshotYear : new Date().getUTCFullYear();
  const queryMap = new Map<string, PlannedQuery>();
  for (const cluster of selected) {
    const labels = nodeLabels(input.result, cluster.targetIds);
    const categories = CATEGORY_BY_PROFILE[cluster.profile].slice(0, input.iteration > 1 ? 3 : 2);
    for (const [categoryIndex, category] of categories.entries()) {
      const query = queryForCategory({
        category,
        role: input.result.brief.roleTitle,
        market: input.result.brief.market,
        year,
        cluster,
        labels,
        question: input.request.scope.question,
      });
      const key = `${category}:${query}`;
      if (queryMap.has(key)) continue;
      queryMap.set(key, {
        id: `risk-query:${stableHash(`${input.request.runId}:${input.iteration}:${key}`)}`,
        category,
        query,
        priority: Math.max(1, 12 - categoryIndex - selected.indexOf(cluster) * 0.1),
      });
    }
  }
  if (input.request.scope.question.trim()) {
    const query = queryForCategory({
      category: "user_focus",
      role: input.result.brief.roleTitle,
      market: input.result.brief.market,
      year,
      cluster: selected[0] || input.audit.clusters[0],
      labels: [],
      question: input.request.scope.question,
    });
    queryMap.set(`user_focus:${query}`, {
      id: `risk-query:${stableHash(`${input.request.runId}:${input.iteration}:user:${query}`)}`,
      category: "user_focus",
      query,
      priority: 12,
    });
  }
  const queries = [...queryMap.values()]
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 12);
  return {
    id: `risk-plan:${stableHash(`${input.request.runId}:${input.iteration}:${queries.map((query) => query.id).join("|")}`)}`,
    iteration: input.iteration,
    clusterIds: selected.map((cluster) => cluster.id),
    queries,
    rationale: selected.map((cluster) => `${cluster.title}：${cluster.researchQuestion || cluster.summary}`),
    stopConditions: [
      "目标风险获得两个以上相互独立来源，或一个权威/一手来源的可定位支持",
      "新证据不再提高任务—过程、直接证据或有效章节覆盖率",
      "达到本轮来源上限；未消除的问题转为已知缺口，不以模型推断冒充事实",
    ],
  };
}

/** Rebuild SourceInput records from the stored evidence layer. */
export function reconstructSourceInputs(result: ColdStartBuildResult): SourceInput[] {
  const segmentsBySource = new Map<string, typeof result.sources.segments>();
  for (const segment of result.sources.segments) {
    const list = segmentsBySource.get(segment.sourceId) || [];
    list.push(segment);
    segmentsBySource.set(segment.sourceId, list);
  }
  return result.sources.assets
    .filter((asset) => asset.kind !== "user_brief")
    .map((asset) => ({
      title: asset.title,
      content: (segmentsBySource.get(asset.id) || [])
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((segment) => segment.text)
        .join("\n\n") || `来源元数据：${asset.title}`,
      kind: asset.kind,
      locator: asset.locator,
      attachmentId: asset.attachmentId,
      observedAt: asset.observedAt,
      publisher: asset.publisher,
      domain: asset.domain,
      publishedAt: asset.publishedAt,
      fetchedAt: asset.fetchedAt,
      sourceTier: asset.sourceTier,
      queryIds: asset.queryIds,
      searchCategories: asset.searchCategories,
      retrievalScore: asset.retrievalScore,
      provider: asset.provider,
      providerRequestIds: asset.providerRequestIds,
      extractionMethod: asset.extractionMethod,
      workspaceEvidence: asset.workspaceEvidence,
    }))
    .filter((source) => source.content.trim());
}

export function requestForRiskResearch(input: {
  result: ColdStartBuildResult;
  request: RiskRunRequest;
  sources: SourceInput[];
  iteration: number;
}): ColdStartRequest {
  return {
    runId: `${input.request.runId}:research:${input.iteration}`.slice(0, 100),
    projectId: input.request.projectId || input.request.snapshotRef.projectId || `snapshot:${stableHash(input.request.snapshotRef.snapshotId)}`,
    roleTitle: input.result.brief.roleTitle,
    roleDescription: [input.result.brief.roleDescription, input.request.scope.question].filter(Boolean).join("\n研究重点：").slice(0, 8_000),
    market: input.result.brief.market,
    audience: input.result.brief.audience,
    snapshotAsOf: input.request.targetAsOf || input.result.snapshot.asOf,
    sources: input.sources.slice(0, 20),
  };
}
