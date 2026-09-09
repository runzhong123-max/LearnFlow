import { stableHash } from "@/lib/build/compiler";
import type { ColdStartBuildResult, EvidenceBinding, SemanticEdge, SemanticNode } from "@/lib/build/types";
import type { RiskAuditReport, RiskCluster, RiskHealthMetrics, RiskIssue, RiskProfile, RiskRepairability, RiskSeverity } from "./types";

type AuditOptions = {
  profiles?: RiskProfile[];
  targetIds?: string[];
  now?: string;
};

const ALL_PROFILES: RiskProfile[] = [
  "structural",
  "semantic",
  "task_quality",
  "capability_skill",
  "evidence",
  "temporal",
  "process",
  "effectiveness",
];

const severityWeight: Record<RiskSeverity, number> = { info: 1, warning: 4, error: 10 };
const repairRank: Record<RiskRepairability, number> = { automatic: 0, research: 1, user: 2, organization_specific: 3, developer: 4 };

function normalize(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** Legacy missing learningKind is the same hybrid domain used by the compiler. */
export function sameSemanticMergeDimension(left: SemanticNode, right: SemanticNode) {
  return left.type === right.type && (left.type !== "knowledge_skill"
    || (left.learningKind || "hybrid") === (right.learningKind || "hybrid"));
}

function grams(value: string) {
  const normalized = normalize(value);
  if (normalized.length < 2) return new Set([normalized]);
  const result = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) result.add(normalized.slice(index, index + 2));
  return result;
}

function similarity(left: string, right: string) {
  const a = grams(left);
  const b = grams(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((item) => b.has(item)).length;
  return (2 * intersection) / (a.size + b.size);
}

function validDate(value?: string) {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function snapshotUpperBound(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return Date.parse(`${value}T23:59:59.999Z`);
  return validDate(value);
}

function sourceTemporalValue(source: ColdStartBuildResult["sources"]["assets"][number]) {
  if (source.publishedAt) return source.publishedAt;
  // Search providers use observedAt=fetchedAt when publication metadata is
  // unavailable. Retrieval time is provenance, not the document's fact time.
  if (source.kind === "public_document" && source.observedAt === source.fetchedAt) return undefined;
  return source.observedAt;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function hasCycle(edges: SemanticEdge[], allowedTypes: Set<string>) {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges.filter((item) => allowedTypes.has(item.type))) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) || []), edge.target]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) return [id];
    if (visited.has(id)) return null;
    visiting.add(id);
    for (const next of outgoing.get(id) || []) {
      const found = visit(next);
      if (found) return [id, ...found];
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const id of outgoing.keys()) {
    const found = visit(id);
    if (found) return unique(found);
  }
  return [];
}

function bindingsFor(targetIds: string[], bindings: EvidenceBinding[]) {
  const targets = new Set(targetIds);
  const selected = bindings.filter((binding) => targets.has(binding.targetId));
  return {
    bindingIds: unique(selected.map((binding) => binding.id)),
    sourceIds: unique(selected.map((binding) => binding.sourceId)),
  };
}

function issueFactory(result: ColdStartBuildResult, now: string) {
  const bindings = result.sources.evidenceBindings;
  return (input: Omit<RiskIssue, "id" | "fingerprint" | "status" | "firstSeenAt" | "lastSeenAt" | "evidenceBindingIds" | "sourceIds"> & {
    evidenceBindingIds?: string[];
    sourceIds?: string[];
  }): RiskIssue => {
    const evidence = bindingsFor(input.targetIds, bindings);
    const fingerprint = stableHash(`${input.profile}:${input.code}:${[...input.targetIds].sort().join("|")}:${normalize(input.title)}`);
    return {
      ...input,
      id: `risk:${fingerprint}`,
      fingerprint,
      evidenceBindingIds: input.evidenceBindingIds || evidence.bindingIds,
      sourceIds: input.sourceIds || evidence.sourceIds,
      status: "open",
      firstSeenAt: now,
      lastSeenAt: now,
    };
  };
}

function edgeEndpoints(result: ColdStartBuildResult) {
  const semanticIds = new Set(result.semantic.nodes.map((node) => node.id));
  const processIds = new Set([
    ...result.process.scenarios.map((scenario) => scenario.id),
    ...result.process.nodes.map((node) => node.id),
    ...result.semantic.nodes.map((node) => node.id),
  ]);
  return { semanticIds, processIds };
}

function connectionCounts(result: ColdStartBuildResult) {
  const counts = new Map<string, number>();
  for (const edge of result.semantic.edges) {
    counts.set(edge.source, (counts.get(edge.source) || 0) + 1);
    counts.set(edge.target, (counts.get(edge.target) || 0) + 1);
  }
  return counts;
}

function makeClusters(issues: RiskIssue[]): RiskCluster[] {
  const remaining = new Set(issues.map((issue) => issue.id));
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const clusters: RiskCluster[] = [];
  while (remaining.size) {
    const seedId = remaining.values().next().value as string;
    const seed = byId.get(seedId)!;
    const members: RiskIssue[] = [];
    const targetIds = new Set(seed.targetIds);
    const queue = [seed];
    remaining.delete(seed.id);
    while (queue.length) {
      const issue = queue.shift()!;
      members.push(issue);
      issue.targetIds.forEach((id) => targetIds.add(id));
      for (const candidateId of [...remaining]) {
        const candidate = byId.get(candidateId)!;
        const sharedTarget = candidate.targetIds.some((id) => targetIds.has(id));
        const sameFamily = candidate.profile === seed.profile && candidate.code.split("_")[0] === seed.code.split("_")[0];
        if (!sharedTarget && !sameFamily) continue;
        remaining.delete(candidateId);
        queue.push(candidate);
      }
    }
    const severity = members.some((issue) => issue.severity === "error") ? "error"
      : members.some((issue) => issue.severity === "warning") ? "warning" : "info";
    const repairability = unique(members.map((issue) => issue.repairability)).sort((a, b) => repairRank[a as RiskRepairability] - repairRank[b as RiskRepairability]) as RiskRepairability[];
    const title = members.length === 1 ? members[0].title : `${members[0].title}等 ${members.length} 项关联风险`;
    const id = `risk-cluster:${stableHash(members.map((issue) => issue.fingerprint).sort().join(":"))}`;
    clusters.push({
      id,
      title,
      summary: members.map((issue) => issue.detail).slice(0, 3).join("；"),
      profile: seed.profile,
      severity,
      issueIds: members.map((issue) => issue.id),
      targetIds: [...targetIds],
      repairability,
      researchQuestion: repairability.includes("research")
        ? `需要补充哪些独立、可定位且时点适用的证据，才能解决“${title}”？`
        : undefined,
      priority: severityWeight[severity] * 10 + members.length * 2 + (repairability.includes("automatic") ? 1 : 0),
    });
  }
  return clusters.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
}

function calculateMetrics(result: ColdStartBuildResult, issues: RiskIssue[]): RiskHealthMetrics {
  const targets = [
    ...result.semantic.nodes,
    ...result.semantic.edges,
    ...result.process.scenarios,
    ...result.process.nodes,
    ...result.process.edges,
  ];
  const boundIds = new Set(result.sources.evidenceBindings.map((binding) => binding.targetId));
  const directIds = new Set(result.sources.evidenceBindings.filter((binding) => binding.support === "direct").map((binding) => binding.targetId));
  const tasks = result.semantic.nodes.filter((node) => node.type === "task");
  const aligned = new Set(result.process.bridges.filter((bridge) => bridge.type === "realizes_task").map((bridge) => bridge.semanticNodeId));
  const domains = new Set(result.sources.assets.map((source) => source.domain || (source.locator ? (() => { try { return new URL(source.locator).hostname; } catch { return ""; } })() : "")).filter(Boolean));
  const inferred = result.process.scenarios.filter((scenario) => scenario.knowledgeState === "inferred_pattern").length;
  const effectiveSections = result.snapshot.sections.filter((section) => section.itemIds.length > 0 && section.summary.trim().length >= 24).length;
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  const issueWeight = issues.reduce((sum, issue) => sum + severityWeight[issue.severity], 0);
  const evidenceCoverage = targets.length ? targets.filter((target) => boundIds.has(target.id)).length / targets.length : 0;
  const directEvidenceCoverage = targets.length ? targets.filter((target) => directIds.has(target.id)).length / targets.length : 0;
  const processCoverage = tasks.length ? tasks.filter((task) => aligned.has(task.id)).length / tasks.length : 0;
  const effectivenessCoverage = result.snapshot.sections.length ? effectiveSections / result.snapshot.sections.length : 0;
  const score = Math.max(0, Math.min(100,
    28 * evidenceCoverage
    + 17 * directEvidenceCoverage
    + 20 * processCoverage
    + 10 * Math.min(domains.size / 6, 1)
    + 15 * effectivenessCoverage
    + 10 * (1 - Math.min(issueWeight / 60, 1)),
  ));
  return {
    score: Number(score.toFixed(1)),
    issueWeight,
    errors,
    warnings,
    evidenceCoverage: Number(evidenceCoverage.toFixed(4)),
    directEvidenceCoverage: Number(directEvidenceCoverage.toFixed(4)),
    processCoverage: Number(processCoverage.toFixed(4)),
    sourceDomainDiversity: domains.size,
    semanticOverlapClusters: issues.filter((issue) => issue.code === "SEMANTIC_OVERLAP" || issue.code === "EXACT_DUPLICATE").length,
    unsupportedTargets: targets.filter((target) => !boundIds.has(target.id)).length,
    inferredProcessRatio: result.process.scenarios.length ? Number((inferred / result.process.scenarios.length).toFixed(4)) : 0,
    effectivenessCoverage: Number(effectivenessCoverage.toFixed(4)),
  };
}

// Saved diagnostics are a projection, not evidence that a defect still exists.
// These checks below are re-evaluated against the current graph every time.
const RECOMPUTED_CODES = new Set([
  "MISSING_ROLE_ROOT", "MISSING_TASK_LAYER", "DANGLING_SEMANTIC_EDGE", "DANGLING_PROCESS_EDGE",
  "ILLEGAL_CYCLE", "ORPHAN_CORE_NODE", "EXACT_DUPLICATE", "SEMANTIC_OVERLAP",
  "TASK_NOT_DELIVERABLE", "TASK_PROCESS_GAP", "CAPABILITY_DIMENSION_POLLUTION", "SKILL_NOT_LEARNABLE",
  "UNSUPPORTED_TARGET", "NO_PUBLIC_EVIDENCE", "NO_HIGH_AUTHORITY_SOURCE", "RESEARCH_CATEGORY_GAPS",
  "LOW_DIRECT_EVIDENCE", "SOURCE_CONCENTRATION", "INVALID_SNAPSHOT_TIME", "FUTURE_SOURCE",
  "STALE_TECHNOLOGY_SOURCE", "NO_PROCESS_SCENARIOS", "SCENARIO_WITHOUT_EVENT", "SCENARIO_WITHOUT_ARTIFACT",
  "INFERRED_PROCESS_ONLY", "THIN_NODE_SUMMARY", "MISSING_SNAPSHOT_SECTION", "NO_TASKS", "UNSUPPORTED_TARGETS",
]);

export function auditRoleSnapshot(result: ColdStartBuildResult, options: AuditOptions = {}): RiskAuditReport {
  const now = options.now || new Date().toISOString();
  const make = issueFactory(result, now);
  const issues: RiskIssue[] = [];
  const add = (issue: ReturnType<typeof make>) => issues.push(issue);
  const { semanticIds, processIds } = edgeEndpoints(result);
  const connections = connectionCounts(result);
  const role = result.semantic.nodes.find((node) => node.type === "market_role");
  const tasks = result.semantic.nodes.filter((node) => node.type === "task");

  if (!role) add(make({ profile: "structural", severity: "error", code: "MISSING_ROLE_ROOT", title: "缺少岗位根节点", detail: "语义图谱没有唯一岗位根节点。", impact: "所有岗位投影和关系导航失去稳定入口。", confidence: 1, targetIds: [], repairability: "developer" }));
  if (tasks.length === 0) add(make({ profile: "structural", severity: "error", code: "MISSING_TASK_LAYER", title: "缺少典型工作任务层", detail: "岗位快照没有形成可验收的典型任务。", impact: "能力、知识技能和事理过程无法获得可靠锚点。", confidence: 1, targetIds: role ? [role.id] : [], repairability: "research" }));
  for (const edge of result.semantic.edges.filter((item) => !semanticIds.has(item.source) || !semanticIds.has(item.target))) {
    add(make({ profile: "structural", severity: "error", code: "DANGLING_SEMANTIC_EDGE", title: "语义关系存在缺失端点", detail: `${edge.id} 指向不存在的节点。`, impact: "图查询和节点引用可能失败。", confidence: 1, targetIds: [edge.id, edge.source, edge.target], repairability: "automatic" }));
  }
  for (const edge of result.process.edges.filter((item) => !processIds.has(item.source) || !processIds.has(item.target))) {
    add(make({ profile: "structural", severity: "error", code: "DANGLING_PROCESS_EDGE", title: "事理关系存在缺失端点", detail: `${edge.id} 指向不存在的事件或对象。`, impact: "事理链无法可靠遍历。", confidence: 1, targetIds: [edge.id, edge.source, edge.target], repairability: "automatic" }));
  }
  const cycle = hasCycle(result.semantic.edges, new Set(["prerequisite_of", "has_unit"]));
  if (cycle.length) add(make({ profile: "structural", severity: "error", code: "ILLEGAL_CYCLE", title: "层级或前置关系形成环", detail: `检测到循环路径：${cycle.join(" → ")}`, impact: "学习路径或能力层级无法排序。", confidence: 1, targetIds: cycle, repairability: "automatic" }));
  for (const node of result.semantic.nodes.filter((item) => item.type !== "market_role" && (connections.get(item.id) || 0) === 0)) {
    add(make({ profile: "structural", severity: "warning", code: "ORPHAN_CORE_NODE", title: `核心节点没有关系：${node.label}`, detail: "节点存在但没有进入岗位结构。", impact: "可视化出现无上下文信息，Agent 难以解释其作用。", confidence: 1, targetIds: [node.id], repairability: "research" }));
  }

  const byType = new Map<string, SemanticNode[]>();
  for (const node of result.semantic.nodes) byType.set(node.type, [...(byType.get(node.type) || []), node]);
  for (const nodes of byType.values()) {
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const left = nodes[leftIndex];
        const right = nodes[rightIndex];
        if (!sameSemanticMergeDimension(left, right)) continue;
        const exact = normalize(left.label) === normalize(right.label) || left.aliases.some((alias) => normalize(alias) === normalize(right.label)) || right.aliases.some((alias) => normalize(alias) === normalize(left.label));
        const score = exact ? 1 : similarity(left.label, right.label);
        if (score < 0.72) continue;
        add(make({
          profile: "semantic",
          severity: exact ? "error" : "warning",
          code: exact ? "EXACT_DUPLICATE" : "SEMANTIC_OVERLAP",
          title: exact ? `同维度重复节点：${left.label}` : `同维度节点语义接近：${left.label} / ${right.label}`,
          detail: `两个 ${left.type} 节点的标签相似度为 ${score.toFixed(2)}，需要判断合并、拆分或明确边界。`,
          impact: "重复概念会降低检索精度并制造伪造的课程或任务区分。",
          confidence: Number(score.toFixed(2)),
          targetIds: [left.id, right.id],
          repairability: exact ? "automatic" : "research",
        }));
      }
    }
  }

  const genericLabels = /^(性能分析|需求分析|问题处理|系统优化|工作流编排|质量检查|项目管理|技术支持|沟通协作)$/u;
  for (const task of tasks) {
    if (genericLabels.test(task.label) || task.label.length < 4) add(make({ profile: "task_quality", severity: "warning", code: "TASK_NOT_DELIVERABLE", title: `任务难以独立验收：${task.label}`, detail: "标签没有说明工作对象、动作或可验收结果。", impact: "无法直接转成教学项目、实训任务或岗位评价。", confidence: 0.82, targetIds: [task.id], repairability: "research" }));
    if (!result.process.bridges.some((bridge) => bridge.type === "realizes_task" && bridge.semanticNodeId === task.id)) add(make({ profile: "process", severity: "warning", code: "TASK_PROCESS_GAP", title: `任务缺少工作场景：${task.label}`, detail: "没有事理场景或事件链说明任务如何发生。", impact: "岗位图谱无法解释真实工作的触发、步骤、交付与异常。", confidence: 1, targetIds: [task.id], repairability: "research" }));
  }
  for (const capability of result.semantic.nodes.filter((node) => node.type === "capability" || node.type === "capability_unit")) {
    if (/(Python|Java|LangGraph|MCP|数据库|框架|协议|工具|平台)$/iu.test(capability.label)) add(make({ profile: "capability_skill", severity: "warning", code: "CAPABILITY_DIMENSION_POLLUTION", title: `能力节点可能是工具或知识技能：${capability.label}`, detail: "能力应描述跨情境的稳定表现，不应直接等同于工具、框架或协议。", impact: "能力层与知识技能层发生维度污染。", confidence: 0.8, targetIds: [capability.id], repairability: "research" }));
  }
  for (const skill of result.semantic.nodes.filter((node) => node.type === "knowledge_skill")) {
    if (genericLabels.test(skill.label) || skill.label.length < 3) add(make({ profile: "capability_skill", severity: "warning", code: "SKILL_NOT_LEARNABLE", title: `知识技能缺少可学习入口：${skill.label}`, detail: "该名称不足以说明可以学习、实践或测评的具体对象。", impact: "学生无法据此形成学习活动，教师无法建立考核点。", confidence: 0.8, targetIds: [skill.id], repairability: "research" }));
  }

  const evidenceTargets = [...result.semantic.nodes, ...result.semantic.edges, ...result.process.scenarios, ...result.process.nodes, ...result.process.edges];
  const bound = new Set(result.sources.evidenceBindings.map((binding) => binding.targetId));
  for (const target of evidenceTargets.filter((item) => !bound.has(item.id))) add(make({ profile: "evidence", severity: "error", code: "UNSUPPORTED_TARGET", title: `对象缺少证据绑定：${"label" in target ? target.label : target.id}`, detail: "没有有效 segment 级证据支持该对象或关系。", impact: "内容只能作为研究候选，不能进入已接受事实层。", confidence: 1, targetIds: [target.id], repairability: "research" }));
  const publicSources = result.sources.assets.filter((source) => source.kind === "public_document");
  if (!publicSources.length) add(make({ profile: "evidence", severity: "error", code: "NO_PUBLIC_EVIDENCE", title: "缺少独立公开证据", detail: "当前岗位认识仅来自用户简报或私域材料。", impact: "无法区分岗位共性与组织特例。", confidence: 1, targetIds: role ? [role.id] : [], repairability: "research" }));
  if (publicSources.length && !publicSources.some((source) => source.sourceTier === "authoritative" || source.sourceTier === "primary")) {
    add(make({ profile: "evidence", severity: "warning", code: "NO_HIGH_AUTHORITY_SOURCE", title: "缺少权威或一手来源", detail: "当前公开资料全部属于二手或情境性来源，应补充职业标准、雇主原始岗位信息或官方技术文档。", impact: "来源数量较多也可能只是重复传播，不能支撑稳定岗位边界。", confidence: 0.95, targetIds: role ? [role.id] : [], repairability: "research" }));
  }
  const missingResearchCategories = result.sources.research?.categoryCoverage.filter((coverage) => coverage.status !== "covered") || [];
  if (missingResearchCategories.length) {
    add(make({ profile: "evidence", severity: "warning", code: "RESEARCH_CATEGORY_GAPS", title: "联网研究存在证据类别缺口", detail: `未覆盖：${missingResearchCategories.map((coverage) => coverage.category).join("、")}。`, impact: "岗位标准、市场职责、真实实践、技术或趋势中的至少一个观察面缺失。", confidence: 1, targetIds: role ? [role.id] : [], repairability: "research" }));
  }
  const directTargets = new Set(result.sources.evidenceBindings.filter((binding) => binding.support === "direct").map((binding) => binding.targetId));
  const directCoverage = evidenceTargets.length ? evidenceTargets.filter((target) => directTargets.has(target.id)).length / evidenceTargets.length : 0;
  if (evidenceTargets.length && directCoverage < 0.25) {
    add(make({ profile: "evidence", severity: "warning", code: "LOW_DIRECT_EVIDENCE", title: "直接证据覆盖不足", detail: `只有 ${(directCoverage * 100).toFixed(0)}% 的对象或关系能在来源文本中直接定位，其余主要是模型推断绑定。`, impact: "表面上的绑定数量会高估事实可靠性，Agent 回答仍需要明确区分事实与推断。", confidence: 1, targetIds: role ? [role.id] : [], repairability: "research" }));
  }
  const sourceCounts = new Map<string, number>();
  for (const binding of result.sources.evidenceBindings) sourceCounts.set(binding.sourceId, (sourceCounts.get(binding.sourceId) || 0) + 1);
  const totalBindings = result.sources.evidenceBindings.length;
  const dominant = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (dominant && totalBindings >= 5 && dominant[1] / totalBindings > 0.65) add(make({ profile: "evidence", severity: "warning", code: "SOURCE_CONCENTRATION", title: "证据过度集中于单一来源", detail: `来源 ${dominant[0]} 承担 ${(dominant[1] / totalBindings * 100).toFixed(0)}% 的绑定。`, impact: "来源偏差可能被误认为岗位共性。", confidence: 0.95, targetIds: role ? [role.id] : [], sourceIds: [dominant[0]], repairability: "research" }));

  const asOf = snapshotUpperBound(result.snapshot.asOf);
  if (!asOf) add(make({ profile: "temporal", severity: "error", code: "INVALID_SNAPSHOT_TIME", title: "快照时间无效", detail: "snapshot.asOf 不能解析为稳定时间点。", impact: "任何时效判断和版本比较都不可靠。", confidence: 1, targetIds: role ? [role.id] : [], repairability: "developer" }));
  if (asOf) {
    for (const source of result.sources.assets) {
      const sourceTime = sourceTemporalValue(source);
      const published = validDate(sourceTime);
      if (published && published > asOf) add(make({ profile: "temporal", severity: "error", code: "FUTURE_SOURCE", title: `来源晚于快照：${source.title}`, detail: `${source.publishedAt || source.observedAt} 晚于 ${result.snapshot.asOf}。`, impact: "未来信息会污染历史时间点快照。", confidence: 1, targetIds: [], sourceIds: [source.id], repairability: "automatic" }));
      const technologySource = source.searchCategories?.includes("technology") || source.searchCategories?.includes("future_signal");
      if (technologySource && published && asOf - published > 548 * 24 * 60 * 60 * 1000) add(make({ profile: "temporal", severity: "warning", code: "STALE_TECHNOLOGY_SOURCE", title: `技术来源可能过时：${source.title}`, detail: "技术或未来信号来源距快照时点已超过十八个月。", impact: "工具链、协议和市场趋势判断可能失真。", confidence: 0.85, targetIds: role ? [role.id] : [], sourceIds: [source.id], repairability: "research" }));
    }
  }

  if (!result.process.scenarios.length) add(make({ profile: "process", severity: "error", code: "NO_PROCESS_SCENARIOS", title: "缺少事理场景", detail: "岗位任务没有工作事件、参与者和交付物流。", impact: "无法说明岗位工作如何在真实情境中发生。", confidence: 1, targetIds: tasks.map((task) => task.id), repairability: "research" }));
  for (const scenario of result.process.scenarios) {
    const nodes = result.process.nodes.filter((node) => node.scenarioId === scenario.id);
    if (!nodes.some((node) => node.kind === "event")) add(make({ profile: "process", severity: "error", code: "SCENARIO_WITHOUT_EVENT", title: `场景没有工作事件：${scenario.label}`, detail: "场景只有说明，没有可追踪的行动。", impact: "事理森林无法展示过程。", confidence: 1, targetIds: [scenario.id], repairability: "research" }));
    if (!nodes.some((node) => node.kind === "artifact")) add(make({ profile: "process", severity: "warning", code: "SCENARIO_WITHOUT_ARTIFACT", title: `场景缺少交付物：${scenario.label}`, detail: "事件链没有形成可验收产物。", impact: "任务完成标准和教学评价缺少抓手。", confidence: 0.9, targetIds: [scenario.id], repairability: "research" }));
  }
  if (result.process.scenarios.length && result.process.scenarios.every((scenario) => scenario.knowledgeState === "inferred_pattern")) add(make({ profile: "process", severity: "warning", code: "INFERRED_PROCESS_ONLY", title: "事理森林全部来自推断", detail: "当前没有规范材料或真实工作事件支撑过程模式。", impact: "不能把推断流程解释为行业真实工作记录。", confidence: 1, targetIds: result.process.scenarios.map((scenario) => scenario.id), repairability: "user" }));

  for (const node of result.semantic.nodes.filter((item) => item.summary.trim().length < 16)) add(make({ profile: "effectiveness", severity: "warning", code: "THIN_NODE_SUMMARY", title: `节点简介信息不足：${node.label}`, detail: "简介没有充分概括核心需求、边界或可行动信息。", impact: "节点卡片和 Agent 引用后的理解价值偏低。", confidence: 0.9, targetIds: [node.id], repairability: "research" }));
  const requiredSections = ["overview", "tasks", "capabilities", "knowledge-skills", "work-process", "evidence-risks"];
  for (const sectionId of requiredSections.filter((id) => !result.snapshot.sections.some((section) => section.id === id))) add(make({ profile: "effectiveness", severity: "error", code: "MISSING_SNAPSHOT_SECTION", title: `岗位快照缺少章节：${sectionId}`, detail: "岗位包没有提供必需的信息投影。", impact: "Agent 无法高效组装完整岗位上下文。", confidence: 1, targetIds: role ? [role.id] : [], repairability: "developer" }));

  for (const legacy of result.audit.issues) {
    if (RECOMPUTED_CODES.has(legacy.code)) continue;
    if (legacy.code === "NO_EXTERNAL_EVIDENCE" && result.sources.assets.some(s => s.kind !== "user_brief")) continue;
    if (legacy.code === "NO_OBSERVED_EPISODE" && result.sources.assets.some(s => s.kind === "workspace_observation")) continue;
    if (issues.some((issue) => issue.code === legacy.code && issue.targetIds.join("|") === legacy.targetIds.join("|"))) continue;
    add(make({
      profile: legacy.code.includes("TASK_PROCESS") ? "process" : legacy.code.includes("EVIDENCE") || legacy.code.includes("UNSUPPORTED") ? "evidence" : "structural",
      severity: legacy.severity,
      code: legacy.code,
      title: legacy.title,
      detail: legacy.detail,
      impact: "该问题来自岗位包编译期审计。",
      confidence: 1,
      targetIds: legacy.targetIds,
      repairability: legacy.repair === "organization_specific" ? "organization_specific" : legacy.repair,
    }));
  }

  const profileSet = new Set(options.profiles?.length ? options.profiles : ALL_PROFILES);
  const targetSet = new Set(options.targetIds || []);
  const selected = issues.filter((issue) => profileSet.has(issue.profile) && (!targetSet.size || issue.targetIds.length === 0 || issue.targetIds.some((id) => targetSet.has(id))));
  const deduplicated = [...new Map(selected.map((issue) => [issue.fingerprint, issue])).values()]
    .sort((left, right) => severityWeight[right.severity] - severityWeight[left.severity] || left.id.localeCompare(right.id));
  const clusters = makeClusters(deduplicated);
  return {
    snapshotId: result.snapshot.id,
    snapshotAsOf: result.snapshot.asOf,
    generatedAt: now,
    profiles: [...profileSet],
    issues: deduplicated,
    clusters,
    metrics: calculateMetrics(result, deduplicated),
  };
}

export function isAuditImproved(before: RiskAuditReport, after: RiskAuditReport) {
  const blockerImproved = after.metrics.errors < before.metrics.errors;
  const scoreImproved = after.metrics.score >= before.metrics.score + 0.5;
  const noBlockerRegression = after.metrics.errors <= before.metrics.errors;
  const noWeightRegression = after.metrics.issueWeight <= before.metrics.issueWeight + 2;
  return noBlockerRegression && noWeightRegression && (blockerImproved || scoreImproved || after.issues.length < before.issues.length);
}
