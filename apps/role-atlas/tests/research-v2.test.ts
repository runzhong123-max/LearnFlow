import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { reconstructBuildResult, compileStaticRolePackage } from "@/lib/packages/compiler";
import type { StaticRolePackageBundle } from "@/lib/packages/types";
import { researchOptionsSchema, stopResearch, type ResearchRun } from "@/lib/research/protocol";
import { taskDefinitionSchema } from "@/lib/research/task-schema";
import { inspectTaskDefinitions, roleDeliveryReadiness } from "@/lib/research/task-definition";
import { compareResearchQuality } from "@/lib/research/quality";
import { ResearchSourceStore } from "@/lib/research/source-store";
import { createSourceReadTool } from "@/lib/iteration/research-tools";
import { buildResearchAgent } from "@/lib/iteration/research-agent";
import { createBudgetLedger } from "@/lib/iteration/budget-ledger";
import { meteredModel } from "@/lib/research/metered-model";
import { researchRecordTools } from "@/lib/research/record-tools";
import { changeProposalTool, compileResearchChanges } from "@/lib/research/semantic-changes";
import { researchViews } from "@/lib/research/views";
import { claimSchema, createEvidenceReviewer, applyEvidenceReview } from "@/lib/iteration/evidence-review";
import { reviewIterationScope } from "@/lib/iteration/scope";
import { createIterationContract } from "@/lib/iteration/planner";
import { snapshotIterationRequestSchema } from "@/lib/iteration/types";
import { refreshRolePackageManifest } from "@/lib/packages/role-package-manifest";
import type { ModelInvoker } from "@/lib/agent/model";
import type { ColdStartRequest } from "@/lib/build/types";

const directory = "packages/golden/llm-app-engineer/1.0.0";
function golden() {
  const manifest = JSON.parse(readFileSync(`${directory}/manifest.json`, "utf8"));
  return reconstructBuildResult({ manifest, components: Object.fromEntries(Object.keys(manifest.hashes).map(path => [path, readFileSync(`${directory}/${path}`, "utf8")])) } as StaticRolePackageBundle);
}
function request(): ColdStartRequest { const base = golden(); return { runId: "research-v2-test", projectId: base.brief.projectId, roleTitle: base.brief.roleTitle, roleDescription: base.brief.roleDescription, market: base.brief.market, audience: base.brief.audience, snapshotAsOf: base.snapshot.asOf, sources: [], research: researchOptionsSchema.parse({}) }; }
function run(): ResearchRun { return { protocol: "role-research/v2", id: "test-run", intent: { ...researchOptionsSchema.parse({}), roleBoundary: "大模型应用工程师", targetAsOf: "2026-08-24", publication: "explicit_user_action" }, agenda: { revision: 0, tasks: [], gaps: [], findingRefs: [] }, findings: [], changeSets: [] }; }
function native(reply: (input: Parameters<NonNullable<ModelInvoker["chat"]>>[0]) => unknown): ModelInvoker {
  const model: ModelInvoker = async function* () { throw new Error("legacy generator must not run"); };
  model.chat = async input => ({ message: { role: "assistant", content: JSON.stringify(reply(input)) }, finishReason: "stop", usage: { inputTokens: 40, outputTokens: 20, estimated: false } });
  return model;
}

test("金标准包、研究材料与审核记录保持冻结哈希", () => {
  const lock = JSON.parse(readFileSync("evals/golden/llm-app-engineer/research-v2/baseline-lock.json", "utf8"));
  for (const [path, hash] of Object.entries(lock.files)) assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), hash, path);
  assert.equal(JSON.parse(readFileSync(`${directory}/manifest.json`, "utf8")).rootHash, lock.packageRootHash);
});

test("老包缺失任务详情仍为未知，不因迁移获得完整首版标记", () => {
  const base = golden(), before = JSON.stringify(base);
  assert.ok(inspectTaskDefinitions(base).some(task => task.gaps.includes("deliverables")));
  assert.equal(roleDeliveryReadiness(base).ready, false);
  assert.equal(JSON.stringify(base), before);
});

test("受控任务字段变体：交付物缺失、伪造引用和冲突分别阻断转换就绪", () => {
  const base = golden(), task = base.semantic.nodes.find(node => node.type === "task")!;
  const source = base.sources.segments.find(segment => task.evidenceSegmentIds.includes(segment.id))!;
  const field = { text: "测试字段，仅验证结构门禁", basis: "synthesis", evidence: [{ segmentId: source.id, quote: source.text.slice(0, 80) }], review: { status: "supported", reason: "测试用已复核意见" } };
  task.taskDefinition = taskDefinitionSchema.parse({ schemaVersion: "role-task-definition/v1", ...Object.fromEntries(["goal", "trigger", "inputs", "actors", "activities", "deliverables", "qualityCriteria", "exceptions"].map(key => [key, structuredClone(field)])) });
  assert.ok(!inspectTaskDefinitions(base).find(item => item.taskId === task.id)!.gaps.some(gap => gap.startsWith("deliverables")));
  const complete = structuredClone(base);
  task.taskDefinition.deliverables.text = "";
  assert.ok(inspectTaskDefinitions(base).find(item => item.taskId === task.id)!.gaps.includes("deliverables"));
  assert.equal(compareResearchQuality(base, complete).conversionImproved, true);
  task.taskDefinition = structuredClone(complete.semantic.nodes.find(node => node.id === task.id)!.taskDefinition!);
  task.taskDefinition.deliverables.evidence[0].quote = "不在实际原文中的伪造交付物";
  assert.ok(inspectTaskDefinitions(base).find(item => item.taskId === task.id)!.gaps.includes("deliverables:evidence"));
  task.taskDefinition.deliverables.review!.status = "conflicting";
  assert.ok(inspectTaskDefinitions(base).find(item => item.taskId === task.id)!.gaps.includes("deliverables:review"));
});

test("来源库即时共享，读取长内容可续页，重复入库不制造新证据", async () => {
  const store = new ResearchSourceStore(), input = request();
  const tool = createSourceReadTool({ segments: store.segments, assets: store.assets });
  const source = { title: "测试来源", content: "工作交付报告需要包含验收依据。".repeat(100), kind: "public_document" as const, locator: "https://example.com/known" };
  const added = store.ingest(input, [source]);
  assert.ok(added.length);
  const count = store.segments.length; store.ingest(input, [source]); assert.equal(store.segments.length, count);
  store.segments[0].text = "甲".repeat(6100) + "尾部验收条件";
  const first = await tool.run({ segmentId: store.segments[0].id }, { turn: 1 });
  assert.equal((first.data as { nextOffset: number }).nextOffset, 6000);
  const tail = await tool.run({ segmentId: store.segments[0].id, offset: "6000" }, { turn: 2 });
  assert.match((tail.data as { quote: string }).quote, /尾部验收条件/u);
  assert.equal((tail.data as { nextOffset: null }).nextOffset, null);
});

test("实际模型调用前保存预占，usage 对账后重启仍延续账本", async () => {
  const ledger = createBudgetLedger({ total: { queries: 10, tokens: 10000, turns: 20 }, reviewReserve: { queries: 0, tokens: 2000, turns: 4 } });
  const checkpoints: ReturnType<typeof ledger.snapshot>[] = [];
  const model = native(() => { assert.equal(checkpoints.at(-1)!.spent.turns, 1); assert.ok(checkpoints.at(-1)!.spent.tokens > 60); return {}; });
  await meteredModel(model, ledger, "general", async () => { checkpoints.push(ledger.snapshot()); }).chat!({ messages: [{ role: "user", content: "test" }], maxCompletionTokens: 100 });
  assert.equal(ledger.snapshot().spent.tokens, 60);
  const restored = createBudgetLedger({ total: { queries: 10, tokens: 10000, turns: 20 }, reviewReserve: { queries: 0, tokens: 2000, turns: 4 } }, ledger.snapshot());
  assert.deepEqual(restored.snapshot(), ledger.snapshot());
  const failing = native(() => { throw new Error("connection_lost"); });
  await assert.rejects(meteredModel(failing, restored).chat!({ messages: [], maxCompletionTokens: 100 }), /connection_lost/u);
  assert.ok(restored.snapshot().spent.tokens > 60, "不确定失败保留预占，不能免费重试");
});

test("主管新增独立问题，恢复后不重复规划已发放的任务，权限与材料隔离", async () => {
  const base = golden(), selected = base.semantic.nodes.find(node => node.type === "task")!.id;
  let calls = 0;
  const model = native(() => { calls++; return { cards: [{ question: "相邻岗位怎样交接质量要求？", reason: "任务接口缺口", sourceClass: "primary_docs", targetIds: ["foreign-role"], queriesHint: [] }] }; });
  const agent = buildResearchAgent({ model });
  const contract = createIterationContract(snapshotIterationRequestSchema.parse({ runId: "v2-plan", snapshotRef: { snapshotId: base.snapshot.id }, research: researchOptionsSchema.parse({ targetIds: [selected], changeScope: "selected" }) }), base);
  const cards = await agent.plan({ contract, graph: base, workItems: [], round: 1 });
  assert.equal(cards.length, 1); assert.deepEqual(cards[0].targetIds, [selected]); assert.deepEqual(cards[0].inputRefs, ["foreign-role"]);
  const restored = buildResearchAgent({ model }); restored.restore(agent.snapshot());
  assert.deepEqual(await restored.plan({ contract, graph: base, workItems: [], round: 1 }), cards); assert.equal(calls, 1);
  assert.equal(restored.record()?.agenda.tasks.length, 1);
  const modified = structuredClone(base), foreign = modified.semantic.nodes.find(node => node.type === "related_role") || modified.semantic.nodes.find(node => node.id !== selected)!;
  foreign.summary += "未授权改写";
  assert.ok(reviewIterationScope(base, modified, contract).reasons.length);
});

test("缺失概念和时间风险成为后续调查，复核冲突不等于已采用事实", async () => {
  const record = run(), store = new ResearchSourceStore();
  const tool = researchRecordTools({ run: record, store, save: async () => {} }).find(tool => tool.name === "submit_finding")!;
  await tool.run({ claim: { id: "missing", statement: "尚缺少职责移交任务", kind: "absence" }, axis: "temporal", consequence: "下游无法设计完整项目", nextQuestion: "当前资料中谁负责职责移交？" }, { turn: 1 });
  const views = researchViews(record);
  assert.equal(views.risks[0].axis, "temporal"); assert.ok(views.risks[0].missingConcept); assert.equal(views.radar[0].qualityTarget, "project_conversion");
  assert.equal(record.findings[0].adoption, "candidate");
  const claim = claimSchema.parse({ id: "conflict", statement: "验收职责归属", kind: "observed", evidenceSpans: [{ segmentId: "s1", quote: "甲验收" }, { segmentId: "s2", quote: "乙验收" }] });
  const review = await createEvidenceReviewer(native(() => ({ verdicts: [{ claimId: "conflict", verdict: "conflicting", note: "同一情境责任归属相互冲突" }] })))({ claims: [claim], segments: [{ id: "s1", text: "甲验收" }, { id: "s2", text: "乙验收" }] });
  assert.equal(applyEvidenceReview([claim], review)[0].reviewStatus, "conflicting");
  assert.equal(applyEvidenceReview([claim], review)[0].verification, "unverified");
});

test("候选改动固定基线，编译失败不部分写入，越权和无依据不能提交", async () => {
  const base = golden(), before = JSON.stringify(base), record = run();
  const target = base.semantic.nodes.find(node => node.type === "knowledge_skill")!, span = base.sources.segments.find(segment => target.evidenceSegmentIds.includes(segment.id))!;
  record.intent.changeScope = "selected"; record.intent.targetIds = [target.id];
  record.findings.push({ id: "f1", claim: claimSchema.parse({ id: "c1", statement: "需要澄清术语表达", kind: "inferred", evidenceSpans: [{ segmentId: span.id, quote: span.text.slice(0, 80) }], affectedNodeIds: [target.id] }), axis: "relational", consequence: "学生难以理解", review: "supported", adoption: "candidate" });
  const tool = changeProposalTool({ base, run: record, save: async () => {} });
  await assert.rejects(tool.run({ motivation: "越权", findingRefs: ["f1"], operations: [{ kind: "deprecate", targetId: base.semantic.nodes.find(node => node.id !== target.id)!.id }] }, { turn: 1 }), /授权范围/u);
  await tool.run({ motivation: "明确术语适用范围", findingRefs: ["f1"], operations: [{ kind: "revise", targetId: target.id, nodes: [{ label: target.label, summary: `${target.summary}（此为测试候选修订）` }] }] }, { turn: 1 });
  const changed = await compileResearchChanges({ base, candidate: base, run: record, request: request() });
  assert.equal(record.changeSets[0].status, "needs_review");
  assert.match(changed.candidate.semantic.nodes.find(node => node.id === target.id)!.summary, /测试候选修订/u);
  assert.equal(JSON.stringify(base), before);
  const stale = structuredClone(record); stale.changeSets[0].status = "candidate"; stale.changeSets[0].checks = []; stale.changeSets[0].baseRootHash = "0".repeat(64);
  const rejected = await compileResearchChanges({ base, candidate: base, run: stale, request: request() });
  assert.equal(stale.changeSets[0].status, "rejected"); assert.deepEqual(rejected.candidate.semantic.nodes, base.semantic.nodes);
});

test("3.1 包保留任务详情，旧包原始引用与内容哈希不被迁移改写", async () => {
  const base = golden(), original = readFileSync(`${directory}/manifest.json`, "utf8");
  const task = base.semantic.nodes.find(node => node.type === "task")!;
  const unknown = { text: "", basis: "unknown", evidence: [] };
  task.taskDefinition = taskDefinitionSchema.parse({ schemaVersion: "role-task-definition/v1", ...Object.fromEntries(["goal", "trigger", "inputs", "actors", "activities", "deliverables", "qualityCriteria", "exceptions"].map(key => [key, unknown])) });
  const updated = refreshRolePackageManifest(base);
  const compiled = await compileStaticRolePackage({ result: updated, packageId: base.packages.rolePackage.packageId, packageVersion: "test-v3.1", visibility: "private", evidencePolicy: "full" });
  assert.equal(compiled.bundle.manifest.protocolVersion, "3.1.0");
  assert.equal(reconstructBuildResult(compiled.bundle).semantic.nodes.find(node => node.id === task.id)!.taskDefinition?.deliverables.basis, "unknown");
  assert.equal(readFileSync(`${directory}/manifest.json`, "utf8"), original);
});

test("停止策略区分目标达成、资料不足、预算、无进展、取消和失败", () => {
  const defaults = { stagnantRounds: 0, limit: 3 };
  assert.equal(stopResearch({ ...defaults, goalReached: true }), "goal_reached");
  assert.equal(stopResearch({ ...defaults, materialMissing: true }), "insufficient_material");
  assert.equal(stopResearch({ ...defaults, budgetExhausted: true }), "budget_exhausted");
  assert.equal(stopResearch({ ...defaults, stagnantRounds: 3 }), "no_progress");
  assert.equal(stopResearch({ ...defaults, cancelled: true }), "cancelled");
  assert.equal(stopResearch({ ...defaults, failed: true }), "failed");
});

test("冷启动预算不足时只交付可继续的草稿，内核预览不触发正式版本或增量交付", async () => {
  const { createColdStartSkill } = await import("@/lib/build/graph");
  const events: import("@/lib/build/events").BuildEvent[] = [];
  const input = { ...request(), research: researchOptionsSchema.parse({ budget: { tokens: 1000, revisions: 1 } }) };
  const stream = await createColdStartSkill(native(() => ({ cards: [] }))).stream({ request: input, laneFailures: [] }, { streamMode: "custom", recursionLimit: 100 });
  for await (const event of stream) events.push(event as import("@/lib/build/events").BuildEvent);
  const completed = events.filter(event => event.kind === "build.run.completed");
  assert.equal(completed.length, 1);
  const result = completed[0].payload.result as ReturnType<typeof golden>;
  assert.equal(result.deliveryReadiness?.ready, false);
  assert.equal(result.snapshot.status, "candidate");
  assert.equal(result.researchRun?.stopReason, "budget_exhausted");
  assert.ok(events.filter(event => event.kind === "build.kernel.completed").every(event => event.payload.preview === true));
  assert.ok(!events.some(event => event.kind === "build.enrichment.queued"));
});

test("原生多轮搜索后读取新增来源并返回精确引用，搜索只按实际查询记账", async () => {
  const { runResearchLoop } = await import("@/lib/agent/research-loop");
  const { createResearchToolset } = await import("@/lib/iteration/research-tools");
  const input = request(), store = new ResearchSourceStore();
  const ledger = createBudgetLedger({ total: { queries: 4, tokens: 10000, turns: 30 }, reviewReserve: { queries: 0, tokens: 2000, turns: 5 } });
  const previous = globalThis.fetch; let queries = 0;
  const content = "大模型应用工程师负责明确需求并实现应用，检查任务交付物与质量要求。".repeat(80);
  try {
    globalThis.fetch = async () => { queries++; return Response.json({ search_result: [{ title: "大模型应用工程师工作任务与交付要求", link: "https://docs.langchain.com/known-test", content, publish_date: "2026-08-20" }] }); };
    const tools = createResearchToolset({ request: input, config: { provider: "glm", apiKey: "test-only" }, segments: store.segments, assets: store.assets, store, ledger });
    const model = native(() => ({}));
    model.chat = async ({ messages }) => {
      const results = messages.filter(message => message.role === "tool");
      let message: import("@/lib/agent/native-model").ChatMessage;
      if (!results.length) message = { role: "assistant", content: null, tool_calls: [{ id: "search-1", type: "function", function: { name: "search_web", arguments: JSON.stringify({ query: "大模型应用工程师 任务交付" }) } }] };
      else if (results.length === 1) {
        const search = JSON.parse(results[0].content!);
        assert.ok(search.data.sourceIndex.length, JSON.stringify(search));
        message = { role: "assistant", content: null, tool_calls: [{ id: "read-1", type: "function", function: { name: "read_source", arguments: JSON.stringify({ segmentId: search.data.sourceIndex[0].segmentId }) } }] };
      } else { const source = JSON.parse(results[1].content!); message = { role: "assistant", content: JSON.stringify({ segmentId: source.data.segmentId, quote: source.data.quote.slice(0, 80) }) }; }
      return { message, finishReason: message.tool_calls ? "tool_calls" : "stop", usage: { inputTokens: 40, outputTokens: 20, estimated: false } };
    };
    const output = await runResearchLoop<{ segmentId: string; quote: string }>({ model, system: "测试研究员", task: "读取已搜索到的任务材料", tools });
    assert.equal(output.stopReason, "final");
    assert.ok(store.verify(output.final!.segmentId, output.final!.quote));
    assert.equal(queries, 1); assert.equal(ledger.snapshot().spent.queries, 1);
  } finally { globalThis.fetch = previous; }
});

test("主管原生读取冷启动共享来源并提交发现，不把资料指令变成权限", async () => {
  const base = golden(), source = base.sources.segments[0];
  const model = native(() => ({}));
  model.chat = async ({ messages, tools }) => {
    assert.ok(tools?.some(tool => tool.function.name === "read_source"));
    const results = messages.filter(message => message.role === "tool");
    const call = (name: string, args: unknown) => ({ role: "assistant" as const, content: null, tool_calls: [{ id: `supervisor-${results.length}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
    const message: import("@/lib/agent/native-model").ChatMessage = !results.length ? call("read_source", { segmentId: source.id }) : results.length === 1 ? call("submit_finding", { claim: { id: "source-finding", statement: "材料包含可继续核对的职责描述", kind: "inferred", evidenceSpans: [{ segmentId: source.id, quote: source.text.slice(0, 40) }] }, axis: "relational", consequence: "核对工作任务边界" }) : { role: "assistant" as const, content: JSON.stringify({ cards: [{ question: "怎样明确任务接口？", reason: "交付要求缺口", sourceClass: "primary_docs", targetIds: [], queriesHint: [] }] }) };
    if (results.length > 1) assert.ok(JSON.parse(results[1].content!).data.findingId);
    return { message, finishReason: message.tool_calls ? "tool_calls" : "stop", usage: { inputTokens: 40, outputTokens: 20, estimated: false } };
  };
  const agent = buildResearchAgent({ model });
  const contract = createIterationContract(snapshotIterationRequestSchema.parse({ runId: "v2-source-plan", snapshotRef: { snapshotId: base.snapshot.id }, research: researchOptionsSchema.parse({}) }), base);
  await agent.plan({ contract, sources: base.sources, workItems: [], round: 1 });
  assert.equal(agent.record()?.findings.length, 1); assert.equal(agent.record()?.findings[0].review, "undetermined");
});

test("允许读取相邻岗位材料，检索仍不赋予改图权限", async () => {
  const { createSearchTool } = await import("@/lib/iteration/research-tools");
  const previous = globalThis.fetch, store = new ResearchSourceStore();
  try {
    globalThis.fetch = async () => Response.json({ search_result: [{ title: "安全工程师交接职责", link: "https://example.com/security-handoff", content: "安全工程师检查风险，并将验收限制移交给应用实施团队。".repeat(50) }] });
    const tool = createSearchTool({ request: request(), config: { provider: "glm", apiKey: "fixture" }, store });
    const response = await tool.run({ query: "安全工程师 怎样移交验收限制" }, { turn: 1 });
    assert.ok(store.assets.length, JSON.stringify(response)); assert.ok(store.segments.some(segment => segment.text.includes("安全工程师")));
  } finally { globalThis.fetch = previous; }
});

test("实际替换文本经过独立复核后低影响修订可进入自动采用，高影响仍审阅", async () => {
  const base = golden(), record = run(), target = base.semantic.nodes.find(node => node.type === "knowledge_skill")!;
  const source = base.sources.segments.find(segment => target.evidenceSegmentIds.includes(segment.id))!;
  record.findings.push({ id: "reason", claim: claimSchema.parse({ id: "reason", statement: "术语需澄清", kind: "inferred", evidenceSpans: [{ segmentId: source.id, quote: source.text.slice(0, 80) }] }), axis: "relational", consequence: "改善学生理解", review: "supported", adoption: "candidate" });
  const tool = changeProposalTool({ base, run: record, save: async () => {} });
  await tool.run({ motivation: "澄清术语", findingRefs: ["reason"], operations: [{ kind: "revise", targetId: target.id, nodes: [{ label: target.label, summary: target.summary + "（适用情境明确）" }] }] }, { turn: 1 });
  const reviewModel = native(input => {
    const content = JSON.parse(input.messages.at(-1)!.content!);
    return { verdicts: content.claims.map((claim: { claimId: string }) => ({ claimId: claim.claimId, verdict: "supported", note: "测试用复核意见" })) };
  });
  const compiled = await compileResearchChanges({ base, candidate: base, request: request(), run: record, reviewModel });
  const { evaluateIteration } = await import("@/lib/iteration/planner");
  const { inspectSnapshot } = await import("@/lib/iteration/inspector");
  const contract = createIterationContract(snapshotIterationRequestSchema.parse({ runId: "automatic-revision", snapshotRef: { snapshotId: base.snapshot.id }, research: record.intent }), base);
  const evaluation = evaluateIteration({ base, candidate: compiled.candidate, before: inspectSnapshot(base), after: inspectSnapshot(compiled.candidate), contract, migrations: {}, workItems: [] });
  assert.equal(evaluation.meaningful, true, JSON.stringify(evaluation));
  assert.equal(record.changeSets[0].status, "candidate"); assert.equal(record.changeSets[0].checks.find(check => check.layer === "evidence")?.passed, true);
  const broken = structuredClone(record); broken.changeSets[0].status = "candidate"; broken.changeSets[0].checks = [];
  broken.changeSets[0].operations.push({ kind: "deprecate", targetId: "missing-object", payload: { nodes: [] } });
  const outcome = await compileResearchChanges({ base, candidate: base, request: request(), run: broken });
  assert.equal(broken.changeSets[0].status, "rejected"); assert.deepEqual(outcome.candidate.semantic.nodes, base.semantic.nodes, "第二项失败不能保留第一项修订");
});

test("提交中断恢复仅重放完成产物，允许自己的已提交版本收尾，不放宽其他基线", async () => {
  const { replayBuildCompletion, replayIterationCompletion, canReplayCommittedIteration } = await import("@/lib/research/recovery");
  const base = golden(), events = [];
  for await (const event of replayBuildCompletion(base, 44)) events.push(event);
  assert.equal(events.length, 1); assert.equal(events[0].seq, 44); assert.equal(events[0].payload.result, base);
  const result = { runId: "finished", baseSnapshotId: base.snapshot.id, projectId: base.projectId, createdSnapshot: true } as import("@/lib/iteration/types").SnapshotIterationResult;
  const iterations = []; for await (const event of replayIterationCompletion(result, 50)) iterations.push(event);
  assert.equal(iterations[0].payload.result, result); assert.equal(iterations[0].seq, 50);
  const provenance = { dispatched: true, runId: "finished", projectId: "p1", baseVersionId: "v1", committed: { sourceRunId: "finished", projectId: "p1", parentVersionId: "v1" } };
  assert.equal(canReplayCommittedIteration(provenance), true);
  assert.equal(canReplayCommittedIteration({ ...provenance, dispatched: false }), false);
  assert.equal(canReplayCommittedIteration({ ...provenance, baseVersionId: "different" }), false);
  assert.equal(canReplayCommittedIteration({ ...provenance, runId: "another" }), false);
});

test("冻结材料中的转述不冒充来源逐字原话，直接事实复核不能越级", async () => {
  const base = golden(), segment = base.sources.segments.find(segment => segment.excerptType === "close_paraphrase")!;
  const tool = createSourceReadTool({ segments: base.sources.segments, assets: base.sources.assets });
  const read = await tool.run({ segmentId: segment.id }, { turn: 1 });
  assert.equal((read.data as { contentKind: string }).contentKind, "source_paraphrase");
  const claim = claimSchema.parse({ id: "direct-from-paraphrase", statement: segment.text, kind: "observed", expression: "direct", evidenceSpans: [{ segmentId: segment.id, quote: segment.text }] });
  const review = await createEvidenceReviewer(native(() => { throw new Error("direct paraphrase must fail before model review"); }))({ claims: [claim], segments: [segment] });
  assert.deepEqual(review?.unverifiable, [claim.id]); assert.equal(applyEvidenceReview([claim], review)[0].verification, "unverified");
});

test("工作过程的返工反馈环合法，硬先修环仍被审计检出", async () => {
  const { auditRoleSnapshot } = await import("@/lib/risk/audit");
  const base = golden(), events = base.process.nodes.filter(node => node.kind === "event").slice(0, 2);
  assert.equal(events.length, 2);
  base.process.edges.push({ id: "feedback-a", source: events[0].id, target: events[1].id, type: "precedes", evidenceSegmentIds: [], evidenceBindingIds: [] }, { id: "feedback-b", source: events[1].id, target: events[0].id, type: "rework_to", evidenceSegmentIds: [], evidenceBindingIds: [] });
  assert.ok(!auditRoleSnapshot(base).issues.some(issue => issue.code === "ILLEGAL_CYCLE"));
  const skills = base.semantic.nodes.filter(node => node.type === "knowledge_skill").slice(0, 2);
  base.semantic.edges.push(...[[skills[0].id, skills[1].id], [skills[1].id, skills[0].id]].map(([source, target], index) => ({ id: `hard-cycle-${index}`, type: "prerequisite_of" as const, source, target, lifecycle: "candidate" as const, confidence: .5, evidenceSegmentIds: [], evidenceBindingIds: [] })));
  assert.ok(auditRoleSnapshot(base).issues.some(issue => issue.code === "ILLEGAL_CYCLE"));
});

test("资料索引和关系切片提供可执行的续读位置，不丢失尾部对象", async () => {
  const { createSourceIndexTool } = await import("@/lib/iteration/research-tools");
  const base = golden(), tool = createSourceIndexTool(base.sources);
  const first = await tool.run({}, { turn: 1 });
  const data = first.data as { sources: unknown[]; nextOffset: number };
  assert.equal(data.sources.length, 20); assert.equal(data.nextOffset, 20);
  const second = await tool.run({ offset: data.nextOffset }, { turn: 2 });
  assert.equal((second.data as { sources: unknown[] }).sources.length, base.sources.assets.length - 20);
  const source = base.sources.assets[0];
  const indexed = await tool.run({ sourceId: source.id }, { turn: 3 });
  assert.ok((indexed.data as { segments: Array<{ id: string }> }).segments.every(segment => base.sources.segments.some(actual => actual.id === segment.id && actual.sourceId === source.id)));
});

test("重复问题的同一发现不算新进展，反证或适用范围变化可以计入", async () => {
  const { reviewedFindingKeys } = await import("@/lib/research/quality");
  const record = run(), claim = claimSchema.parse({ id: "f", statement: "任务交付要求存在冲突", kind: "inferred" });
  record.findings.push({ id: "a", claim, axis: "relational", consequence: "需复核", review: "supported", adoption: "candidate" });
  const before = reviewedFindingKeys(record);
  record.findings.push({ ...record.findings[0], id: "different-task" });
  assert.deepEqual(reviewedFindingKeys(record), before);
  record.findings[1].review = "conflicting";
  assert.equal(reviewedFindingKeys(record).length, 2);
});

test("新协议范围和预算投影到旧 API 字段后仍能排队与恢复，不受旧隐藏上限拒绝", () => {
  for (const queries of [1, 20000]) {
    const research = researchOptionsSchema.parse({ objective: "目".repeat(8000), targetIds: Array.from({ length: 128 }, (_, i) => `target-${i}`), changeScope: "selected", budget: { queries, tasks: 1 } });
    const queued = snapshotIterationRequestSchema.parse({ runId: "queue-v2-bounds", snapshotRef: { snapshotId: golden().snapshot.id }, research, prompt: research.objective, targetIds: research.targetIds, queryBudget: research.budget.queries, sourceLimit: research.budget.queries, maxWorkItems: research.budget.tasks });
    assert.deepEqual(snapshotIterationRequestSchema.parse(JSON.parse(JSON.stringify(queued))), queued);
    assert.equal(queued.queryBudget, queries); assert.equal(queued.maxWorkItems, 1);
  }
});

test("草稿续研复用全部来源和长正文，转述性质不因重新入库丢失", async () => {
  const { reusableResearchSources } = await import("@/lib/research/recovery");
  const { prepareBuildInput } = await import("@/lib/build/compiler");
  const { coldStartRequestSchema } = await import("@/lib/build/types");
  const base = golden(), asset = base.sources.assets[0];
  const before = reusableResearchSources(base);
  assert.ok(before.length > 20);
  const segment = base.sources.segments.find(segment => segment.sourceId === asset.id)!;
  segment.text = "甲".repeat(61000) + "长正文最后的交付要求";
  const reused = reusableResearchSources(base), parts = reused.filter(source => source.locator === asset.locator);
  assert.ok(parts.length > 1); assert.match(parts.map(part => part.content).join(""), /长正文最后的交付要求/u);
  const resumed = coldStartRequestSchema.parse({ ...request(), sources: reused });
  assert.equal(resumed.sources.length, reused.length);
  assert.ok(prepareBuildInput(resumed).segments.some(segment => segment.excerptType === "close_paraphrase"));
});
