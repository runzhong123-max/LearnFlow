import { stableHash } from "@/lib/build/compiler";
import type { AuditIssue, ColdStartBuildResult, ResearchTopic } from "@/lib/build/types";
import { auditRoleSnapshot } from "@/lib/risk/audit";
import type { RiskIssue, RiskProfile } from "@/lib/risk/types";
import type { AgentProbe, IterationFinding, IterationFindingLayer, SnapshotInspection } from "./types";
import { learningCoverage } from "./learning-health";

const HARD_PROTOCOL_CODES = new Set([
  "MISSING_ROLE_ROOT",
  "DANGLING_SEMANTIC_EDGE",
  "DANGLING_PROCESS_EDGE",
  "ILLEGAL_CYCLE",
  "INVALID_SNAPSHOT_TIME",
]);

const LAYER_BY_PROFILE: Record<RiskProfile, IterationFindingLayer> = {
  structural: "protocol",
  semantic: "semantic",
  task_quality: "coverage",
  capability_skill: "semantic",
  evidence: "evidence",
  temporal: "temporal",
  process: "process",
  effectiveness: "agent",
};

function clamp(value: number) {
  return Math.max(0, Math.min(100, Number(value.toFixed(1))));
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function findingFromRisk(issue: RiskIssue): IterationFinding {
  const hardBlocker = issue.severity === "error" && HARD_PROTOCOL_CODES.has(issue.code);
  return {
    id: `finding:${issue.fingerprint}`,
    layer: LAYER_BY_PROFILE[issue.profile],
    classification: hardBlocker
      ? "invariant"
      : issue.repairability === "automatic" || issue.code === "UNSUPPORTED_TARGET"
        ? "core_usability"
        : "research",
    severity: issue.severity,
    code: issue.code,
    title: issue.title,
    detail: issue.detail,
    impact: issue.impact,
    targetIds: issue.targetIds,
    evidenceBindingIds: issue.evidenceBindingIds,
    confidence: issue.confidence,
    suggestedAction: issue.repairability,
    hardBlocker,
  };
}

function customFinding(input: Omit<IterationFinding, "id">): IterationFinding {
  return {
    ...input,
    id: `finding:${stableHash(`${input.layer}:${input.code}:${[...input.targetIds].sort().join("|")}`)}`,
  };
}

function agentProbes(result: ColdStartBuildResult): AgentProbe[] {
  const semanticIds = new Set(result.semantic.nodes.map((node) => node.id));
  const sourceIds = new Set(result.sources.assets.map((source) => source.id));
  const segmentIds = new Set(result.sources.segments.map((segment) => segment.id));
  const bindingIds = new Set(result.sources.evidenceBindings.map((binding) => binding.id));
  const roleRoots = result.semantic.nodes.filter((node) => node.type === "market_role");
  const danglingSemantic = result.semantic.edges.filter((edge) => !semanticIds.has(edge.source) || !semanticIds.has(edge.target));
  const brokenBindings = result.sources.evidenceBindings.filter((binding) => !sourceIds.has(binding.sourceId) || !segmentIds.has(binding.segmentId));
  const brokenObjectBindingRefs = [
    ...result.semantic.nodes,
    ...result.semantic.edges,
    ...result.process.scenarios,
    ...result.process.nodes,
    ...result.process.edges,
  ].filter((target) => target.evidenceBindingIds.some((id) => !bindingIds.has(id)));
  const aliases = new Map<string, string[]>();
  for (const node of result.semantic.nodes) {
    for (const alias of [node.label, ...node.aliases]) {
      const key = alias.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
      if (!key) continue;
      aliases.set(key, unique([...(aliases.get(key) || []), node.id]));
    }
  }
  const ambiguousAliases = [...aliases.values()].filter((ids) => ids.length > 1);
  const requiredSections = new Set(["overview", "tasks", "capabilities", "knowledge-skills", "work-process", "evidence-risks"]);
  const missingSections = [...requiredSections].filter((id) => !result.snapshot.sections.some((section) => section.id === id));
  const emptyCoreSections = result.snapshot.sections.filter((section) => ["tasks", "capabilities", "knowledge-skills", "work-process"].includes(section.id) && section.itemIds.length === 0);
  return [
    {
      id: "probe:role-root",
      label: "岗位根节点可唯一解析",
      status: roleRoots.length === 1 ? "passed" : "failed",
      detail: roleRoots.length === 1 ? `根节点为 ${roleRoots[0].id}` : `检测到 ${roleRoots.length} 个岗位根节点。`,
      targetIds: roleRoots.map((node) => node.id),
    },
    {
      id: "probe:graph-traversal",
      label: "语义关系可遍历",
      status: danglingSemantic.length || result.semantic.edges.length === 0 ? "failed" : "passed",
      detail: danglingSemantic.length ? `${danglingSemantic.length} 条关系存在缺失端点。` : result.semantic.edges.length === 0 ? "语义图没有任何可遍历关系。" : `${result.semantic.edges.length} 条语义关系端点完整。`,
      targetIds: danglingSemantic.map((edge) => edge.id),
    },
    {
      id: "probe:evidence-resolution",
      label: "证据引用可解析",
      status: brokenBindings.length || brokenObjectBindingRefs.length ? "failed" : "passed",
      detail: brokenBindings.length || brokenObjectBindingRefs.length
        ? `${brokenBindings.length} 条绑定或 ${brokenObjectBindingRefs.length} 个对象引用无法解析。`
        : `${result.sources.evidenceBindings.length} 条证据绑定可追溯到来源片段。`,
      targetIds: [...brokenBindings.map((binding) => binding.id), ...brokenObjectBindingRefs.map((target) => target.id)],
    },
    {
      id: "probe:alias-resolution",
      label: "节点别名可消歧",
      status: ambiguousAliases.length ? "warning" : "passed",
      detail: ambiguousAliases.length ? `${ambiguousAliases.length} 组别名对应多个节点，需要结合类型和邻域消歧。` : "未发现跨节点别名冲突。",
      targetIds: unique(ambiguousAliases.flat()),
    },
    {
      id: "probe:snapshot-context",
      label: "Agent 快照章节完整",
      status: missingSections.length || emptyCoreSections.length ? "failed" : "passed",
      detail: missingSections.length ? `缺少章节：${missingSections.join("、")}` : emptyCoreSections.length ? `章节存在但内容为空：${emptyCoreSections.map((section) => section.title).join("、")}` : "六个核心上下文章节均可读取且核心内容非空。",
      targetIds: [...missingSections, ...emptyCoreSections.map((section) => section.id)],
    },
  ];
}

function coverageFindings(result: ColdStartBuildResult) {
  const findings: IterationFinding[] = [];
  const { tasks, skills, tasksWithoutSkills } = learningCoverage(result);
  for (const task of tasksWithoutSkills) {
    findings.push(customFinding({
      layer: "coverage",
      classification: "research",
      severity: "warning",
      code: "TASK_SKILL_GAP",
      title: `任务缺少可学习知识技能：${task.label}`,
      detail: "该任务没有连接到能够解释其实施、调试或验收的具体知识技能。",
      impact: "Agent 无法组装可靠学习路径，教师也难以据此形成实训和评价入口。",
      targetIds: [task.id],
      evidenceBindingIds: task.evidenceBindingIds,
      confidence: 0.95,
      suggestedAction: "research",
      hardBlocker: false,
    }));
  }
  if (tasks.length >= 3 && skills.length / tasks.length < 0.75) {
    findings.push(customFinding({
      layer: "coverage",
      classification: "research",
      severity: "warning",
      code: "SKILL_COVERAGE_SPARSE",
      title: "知识技能结构相对任务复杂度明显稀疏",
      detail: `${tasks.length} 个任务仅形成 ${skills.length} 个知识技能节点；该判断来自任务覆盖而非固定节点数量门槛。`,
      impact: "岗位图谱可能只能描述做什么，尚不足以解释如何学习、实施、调试和验收。",
      targetIds: tasksWithoutSkills.map((task) => task.id),
      evidenceBindingIds: [],
      confidence: 0.8,
      suggestedAction: "research",
      hardBlocker: false,
    }));
  }
  return { findings, tasks, skills, tasksWithoutSkills };
}

function pedagogyFindings(result: ColdStartBuildResult) {
  const findings: IterationFinding[] = [];
  const taskIds = new Set(result.semantic.nodes.filter((node) => node.type === "task").map((node) => node.id));
  const capabilities = result.semantic.nodes.filter((node) => node.type === "capability");
  const units = result.semantic.nodes.filter((node) => node.type === "capability_unit");
  for (const capability of capabilities) {
    const supportedTasks = new Set(result.semantic.edges
      .filter((edge) => edge.target === capability.id && taskIds.has(edge.source) && edge.type === "requires_capability")
      .map((edge) => edge.source));
    if (taskIds.size > 1 && supportedTasks.size < 2) findings.push(customFinding({
      layer: "semantic", classification: "research", severity: "warning", code: "CAPABILITY_NOT_CROSS_TASK",
      title: `能力缺少跨任务迁移依据：${capability.label}`,
      detail: "该能力目前只服务一个任务，更可能是任务步骤、工具行为或能力单元。",
      impact: "能力层失去抽象和启发作用。", targetIds: [capability.id], evidenceBindingIds: capability.evidenceBindingIds,
      confidence: 0.9, suggestedAction: "research", hardBlocker: false,
    }));
  }
  for (const unit of units.filter((node) => !node.cultivation)) findings.push(customFinding({
    layer: "coverage", classification: "core_usability", severity: "warning", code: "CAPABILITY_UNIT_CULTIVATION_GAP",
    title: `能力单元缺少日常培养设计：${unit.label}`,
    detail: "尚未说明微练习、频率、反馈、学习证据、递进与独立完成标准。",
    impact: "教师和学生无法把能力单元转化为可持续的日常培养动作。", targetIds: [unit.id], evidenceBindingIds: unit.evidenceBindingIds,
    confidence: 1, suggestedAction: "research", hardBlocker: false,
  }));
  const projection = result.semantic.learningPathProjection;
  for (const binding of projection?.bindings.filter((item) => item.mappingMode === "ambiguous" || item.mappingMode === "graph_gap") || []) {
    findings.push(customFinding({
      layer: "coverage", classification: "research", severity: "info",
      code: binding.mappingMode === "ambiguous" ? "LEARNING_PATH_AMBIGUOUS" : "LEARNING_PATH_GRAPH_GAP",
      title: binding.mappingMode === "ambiguous" ? "学习路径映射需要消歧" : "知识技能尚无学习路径锚点",
      detail: binding.rationale,
      impact: "岗位要求暂时不能稳定转化为学生可读取的学习路线。", targetIds: [binding.semanticNodeId], evidenceBindingIds: binding.evidenceBindingIds,
      confidence: 0.85, suggestedAction: "research", hardBlocker: false,
    }));
  }
  return findings;
}

/**
 * Diagnose a snapshot without deciding whether model prose may be shown.
 * Only protocol invariants are blockers; all semantic/coverage findings stay
 * visible and become iteration work instead of deleting the candidate.
 */
export function inspectSnapshot(result: ColdStartBuildResult, options?: { targetIds?: string[]; now?: string }): SnapshotInspection {
  const audit = auditRoleSnapshot(result, { targetIds: options?.targetIds, now: options?.now });
  const findings = audit.issues.map(findingFromRisk);
  const coverage = coverageFindings(result);
  findings.push(...coverage.findings);
  findings.push(...pedagogyFindings(result));
  const deduplicated = [...new Map(findings.map((finding) => [finding.id, finding])).values()];
  const probes = agentProbes(result);
  for (const probe of probes.filter((item) => item.status === "failed")) {
    const existing = deduplicated.some((finding) => finding.targetIds.some((id) => probe.targetIds.includes(id)) && finding.layer === "protocol");
    if (existing) continue;
    const evidenceProtocolFailure = probe.id === "probe:evidence-resolution";
    deduplicated.push(customFinding({
      layer: evidenceProtocolFailure ? "protocol" : "agent",
      classification: evidenceProtocolFailure ? "invariant" : "core_usability",
      severity: "error",
      code: `AGENT_${probe.id.split(":").at(-1)!.replace(/-/gu, "_").toUpperCase()}`,
      title: probe.label,
      detail: probe.detail,
      impact: "结构可能通过序列化校验，但 Agent 工具无法稳定读取或组装上下文。",
      targetIds: probe.targetIds,
      evidenceBindingIds: [],
      confidence: 1,
      suggestedAction: "developer",
      hardBlocker: evidenceProtocolFailure,
    }));
  }
  const hardBlockers = deduplicated.filter((finding) => finding.hardBlocker);
  const semanticProblems = deduplicated.filter((finding) => finding.layer === "semantic" && finding.severity !== "info").length;
  const temporalErrors = deduplicated.filter((finding) => finding.layer === "temporal" && finding.severity === "error").length;
  const passedProbes = probes.filter((probe) => probe.status === "passed").length;
  const acceptedNodes = result.semantic.nodes.filter((node) => node.lifecycle === "stable");
  const boundTargets = new Set(result.sources.evidenceBindings.map((binding) => binding.targetId));
  const unsupportedAccepted = acceptedNodes.filter((node) => !boundTargets.has(node.id));
  const tasksWithoutProcess = coverage.tasks.filter((task) => !result.process.bridges.some((bridge) => bridge.type === "realizes_task" && bridge.semanticNodeId === task.id));
  const semanticCoreTypes = ["task", "capability", "knowledge_skill"];
  const presentSemanticCoreTypes = semanticCoreTypes.filter((type) => result.semantic.nodes.some((node) => node.type === type)).length;
  const semanticCoreCoverage = presentSemanticCoreTypes / semanticCoreTypes.length;
  const structuralUtility = result.semantic.edges.length > 0 ? semanticCoreCoverage : semanticCoreCoverage * 0.35;
  return {
    snapshotId: result.snapshot.id,
    generatedAt: options?.now || new Date().toISOString(),
    protocolValid: hardBlockers.length === 0,
    hardBlockers,
    findings: deduplicated,
    audit,
    axes: {
      structuralValidity: clamp((100 - hardBlockers.length * 35) * (0.35 + structuralUtility * 0.65)),
      semanticClarity: clamp((100 - semanticProblems * 7) * semanticCoreCoverage),
      evidenceReadiness: clamp(audit.metrics.evidenceCoverage * 65 + audit.metrics.directEvidenceCoverage * 35),
      temporalIntegrity: clamp(100 - temporalErrors * 25),
      processCoverage: clamp(audit.metrics.processCoverage * 100),
      agentUsability: clamp((probes.length ? passedProbes / probes.length * 100 : 0) * (0.4 + semanticCoreCoverage * 0.6)),
    },
    core: {
      nodeCount: result.semantic.nodes.length,
      acceptedNodeCount: acceptedNodes.length,
      errorCount: deduplicated.filter((finding) => finding.severity === "error").length,
      unsupportedAcceptedCount: unsupportedAccepted.length,
    },
    frontier: {
      candidateNodeCount: result.semantic.nodes.filter((node) => node.lifecycle === "candidate").length,
      researchFindingCount: deduplicated.filter((finding) => finding.classification === "research").length,
      openTopicCount: result.audit.researchTopics.length,
    },
    coverage: {
      tasks: coverage.tasks.length,
      knowledgeSkills: coverage.skills.length,
      tasksWithoutSkills: coverage.tasksWithoutSkills.length,
      tasksWithoutProcess: tasksWithoutProcess.length,
      evidenceCoverage: audit.metrics.evidenceCoverage,
      directEvidenceCoverage: audit.metrics.directEvidenceCoverage,
    },
    agentProbes: probes,
  };
}

export function inspectionToBuildAudit(inspection: SnapshotInspection): { issues: AuditIssue[]; researchTopics: ResearchTopic[] } {
  const issues: AuditIssue[] = inspection.findings.map((finding) => ({
    id: `issue:${stableHash(finding.id)}`,
    code: finding.code,
    severity: finding.severity,
    title: finding.title,
    detail: finding.detail,
    targetIds: finding.targetIds,
    repair: finding.suggestedAction === "developer" ? "automatic" : finding.suggestedAction,
  }));
  const researchTopics = inspection.findings
    .filter((finding) => finding.classification === "research")
    .map((finding) => ({
      id: `research:${stableHash(finding.id)}`,
      title: finding.title,
      question: `需要哪些证据、工作实例或边界判断，才能解决“${finding.title}”？`,
      reason: finding.detail,
      targetIds: finding.targetIds,
    }));
  return { issues, researchTopics };
}

/** Re-materialize the snapshot-facing audit projection after graph changes. */
export function applyInspectionToSnapshot(result: ColdStartBuildResult, inspection: SnapshotInspection): ColdStartBuildResult {
  const candidate = structuredClone(result);
  const inspected = inspectionToBuildAudit(inspection);
  // Iteration findings describe the current candidate. Keeping compiler issues
  // that have already been resolved would make the next snapshot self-contradictory.
  candidate.audit.issues = inspected.issues;
  candidate.audit.researchTopics = inspected.researchTopics;
  candidate.audit.inspection = {
    protocolValid: inspection.protocolValid,
    axes: inspection.axes,
    core: inspection.core,
    frontier: inspection.frontier,
    coverage: inspection.coverage,
    agentProbes: inspection.agentProbes,
    hardBlockerIds: inspection.hardBlockers.map((finding) => finding.id),
  };
  const evidenceRisks = candidate.snapshot.sections.find((section) => section.id === "evidence-risks");
  if (evidenceRisks) {
    evidenceRisks.summary = inspection.findings.length
      ? inspection.findings.slice(0, 20).map((finding) => `${finding.title}：${finding.detail}`).join("\n")
      : "本轮检查未发现开放问题。";
    evidenceRisks.itemIds = unique(inspection.findings.flatMap((finding) => finding.targetIds));
    evidenceRisks.status = "candidate";
  }
  candidate.validation.structural.passed = inspection.protocolValid;
  candidate.validation.structural.issues = inspection.hardBlockers.map((finding) => finding.title);
  const learningGaps = inspection.findings.filter(f => f.code === "TASK_SKILL_GAP");
  if (learningGaps.length) {
    candidate.validation.semantic.passed = false;
    candidate.validation.semantic.issues = unique([...candidate.validation.semantic.issues, ...learningGaps.map(f => f.title)]);
    candidate.validation.publishable = false;
    if (candidate.build?.enrichment) candidate.build.enrichment.status = "degraded";
  }
  candidate.validation.publishable = candidate.validation.publishable && inspection.protocolValid;
  if (!inspection.protocolValid) {
    candidate.snapshot.status = "candidate";
    candidate.packages.rolePackage.status = "candidate";
  }
  return candidate;
}
