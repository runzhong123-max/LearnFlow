import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInvoker } from "@/lib/agent/model";
import { compileProcessDraft, prepareBuildInput } from "@/lib/build/compiler";
import { createColdStartSkill } from "@/lib/build/graph";
import type { ColdStartRequest, SourceAsset } from "@/lib/build/types";
import { createSourceShards, qualifySource, qualifySources, selectKernelSourceShards } from "@/lib/build/workflow";

function source(overrides: Partial<SourceAsset> & Pick<SourceAsset, "id" | "title">): SourceAsset {
  return {
    kind: "public_document",
    contentHash: "content",
    visibility: "publishable_metadata",
    ...overrides,
  };
}

test("来源资格按可承担的证据角色判定，不把教程营销页冒充官方或工作实践", () => {
  const segments = [{ id: "seg:one", sourceId: "src:noisy", ordinal: 0, contentHash: "x", text: "零基础速成教程，立即报名并加微信领取简历模板。" }];
  const noisy = qualifySource(source({ id: "src:noisy", title: "速成课", locator: "https://blog.csdn.net/example", sourceTier: "contextual", searchCategories: ["official_standard", "work_practice"] }), segments);
  assert.equal(noisy.status, "quarantined");
  assert.deepEqual(noisy.evidenceRoles, []);

  const technicalSegments = [{ id: "seg:tech", sourceId: "src:tech", ordinal: 0, contentHash: "y", text: "官方 API 技术文档说明架构、接口和 SDK 的工程实践。" }];
  const technical = qualifySource(source({ id: "src:tech", title: "API Reference", locator: "https://docs.example.com/reference", sourceTier: "primary", searchCategories: ["technology"] }), technicalSegments);
  assert.ok(technical.evidenceRoles.includes("technology_primary"));
});

test("任务屏障只调度当前工作证据，技术、教学和未来信号仍保存在来源层但不污染任务", () => {
  const segments = [
    { id: "seg:work", sourceId: "src:work", ordinal: 0, contentHash: "work", text: "岗位职责包括设计接口、发布服务并处理线上故障。" },
    { id: "seg:future", sourceId: "src:future", ordinal: 0, contentHash: "future", text: "未来趋势可能让工程师转向管理智能体团队。" },
    { id: "seg:tech", sourceId: "src:tech", ordinal: 0, contentHash: "tech", text: "官方 API 技术文档说明接口和 SDK。" },
  ];
  const assets = qualifySources([
    source({ id: "src:work", title: "岗位职责", searchCategories: ["job_market"] }),
    source({ id: "src:future", title: "趋势报告", searchCategories: ["future_signal"] }),
    source({ id: "src:tech", title: "API Reference", locator: "https://docs.example.com/reference", sourceTier: "primary", searchCategories: ["technology"] }),
  ], segments);
  assert.equal(assets.length, 3, "所有来源都必须继续进入证据索引");
  const shards = createSourceShards({ assets, segments });
  assert.deepEqual(shards.map((shard) => shard.sourceId), ["src:work"]);
});

test("低相关相邻岗位 JD 保留在证据层，但不占用岗位内核抽取关键路径", () => {
  const segments = [
    { id: "seg:target", sourceId: "src:target", ordinal: 0, contentHash: "target", text: "数据平台工程师岗位职责包括设计数据平台架构与处理链路。" },
    { id: "seg:adjacent", sourceId: "src:adjacent", ordinal: 0, contentHash: "adjacent", text: "交付工程师岗位职责包括现场部署、验收和交付文档编制。" },
  ];
  const assets = qualifySources([
    source({ id: "src:target", title: "数据平台工程师招聘", searchCategories: ["job_market"], retrievalScore: 0.86 }),
    source({ id: "src:adjacent", title: "交付工程师招聘", searchCategories: ["job_market"], retrievalScore: 0.69 }),
  ], segments);
  const allShards = createSourceShards({ assets, segments });
  const routed = selectKernelSourceShards({ shards: allShards, assets, roleTitle: "数据平台工程师" });
  assert.deepEqual(routed.selected.map((shard) => shard.sourceId), ["src:target"]);
  assert.deepEqual(routed.deferred.map((shard) => shard.sourceId), ["src:adjacent"]);
  assert.equal(assets.length, 2, "延后只改变调度，不删除来源事实");
});

test("来源分片不会混合不同来源，且每个工作项保持在硬 token 预算内", () => {
  const request: ColdStartRequest = {
    runId: "run-shard-budget",
    projectId: "project-shard-budget",
    roleTitle: "后端开发工程师",
    roleDescription: "验证通用分片调度。",
    market: "中国大陆",
    audience: ["高职学生"],
    snapshotAsOf: "2026-08-23",
    sources: [
      { title: "来源 A", kind: "private_document", content: `${"接口设计与实现。".repeat(900)}\n\n${"编写测试并交付服务。".repeat(900)}` },
      { title: "来源 B", kind: "private_document", content: `${"排查故障并形成复盘。".repeat(900)}\n\n${"监测指标并执行恢复。".repeat(900)}` },
    ],
  };
  const prepared = prepareBuildInput(request);
  const assets = qualifySources(prepared.assets, prepared.segments);
  const shards = createSourceShards({ assets, segments: prepared.segments });
  assert.ok(shards.length >= 3);
  for (const shard of shards) {
    assert.ok(shard.estimatedTokens <= 2_200);
    assert.ok(shard.segments.every((segment) => segment.sourceId === shard.sourceId));
  }
});

test("单个来源分片失败只拆分并重跑该分片，不让整轮冷启动失败", async () => {
  let multiSegmentFailures = 0;
  const model: ModelInvoker = async function* ({ system, user }) {
    if (!system.includes("岗位证据原子抽取器")) {
      yield { type: "text", delta: JSON.stringify({}) };
      return;
    }
    const payload = JSON.parse(user) as { segments: Array<{ id: string }> };
    if (payload.segments.length > 1) {
      multiSegmentFailures += 1;
      throw new Error("simulated oversized shard failure");
    }
    yield { type: "text", delta: JSON.stringify({ mentions: [], propositions: [] }) };
  };
  const paragraph = "设计接口、实现服务并编写测试形成可验收交付物；".repeat(40);
  const request: ColdStartRequest = {
    runId: "run-local-recovery",
    projectId: "project-local-recovery",
    roleTitle: "后端开发工程师",
    roleDescription: "验证分片局部恢复。",
    market: "中国大陆",
    audience: ["高职学生"],
    snapshotAsOf: "2026-08-23",
    sources: [{ title: "两段岗位实践", kind: "private_document", content: `${paragraph}\n\n${paragraph}` }],
  };
  const graph = createColdStartSkill(model);
  const state = await graph.invoke({ request, laneFailures: [] }, { configurable: { thread_id: "local-recovery" } });
  assert.ok(state.result);
  assert.equal(multiSegmentFailures, 1);
  const extractionItems = state.result!.build!.workItems.filter((item) => item.stage === "source-mention-extraction");
  assert.ok(extractionItems.some((item) => item.status === "recovered"));
  assert.ok(extractionItems.filter((item) => item.status === "completed").length >= 2, "两个恢复分片都应完成；有外部工作证据时用户简报不重复占用模型调用");
  assert.equal(state.result!.audit.issues.some((issue) => issue.code === "LANE_FALLBACK" && issue.detail.includes("来源分片")), false);
});

test("单段来源输出截断时以更紧凑配额局部重试，并把父工作项标为 recovered", async () => {
  let targetAttempts = 0;
  const model: ModelInvoker = async function* ({ system, user }) {
    const payload = JSON.parse(user) as Record<string, unknown>;
    if (!system.includes("岗位证据原子抽取器")) {
      yield { type: "text", delta: JSON.stringify({}) };
      return;
    }
    if (payload.sourceTitle === "单段岗位实践") {
      targetAttempts += 1;
      const limits = payload.limits as { mentions: number };
      if (limits.mentions > 5) throw new Error("simulated truncated JSON");
    }
    yield { type: "text", delta: JSON.stringify({ mentions: [], propositions: [] }) };
  };
  const request: ColdStartRequest = {
    runId: "run-single-shard-recovery",
    projectId: "project-single-shard-recovery",
    roleTitle: "后端开发工程师",
    roleDescription: "验证单段紧凑恢复。",
    market: "中国大陆",
    audience: ["高职学生"],
    snapshotAsOf: "2026-08-23",
    sources: [{ title: "单段岗位实践", kind: "private_document", content: "工作流程：设计接口、实现服务并编写测试，形成可部署程序、验证记录等交付物。" }],
  };
  const state = await createColdStartSkill(model).invoke(
    { request, laneFailures: [] },
    { configurable: { thread_id: "single-shard-recovery" } },
  );
  assert.equal(targetAttempts, 2);
  const items = state.result!.build!.workItems.filter((item) => item.stage === "source-mention-extraction");
  assert.ok(items.some((item) => item.lane.includes("单段") || item.status === "recovered"));
  assert.ok(items.some((item) => item.status === "recovered"));
  assert.ok(items.some((item) => item.lane.endsWith(":recovery-1") && item.status === "completed"));
  assert.equal(state.result!.audit.issues.some((issue) => issue.code === "LANE_FALLBACK" && issue.detail.includes("来源分片")), false);
});

test("事理知识状态由证据来源确定，工作区观察不会因模型保守标签降为推断", () => {
  const segments = [{ id: "seg:workspace", sourceId: "src:workspace", ordinal: 0, contentHash: "observed", text: "值班人员确认影响后回滚版本并形成事故报告。" }];
  const assets = [source({
    id: "src:workspace",
    title: "事故处置记录",
    kind: "workspace_observation",
    qualification: { status: "accepted", evidenceRoles: ["workspace_observation", "work_practice"], reasons: ["工作观察"] },
  })];
  const process = compileProcessDraft({
    draft: {
      scenarios: [
        { tempId: "s1", label: "处置服务事故", summary: "从确认影响到恢复服务。", trigger: "服务异常", outcome: "服务恢复", knowledgeState: "inferred_pattern", evidenceSegmentIds: ["seg:workspace"], evidenceSpans: [{ segmentId: "seg:workspace", quote: "确认影响后回滚版本并形成事故报告" }] },
        { tempId: "s2", label: "处置服务事故", summary: "确认影响、回滚版本并形成事故报告。", trigger: "服务指标异常", outcome: "服务恢复且报告完成", knowledgeState: "inferred_pattern", evidenceSegmentIds: ["seg:workspace"], evidenceSpans: [{ segmentId: "seg:workspace", quote: "确认影响后回滚版本并形成事故报告" }] },
      ],
      nodes: [
        { tempId: "e1", scenarioTempId: "s1", kind: "event", label: "回滚版本", summary: "执行版本回滚。", sequenceHint: 1, knowledgeState: "inferred_pattern", evidenceSegmentIds: ["seg:workspace"], evidenceSpans: [{ segmentId: "seg:workspace", quote: "回滚版本" }] },
        { tempId: "e2", scenarioTempId: "s2", kind: "event", label: "回滚版本", summary: "通过版本回滚恢复服务。", sequenceHint: 2, knowledgeState: "inferred_pattern", evidenceSegmentIds: ["seg:workspace"], evidenceSpans: [{ segmentId: "seg:workspace", quote: "回滚版本" }] },
      ],
      edges: [],
      bridges: [],
    },
    segments,
    assets,
    semanticNodes: [],
  });
  assert.equal(process.scenarios[0].knowledgeState, "observed_pattern");
  assert.equal(process.nodes[0].knowledgeState, "observed_pattern");
  assert.equal(process.scenarios[0].lifecycle, "stable");
  assert.equal(process.scenarios.length, 1, "并行分组不得留下重复场景 ID");
  assert.equal(process.nodes.length, 1, "并行分组不得留下重复事件 ID");
});

test("相同输入可复用确定性工作项缓存，缓存命中仍产生完整不可变快照", async () => {
  let calls = 0;
  const model: ModelInvoker = async function* ({ system }) {
    calls += 1;
    if (system.includes("岗位证据原子抽取器")) yield { type: "text", delta: JSON.stringify({ mentions: [], propositions: [] }) };
    else yield { type: "text", delta: JSON.stringify({}) };
  };
  const request: ColdStartRequest = {
    runId: "run-cache-reuse",
    projectId: "project-cache-reuse",
    roleTitle: "软件测试工程师",
    roleDescription: "验证工作项缓存。",
    market: "中国大陆",
    audience: ["高职学生"],
    snapshotAsOf: "2026-08-23",
    sources: [{ title: "岗位说明", kind: "private_document", content: "设计测试用例并执行回归测试，形成测试报告。" }],
  };
  const cache = new Map<string, unknown>();
  const graph = createColdStartSkill(model, { cache });
  const first = await graph.invoke({ request, laneFailures: [] }, { configurable: { thread_id: "cache-first" } });
  const callsAfterFirst = calls;
  const second = await graph.invoke({ request, laneFailures: [] }, { configurable: { thread_id: "cache-second" } });
  assert.equal(calls, callsAfterFirst);
  assert.ok(second.result!.build!.workItems.every((item) => item.cacheHit));
  assert.equal(first.result!.snapshot.id, second.result!.snapshot.id);
});

test("任务派生组超时后只二分重跑该组，并把完全恢复的父工作项标记为 recovered", async () => {
  const model: ModelInvoker = async function* ({ system, user }) {
    const payload = JSON.parse(user) as Record<string, unknown>;
    if (system.includes("岗位证据原子抽取器")) {
      const segment = (payload.segments as Array<{ id: string }>)[0];
      yield { type: "text", delta: JSON.stringify({
        mentions: [
          { tempId: "m1", kind: "task", label: "设计接口", definitionHint: "设计服务接口并形成接口定义。", attributes: { workObject: "服务需求", action: "设计接口", deliverable: "接口定义", acceptance: "通过评审" }, sourceSegmentId: segment.id, evidenceSpan: { segmentId: segment.id, quote: "设计服务接口并形成接口定义" }, confidence: 0.8 },
          { tempId: "m2", kind: "task", label: "实现服务", definitionHint: "实现服务并形成可部署程序。", attributes: { workObject: "接口定义", action: "实现服务", deliverable: "可部署程序", acceptance: "通过测试" }, sourceSegmentId: segment.id, evidenceSpan: { segmentId: segment.id, quote: "实现服务并形成可部署程序" }, confidence: 0.8 },
          { tempId: "k1", kind: "knowledge_skill", label: "接口契约测试", definitionHint: "验证接口实现是否符合契约。", attributes: {}, sourceSegmentId: segment.id, evidenceSpan: { segmentId: segment.id, quote: "接口契约测试" }, confidence: 0.75 },
          { tempId: "e1", kind: "work_event", label: "执行接口契约测试", definitionHint: "对服务执行契约验证。", attributes: {}, sourceSegmentId: segment.id, evidenceSpan: { segmentId: segment.id, quote: "执行接口契约测试" }, confidence: 0.72 },
        ],
        propositions: [],
      }) };
      return;
    }
    if (system.includes("典型工作任务规范化器") || system.includes("典型工作任务全局归并器")) {
      const mentions = (payload.mentions || []) as Array<{ id: string; label: string }>;
      const candidates = (payload.candidates || []) as Array<{ tasks: Array<{ mentionIds: string[] }> }>;
      const ids = mentions.length ? mentions.map((item) => item.id) : candidates.flatMap((item) => item.tasks.flatMap((task) => task.mentionIds));
      yield { type: "text", delta: JSON.stringify({
        roleSummary: "负责设计并实现后端服务。",
        tasks: [
          { tempId: "t1", label: "设计服务接口", summary: "形成可评审的接口定义。", workObject: "服务需求", action: "设计接口", deliverable: "接口定义", acceptance: "通过评审", aliases: [], mentionIds: ids.slice(0, 1), confidence: 0.8 },
          { tempId: "t2", label: "实现后端服务", summary: "形成通过测试的可部署程序。", workObject: "接口定义", action: "实现服务", deliverable: "可部署程序", acceptance: "通过测试", aliases: [], mentionIds: ids.slice(1, 2), confidence: 0.8 },
        ],
        roleContexts: [],
      }) };
      return;
    }
    if (system.includes("任务导向的知识技能规范化器")) {
      const tasks = payload.tasks as Array<{ id: string; label: string }>;
      if (tasks.length > 1) throw new Error("simulated oversized knowledge group");
      const segment = (payload.evidenceSegments as Array<{ id: string; text: string }>)[0];
      yield { type: "text", delta: JSON.stringify({ skills: [{ tempId: "skill", label: `${tasks[0].label}的验收方法`, summary: "用于验证任务交付质量。", learningKind: "knowledge", learningDefinition: { scopeNote: "针对给定接口交付的验收方法。", assessmentCriteria: ["解释接口契约与测试结论的对应关系"] }, evidenceSpans: [{ segmentId: segment.id, quote: segment.text }], learningOutcome: "能解释验收标准", practiceArtifact: "验收记录", assessment: "完成一次验证", taskTempIds: [tasks[0].id], mentionIds: [], confidence: 0.7 }] }) };
      return;
    }
    if (system.includes("跨任务能力归纳器")) {
      yield { type: "text", delta: JSON.stringify({ capabilities: [] }) };
      return;
    }
    if (system.includes("任务锚定的岗位事理抽取器")) {
      const tasks = payload.tasks as Array<{ id: string; label: string }>;
      if (tasks.length > 1) throw new Error("simulated oversized process group");
      const segment = (payload.segments as Array<{ id: string }>)[0];
      yield { type: "text", delta: JSON.stringify({
        scenarios: [{ tempId: "s", label: `${tasks[0].label}工作周期`, summary: "从触发到交付。", trigger: "收到任务", outcome: "完成交付", knowledgeState: "inferred_pattern", evidenceSegmentIds: [segment.id] }],
        nodes: [
          { tempId: "a", scenarioTempId: "s", kind: "event", label: "确认输入", summary: "确认任务输入。", sequenceHint: 1, knowledgeState: "inferred_pattern", evidenceSegmentIds: [segment.id] },
          { tempId: "b", scenarioTempId: "s", kind: "event", label: "完成任务", summary: "执行并形成交付。", sequenceHint: 2, knowledgeState: "inferred_pattern", evidenceSegmentIds: [segment.id] },
        ],
        edges: [{ type: "directly_follows", sourceTempId: "a", targetTempId: "b", evidenceSegmentIds: [segment.id] }],
        bridges: [{ processTempId: "b", semanticLabel: tasks[0].label, type: "realizes_task", confidence: 0.7 }],
      }) };
      return;
    }
    yield { type: "text", delta: JSON.stringify({}) };
  };
  const request: ColdStartRequest = {
    runId: "run-derived-recovery",
    projectId: "project-derived-recovery",
    roleTitle: "后端开发工程师",
    roleDescription: "验证任务组局部恢复。",
    market: "中国大陆",
    audience: ["高职学生"],
    snapshotAsOf: "2026-08-23",
    sources: [{ title: "岗位实践", kind: "private_document", content: "设计服务接口并形成接口定义，实现服务并形成可部署程序，使用接口契约测试并执行接口契约测试。" }],
  };
  const graph = createColdStartSkill(model);
  const state = await graph.invoke({ request, laneFailures: [] }, { configurable: { thread_id: "derived-recovery" } });
  const result = state.result!;
  assert.equal(result.semantic.nodes.filter((node) => node.type === "task").length, 2);
  assert.equal(result.semantic.nodes.filter((node) => node.type === "knowledge_skill").length, 2);
  assert.equal(result.process.scenarios.length, 2);
  assert.ok(result.build!.workItems.some((item) => item.stage === "task-knowledge-derivation" && item.status === "recovered"));
  assert.ok(result.build!.workItems.some((item) => item.stage === "task-process-expansion" && item.status === "recovered"));
  assert.ok(result.build!.workItems.every((item) => item.maxOutputTokens <= (item.stage === "task-knowledge-derivation" ? 8_000 : item.stage === "cross-task-capability-derivation" ? 8_000 : 6_000)), "知识、能力培养规格和过程各自遵守有界输出预算");
  assert.equal(result.audit.issues.some((issue) => issue.code === "LANE_FALLBACK" && /派生失败|展开失败/u.test(issue.detail)), false);
  assert.ok(result.audit.issues.some((issue) => issue.detail.includes("知识技能覆盖缺口")), "局部恢复只产出知识，没有实操技能时仍保留质量缺口");
});
