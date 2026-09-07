import assert from "node:assert/strict";
import test from "node:test";
import langGraphTrace from "@/fixtures/workspaces/langgraph-pr-8053.json";
import type { ModelInvoker } from "@/lib/agent/model";
import { prepareBuildInput } from "@/lib/build/compiler";
import { createSnapshotIterationSkill } from "@/lib/iteration/graph";
import type { IterationEvent, SnapshotIterationRequest, SnapshotIterationResult } from "@/lib/iteration/types";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";
import { normalizeWorkspaceConnection } from "@/lib/workspaces/adapters";
import { alignWorkspaceToSnapshot } from "@/lib/workspaces/align";
import { createWorkspaceIngestionSkill } from "@/lib/workspaces/graph";
import { ingestWorkspacePackage, sanitizeWorkspacePackage } from "@/lib/workspaces/ingest";
import type { WorkspaceRunEvent } from "@/lib/workspaces/events";
import { workspaceIngestionRequestSchema, workspacePackageSchema } from "@/lib/workspaces/types";

const workspaceUpgradeModel: ModelInvoker = async function* ({ system, user }) {
  const payload = JSON.parse(user) as Record<string, unknown>;
  if (system.includes("岗位证据原子抽取器")) {
    const segments = payload.segments as Array<{ id: string; text: string }>;
    const segment = segments.find((item) => /checkpoint|子图状态|回归测试|CI/u.test(item.text));
    if (!segment) {
      yield { type: "text", delta: JSON.stringify({ mentions: [], propositions: [] }) };
      return;
    }
    const quote = segment.text.slice(0, Math.min(80, segment.text.length));
    yield { type: "text", delta: JSON.stringify({ mentions: [
      { tempId: "m-task", kind: "task", label: "Agent 系统开发", definitionHint: "实现状态持久化、测试和发布。", attributes: { deliverable: "通过 CI 的修复" }, sourceSegmentId: segment.id, evidenceSpan: { segmentId: segment.id, quote }, confidence: 0.82 },
      { tempId: "m-skill", kind: "knowledge_skill", label: "LangGraph 状态持久化", definitionHint: "设计 thread 与 checkpoint 命名空间。", attributes: {}, sourceSegmentId: segment.id, evidenceSpan: { segmentId: segment.id, quote }, confidence: 0.78 },
      { tempId: "m-event-1", kind: "work_event", label: "复现并定位 checkpoint namespace", definitionHint: "比较版本并定位配置合并回归。", attributes: { deliverable: "定位结论" }, sourceSegmentId: segment.id, evidenceSpan: { segmentId: segment.id, quote }, confidence: 0.8 },
      { tempId: "m-event-2", kind: "work_event", label: "评审并执行回归测试", definitionHint: "补全父子图契约并通过 CI。", attributes: { deliverable: "回归测试结果" }, sourceSegmentId: segment.id, evidenceSpan: { segmentId: segment.id, quote }, confidence: 0.8 },
    ], propositions: [] }) };
    return;
  }
  if (system.includes("典型工作任务规范化器") || system.includes("典型工作任务全局归并器")) {
    const mentions = (payload.mentions || []) as Array<{ id: string; kind: string }>;
    const candidates = (payload.candidates || []) as Array<{ tasks: Array<{ mentionIds: string[] }> }>;
    const mentionIds = mentions.filter((item) => item.kind === "task" || item.kind === "work_event").map((item) => item.id);
    yield { type: "text", delta: JSON.stringify({ roleSummary: "把大模型能力转化为可运行、可验证的 Agent 系统。", tasks: [{ tempId: "task-agent", label: "Agent 系统开发", summary: "实现状态持久化、修复验证和发布。", workObject: "Agent 状态系统", action: "定位并修复回归", deliverable: "通过 CI 的修复", acceptance: "回归测试和 CI 通过", aliases: [], mentionIds: mentionIds.length ? mentionIds : candidates.flatMap((item) => item.tasks.flatMap((task) => task.mentionIds)), confidence: 0.82 }], roleContexts: [] }) };
    return;
  }
  if (system.includes("任务导向的知识技能规范化器")) {
    const tasks = payload.tasks as Array<{ id: string }>;
    const mentions = payload.knowledgeMentions as Array<{ id: string }>;
    yield { type: "text", delta: JSON.stringify({ skills: [{ tempId: "skill-state", label: "LangGraph 状态持久化", summary: "设计 thread 与 checkpoint 命名空间并执行回归验证。", learningKind: "skill", learningDefinition: { scopeNote: "配置 thread 与 checkpoint 命名空间，不涉及无关存储系统。", assessmentCriteria: ["复现状态回归并提供验证结果"] }, learningOutcome: "解释持久化契约", practiceArtifact: "回归测试", assessment: "复现并修复状态回归", taskTempIds: tasks.map((item) => item.id), mentionIds: mentions.map((item) => item.id), confidence: 0.78 }] }) };
    return;
  }
  if (system.includes("跨任务能力归纳器")) {
    yield { type: "text", delta: JSON.stringify({ capabilities: [] }) };
    return;
  }
  if (system.includes("任务锚定的岗位事理抽取器")) {
    const tasks = payload.tasks as Array<{ label: string }>;
    const segments = payload.segments as Array<{ id: string; sourceKind: string }>;
    const evidenceSegmentId = segments.find((segment) => segment.sourceKind === "workspace_observation")?.id || segments.at(-1)!.id;
    yield { type: "text", delta: JSON.stringify({
      scenarios: [{ tempId: "s1", label: "修复 Agent 状态持久化回归", summary: "从复现、修复、审查到 CI 验证。", trigger: "子图状态无法跨轮恢复", outcome: "回归测试与 CI 通过", knowledgeState: "observed_pattern", evidenceSegmentIds: [evidenceSegmentId] }],
      nodes: [
        { tempId: "e1", scenarioTempId: "s1", kind: "event", label: "复现并定位 checkpoint namespace", summary: "比较版本并定位配置合并回归。", sequenceHint: 1, knowledgeState: "observed_pattern", evidenceSegmentIds: [evidenceSegmentId] },
        { tempId: "e2", scenarioTempId: "s1", kind: "event", label: "评审并执行回归测试", summary: "补全父子图契约并通过 CI。", sequenceHint: 2, knowledgeState: "observed_pattern", evidenceSegmentIds: [evidenceSegmentId] },
      ],
      edges: [{ type: "directly_follows", sourceTempId: "e1", targetTempId: "e2", evidenceSegmentIds: [evidenceSegmentId] }],
      bridges: [{ processTempId: "e1", semanticLabel: tasks[0].label, type: "realizes_task", confidence: 0.75 }],
    }) };
    return;
  }
  yield { type: "text", delta: JSON.stringify({}) };
};

function githubRequest() {
  return workspaceIngestionRequestSchema.parse({
    runId: "workspace-langgraph-8053",
    projectId: "project:llm-app-engineer",
    connection: {
      adapterId: "github_trace",
      payload: langGraphTrace,
      roleHint: "大模型应用工程师",
      visibility: "publishable_metadata",
      provenance: {
        locator: "https://github.com/langchain-ai/langgraph/pull/8053",
        publisher: "langchain-ai/langgraph",
        license: "MIT",
        capturedAt: "2026-08-22T00:00:00Z",
      },
    },
    maxObservations: 16,
    redactPersonalData: true,
  });
}

test("GitHub 适配器把真实 Issue/PR 链归一化为事件、对象、产物和真实性元数据", () => {
  const request = githubRequest();
  const packageValue = normalizeWorkspaceConnection(request.connection);
  assert.equal(packageValue.adapterId, "github_trace");
  assert.equal(packageValue.evidenceClass, "real_work_activity");
  assert.equal(packageValue.provenance.license, "MIT");
  assert.ok(packageValue.events.some((event) => event.type === "quality_review"));
  assert.ok(packageValue.events.some((event) => event.type === "verification"));
  assert.ok(packageValue.resources.some((resource) => resource.kind === "patch"));
  assert.ok(packageValue.resources.some((resource) => resource.kind === "ci_run"));

  const ingestion = ingestWorkspacePackage(request, packageValue);
  assert.equal(ingestion.inventory.caseCount, 1);
  assert.equal(ingestion.observations.length, 1);
  assert.match(ingestion.observations[0].source.content, /事件链|关联交付物与证据/u);
  assert.equal(ingestion.observations[0].source.workspaceEvidence?.evidenceClass, "real_work_activity");
  assert.equal(ingestion.observations[0].source.locator, "https://github.com/langchain-ai/langgraph/pull/8053");
});

test("安全扫描遮蔽密钥、个人信息和本机路径，但不清空仍有价值的工作观察", () => {
  const packageValue = workspacePackageSchema.parse({
    protocolVersion: "1.0",
    id: "workspace:safety",
    title: "安全扫描样例",
    adapterId: "generic_package",
    roleHint: "大模型应用工程师",
    evidenceClass: "synthetic_fixture",
    visibility: "project_private",
    provenance: { capturedAt: "2026-08-22T00:00:00Z", notes: [] },
    resources: [{
      id: "resource:runbook",
      kind: "document",
      title: "部署排障记录",
      summary: "联系 dev@example.com，读取 /Users/alice/project/.env 后修复配置。",
      content: "api_key=tvly-abcdefghijklmnopqrstuvwxyz123456 服务回滚成功。",
      caseId: "incident:1",
      metadata: {},
    }],
    objects: [], events: [], links: [], metadata: {}, timeWindow: {},
  });
  const sanitized = sanitizeWorkspacePackage(packageValue, true);
  assert.equal(sanitized.package.resources.length, 1);
  const text = JSON.stringify(sanitized.package.resources[0]);
  assert.doesNotMatch(text, /dev@example\.com|\/Users\/alice|tvly-/u);
  assert.match(text, /REDACTED_EMAIL|REDACTED_LOCAL_PATH|REDACTED_SECRET/u);
  assert.deepEqual(new Set(sanitized.safetyFindings.map((item) => item.code)), new Set(["SECRET_LIKE_CONTENT", "LOCAL_PATH", "PERSONAL_DATA_REDACTED"]));
});

test("工作区图并行抽取事件 episode 与独立产物，汇合后对齐岗位任务", async () => {
  const base = bundledRoleSnapshot();
  const generic = workspacePackageSchema.parse({
    protocolVersion: "1.0",
    id: "workspace:parallel",
    title: "Agent 服务迭代",
    adapterId: "generic_package",
    roleHint: "大模型应用工程师",
    evidenceClass: "real_work_activity",
    visibility: "project_private",
    provenance: { capturedAt: "2026-08-22T00:00:00Z", notes: [] },
    timeWindow: {}, metadata: {}, links: [], objects: [],
    resources: [
      { id: "r:issue", kind: "task", title: "设计 Agent 工具调用与状态持久化", summary: "完成 Agent 工具编排、checkpoint 与回归测试。", caseId: "case:1", metadata: {} },
      { id: "r:guide", kind: "document", title: "Agent 工具调用操作手册", summary: "独立交付的运维与排障手册。", metadata: {} },
    ],
    events: [
      { id: "e:design", caseId: "case:1", type: "task_received", label: "分析 Agent 工具调用需求", summary: "明确状态持久化和回归测试边界。", sequence: 1, objectIds: [], resourceIds: ["r:issue"] },
      { id: "e:verify", caseId: "case:1", type: "verification", label: "执行 Agent 回归验证", summary: "工具调用测试通过。", sequence: 2, objectIds: [], resourceIds: ["r:issue"], outcome: "候选方案可发布" },
    ],
  });
  const request = workspaceIngestionRequestSchema.parse({
    runId: "workspace-parallel-test",
    connection: { adapterId: "generic_package", payload: generic },
    maxObservations: 16,
    redactPersonalData: true,
  });
  const graph = createWorkspaceIngestionSkill();
  const events: WorkspaceRunEvent[] = [];
  const stream = await graph.stream({ request, base, observationLanes: [], observations: [], safetyFindings: [], quarantinedResourceIds: [] }, { configurable: { thread_id: "workspace-parallel-test" }, streamMode: "custom" });
  for await (const event of stream) events.push(event as WorkspaceRunEvent);
  const completed = events.findLast((event) => event.kind === "workspace.run.completed")!;
  const result = completed.payload.result!;
  assert.equal(result.observations.length, 2);
  const extractionLanes = new Set(events.filter((event) => event.kind === "workspace.episode.extracted").map((event) => event.payload.lane));
  assert.deepEqual(extractionLanes, new Set(["event_episode", "standalone_artifact"]));
  const alignment = completed.payload.alignment!;
  assert.equal(alignment.alignments.length, 2);
  assert.equal(alignment.snapshotId, base.snapshot.id);
});

test("Workspace Evidence 元数据穿过岗位包编译源层", () => {
  const request = githubRequest();
  const ingestion = ingestWorkspacePackage(request, normalizeWorkspaceConnection(request.connection));
  const prepared = prepareBuildInput({
    runId: "workspace-compiler-test",
    projectId: "project:test",
    roleTitle: "大模型应用工程师",
    roleDescription: "测试真实工作区证据传递。",
    market: "中国大陆",
    audience: ["高职学生", "教师"],
    snapshotAsOf: "2026-08-22",
    sources: ingestion.observations.map((observation) => observation.source),
  });
  const workspaceAsset = prepared.assets.find((asset) => asset.kind === "workspace_observation");
  assert.equal(workspaceAsset?.workspaceEvidence?.workspacePackageId, ingestion.package.id);
  assert.equal(workspaceAsset?.workspaceEvidence?.episodeId, ingestion.observations[0].episodeId);
  const report = alignWorkspaceToSnapshot(ingestion, bundledRoleSnapshot());
  assert.equal(report.alignments.length, ingestion.observations.length);
});

test("工作区观察进入统一 instantiate 迭代，并在回退评估前保持来源与事理证据", async () => {
  const base = bundledRoleSnapshot();
  const workspaceRequest = githubRequest();
  const ingestion = ingestWorkspacePackage(workspaceRequest, normalizeWorkspaceConnection(workspaceRequest.connection));
  const request: SnapshotIterationRequest = {
    runId: "workspace-unified-iteration-test",
    snapshotRef: { snapshotId: base.snapshot.id },
    projectId: "project:llm-app-engineer",
    initiativeProfile: "co_guided",
    prompt: "用真实开发工作链实例化 Agent 系统开发任务和事理过程。",
    targetIds: [],
    supplementalSources: ingestion.observations.map((observation) => observation.source),
    webResearch: false,
    maxRounds: 1,
    sourceLimit: 8,
    maxWorkItems: 10,
  };
  const graph = createSnapshotIterationSkill({ model: workspaceUpgradeModel, modelLabel: "fixture/workspace-upgrade" });
  const events: IterationEvent[] = [];
  const stream = await graph.stream({
    request,
    base,
    candidate: base,
    round: 1,
    opportunities: [],
    workItems: [],
    researchPlans: [],
    researchReports: [],
    researchedSources: [],
    patches: [],
    migrations: {},
  }, { configurable: { thread_id: "workspace-unified-iteration-test" }, streamMode: "custom" });
  for await (const event of stream) events.push(event as IterationEvent);
  const completed = events.findLast((event) => event.kind === "iteration.run.completed")!;
  const result = completed.payload.result as SnapshotIterationResult;
  assert.ok(result.contract.changeIntents.includes("instantiate"));
  assert.ok(result.opportunities.some((opportunity) => opportunity.origin === "workspace"));
  assert.ok(result.candidate.sources.assets.some((asset) => asset.workspaceEvidence?.workspacePackageId === ingestion.package.id));
  assert.ok(result.candidate.process.scenarios.length > 0);
  assert.ok(result.candidate.process.scenarios.some((scenario) => scenario.knowledgeState === "observed_pattern"), "工作区观察可支持 observed pattern，但仍不等于岗位共性");
  assert.ok(events.some((event) => event.kind === "iteration.evaluation.completed"), "必须经过回退与信息增量评估后才可形成版本");
});
