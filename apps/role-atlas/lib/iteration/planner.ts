import { stableHash } from "@/lib/build/compiler";
import { iterationTargetNodes } from "./targets";
import { learningRegressionReasons, sourceFingerprints } from "./preserve-graph";
import type { ColdStartBuildResult, WebSearchCategory } from "@/lib/build/types";
import type { PlannedQuery } from "@/lib/search/web-research";
import type {
  InitiativeProfile,
  IterationContract,
  IterationEvaluation,
  IterationFinding,
  IterationIntent,
  IterationOpportunity,
  IterationResearchPlan,
  IterationWorkItem,
  SnapshotInspection,
  SnapshotIterationRequest,
} from "./types";

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function includesAny(value: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(value));
}

function intentsFromRequest(request: SnapshotIterationRequest): IterationIntent[] {
  if (request.mode === "freshness") return ["refresh", "verify"];
  if (request.mode === "deep_research") return ["expand", "verify"];
  if (request.mode === "risk_repair") return ["repair", "verify"];
  const text = request.prompt.trim();
  const intents: IterationIntent[] = ["verify"];
  if (request.initiativeProfile !== "user_directed" || !text) intents.push("repair", "expand");
  if (includesAny(text, [/修复|重复|错误|风险|冲突|不准|过时/u])) intents.push("repair");
  if (includesAny(text, [/深入|研究|扩展|补充|了解|学习|职责|任务|技能/u])) intents.push("expand");
  if (request.targetAsOf || includesAny(text, [/最新|现在|近期|变化|趋势|更新时点/u])) intents.push("refresh");
  if (request.supplementalSources.some((source) => source.kind === "workspace_observation" || source.kind === "private_document")) intents.push("instantiate");
  return unique(intents);
}

export function createIterationContract(request: SnapshotIterationRequest, result: ColdStartBuildResult): IterationContract {
  const profile = request.initiativeProfile;
  const mode = request.mode || "auto";
  const prompt = request.prompt.trim();
  const targetNodes = new Map(iterationTargetNodes(result).map((node) => [node.id, node.label]));
  const selectedLabels = request.targetIds.map((id) => targetNodes.get(id) || id);
  const targetAsOf = request.targetAsOf || (mode === "freshness" ? new Date().toISOString().slice(0, 10) : result.snapshot.asOf);
  const objective = profile === "autonomous"
    ? `自动发现并迭代“${result.brief.roleTitle}”快照中价值最高的结构、证据、时效、事理与 Agent 可用性问题。`
    : prompt || (selectedLabels.length
      ? `围绕“${selectedLabels.join("、")}”补充证据、任务关系与能力结构。`
      : `围绕当前岗位重点，自动发现关联问题并提升“${result.brief.roleTitle}”快照。`);
  const graphRadius = profile === "autonomous" ? "global" as const : profile === "co_guided" ? 2 : 1;
  return {
    id: `iteration-contract:${stableHash(`${request.runId}:${profile}:${objective}`)}`,
    initiativeProfile: profile,
    mode,
    objective,
    targetIds: unique(request.targetIds),
    targetAsOf,
    changeIntents: intentsFromRequest(request),
    evidencePolicy: [
      "事实性新增优先使用可定位的一手、权威或相互独立来源",
      "来源级元数据不能冒充 segment 级直接证据",
      "真实工作区只证明组织实例，不自动上升为岗位共性",
      "推断内容进入研究前沿，不渲染为已接受事实",
    ],
    budgets: {
      maxRounds: request.maxRounds,
      maxSources: request.sourceLimit,
      maxWorkItems: request.maxWorkItems,
      graphRadius,
    },
    acceptancePolicy: [
      "协议不变量必须保持有效；失败候选保留诊断但不覆盖当前快照",
      "已接受核心不得产生新的结构错误或显著证据回退",
      "允许有明确认识状态和证据边界的研究前沿增长",
      "本轮必须产生风险降低、信息增量或用户目标满足中的至少一项",
    ],
    stopConditions: [
      "达到来源、任务或轮次预算",
      "新增研究不再提高目标覆盖、证据或问题解决程度",
      "剩余问题依赖用户判断、组织资料或真实工作区",
      "继续变化会造成已接受核心回退",
    ],
    inferredFrom: [
      `发起方式：${profile}`,
      `功能类型：${mode === "freshness" ? "时效迭代" : mode === "deep_research" ? "深度研究" : mode === "risk_repair" ? "风险修复" : "自动判定"}`,
      prompt ? `用户目标：${prompt}` : "用户未限定主题",
      request.targetIds.length ? `选中对象：${request.targetIds.join("、")}` : "未选中具体对象",
      request.supplementalSources.length ? `附加资料：${request.supplementalSources.length} 项` : "无附加资料",
    ],
  };
}

function findingIntent(finding: IterationFinding): IterationIntent {
  if (finding.layer === "temporal") return "refresh";
  if (finding.suggestedAction === "automatic" || finding.classification === "invariant") return "repair";
  if (finding.layer === "evidence") return "verify";
  return "expand";
}

function findingValue(finding: IterationFinding) {
  const severity = { error: 40, warning: 24, info: 10 }[finding.severity];
  const classification = { invariant: 20, core_usability: 14, research: 8 }[finding.classification];
  const unlock = finding.layer === "protocol" ? 18 : finding.layer === "process" || finding.layer === "coverage" ? 10 : 4;
  return Math.min(100, severity + classification + unlock + finding.confidence * 12);
}

function isFindingInScope(
  finding: IterationFinding,
  profile: InitiativeProfile,
  targetIds: Set<string>,
) {
  if (finding.hardBlocker) return true;
  if (profile === "autonomous") return true;
  if (targetIds.size === 0) return profile !== "user_directed";
  const targeted = finding.targetIds.some((id) => targetIds.has(id));
  if (profile === "user_directed") return targeted;
  return targeted || finding.severity === "error" || finding.classification === "core_usability";
}

export function discoverIterationOpportunities(input: {
  request: SnapshotIterationRequest;
  contract: IterationContract;
  inspection: SnapshotInspection;
}): IterationOpportunity[] {
  const targetIds = new Set(input.contract.targetIds);
  const opportunities: IterationOpportunity[] = [];
  if (input.request.prompt.trim() || input.contract.targetIds.length) {
    opportunities.push({
      id: `opportunity:${stableHash(`${input.request.runId}:user:${input.request.prompt}:${input.contract.targetIds.join("|")}`)}`,
      origin: "user",
      title: input.request.prompt.trim() ? "完成用户明确提出的研究目标" : "研究选中节点及其必要关联",
      detail: input.request.prompt.trim() || input.contract.objective,
      targetIds: input.contract.targetIds,
      findingIds: [],
      intents: input.contract.changeIntents,
      expectedValue: 100,
      requiresResearch: input.request.webResearch,
    });
  }
  if (input.contract.mode === "freshness" || input.request.targetAsOf) {
    opportunities.push({
      id: `opportunity:${stableHash(`${input.request.runId}:time:${input.contract.targetAsOf}`)}`,
      origin: "time_clock",
      title: `核验截至 ${input.contract.targetAsOf} 的岗位事实`,
      detail: `围绕目标时点 ${input.contract.targetAsOf} 核对标准、技术与岗位要求；日期本身不作为证据增量。`,
      targetIds: input.contract.targetIds,
      findingIds: [],
      intents: ["refresh", "verify"],
      expectedValue: 95,
      requiresResearch: input.request.webResearch,
    });
  }
  const selectedFindings = input.inspection.findings
    .filter((finding) => isFindingInScope(finding, input.contract.initiativeProfile, targetIds))
    .filter((finding) => finding.hardBlocker || input.contract.changeIntents.includes(findingIntent(finding)))
    .sort((left, right) => findingValue(right) - findingValue(left));
  const groups = new Map<string, IterationFinding[]>();
  for (const finding of selectedFindings) {
    const intent = findingIntent(finding);
    const key = `${intent}:${finding.layer}:${finding.classification}`;
    groups.set(key, [...(groups.get(key) || []), finding]);
  }
  for (const [key, findings] of groups) {
    const intent = key.split(":")[0] as IterationIntent;
    opportunities.push({
      id: `opportunity:${stableHash(`${input.request.runId}:${key}:${findings.map((finding) => finding.id).join("|")}`)}`,
      origin: findings[0].layer === "temporal" ? "time_clock" : "inspector",
      title: findings.length === 1 ? findings[0].title : `${findings[0].title}等 ${findings.length} 项关联发现`,
      detail: findings.slice(0, 3).map((finding) => finding.detail).join("；"),
      targetIds: unique(findings.flatMap((finding) => finding.targetIds)),
      findingIds: findings.map((finding) => finding.id),
      intents: [intent],
      expectedValue: Math.max(...findings.map(findingValue)),
      requiresResearch: findings.some((finding) => finding.suggestedAction === "research") || intent === "expand" || intent === "refresh",
    });
  }
  if (input.request.supplementalSources.length) {
    opportunities.push({
      id: `opportunity:${stableHash(`${input.request.runId}:workspace:${input.request.supplementalSources.length}`)}`,
      origin: "workspace",
      title: "蒸馏本轮附加资料与工作区观察",
      detail: `将 ${input.request.supplementalSources.length} 项资料区分为岗位共性、组织实例和待验证线索。`,
      targetIds: input.contract.targetIds,
      findingIds: [],
      intents: ["instantiate", "verify"],
      expectedValue: 92,
      requiresResearch: false,
    });
  }
  return opportunities
    .sort((left, right) => right.expectedValue - left.expectedValue || left.id.localeCompare(right.id))
    .slice(0, input.contract.budgets.maxWorkItems);
}

export function planIterationWork(input: {
  runId: string;
  opportunities: IterationOpportunity[];
  contract: IterationContract;
}): IterationWorkItem[] {
  const protocolItems = input.opportunities.filter((opportunity) => opportunity.intents.includes("repair") && opportunity.expectedValue >= 70);
  return input.opportunities.map((opportunity, index) => {
    const kind = opportunity.intents.find((intent) => input.contract.changeIntents.includes(intent))
      || opportunity.intents[0]
      || "verify";
    const dependencies = kind === "repair" ? [] : protocolItems
      .filter((item) => item.id !== opportunity.id)
      .map((item) => `work:${stableHash(`${input.runId}:${item.id}`)}`);
    return {
      id: `work:${stableHash(`${input.runId}:${opportunity.id}`)}`,
      kind,
      origin: opportunity.origin,
      title: opportunity.title,
      detail: opportunity.detail,
      targetIds: opportunity.targetIds,
      findingIds: opportunity.findingIds,
      priority: Math.max(1, Math.round(opportunity.expectedValue - index * 1.5)),
      requiresResearch: opportunity.requiresResearch,
      dependencies,
      status: "planned",
    };
  });
}

function categoryForWorkItem(item: IterationWorkItem): WebSearchCategory[] {
  if (item.kind === "refresh") return ["technology", "future_signal"];
  if (item.kind === "instantiate") return ["work_practice"];
  if (item.kind === "expand") return ["work_practice", "education"];
  if (item.kind === "repair") return ["official_standard", "job_market"];
  return ["official_standard", "work_practice"];
}

function queryText(input: { category: WebSearchCategory; role: string; market: string; asOf: string; item: IterationWorkItem; targetLabels: string[]; prompt: string }) {
  const focus = input.targetLabels.length ? `${input.item.title} ${input.targetLabels.slice(0, 3).join(" ")}` : input.item.title;
  const templates: Record<WebSearchCategory, string> = {
    official_standard: `${input.market} ${input.role} ${focus} 职业标准 专业标准 官方`,
    job_market: `${input.market} ${input.role} ${focus} 招聘 职责 任职要求 交付物`,
    work_practice: `${input.role} ${focus} 实际工作流程 项目复盘 操作步骤 交付物`,
    technology: `${input.role} ${focus} 官方文档 最佳实践 版本变化 截至 ${input.asOf}`,
    education: `${input.role} ${focus} 实训项目 学习成果 评价标准`,
    future_signal: `${input.role} ${focus} 行业趋势 技能变化 AI影响 截至 ${input.asOf}`,
    user_focus: `${input.role} ${input.prompt || focus} ${input.market}`,
  };
  return templates[input.category].replace(/\s+/gu, " ").trim();
}

export function planIterationResearch(input: {
  runId: string;
  round: number;
  result: ColdStartBuildResult;
  request: SnapshotIterationRequest;
  contract: IterationContract;
  workItems: IterationWorkItem[];
}): IterationResearchPlan {
  const queries = new Map<string, PlannedQuery>();
  const nodeLabels = new Map(iterationTargetNodes(input.result).map((node) => [node.id, node.label]));
  const labelsFor = (item: IterationWorkItem) => item.targetIds.map((id) => nodeLabels.get(id) || id);
  const researchItems = input.workItems.filter((item) => item.requiresResearch).slice(0, 8);
  for (const item of researchItems) {
    const categories = categoryForWorkItem(item).slice(0, input.round > 1 ? 2 : 1);
    for (const category of categories) {
      const query = queryText({
        category,
        role: input.result.brief.roleTitle,
        market: input.result.brief.market,
        asOf: input.contract.targetAsOf,
        item,
        targetLabels: labelsFor(item),
        prompt: input.request.prompt || input.contract.objective,
      });
      const key = `${category}:${query}`;
      queries.set(key, {
        id: `iteration-query:${stableHash(`${input.runId}:${input.round}:${key}`)}`,
        category,
        query,
        priority: item.priority,
      });
    }
  }
  if (input.request.prompt.trim() || input.contract.targetIds.length) {
    const focusItem = input.workItems.find((item) => item.origin === "user") || input.workItems[0];
    if (focusItem) {
      const category: WebSearchCategory = "user_focus";
      const query = queryText({
        category,
        role: input.result.brief.roleTitle,
        market: input.result.brief.market,
        asOf: input.contract.targetAsOf,
        item: focusItem,
        targetLabels: labelsFor(focusItem),
        prompt: input.request.prompt || input.contract.objective,
      });
      queries.set(`${category}:${query}`, {
        id: `iteration-query:${stableHash(`${input.runId}:${input.round}:user:${query}`)}`,
        category,
        query,
        priority: 100,
      });
    }
  }
  return {
    id: `iteration-plan:${stableHash(`${input.runId}:${input.round}:${[...queries.keys()].join("|")}`)}`,
    round: input.round,
    workItemIds: researchItems.map((item) => item.id),
    queries: [...queries.values()].sort((left, right) => right.priority - left.priority).slice(0, 12),
    rationale: researchItems.map((item) => `${item.title}：${item.detail}`),
    stopConditions: input.contract.stopConditions,
  };
}

export function evaluateIteration(input: {
  base: ColdStartBuildResult;
  candidate: ColdStartBuildResult;
  before: SnapshotInspection;
  after: SnapshotInspection;
  contract: IterationContract;
  migrations?: Record<string, string>;
}): IterationEvaluation {
  const originalSources = new Set(sourceFingerprints(input.base).values());
  const candidateSources = sourceFingerprints(input.candidate);
  const newSources = new Set(input.candidate.sources.assets.filter(s => s.kind !== "user_brief" && !originalSources.has(candidateSources.get(s.id)!)).map(s => candidateSources.get(s.id)!)).size;
  const newSemanticNodes = Math.max(0, input.candidate.semantic.nodes.length - input.base.semantic.nodes.length);
  const newProcessScenarios = Math.max(0, input.candidate.process.scenarios.length - input.base.process.scenarios.length);
  const beforeIds = new Set(input.before.findings.map((finding) => finding.id));
  const afterIds = new Set(input.after.findings.map((finding) => finding.id));
  const resolvedFindings = [...beforeIds].filter((id) => !afterIds.has(id)).length;
  const introducedFindings = [...afterIds].filter((id) => !beforeIds.has(id)).length;
  const targetDateBlocked = input.contract.targetAsOf !== input.base.snapshot.asOf
    && input.after.findings.some((finding) => finding.layer === "temporal" && finding.severity === "error");
  const learningReasons = learningRegressionReasons(input.base, input.candidate, input.migrations);
  if (input.after.coverage.tasksWithoutSkills > input.before.coverage.tasksWithoutSkills) {
    learningReasons.push(`任务缺少知识技能覆盖 ${input.before.coverage.tasksWithoutSkills} → ${input.after.coverage.tasksWithoutSkills}，不能以其他维度增益抵消`);
  }
  const coreRegression = learningReasons.length > 0 || targetDateBlocked || !input.after.protocolValid
    || input.after.core.errorCount > input.before.core.errorCount
    || input.after.core.unsupportedAcceptedCount > input.before.core.unsupportedAcceptedCount
    || input.after.axes.agentUsability + 5 < input.before.axes.agentUsability;
  const healthImproved = input.after.audit.metrics.score >= input.before.audit.metrics.score + 0.5
    || input.after.core.errorCount < input.before.core.errorCount
    || resolvedFindings > introducedFindings;
  const informationScore = Math.max(0,
    newSources * 8
    + newSemanticNodes * 3
    + newProcessScenarios * 6
    + resolvedFindings * 5
    - introducedFindings * 3,
  );
  const objectiveSignals = [
    newSources ? `新增 ${newSources} 个来源` : "",
    newSemanticNodes ? `新增 ${newSemanticNodes} 个语义节点` : "",
    newProcessScenarios ? `新增 ${newProcessScenarios} 个事理场景` : "",
    resolvedFindings ? `解决 ${resolvedFindings} 项发现` : "",
  ].filter(Boolean);
  const meaningful = input.after.protocolValid && !coreRegression && (healthImproved || informationScore > 0);
  return {
    meaningful,
    coreRegression,
    protocolValid: input.after.protocolValid,
    healthImproved,
    informationGain: {
      score: informationScore,
      newSources,
      newSemanticNodes,
      newProcessScenarios,
      resolvedFindings,
      introducedFindings,
    },
    objectiveSignals,
    reasons: meaningful
      ? [...objectiveSignals, healthImproved ? "核心健康或风险状态获得改善" : "研究前沿获得有界信息增量"]
      : [
        ...learningReasons,
        !input.after.protocolValid ? "候选存在协议不变量错误" : "",
        targetDateBlocked ? "目标时点仍有来源越界或日期错误，不能写入该时点快照" : coreRegression ? "已接受核心发生回退" : "",
        !healthImproved && informationScore === 0 ? "没有可证明的风险降低或信息增量" : "",
      ].filter(Boolean),
  };
}
