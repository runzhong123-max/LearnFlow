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
