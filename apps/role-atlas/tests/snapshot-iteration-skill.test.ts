import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInvoker } from "@/lib/agent/model";
import { createSnapshotIterationSkill, mergeIterationSources } from "@/lib/iteration/graph";
import type { IterationEvent, SnapshotIterationRequest, SnapshotIterationResult } from "@/lib/iteration/types";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";
import { reconstructSourceInputs } from "@/lib/risk/research";

const modelMustNotRun: ModelInvoker = async function* () {
  yield* [];
  throw new Error("关闭联网且没有附加资料时不应调用模型");
};

test("成熟快照迭代不会被冷启动的 20 项输入上限截断来源历史", () => {
  const base = bundledRoleSnapshot();
  const current = reconstructSourceInputs(base);
  assert.ok(current.length > 20);
  const incoming = { title: "新增研究来源", content: "用于补充本轮研究。", kind: "public_document" as const, locator: "https://example.com/new" };
  const merged = mergeIterationSources(current, [incoming], current.length + 1);
  assert.equal(merged.length, current.length + 1);
  assert.ok(merged.some((source) => source.locator === incoming.locator));
});

test("统一迭代 Skill 可自动发现并确定性修复协议错误，随后创建不可变快照", async () => {
  const base = structuredClone(bundledRoleSnapshot());
  base.semantic.edges.push({
    id: "edge:iteration-dangling",
    type: "requires_skill",
    source: base.semantic.nodes.find((node) => node.type === "task")!.id,
    target: "skill:iteration-missing",
    lifecycle: "candidate",
    confidence: 0.4,
    evidenceSegmentIds: [],
    evidenceBindingIds: [],
  });
  const request: SnapshotIterationRequest = {
    runId: "iteration-skill-test",
    snapshotRef: { snapshotId: base.snapshot.id },
    initiativeProfile: "autonomous",
    prompt: "",
    targetIds: [],
    supplementalSources: [],
    webResearch: false,
    maxRounds: 2,
    sourceLimit: 12,
    maxWorkItems: 10,
  };
  const graph = createSnapshotIterationSkill({ model: modelMustNotRun });
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
  }, { configurable: { thread_id: "iteration-skill-test" }, streamMode: "custom" });
  for await (const event of stream) events.push(event as IterationEvent);
  const completed = events.findLast((event) => event.kind === "iteration.run.completed")!;
  const result = completed.payload.result as SnapshotIterationResult;
  assert.equal(result.createdSnapshot, true);
  assert.notEqual(result.candidate.snapshot.id, base.snapshot.id);
  assert.equal(result.candidate.semantic.edges.some((edge) => edge.id === "edge:iteration-dangling"), false);
  assert.equal(result.inspectionAfter.protocolValid, true);
  assert.ok(result.workItems.some((item) => item.status === "completed"), "评估应回写已被候选修复的工作项状态");
  assert.equal(result.candidate.audit.inspection?.protocolValid, true);
  assert.match(result.candidate.snapshot.sections.find((section) => section.id === "evidence-risks")!.summary, /任务缺少工作场景|节点简介信息不足/u);
  const kinds = new Set(events.map((event) => event.kind));
  for (const kind of ["iteration.contract.created", "iteration.inspection.completed", "iteration.work.plan.created", "iteration.consolidation.started", "iteration.patch.applied", "iteration.evaluation.started", "iteration.evaluation.completed", "iteration.run.completed"] as const) assert.ok(kinds.has(kind), `缺少 ${kind}`);
});

test("阶段检查点恢复会从下一节点继续，不重复契约和结构扫描", async () => {
  const base = bundledRoleSnapshot();
  const request: SnapshotIterationRequest = {
    runId: "iteration-resume-test",
    snapshotRef: { snapshotId: base.snapshot.id },
    initiativeProfile: "autonomous",
    prompt: "",
    targetIds: [],
    supplementalSources: [],
    webResearch: false,
    maxRounds: 1,
    sourceLimit: 8,
    maxWorkItems: 8,
  };
  let discovery: Record<string, unknown> | undefined;
  const first = createSnapshotIterationSkill({
    model: modelMustNotRun,
    onCheckpoint: async (phase, state) => { if (phase === "discovery") discovery = state; },
  });
  await first.invoke({
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
  }, { configurable: { thread_id: "iteration-resume-seed" } });
  assert.ok(discovery);

  const resumed = createSnapshotIterationSkill({ model: modelMustNotRun, initialSeq: 52 });
  const events: IterationEvent[] = [];
  const stream = await resumed.stream({
    round: 1,
    opportunities: [],
    workItems: [],
    researchPlans: [],
    researchReports: [],
    researchedSources: [],
    patches: [],
    migrations: {},
    ...discovery,
    request,
    base,
    candidate: base,
    resumeFrom: "discovery",
  }, { configurable: { thread_id: "iteration-resume-run" }, streamMode: "custom" });
  for await (const event of stream) events.push(event as IterationEvent);
  assert.ok(events.every(event => event.seq > 52));
  assert.ok(discovery.candidate, "完整候选快照必须跨阶段保留");
  assert.ok(Array.isArray(discovery.researchedSources));
  const kinds = new Set(events.map((event) => event.kind));
  assert.equal(kinds.has("iteration.contract.created"), false);
  assert.equal(kinds.has("iteration.inspection.started"), false);
  assert.equal(kinds.has("iteration.research.plan.created"), true);
  assert.equal(kinds.has("iteration.run.completed"), true);
});


async function offlineIteration(base: ReturnType<typeof bundledRoleSnapshot>, targetAsOf: string) {
  const request: SnapshotIterationRequest = {
    runId: `iteration-date-${targetAsOf}`, snapshotRef: { snapshotId: base.snapshot.id },
    initiativeProfile: "autonomous", mode: "freshness", prompt: "", targetIds: [],
    targetAsOf, supplementalSources: [], webResearch: false, maxRounds: 1, sourceLimit: 12, maxWorkItems: 10,
  };
  const events: IterationEvent[] = [];
  const graph = createSnapshotIterationSkill({ model: modelMustNotRun });
  for await (const raw of await graph.stream({ request, base, candidate: base }, { streamMode: "custom" })) events.push(raw as IterationEvent);
  return { events, result: events.findLast((event) => event.kind === "iteration.run.completed")!.payload.result as SnapshotIterationResult };
}

test("目标日期先参与来源核验和修复，再写入快照、brief和manifest", async () => {
  const base = structuredClone(bundledRoleSnapshot());
  const originalDate = base.snapshot.asOf;
  const targetAsOf = new Date(Date.parse(`${originalDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const source = { ...base.sources.assets[0], id: "source:date-review", title: "必须按目标日核验的来源", publishedAt: originalDate, observedAt: originalDate, contentHash: "date-review-source" };
  base.sources.assets.push(source);
  const { result, events } = await offlineIteration(base, targetAsOf);
  assert.ok(events.some((event) => event.kind === "iteration.finding.discovered" && (event.payload.finding as { code?: string; title?: string })?.code === "FUTURE_SOURCE" && (event.payload.finding as { title: string }).title.includes(source.title)));
  assert.ok(result.patches.some((patch) => patch.operations.some((operation) => operation.op === "remove_source" && operation.sourceId === source.id)));
  assert.equal(result.createdSnapshot, true);
  assert.equal(result.candidate.sources.assets.some((item) => item.id === source.id), false);
  assert.equal(result.candidate.snapshot.asOf, targetAsOf);
  assert.equal(result.candidate.brief.snapshotAsOf, targetAsOf);
  assert.equal(result.candidate.packages.rolePackage.snapshotAsOf, targetAsOf);
  assert.ok(result.candidate.snapshot.id.includes(`@${targetAsOf}:`));
  assert.equal(base.snapshot.asOf, originalDate);
  assert.ok(base.sources.assets.some((item) => item.id === source.id));
});

test("无新来源和结构变化时只选择目标日期不会制造新版本", async () => {
  const fixture = structuredClone(bundledRoleSnapshot());
  const base = (await offlineIteration(fixture, fixture.snapshot.asOf)).result.candidate;
  const targetAsOf = new Date(Date.parse(`${base.snapshot.asOf}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const { result } = await offlineIteration(base, targetAsOf);
  assert.equal(result.patches.some((patch) => patch.operations.length), false);
  assert.equal(result.createdSnapshot, false);
  assert.equal(result.status, "no_change");
  assert.equal(result.candidate.snapshot.asOf, base.snapshot.asOf);
  assert.equal(result.candidate.snapshot.id, base.snapshot.id);
  assert.equal(result.contract.targetAsOf, targetAsOf);
});
