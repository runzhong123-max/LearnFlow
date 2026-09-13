import { stableHash } from "@/lib/build/compiler";
import { iterationTargetNodes } from "./targets";
import { compareResearchQuality } from "@/lib/research/quality";
import { learningRegressionReasons, sourceFingerprints } from "./preserve-graph";
import { findingIdentity } from "./inspector";
import type { ColdStartBuildResult, WebSearchCategory } from "@/lib/build/types";
import type { PlannedQuery } from "@/lib/search/web-research";
import { researchRoleTitle } from "@/lib/search/role-query";
import { reviewIterationScope } from "./scope";
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
  if (request.research) request = { ...request, prompt: request.research.objective ?? request.prompt, targetIds: request.research.targetIds, initiativeProfile: request.research.changeScope === "selected" ? "user_directed" : "autonomous", maxRounds: request.research.budget.revisions, maxWorkItems: request.research.budget.tasks };
  const profile = request.initiativeProfile;
  const mode = request.mode || "auto";
  const prompt = request.prompt.trim();
  const targetNodes = new Map(iterationTargetNodes(result).map((node) => [node.id, node.label]));
  const selectedLabels = request.targetIds.map((id) => targetNodes.get(id) || id);
  const targetAsOf = request.targetAsOf || (mode === "freshness" ? new Date().toISOString().slice(0, 10) : result.snapshot.asOf);
  const objective = profile === "autonomous"
    ? `自动发现并迭代“${result.brief.roleTitle}”快照中价值最高的结构、证据、时效、事理与 Agent 可用性问题。${prompt ? `优先关注用户目标：${prompt}` : ""}`
    : prompt || (selectedLabels.length
      ? `围绕“${selectedLabels.join("、")}”补充证据、任务关系与能力结构。`
      : `围绕当前岗位重点，自动发现关联问题并提升“${result.brief.roleTitle}”快照。`);
  const feedbackScope = new Set(request.targetIds);
  if (profile === "user_directed" && feedbackScope.size) for (let depth = 0; depth < 3; depth++) {
    for (const edge of result.semantic.edges) if (edge.lifecycle !== "rejected" && feedbackScope.has(edge.source)
      && ["requires_skill", "requires_capability", "contains"].includes(edge.type)) feedbackScope.add(edge.target);
  }
  const learningMountFeedback = (request.learningMountFeedback || []).filter(feedback => result.semantic.nodes.some(node => node.id === feedback.roleNodeId && node.type === "knowledge_skill" && node.lifecycle !== "rejected")
    && (profile !== "user_directed" || feedbackScope.has(feedback.roleNodeId)));
  const graphRadius = profile === "autonomous" ? "global" as const : profile === "co_guided" ? 2 : 1;
  return {
    id: `iteration-contract:${stableHash(`${request.runId}:${profile}:${objective}`)}`,
    research: request.research,
    stopPolicy: { maxRounds: request.maxRounds, stagnantRounds: request.research?.budget.stagnantRounds ?? request.stagnantRoundLimit ?? 3 },
    initiativeProfile: profile,
    mode,
    objective,
    learningMountFeedback,
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
    inferredFrom: [
      `发起方式：${profile}`,
      `功能类型：${mode === "freshness" ? "时效迭代" : mode === "deep_research" ? "深度研究" : mode === "risk_repair" ? "风险修复" : "自动判定"}`,
      prompt ? `用户目标：${prompt}` : "用户未限定主题",
      request.targetIds.length ? `选中对象：${request.targetIds.join("、")}` : "未选中具体对象",
      request.supplementalSources.length ? `附加资料：${request.supplementalSources.length} 项` : "无附加资料",
    ],
  };
}

// These are diagnosed defects of existing objects, not open-ended expansion.
// They may require evidence and model work even though the mutation is a repair.
const RESEARCH_REPAIR_CODES = new Set([
  "TASK_SKILL_GAP", "TASK_LEARNING_KIND_GAP", "TASK_PROCESS_INCOMPLETE", "SKILL_COVERAGE_SPARSE", "SKILL_NOT_LEARNABLE",
  "TASK_CAPABILITY_GAP", "TASK_CAPABILITY_UNIT_GAP",
  "LEARNING_PATH_AMBIGUOUS", "LEARNING_PATH_GRAPH_GAP", "CAPABILITY_UNIT_CULTIVATION_GAP",
  "MISSING_TASK_LAYER", "ORPHAN_CORE_NODE", "SEMANTIC_OVERLAP", "TASK_NOT_DELIVERABLE",
  "CAPABILITY_DIMENSION_POLLUTION", "CAPABILITY_NOT_CROSS_TASK",
  "TASK_PROCESS_GAP", "NO_PROCESS_SCENARIOS", "SCENARIO_WITHOUT_EVENT", "SCENARIO_WITHOUT_ARTIFACT",
]);

function findingIntent(finding: IterationFinding, mode?: IterationContract["mode"]): IterationIntent {
  if (mode === "risk_repair" && finding.suggestedAction === "research"
    && RESEARCH_REPAIR_CODES.has(finding.code)) return "repair";
  if (finding.layer === "temporal") return "refresh";
  if (finding.suggestedAction === "automatic" || finding.classification === "invariant") return "repair";
  if (finding.layer === "evidence") return "verify";
  return "expand";
}

function findingValue(finding: IterationFinding) {
  // An empty legacy snapshot needs task extraction before any narrower tool can
  // meaningfully inspect skills, freshness or workspace alignment.
  if (finding.code === "MISSING_TASK_LAYER") return 100;
  const severity = { error: 40, warning: 24, info: 10 }[finding.severity];
  const classification = { invariant: 20, core_usability: 14, research: 8 }[finding.classification];
  const unlock = finding.layer === "protocol" ? 18 : finding.layer === "process" || finding.layer === "coverage" ? 10 : 4;
  const blockingLearning = ["TASK_SKILL_GAP", "TASK_LEARNING_KIND_GAP"].includes(finding.code) ? 22 : 0;
  return Math.min(100, severity + classification + unlock + finding.confidence * 12 + blockingLearning);
}

function isFindingInScope(
  finding: IterationFinding,
  profile: InitiativeProfile,
  targetIds: Set<string>,
  prompt: string,
) {
  if (finding.hardBlocker || finding.code === "MISSING_TASK_LAYER") return true;
  if (profile === "autonomous") return true;
  if (targetIds.size === 0) {
    if (profile !== "user_directed") return true;
    // A textual direction is a real scope, not an empty selection. Match the
    // requested dimension without silently adopting unrelated discoveries.
    const dimensions: Array<[RegExp, RegExp]> = [
      [/知识|技能|学习路径|学习点/u, /SKILL|LEARNING/u],
      [/能力|培养|单元/u, /CAPABILITY/u],
      [/过程|流程|场景|交付/u, /PROCESS|SCENARIO|DELIVERABLE/u],
      [/证据|来源|核验/u, /EVIDENCE|SOURCE|UNSUPPORTED/u],
      [/时效|最新|更新|过时/u, /STALE|TEMPORAL|TIME|DATE/u],
    ];
    const requested = dimensions.filter(([pattern]) => pattern.test(prompt));
    return requested.length ? requested.some(([, codes]) => codes.test(finding.code))
      : /全量|全部|整体|全岗位|风险修复|自动发现/u.test(prompt);
  }
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
      requiresResearch: true,
    });
  }
  for (const feedback of input.contract.learningMountFeedback || []) {
    opportunities.push({ id: `opportunity:${stableHash(`${input.request.runId}:mount:${feedback.roleNodeId}:${feedback.reason}`)}`,
      origin: "inspector", title: "补研学习路径挂载所需定义与证据", detail: `${feedback.reason}；研究目标：${feedback.researchGoal}`,
      targetIds: [feedback.roleNodeId], findingIds: input.inspection.findings.filter(finding => finding.targetIds.includes(feedback.roleNodeId) && /LEARNING|SKILL/u.test(finding.code)).map(finding => finding.id),
      intents: [input.contract.mode === "risk_repair" ? "repair" : "expand"], expectedValue: 98, requiresResearch: true });
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
      requiresResearch: true,
    });
  }
  const selectedFindings = input.inspection.findings
    .filter((finding) => isFindingInScope(finding, input.contract.initiativeProfile, targetIds, input.request.prompt))
    // Human observations and developer interventions cannot be obtained by web research.
    .filter((finding) => finding.hardBlocker || ["automatic", "research"].includes(finding.suggestedAction))
    .filter((finding) => finding.hardBlocker || finding.code === "MISSING_TASK_LAYER" || input.contract.changeIntents.includes(findingIntent(finding, input.contract.mode)))
    // Individual task gaps already carry the work; do not spend another slot on their aggregate.
    .filter((finding, _, findings) => finding.code !== "SKILL_COVERAGE_SPARSE"
      || !findings.some(other => other.code === "TASK_SKILL_GAP"))
    .sort((left, right) => findingValue(right) - findingValue(left));
  const groups = new Map<string, IterationFinding[]>();
  for (const finding of selectedFindings) {
    const intent = findingIntent(finding, input.contract.mode);
    // Keep task-specific defects separate, so four uncovered tasks do not share
    // a single query containing only the first three labels.
    const key = `${intent}:${finding.layer}:${finding.classification}:${finding.suggestedAction === "research" && RESEARCH_REPAIR_CODES.has(finding.code) ? `${finding.code}:${[...finding.targetIds].sort().join("|")}` : "group"}`;
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
      requiresResearch: true,
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
      status: "planned",
    };
  });
}

function categoryForWorkItem(item: IterationWorkItem): WebSearchCategory[] {
  if (item.kind === "refresh") return ["technology", "future_signal", "official_standard", "job_market"];
  if (item.kind === "instantiate" || item.origin === "workspace") return ["work_practice", "official_standard", "technology", "education"];
  if (item.kind === "expand") return ["work_practice", "education", "technology", "official_standard"];
  if (item.kind === "repair" && /知识|技能|学习|部署|SQL|调试/u.test(`${item.title} ${item.detail}`)) return ["technology", "work_practice", "education", "official_standard"];
  if (item.kind === "repair") return ["official_standard", "work_practice", "technology", "education"];
  return ["official_standard", "work_practice", "technology", "education"];
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
  previousPlans?: IterationResearchPlan[];
}): IterationResearchPlan {
  const queries = new Map<string, PlannedQuery>();
  const roleTitle = researchRoleTitle(input.result.brief.roleTitle);
  const researchPrompt = input.request.prompt || input.contract.objective.split(input.result.brief.roleTitle).join(roleTitle);
  const nodeLabels = new Map(iterationTargetNodes(input.result).map((node) => {
    const task = input.result.semantic.nodes.find(candidate => candidate.id === node.id && candidate.type === "task");
    return [node.id, `${node.label === input.result.brief.roleTitle ? roleTitle : node.label}${task ? ` ${task.summary.slice(0, 160)}` : ""}`];
  }));
  const labelsFor = (item: IterationWorkItem) => item.targetIds.map((id) => nodeLabels.get(id) || id);
  const attempts = new Map<string, number>();
  for (const plan of input.previousPlans || []) for (const id of plan.workItemIds) attempts.set(id, (attempts.get(id) || 0) + 1);
  const researchItems = input.workItems.filter((item) => item.requiresResearch && item.status !== "completed" && item.status !== "skipped")
    .sort((a, b) => (attempts.get(a.id) || 0) - (attempts.get(b.id) || 0) || b.priority - a.priority).slice(0, 32);
  for (const item of researchItems) {
    // Follow-up searches change the evidence category instead of repeating round one.
    const availableCategories = categoryForWorkItem(item);
    const attempt = attempts.get(item.id) ?? input.round - 1;
    const categories = [availableCategories[attempt % availableCategories.length]];
    for (const category of categories) {
      const query = queryText({
        category,
        role: roleTitle,
        market: input.result.brief.market,
        asOf: input.contract.targetAsOf,
        item,
        targetLabels: labelsFor(item),
        prompt: researchPrompt,
      }).split(input.result.brief.roleTitle).join(roleTitle);
      const key = `${category}:${query}`;
      queries.set(key, {
        id: `iteration-query:${stableHash(`${input.runId}:${input.round}:${key}`)}`,
        category,
        query,
        priority: item.priority,
      });
    }
  }
  if (researchItems.length && !input.result.semantic.nodes.some(node => node.type === "task" && node.lifecycle !== "rejected")) {
    // Source/skill checks alone cannot recover a role-only snapshot. Always
    // look for actual duties and delivery examples as the missing foundation.
    const category: WebSearchCategory = input.round > 1 ? "work_practice" : "job_market";
    const query = queryText({ category, role: roleTitle, market: input.result.brief.market,
      asOf: input.contract.targetAsOf, item: { ...researchItems[0], title: "典型工作任务与交付验收" }, targetLabels: [], prompt: "" });
    queries.set(`${category}:${query}`, { id: `iteration-query:${stableHash(`${input.runId}:${input.round}:task-recovery:${query}`)}`, category, query, priority: 101 });
  }
  if (input.request.prompt.trim() || input.contract.targetIds.length) {
    const focusItem = input.workItems.find((item) => item.origin === "user") || input.workItems[0];
    if (focusItem) {
      const category: WebSearchCategory = "user_focus";
      const query = queryText({
        category,
        role: roleTitle,
        market: input.result.brief.market,
        asOf: input.contract.targetAsOf,
        item: focusItem,
        targetLabels: labelsFor(focusItem),
        prompt: researchPrompt,
      }).split(input.result.brief.roleTitle).join(roleTitle);
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
    queries: input.request.webResearch ? [...queries.values()].sort((left, right) => right.priority - left.priority).slice(0, 32) : [],
    rationale: researchItems.map((item) => `${item.title}：${item.detail}`),
    stopPolicy: input.contract.stopPolicy,
  };
}

export function evaluateIteration(input: {
  base: ColdStartBuildResult;
  candidate: ColdStartBuildResult;
  before: SnapshotInspection;
  after: SnapshotInspection;
  contract: IterationContract;
  migrations?: Record<string, string>;
  workItems?: IterationWorkItem[];
  previousAccepted?: { candidate: ColdStartBuildResult; inspection: SnapshotInspection };
}): IterationEvaluation {
  const originalSources = new Set(sourceFingerprints(input.base).values());
  const candidateSources = sourceFingerprints(input.candidate);
  const newSources = new Set(input.candidate.sources.assets.filter(s => s.kind !== "user_brief" && !originalSources.has(candidateSources.get(s.id)!)).map(s => candidateSources.get(s.id)!)).size;
  const newSemanticNodes = Math.max(0, input.candidate.semantic.nodes.length - input.base.semantic.nodes.length);
  const newProcessScenarios = Math.max(0, input.candidate.process.scenarios.length - input.base.process.scenarios.length);
  const beforeIds = new Set(input.before.findings.map(findingIdentity));
  const afterIds = new Set(input.after.findings.map(findingIdentity));
  const resolvedFindings = [...beforeIds].filter((id) => !afterIds.has(id)).length;
  const introducedFindings = [...afterIds].filter((id) => !beforeIds.has(id)).length;
  const targetDateBlocked = input.contract.targetAsOf !== input.base.snapshot.asOf
    && input.after.findings.some((finding) => finding.layer === "temporal" && finding.severity === "error");
  const scope = reviewIterationScope(input.base, input.candidate, input.contract);
  const reviewedChanges = input.contract.research ? input.candidate.researchRun?.changeSets.filter(change => (change.status === "needs_review" || (change.status === "candidate" && change.checks.some(check => check.layer === "evidence" && check.passed))) && change.checks.some(check => check.layer === "integrity" && check.passed)) || [] : [];
  const retired = new Set(reviewedChanges.flatMap(change => change.operations.filter(operation => ["replace", "split", "deprecate"].includes(operation.kind)).map(operation => operation.targetId)));
  const learningReasons = [...learningRegressionReasons(input.base, input.candidate, input.migrations, retired), ...scope.reasons];
  if (input.previousAccepted) {
    const prior = input.previousAccepted;
    const priorLosses = learningRegressionReasons(prior.candidate, input.candidate, input.migrations, retired);
    if (priorLosses.length || input.after.core.errorCount > prior.inspection.core.errorCount
      || input.after.core.unsupportedAcceptedCount > prior.inspection.core.unsupportedAcceptedCount
      || input.after.coverage.tasksWithoutSkills > prior.inspection.coverage.tasksWithoutSkills
      || input.after.axes.agentUsability + 5 < prior.inspection.axes.agentUsability) {
      learningReasons.push("后续候选相对本轮已验证成果发生回退，保留前一轮改进", ...priorLosses);
    }
  }
  const recoversEmptyTaskLayer = input.before.coverage.tasks === 0 && input.after.coverage.tasks > 0
    && input.after.coverage.knowledgeSkills > 0 && input.after.coverage.tasksWithoutSkills < input.after.coverage.tasks;
  if (!recoversEmptyTaskLayer && input.after.coverage.tasksWithoutSkills > input.before.coverage.tasksWithoutSkills) {
    learningReasons.push(`任务缺少知识技能覆盖 ${input.before.coverage.tasksWithoutSkills} → ${input.after.coverage.tasksWithoutSkills}，不能以其他维度增益抵消`);
  }
  const quality = compareResearchQuality(input.base, input.candidate);
  if (input.contract.research && quality.regressed.length) learningReasons.push(`任务转换信息发生回退：${quality.regressed.join("、")}`);
  const coreRegression = learningReasons.length > 0 || targetDateBlocked || !input.after.protocolValid
    || input.after.core.errorCount > input.before.core.errorCount
    || input.after.core.unsupportedAcceptedCount > input.before.core.unsupportedAcceptedCount
    || input.after.axes.agentUsability + 5 < input.before.axes.agentUsability;
  const healthImproved = input.after.audit.metrics.score >= input.before.audit.metrics.score + 0.5
    || input.after.core.errorCount < input.before.core.errorCount
    || resolvedFindings > introducedFindings;
  const informationScore = input.contract.research ? Math.max(0, (quality.conversionImproved ? 300 : 0) + (quality.expressionImproved ? 200 : 0) + resolvedFindings * 100 - introducedFindings * 100) : Math.max(0,
    newSources * 8
    + newSemanticNodes * 3
    + newProcessScenarios * 6
    + resolvedFindings * 5
    - introducedFindings * 3,
  );
  const objectiveSignals = [
    ...(input.contract.research ? [quality.conversionImproved ? "典型任务转换信息改善" : "", quality.expressionImproved ? "明确的表达缺陷减少（仍待学生反馈验证）" : ""] : []),
    newSources ? `新增 ${newSources} 个来源` : "",
    newSemanticNodes ? `新增 ${newSemanticNodes} 个语义节点` : "",
    newProcessScenarios ? `新增 ${newProcessScenarios} 个事理场景` : "",
    resolvedFindings ? `解决 ${resolvedFindings} 项发现` : "",
  ].filter(Boolean);
  const selectedFindingIds = new Set(input.workItems?.flatMap(item => item.findingIds)
    ?? input.before.findings.map(finding => finding.id));
  const selectedFindings = input.before.findings.filter(f => selectedFindingIds.has(f.id));
  const selectedResolved = selectedFindings.some(f => !afterIds.has(findingIdentity(f)));
  const coverageImproved = selectedFindings.some(f => ["TASK_SKILL_GAP", "TASK_LEARNING_KIND_GAP", "SKILL_COVERAGE_SPARSE"].includes(f.code))
    && input.after.coverage.tasksWithoutSkills < input.before.coverage.tasksWithoutSkills;
  const evidenceImproved = selectedFindings.some(f => f.layer === "evidence")
    && input.after.coverage.directEvidenceCoverage > input.before.coverage.directEvidenceCoverage;
  const mountDefinitionImproved = (input.contract.learningMountFeedback || []).some(feedback => {
    const before = input.base.semantic.nodes.find(node => node.id === feedback.roleNodeId);
    const after = input.candidate.semantic.nodes.find(node => node.id === feedback.roleNodeId);
    if (!before || !after || !after.learningDefinition?.scopeNote.trim() || !after.learningDefinition.assessmentCriteria.some(item => item.trim())) return false;
    const oldBindings = new Set(input.base.sources.evidenceBindings.filter(binding => binding.targetId === before.id).map(binding => binding.id));
    const newEvidence = input.candidate.sources.evidenceBindings.some(binding => binding.targetId === after.id && !oldBindings.has(binding.id)
      && binding.supportRole !== "contradicts" && input.candidate.sources.segments.some(segment => segment.id === binding.segmentId && segment.text.trim()));
    const oldMode = input.base.semantic.learningPathProjection?.bindings.find(binding => binding.semanticNodeId === before.id)?.mappingMode;
    const newMode = input.candidate.semantic.learningPathProjection?.bindings.find(binding => binding.semanticNodeId === after.id)?.mappingMode;
    return (newEvidence && JSON.stringify(before.learningDefinition) !== JSON.stringify(after.learningDefinition))
      || (Boolean(oldMode) && ["ambiguous", "graph_gap"].includes(oldMode!) && Boolean(newMode) && !["ambiguous", "graph_gap"].includes(newMode!));
  });
  const repairProgress = reviewedChanges.length > 0 || Boolean(input.contract.research && quality.conversionImproved) || selectedResolved || coverageImproved || evidenceImproved || mountDefinitionImproved;
  const targetedResolution = selectedFindings.some(f => f.targetIds.some(id => input.contract.targetIds.includes(id)) && !afterIds.has(findingIdentity(f)));
  const targetProgress = scope.targetedChange || targetedResolution || recoversEmptyTaskLayer;
  const meaningful = input.after.protocolValid && !coreRegression
    && targetProgress
    && (input.contract.mode === "risk_repair" ? repairProgress : healthImproved || informationScore > 0 || reviewedChanges.length > 0);
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
        input.contract.mode === "risk_repair" && !repairProgress ? "选中的修复问题尚未改善；新增来源或无关节点不等于修复完成" : "",
        !targetProgress ? "未形成选中范围内可验证的节点、关系、证据或问题修复，新增来源本身不等于定向研究完成" : "",
      ].filter(Boolean),
  };
}
