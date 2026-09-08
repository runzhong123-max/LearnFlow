import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInvoker } from "@/lib/agent/model";
import { createColdStartSkill } from "@/lib/build/graph";
import type { BuildEvent } from "@/lib/build/events";
import type { ColdStartBuildResult, ColdStartRequest } from "@/lib/build/types";

const fakeModel: ModelInvoker = async function* ({ system, user }) {
  const payload = JSON.parse(user) as Record<string, unknown>;
  yield { type: "reasoning", delta: "按稳定任务和证据范围处理本工作项。" };
  if (system.includes("岗位证据原子抽取器")) {
    const segments = payload.segments as Array<{ id: string; text: string }>;
    const segment = segments.find((item) => item.text.includes("RAG 系统构建"));
    if (!segment) {
      yield { type: "text", delta: JSON.stringify({ mentions: [], propositions: [] }) };
      return;
    }
    yield { type: "text", delta: JSON.stringify({
      mentions: [
        { tempId: "m-task", kind: "task", label: "RAG 系统构建", definitionHint: "构建检索增强生成链路并交付服务。", attributes: { workObject: "知识问答需求", action: "构建 RAG 链路", deliverable: "RAG 服务", acceptance: "可运行并完成效果检查" }, sourceSegmentId: segment.id, evidenceSpan: { segmentId: segment.id, quote: "大模型应用工程师负责 RAG 系统构建" }, confidence: 0.84 },
        { tempId: "m-skill", kind: "knowledge_skill", label: "检索质量评测", definitionHint: "使用评测检查检索效果。", attributes: {}, sourceSegmentId: segment.id, evidenceSpan: { segmentId: segment.id, quote: "使用检索质量评测检查效果" }, confidence: 0.78 },
        { tempId: "m-event", kind: "work_event", label: "构建 RAG 链路", definitionHint: "实现检索与生成链路。", attributes: { deliverable: "可运行服务" }, sourceSegmentId: segment.id, evidenceSpan: { segmentId: segment.id, quote: "构建 RAG 链路" }, confidence: 0.75 },
        { tempId: "m-artifact", kind: "deliverable", label: "可运行服务", definitionHint: "岗位交付的服务。", attributes: {}, sourceSegmentId: segment.id, evidenceSpan: { segmentId: segment.id, quote: "可运行服务" }, confidence: 0.72 },
      ],
      propositions: [{ tempId: "p1", subjectTempId: "m-task", predicateHint: "requires_skill", objectTempId: "m-skill", sourceSegmentId: segment.id, evidenceSpan: { segmentId: segment.id, quote: "使用检索质量评测检查效果" }, assertionMode: "explicit", confidence: 0.76 }],
    }) };
    return;
  }
  if (system.includes("典型工作任务规范化器") || system.includes("典型工作任务全局归并器")) {
    const mentions = (payload.mentions || []) as Array<{ id: string; kind: string; label: string }>;
    const candidates = (payload.candidates || []) as Array<{ tasks: Array<{ mentionIds: string[] }> }>;
    const mentionIds = mentions.filter((item) => item.kind === "task" || item.kind === "work_event").map((item) => item.id);
    const preserved = mentionIds.length ? mentionIds : candidates.flatMap((item) => item.tasks.flatMap((task) => task.mentionIds));
    yield { type: "text", delta: JSON.stringify({
      roleSummary: "负责把大模型能力集成为可评测、可运行的业务应用。",
      tasks: [{ tempId: "task-rag", label: "RAG 系统构建", summary: "构建检索增强生成链路并交付可运行服务。", workObject: "知识问答需求", action: "构建检索与生成链路", deliverable: "RAG 服务", acceptance: "服务可运行且通过效果检查", aliases: [], mentionIds: preserved, confidence: 0.82 }],
      roleContexts: [],
    }) };
    return;
  }
  if (system.includes("任务导向的知识技能规范化器")) {
    const tasks = payload.tasks as Array<{ id: string }>;
    const mentions = payload.knowledgeMentions as Array<{ id: string }>;
    yield { type: "text", delta: JSON.stringify({ skills: [{ tempId: "skill-eval", label: "检索质量评测", summary: "设计指标并诊断检索结果。", learningKind: "skill", learningDefinition: { scopeNote: "使用给定检索结果评估召回质量，不涉及模型训练。", assessmentCriteria: ["在固定评测集上计算召回指标并定位失败样本"] }, learningOutcome: "能解释并计算核心检索指标", practiceArtifact: "检索评测报告", assessment: "在给定数据集上诊断误差", taskTempIds: tasks.map((item) => item.id), mentionIds: mentions.map((item) => item.id), confidence: 0.78 }] }) };
    return;
  }
  if (system.includes("跨任务能力归纳器")) {
    yield { type: "text", delta: JSON.stringify({ capabilities: [] }) };
    return;
  }
  if (system.includes("任务锚定的岗位事理抽取器")) {
    const tasks = payload.tasks as Array<{ id: string; label: string }>;
    const segments = payload.segments as Array<{ id: string }>;
    const evidenceSegmentId = segments.at(-1)?.id || "seg:missing";
    yield { type: "text", delta: JSON.stringify({
      scenarios: [{ tempId: "s1", label: "交付 RAG 应用", summary: "从需求确认到上线评测。", trigger: "业务提出知识问答需求", outcome: "可运行 RAG 服务", knowledgeState: "observed_pattern", evidenceSegmentIds: [evidenceSegmentId] }],
      nodes: [
        { tempId: "e0", scenarioTempId: "s1", kind: "event", label: "确认知识问答需求", summary: "确认范围和验收标准。", sequenceHint: 1, knowledgeState: "observed_pattern", evidenceSegmentIds: [evidenceSegmentId] },
        { tempId: "e1", scenarioTempId: "s1", kind: "event", label: "构建 RAG 链路", summary: "实现检索与生成链路。", sequenceHint: 2, knowledgeState: "observed_pattern", evidenceSegmentIds: [evidenceSegmentId] },
        { tempId: "a1", scenarioTempId: "s1", kind: "artifact", label: "RAG 服务", summary: "可部署的应用服务。", sequenceHint: 3, knowledgeState: "observed_pattern", evidenceSegmentIds: [evidenceSegmentId] },
      ],
      edges: [{ type: "directly_follows", sourceTempId: "e0", targetTempId: "e1", evidenceSegmentIds: [evidenceSegmentId] }, { type: "produces", sourceTempId: "e1", targetTempId: "a1", evidenceSegmentIds: [evidenceSegmentId] }],
      bridges: [{ processTempId: "e1", semanticLabel: tasks[0].label, type: "realizes_task", confidence: 0.74 }],
    }) };
    return;
  }
  yield { type: "text", delta: JSON.stringify({}) };
};

function request(): ColdStartRequest {
  return {
    runId: "run-cold-start-test",
    projectId: "project-cold-start-test",
    roleTitle: "大模型应用工程师",
    roleDescription: "研究这个岗位的任务、能力和真实工作方式。",
    market: "中国大陆",
    audience: ["高职学生", "教师"],
    snapshotAsOf: "2026-08-21",
    sources: [{
      title: "岗位实践说明",
      kind: "public_document",
      searchCategories: ["work_practice"],
      content: "工作流程显示：大模型应用工程师负责 RAG 系统构建，交付 RAG 服务，并使用检索质量评测检查效果。典型过程包括构建 RAG 链路和形成可运行服务。",
    }],
  };
}

test("冷启动 Skill 从共享证据编译含三命名空间的统一岗位包", async () => {
  const graph = createColdStartSkill(fakeModel);
  const state = await graph.invoke(
    { request: request(), laneFailures: [] },
    { configurable: { thread_id: "cold-start-invoke" } },
  );
  const result = state.result!;
  assert.equal(result.semantic.nodes.filter((node) => node.type === "knowledge_skill").length, 1);
  assert.ok(result.semantic.edges.some((edge) => edge.type === "performs"), "编译器应补齐岗位到任务的候选关系");
  assert.ok(result.sources.evidenceBindings.length > 0);
  assert.ok(result.process.bridges.some((bridge) => bridge.type === "realizes_task"));
  assert.equal(result.process.scenarios[0].knowledgeState, "inferred_pattern", "公开描述不能被模型提升为真实观察");
  assert.ok(result.snapshot.sections.some((section) => section.id === "work-process"));
  assert.equal(result.packages.rolePackage.protocolVersion, "3.0.0");
  assert.deepEqual(Object.keys(result.packages.rolePackage.namespaces).sort(), ["evidence", "process", "semantic"]);
  assert.match(result.packages.rolePackage.packageVersion, /^0\.1\.0-candidate\.[a-z0-9]+$/);
  assert.equal(result.snapshot.id, result.packages.rolePackage.snapshotId);
  assert.match(result.snapshot.id, /^snapshot:[a-z0-9]+@2026-08-21:[a-z0-9]+$/);
  assert.ok(result.audit.inspection, "冷启动完成后应保留非阻断结构检查结果");
  assert.equal(result.audit.inspection?.protocolValid, true);
  assert.equal(result.build?.workflowVersion, "4.3");
  assert.ok(result.build?.workItems.some((item) => item.stage === "task-normalization"));
  assert.ok(result.sources.mentions?.some((mention) => mention.evidenceSpan?.quote === "大模型应用工程师负责 RAG 系统构建"));
  assert.equal(result.validation.publishable, false, "只有推断型事理模式时应保持候选状态");
});

test("知识 Lane 最多补齐一轮，保留已通过点并拒绝综合能力误分类", async () => {
  let knowledgeCalls = 0;
  const model: ModelInvoker = async function* (input) {
    if (!input.system.includes("任务导向的知识技能规范化器")) { yield* fakeModel(input); return; }
    knowledgeCalls += 1;
    const payload = JSON.parse(input.user);
    const segment = payload.evidenceSegments.find((item: { text: string }) => item.text.includes("使用检索质量评测检查效果"));
    const point = { tempId: "point", label: knowledgeCalls === 1 ? "检索质量评测" : "检索效果判定规则", summary: "使用评测检查检索效果。",
      learningKind: knowledgeCalls === 1 ? "skill" : "knowledge", learningDefinition: { scopeNote: "评估给定检索结果，不涉及模型训练。", assessmentCriteria: ["在给定评测样本上说明效果判定依据"] },
      taskTempIds: payload.tasks.map((task: { id: string }) => task.id), evidenceSpans: [{ segmentId: segment.id, quote: "使用检索质量评测检查效果" }], confidence: 0.7 };
    if (knowledgeCalls === 1) yield { type: "text", delta: JSON.stringify({ skills: [point, { ...point, tempId: "bad-capability", label: "协调与组织能力", learningKind: "hybrid" }] }) };
    else {
      assert.equal(payload.repair.acceptedPoints[0].label, "检索质量评测");
      assert.match(payload.repair.issues[0].detail, /综合能力/u);
      yield { type: "text", delta: JSON.stringify({ skills: [point] }) };
    }
  };
  const built = await createColdStartSkill(model).invoke({ request: { ...request(), runId: "bounded-knowledge-repair" }, laneFailures: [] });
  const points = built.result!.semantic.nodes.filter((node) => node.type === "knowledge_skill");
  assert.equal(knowledgeCalls, 2);
  assert.deepEqual(new Set(points.map((point) => point.label)), new Set(["检索质量评测", "检索效果判定规则"]));
  assert.ok(points.every((point) => point.learningDefinition && point.learningKind !== "hybrid"));
  assert.ok(built.result!.build!.workItems.some((item) => item.lane.endsWith(":coverage-repair")));
});

test("有限补齐仍无证据时保留显式知识缺口，不制造任务来源支持的伪知识", async () => {
  let knowledgeCalls = 0;
  const model: ModelInvoker = async function* (input) {
    if (!input.system.includes("任务导向的知识技能规范化器")) { yield* fakeModel(input); return; }
    knowledgeCalls += 1;
    const payload = JSON.parse(input.user);
    yield { type: "text", delta: JSON.stringify({ skills: [], gaps: payload.tasks.map((task: { id: string }) => ({ taskTempId: task.id, reason: "来源没有说明可复核的评测方法和评价条件。" })) }) };
  };
  const built = await createColdStartSkill(model).invoke({ request: { ...request(), runId: "bounded-knowledge-gap" }, laneFailures: [] });
  assert.equal(knowledgeCalls, 2);
  assert.equal(built.result!.semantic.nodes.filter((node) => node.type === "knowledge_skill").length, 0);
  assert.equal(built.result!.build!.enrichment!.status, "degraded");
  assert.ok(built.result!.audit.issues.some((issue) => /知识技能覆盖缺口/u.test(issue.detail)));
});

test("任务屏障后知识技能、能力与事理 Lane 真正并行，而不是按产物串行等待", async () => {
  const intervals = {
    knowledge: { startedAt: 0, endedAt: 0 },
    process: { startedAt: 0, endedAt: 0 },
  };
  const parallelModel: ModelInvoker = async function* (input) {
    if (input.system.includes("任务导向的知识技能规范化器") && !intervals.knowledge.startedAt) {
      intervals.knowledge.startedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 40));
      for await (const chunk of fakeModel(input)) yield chunk;
      intervals.knowledge.endedAt = Date.now();
      return;
    }
    if (input.system.includes("任务锚定的岗位事理抽取器") && !intervals.process.startedAt) {
      intervals.process.startedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 40));
      for await (const chunk of fakeModel(input)) yield chunk;
      intervals.process.endedAt = Date.now();
      return;
    }
    for await (const chunk of fakeModel(input)) yield chunk;
  };
  const state = await createColdStartSkill(parallelModel).invoke(
    { request: request(), laneFailures: [] },
    { configurable: { thread_id: "cold-start-parallel-derived-lanes" } },
  );
  assert.ok(state.result);
  assert.ok(intervals.knowledge.startedAt && intervals.process.startedAt);
  assert.equal(
    Math.max(intervals.knowledge.startedAt, intervals.process.startedAt) < Math.min(intervals.knowledge.endedAt, intervals.process.endedAt),
    true,
    "两个 Lane 的执行区间必须重叠；谁先启动不应成为编排契约",
  );
});

test("同一时点的冷启动也生成不可变的精确快照身份", async () => {
  const graph = createColdStartSkill(fakeModel);
  const first = await graph.invoke(
    { request: request(), laneFailures: [] },
    { configurable: { thread_id: "cold-start-version-one" } },
  );
  const secondRequest = { ...request(), runId: "run-cold-start-test-two" };
  const second = await graph.invoke(
    { request: secondRequest, laneFailures: [] },
    { configurable: { thread_id: "cold-start-version-two" } },
  );
  assert.notEqual(first.result!.packages.rolePackage.packageVersion, second.result!.packages.rolePackage.packageVersion);
  assert.notEqual(first.result!.snapshot.id, second.result!.snapshot.id);
  assert.match(first.result!.snapshot.id, /@2026-08-21:/);
});

test("冷启动 Skill 按事件流暴露证据、双图、快照、审计和包编译进程", async () => {
  const graph = createColdStartSkill(fakeModel);
  const events: BuildEvent[] = [];
  const stream = await graph.stream(
    { request: request(), laneFailures: [] },
    { configurable: { thread_id: "cold-start-stream" }, streamMode: "custom" },
  );
  for await (const event of stream) events.push(event as BuildEvent);
  const kinds = new Set(events.map((event) => event.kind));
  for (const expected of [
    "build.source.segmented",
    "build.source.qualified",
    "build.work_item.started",
    "build.task_barrier.completed",
    "build.fast_snapshot.completed",
    "build.evidence.bound",
    "build.semantic.patch",
    "build.process.patch",
    "build.inspection.started",
    "build.inspection.completed",
    "build.snapshot.section.drafted",
    "build.package.validation.completed",
    "build.run.completed",
  ] as const) assert.ok(kinds.has(expected), `缺少 ${expected}`);
  const fastEvent = events.find((event) => event.kind === "build.fast_snapshot.completed")!;
  const fastResult = fastEvent.payload.result as ColdStartBuildResult;
  const finalResult = events.findLast((event) => event.kind === "build.run.completed")!.payload.result as ColdStartBuildResult;
  assert.ok(fastResult.semantic.nodes.some((node) => node.type === "task"), "快速快照必须包含任务屏障产物");
  assert.equal(fastResult.process.scenarios.length, 0, "快速快照不得伪造尚未展开的事理森林");
  assert.equal(fastResult.snapshot.status, "candidate");
  assert.notEqual(fastResult.snapshot.id, finalResult.snapshot.id, "快速快照与完整快照必须是两个不可变版本");
  assert.ok(events.indexOf(fastEvent) < events.findIndex((event) => event.kind === "build.targeted_research.started") || !kinds.has("build.targeted_research.started"));
  assert.ok(events.some((event) => event.kind === "build.reasoning.delta" && event.profile === "semantic"));
  assert.ok(events.some((event) => event.kind === "build.reasoning.delta" && event.profile === "process"));
  assert.deepEqual(events.map((event) => event.seq), [...events].sort((a, b) => a.seq - b.seq).map((event) => event.seq));
});

test("岗位内核先独立完成并保留全部来源，事理胶囊进入后台队列", async () => {
  const graph = createColdStartSkill(fakeModel, { execution: "kernel" });
  const events: BuildEvent[] = [];
  const stream = await graph.stream(
    { request: { ...request(), runId: "run-kernel-only" }, laneFailures: [] },
    { configurable: { thread_id: "cold-start-kernel-only" }, streamMode: "custom" },
  );
  for await (const event of stream) events.push(event as BuildEvent);
  const kernelEvent = events.find((event) => event.kind === "build.kernel.completed");
  assert.ok(kernelEvent, "必须产生可以单独提交的岗位内核");
  assert.equal(events.some((event) => event.kind === "build.run.completed"), false, "内核请求不能等待后台完整构建");
  const result = kernelEvent.payload.result as ColdStartBuildResult;
  assert.equal(result.build?.stage, "kernel");
  assert.equal(result.build?.enrichment?.status, "queued");
  assert.deepEqual(result.build?.enrichment?.pendingLanes, ["capability", "knowledge", "skill_dependencies", "process", "inspection"]);
  assert.equal(result.semantic.nodes.some((node) => node.type === "knowledge_skill" || node.type === "capability"), false, "首个内核不能等待能力或知识生成");
  assert.ok(result.sources.assets.length > 0 && result.sources.segments.length > 0 && (result.sources.mentions?.length || 0) > 0);
  assert.ok((result.process.capsules?.length || 0) > 0);
  assert.ok(result.process.capsules?.every((capsule) => capsule.expansionStatus === "queued"));
  assert.ok(result.semantic.nodes.filter((node) => node.defaultVisibility !== false).length > 1);
  assert.equal(result.build?.workItems.some((item) => item.stage === "kernel-knowledge-domains" || item.stage === "kernel-capabilities"), false);
  assert.ok((result.build?.metrics.firstKernelMs || 0) - (result.build?.metrics.firstTaskSkeletonMs || 0) < 1_000, "任务屏障后只能做确定性编译，不能再等待模型");
});

test("岗位内核返回后，语义增量先于事理增量形成两个可提交版本", async () => {
  const kernelState = await createColdStartSkill(fakeModel, { execution: "kernel" }).invoke(
    { request: { ...request(), runId: "run-kernel-for-enrichment" }, laneFailures: [] },
    { configurable: { thread_id: "cold-start-kernel-for-enrichment" } },
  );
  const kernel = kernelState.result!;
  const events: BuildEvent[] = [];
  const enrichment = createColdStartSkill(fakeModel, { execution: "enrichment" });
  const stream = await enrichment.stream(
    {
      request: { ...request(), runId: "run-background-enrichment" },
      baseResult: kernel,
      laneFailures: [],
    },
    { configurable: { thread_id: "cold-start-background-enrichment" }, streamMode: "custom" },
  );
  for await (const event of stream) events.push(event as BuildEvent);
  const semanticEvent = events.find((event) => event.kind === "build.enrichment.semantic.completed");
  const processEvent = events.find((event) => event.kind === "build.enrichment.process.completed");
  const finalEvent = events.find((event) => event.kind === "build.run.completed");
  assert.ok(semanticEvent && processEvent && finalEvent);
  assert.ok(events.indexOf(semanticEvent) < events.indexOf(processEvent));
  assert.ok(events.indexOf(processEvent) < events.indexOf(finalEvent));
  const semantic = semanticEvent.payload.result as ColdStartBuildResult;
  const final = finalEvent.payload.result as ColdStartBuildResult;
  assert.equal(semantic.build?.stage, "semantic_enrichment");
  assert.equal(semantic.build?.enrichment?.status, "running");
  assert.ok(semantic.build?.enrichment?.completedLanes.includes("capability"), "后台语义版本必须处理跨任务能力分支");
  assert.ok(semantic.semantic.nodes.filter((node) => node.defaultVisibility !== false).length > kernel.semantic.nodes.filter((node) => node.defaultVisibility !== false).length, "后台语义版本必须在默认图谱中可见地生长");
  assert.ok(semantic.semantic.nodes.some((node) => node.type === "knowledge_skill" && node.defaultVisibility !== false), "代表知识技能应提升为可见内核节点");
  assert.equal(final.build?.stage, "full_enrichment");
  assert.ok(final.process.scenarios.length > 0);
  assert.ok(final.process.capsules?.every((capsule) => capsule.expansionStatus === "complete" || capsule.expansionStatus === "degraded"));
  assert.equal(final.sources.assets.length, kernel.sources.assets.length, "无补研时后台增量不得丢失内核来源");
  assert.notEqual(kernel.snapshot.id, semantic.snapshot.id);
  assert.notEqual(semantic.snapshot.id, final.snapshot.id);
});

test("事理派生失败时保留任务屏障形成的快速快照，并只标记受影响工作项", async () => {
  const partialProcessModel: ModelInvoker = async function* (input) {
    if (input.system.includes("任务锚定的岗位事理抽取器")) throw new Error("simulated task group timeout");
    for await (const part of fakeModel(input)) yield part;
  };
  const graph = createColdStartSkill(partialProcessModel);
  const events: BuildEvent[] = [];
  const stream = await graph.stream(
    { request: { ...request(), runId: "run-partial-process" }, laneFailures: [] },
    { configurable: { thread_id: "cold-start-partial-process" }, streamMode: "custom" },
  );
  for await (const event of stream) events.push(event as BuildEvent);
  const result = events.findLast((event) => event.kind === "build.run.completed")!.payload.result as ColdStartBuildResult;
  assert.equal(result.process.scenarios.length, 0);
  assert.ok(result.semantic.nodes.some((node) => node.type === "task" && node.label === "RAG 系统构建"));
  assert.ok(result.audit.issues.some((issue) => issue.code === "LANE_FALLBACK" && issue.detail.includes("事理展开失败")));
  assert.ok(result.build?.workItems.some((item) => item.stage === "task-process-expansion" && item.status === "failed"));
  const barrierIndex = events.findIndex((event) => event.kind === "build.task_barrier.completed");
  const failedIndex = events.findIndex((event) => event.kind === "build.work_item.failed" && (event.payload.workItem as { stage?: string }).stage === "task-process-expansion");
  assert.ok(barrierIndex >= 0 && failedIndex > barrierIndex, "派生失败必须发生在稳定任务屏障之后");
});

test("模型分支返回非法结构时保守降级，但仍保留证据、快照骨架和可研究问题", async () => {
  const invalidModel: ModelInvoker = async function* () {
    yield { type: "reasoning", delta: "尝试抽取。" };
    yield { type: "text", delta: "这不是合法 JSON" };
  };
  const graph = createColdStartSkill(invalidModel);
  const state = await graph.invoke(
    { request: { ...request(), sources: [] }, laneFailures: [] },
    { configurable: { thread_id: "cold-start-fallback" } },
  );
  const result = state.result!;
  assert.equal(result.semantic.nodes.filter((node) => node.type === "market_role").length, 1);
  assert.equal(result.process.scenarios.length, 0);
  assert.ok(result.snapshot.sections.some((section) => section.id === "implicit-responsibilities"));
  assert.ok(result.audit.issues.some((issue) => issue.code === "NO_EXTERNAL_EVIDENCE"));
  assert.ok(result.audit.issues.filter((issue) => issue.code === "LANE_FALLBACK").length >= 1);
  assert.equal(result.validation.publishable, false);
});

test("模型引用不存在的片段时在 mention 层拒绝，绝不回退到用户简报", async () => {
  const invalidEvidenceModel: ModelInvoker = async function* ({ system }) {
    if (system.includes("岗位证据原子抽取器")) {
      yield {
        type: "text",
        delta: JSON.stringify({
          mentions: [{
            tempId: "m1",
            kind: "task",
            label: "不存在证据的任务",
            definitionHint: "这条内容不应被自动绑定到任何来源。",
            attributes: {},
            sourceSegmentId: "seg:model-hallucinated",
            evidenceSpan: { segmentId: "seg:model-hallucinated", quote: "不存在的原文" },
            confidence: 0.9,
          }],
          propositions: [],
        }),
      };
      return;
    }
    for await (const part of fakeModel({ system, user: JSON.stringify({ mentions: [], candidates: [] }) })) yield part;
  };
  const graph = createColdStartSkill(invalidEvidenceModel);
  const state = await graph.invoke(
    { request: request(), laneFailures: [] },
    { configurable: { thread_id: "cold-start-invalid-evidence" } },
  );
  const result = state.result!;
  assert.equal(result.sources.mentions?.some((mention) => mention.surfaceForm === "不存在证据的任务"), false);
  assert.equal(result.semantic.nodes.some((node) => node.label === "不存在证据的任务"), false);
  assert.equal(result.validation.publishable, false);
});
