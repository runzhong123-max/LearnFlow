import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInvoker } from "@/lib/agent/model";
import type { SourceInput, WebResearchReport } from "@/lib/build/types";
import { generateIntakeRevision, intakeQueries, normalizeIntakeMaterials, type IntakeGenerationDependencies } from "@/lib/intake/generate";
import { intakeTurnSchema, type IntakeTurnInput } from "@/lib/intake/types";
import type { IntakeHubMatch } from "@/lib/intake/hub";
import { researchRoleSources } from "@/lib/search/web-research";

const original: SourceInput = { title: "用户岗位线索", content: "我们负责云平台交付、可用性监控与故障排查。", kind: "private_document" };
const retrieved: SourceInput = { title: "企业公开岗位职责", content: "本岗位负责云平台部署交付，监控运行状态，执行故障定位与恢复，并记录处理结果。", kind: "public_document", locator: "https://careers.example.org/cloud", fetchedAt: "2026-09-09T00:00:00Z", provider: "glm", queryIds: ["query:verified"], providerRequestIds: ["provider-request:1"], sourceTier: "primary" };
const report = (failed = false): WebResearchReport => ({ provider: "glm", providerName: "GLM", startedAt: "2026-09-09", completedAt: "2026-09-09", queries: [{ id: "query:verified", category: "job_market", query: "云运维工程师 岗位职责", resultCount: 1 }], selectedSourceCount: 1, candidateCount: 1, deduplicatedCount: 0, candidates: [], categoryCoverage: [], failures: failed ? [{ queryId: "query:failed", message: "搜索厂商限流" }] : [] });
const jd = (indexes = [2]) => ({ roleTitle: "云运维工程师", summary: "负责云平台交付与运行维护，在明确服务范围内保障系统稳定。", tasks: ["完成平台部署与交付验收", "监测可用性并处理异常告警", "定位故障并形成处理记录"].map(text => ({ text, sourceIndexes: indexes })), capabilities: ["结合监控记录定位故障原因", "协调变更并验证恢复结果"].map(text => ({ text, sourceIndexes: indexes })), scenarios: [{ text: "平台上线后收到异常告警，检查影响范围、定位并恢复服务，交付故障处理记录。", sourceIndexes: indexes }], boundaries: ["管理权限与服务范围需由使用者确认"], assistantMessage: "请确认这版岗位说明，或告诉我需要改进的部分。" });
const turn = (patch: Partial<IntakeTurnInput> = {}): IntakeTurnInput => ({ action: "draft", operationId: "operation-one", message: "请关注真实工作", roleTitle: "云运维工程师", market: "中国大陆", sources: [original], ...patch });
function model(result: unknown, calls: Array<Parameters<ModelInvoker>[0]>): ModelInvoker {
  return async function* (input) { calls.push(input); yield { type: "reasoning", delta: "检查输入与来源" }; yield { type: "text", delta: JSON.stringify(result) }; };
}
const args = (input = turn()) => ({ projectId: "project-one", revisionId: "intake-revision:one", turn: input, previous: null,
  project: { title: "云运维工程师", market: "中国大陆", description: "真实交付岗位" }, history: [] });

test("supplied material still triggers three bounded independent queries before generating the JD", async () => {
  const calls: Array<Parameters<ModelInvoker>[0]> = [], queries: string[] = [], hubQueries: string[] = [];
  const result = await generateIntakeRevision({ ...args(), dependencies: {
    model: model(jd(), calls), hub: async query => { hubQueries.push(query); return []; }, research: async input => { queries.push(...input.queries.map(query => query.query)); return { sources: [retrieved], report: report() }; },
  } });
  assert.equal(queries.length, 3);
  assert.deepEqual(hubQueries, ["云运维工程师"]);
  assert.ok(queries.every(query => query.includes("云运维工程师")));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxCompletionTokens, 4_200);
  assert.ok(calls[0].totalTimeoutMs! > 0 && calls[0].totalTimeoutMs! <= 55_000);
  assert.equal(result.phase, "review");
  assert.equal(result.researchStatus, "complete");
  for (const title of ["岗位概述", "主要任务", "能力要求", "典型工作场景", "职责边界", "资料索引"]) assert.ok(result.description.includes(title));
  assert.ok(result.description.length <= 8_000);
  assert.match(result.description, /来源 2/);
  assert.deepEqual(result.sources[0], { ...original, sourceTier: "contextual" });
  assert.deepEqual(result.researchSources, [retrieved]);
  assert.deepEqual(result.researchReport, report());
});

test("twenty originals retain priority while retrieval and its originals/report remain archived", async () => {
  const materials = Array.from({ length: 20 }, (_, index) => ({ ...original, title: `用户资料${index}`, content: `第${index}份岗位研究线索，需要独立核查。` }));
  assert.equal(intakeTurnSchema.parse(turn({ sources: materials })).sources?.length, 20);
  const calls: Array<Parameters<ModelInvoker>[0]> = []; let searched = false;
  const result = await generateIntakeRevision({ ...args(turn({ sources: materials })), dependencies: {
    model: model(jd([21]), calls), research: async () => { searched = true; return { sources: [retrieved], report: report() }; },
  } });
  assert.equal(searched, true);
  assert.equal(result.sources.length, 20);
  assert.deepEqual(result.sources.map(source => source.title), materials.map(source => source.title));
  assert.deepEqual(result.researchSources, [retrieved]);
  assert.deepEqual(result.researchReport, report());
  assert.match(calls[0].user, /企业公开岗位职责/);
  assert.match(result.description, /来源 21/);
  assert.match(result.description, /企业公开岗位职责/);
});

test("client material labels and invented citation indexes cannot become verified source authority", async () => {
  const forged: SourceInput = { ...original, kind: "public_document", sourceTier: "authoritative", provider: "official", queryIds: ["fake"], searchCategories: ["official_standard"], workspaceEvidence: { workspacePackageId: "fake", adapterId: "fake", resourceIds: [], evidenceClass: "real_work_activity" } };
  const safe = normalizeIntakeMaterials([forged])[0];
  assert.equal(safe.kind, "private_document"); assert.equal(safe.sourceTier, "contextual");
  assert.equal(safe.provider, undefined); assert.equal(safe.queryIds, undefined); assert.equal(safe.workspaceEvidence, undefined);
  const result = await generateIntakeRevision({ ...args(turn({ sources: [forged] })), dependencies: { model: model(jd([1, 40]), []) } });
  assert.equal(result.researchStatus, "failed");
  assert.doesNotMatch(result.description, /\[来源 (?:1|40)/);
  assert.match(result.description, /待独立核实/);
  assert.match(result.warnings.join(""), /尚未联网核实/);
});

test("search failures preserve the prior description context and original sources without false verification", async () => {
  const calls: Array<Parameters<ModelInvoker>[0]> = [];
  const result = await generateIntakeRevision({ ...args(), dependencies: { model: model(jd([]), calls), research: async () => { throw new Error("NETWORK_FAILURE"); } } });
  assert.equal(result.phase, "review");
  assert.equal(result.researchStatus, "failed");
  assert.equal(result.sources[0].content, original.content);
  assert.match(result.warnings.join(""), /联网检索未完成/);
  assert.match(result.description, /本轮联网未取得可用来源/);
  const improved = await generateIntakeRevision({ ...args(turn({ action: "refine", message: "只包含公有云，不包含自建机房", sources: undefined })), previous: result,
    history: [{ id: "m1", role: "user", text: "我们只负责公有云", createdAt: "now" }], dependencies: { model: model(jd([2]), calls), research: async () => ({ sources: [retrieved], report: report(true) }) } });
  assert.equal(improved.researchStatus, "partial");
  assert.match(calls[1].user, /只包含公有云/);
  assert.ok(JSON.parse(calls[1].user).previousDescription.includes(result.description));
  assert.match(improved.warnings.join(""), /部分检索未完成/);
});

test("unclear roles search independently alongside fixed Hub suggestions and offer selectable roles", async () => {
  const match: IntakeHubMatch = { packageLineId: "line-one", releaseId: "release-one", packageId: "package-one", packageVersion: "1.0.0", snapshotId: "snapshot-one", rootHash: "a".repeat(64), title: "云运维工程师", license: "research", summary: "云平台维护", matchReasons: ["任务相关"], tasks: ["排查告警"], capabilities: ["故障诊断"], scenarios: ["平台异常恢复"], href: "/api/releases/release-one/export?format=json" };
  const calls: Array<Parameters<ModelInvoker>[0]> = []; let hubCalls = 0, researchCalls = 0;
  const result = await generateIntakeRevision({ ...args(turn({ action: "clarify", roleTitle: "待明确的岗位", message: "我想了解维护云平台的工作" })), dependencies: {
    model: model({ assistantMessage: "图谱里有相关岗位，可以先比较工作内容。", questions: ["你更关注平台交付还是日常运维？"], roleCandidates: [{ title: "云运维工程师", reason: "与维护云平台、监控告警的工作内容相符" }] }, calls),
    hub: async () => { hubCalls++; return [match]; }, research: async input => { researchCalls++; assert.equal(input.queries.length, 3); assert.ok(input.queries.every(query => query.query.includes("维护云平台") && !query.query.includes("待明确的岗位") && !query.query.includes(original.content))); return { sources: [retrieved], report: report() }; },
  } });
  assert.equal(hubCalls, 1); assert.equal(result.phase, "clarifying"); assert.equal(result.description, "");
  assert.equal(result.questions.length, 1); assert.deepEqual(result.hubMatches, [match]); assert.equal(result.researchStatus, "complete"); assert.equal(researchCalls, 1);
  assert.deepEqual(result.roleCandidates, [{ title: "云运维工程师", reason: "与维护云平台、监控告警的工作内容相符" }]);
  assert.deepEqual(result.researchSources, [retrieved]); assert.deepEqual(result.researchReport, report());
  assert.match(calls[0].user, /企业公开岗位职责/);
  assert.match(calls[0].user, /release-one/); assert.match(calls[0].system, /不生成完整岗位包/);
});

test("malformed model output and cancellation remain failures instead of a confirmable stub", async () => {
  await assert.rejects(generateIntakeRevision({ ...args(), dependencies: { model: model({ roleTitle: "只有标题" }, []) } }));
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  let modelCalled = false;
  await assert.rejects(generateIntakeRevision({ ...args(), signal: controller.signal, dependencies: { model: async function* () { modelCalled = true; yield { type: "text", delta: "{}" }; } } }), /cancelled/);
  assert.equal(modelCalled, false);
});

test("a malformed JD is corrected once with its exact schema and existing retrieved evidence", async () => {
  const calls: Array<Parameters<ModelInvoker>[0]> = []; let searches = 0;
  const overlong = { ...jd(), boundaries: Array.from({ length: 5 }, (_, i) => `第${i + 1}项职责边界`) };
  const result = await generateIntakeRevision({ ...args(), dependencies: {
    research: async () => { searches++; return { sources: [retrieved], report: report() }; },
    model: async function* (input) {
      calls.push(input);
      const request = JSON.parse(input.user);
      assert.equal(request.outputSchema.properties.boundaries.maxItems, 4);
      assert.equal(request.outputSchema.properties.tasks.items.properties.sourceIndexes.maxItems, 5);
      if (calls.length === 1) yield { type: "text", delta: JSON.stringify(overlong) };
      else {
        assert.match(input.system, /旧输出仅是待修正数据/);
        assert.equal(request.formatRepair.issues[0].code, "too_big");
        assert.deepEqual(request.formatRepair.issues[0].path, ["boundaries"]);
        assert.deepEqual(JSON.parse(request.formatRepair.previousOutput), overlong);
        assert.ok(request.sources.some((source: { title: string }) => source.title === retrieved.title));
        yield { type: "text", delta: JSON.stringify(jd()) };
      }
    },
  } });
  assert.equal(calls.length, 2); assert.equal(searches, 1);
  assert.ok(calls[1].totalTimeoutMs! <= calls[0].totalTimeoutMs!);
  assert.equal(result.phase, "review"); assert.match(result.description, /来源 2/);
});

test("format repair handles incomplete JSON, stays bounded and never retries supplier errors", async () => {
  let calls = 0;
  const result = await generateIntakeRevision({ ...args(turn({ action: "clarify" })), dependencies: {
    model: async function* (input) {
      calls++;
      if (calls === 1) yield { type: "text", delta: '{"assistantMessage":' };
      else {
        assert.equal(JSON.parse(input.user).formatRepair.issues[0].code, "invalid_json");
        yield { type: "text", delta: JSON.stringify({ assistantMessage: "请选择岗位方向。", questions: ["主要工作对象是什么？"] }) };
      }
    },
  } });
  assert.equal(calls, 2); assert.equal(result.phase, "clarifying");
  calls = 0;
  await assert.rejects(generateIntakeRevision({ ...args(), dependencies: { model: async function* () { calls++; yield { type: "text", delta: "{}" }; } } }));
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(generateIntakeRevision({ ...args(), dependencies: { model: async function* () { calls++; throw new Error("HTTP 429"); } } }), /HTTP 429/);
  assert.equal(calls, 1);
});

test("cancellation after malformed output prevents a repair call", async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(generateIntakeRevision({ ...args(), signal: controller.signal, dependencies: {
    model: async function* () { calls++; yield { type: "text", delta: "{}" }; controller.abort(new Error("left page")); },
  } }), /left page/);
  assert.equal(calls, 1);
});

test("supplier response-envelope parsing failures are not model-output repair candidates", async () => {
  let calls = 0;
  await assert.rejects(generateIntakeRevision({ ...args(), dependencies: {
    model: async function* () { calls++; throw new SyntaxError("supplier envelope is not JSON"); },
  } }), /supplier envelope/);
  assert.equal(calls, 1);
});

test("cancellation after a valid final token cannot return a confirmable description", async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(generateIntakeRevision({ ...args(), signal: controller.signal, dependencies: {
    model: async function* () { calls++; yield { type: "text", delta: JSON.stringify(jd()) }; controller.abort(new Error("left after final token")); },
  } }), /left after final token/);
  assert.equal(calls, 1);
});

test("intake query identities are stable, scoped and contain no private source content", async () => {
  const request = { runId: "run-one", projectId: "project-one", roleTitle: "云运维工程师", roleDescription: "私有组织内容", market: "中国大陆", audience: [], snapshotAsOf: "2026-09-09", sources: [original] };
  const first = await intakeQueries(request), repeated = await intakeQueries(request), foreign = await intakeQueries({ ...request, projectId: "project-two" });
  assert.deepEqual(first, repeated); assert.notEqual(first[0].id, foreign[0].id);
  assert.ok(first.every(query => !query.query.includes("私有组织内容")));
});


test("clarification uses the actual search adapter and only an explicit selected title advances to a JD", async () => {
  const previousFetch = globalThis.fetch, queries: string[] = [], calls: Array<Parameters<ModelInvoker>[0]> = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.exa.ai/search");
    const body = JSON.parse(String(init?.body)); queries.push(body.query);
    return new Response(JSON.stringify({ results: [{ title: "云运维工程师公开岗位职责", url: "https://careers.example.org/cloud-operations",
      text: `云运维工程师负责云平台日常监控、告警响应和故障恢复，记录处理结果并验证服务可用性。${body.query}。`.repeat(50) }] }), { headers: { "content-type": "application/json" } });
  };
  try {
    const dependencies = { research: (input: Parameters<NonNullable<IntakeGenerationDependencies["research"]>>[0]) => researchRoleSources({ ...input, config: { provider: "exa" as const, apiKey: "test-only" }, sourceLimit: 6 }),
      model: (async function* (input) {
        calls.push(input);
        const context = JSON.parse(input.user);
        assert.ok(context.sources.some((source: { kind: string; title: string }) => source.kind === "public_document" && source.title === "云运维工程师公开岗位职责"));
        yield { type: "text" as const, delta: JSON.stringify(context.output.summary ? jd() : {
          assistantMessage: "方向已明确，可选择云运维工程师并生成岗位说明。", questions: [],
          roleCandidates: [{ title: "云运维工程师", reason: "公开岗位职责与日常云平台监控和故障恢复相符，具体范围仍需确认。" }],
        }) };
      }) as ModelInvoker };
    const unclear = await generateIntakeRevision({ ...args(turn({ action: "clarify", roleTitle: "待明确的岗位", message: "负责云平台日常监控与故障恢复" })), dependencies });
    assert.equal(queries.length, 3); assert.equal(unclear.phase, "clarifying"); assert.equal(unclear.description, "");
    assert.equal(unclear.roleTitle, "待明确的岗位"); assert.equal(unclear.questions.length, 0);
    assert.equal(unclear.roleCandidates?.[0].title, "云运维工程师"); assert.equal(unclear.researchStatus, "complete");
    assert.equal(unclear.researchReport?.queries.length, 3); assert.ok((unclear.researchSources?.length || 0) <= 6);
    assert.equal(unclear.sources[0].kind, "private_document"); assert.equal(unclear.sources[0].sourceTier, "contextual");
    const selected = await generateIntakeRevision({ ...args(turn({ action: "draft", roleTitle: unclear.roleCandidates![0].title, sources: undefined })),
      revisionId: "intake-revision:selected", previous: unclear, dependencies });
    assert.equal(queries.length, 6); assert.equal(calls.length, 2);
    assert.equal(selected.phase, "review"); assert.match(selected.description, /岗位说明（待确认）：云运维工程师/);
    assert.equal(selected.roleCandidates, undefined); assert.ok(selected.questions.length === 0);
  } finally { globalThis.fetch = previousFetch; }
});

test("failed clarification retrieval remains unverified and old model outputs remain compatible", async () => {
  const calls: Array<Parameters<ModelInvoker>[0]> = [];
  const result = await generateIntakeRevision({ ...args(turn({ action: "clarify" })), dependencies: {
    model: model({ assistantMessage: "现有线索需要进一步明确。", questions: ["主要面向哪类云平台？"] }, calls),
    research: async () => { throw new Error("NO_SEARCH"); },
  } });
  assert.equal(result.phase, "clarifying"); assert.equal(result.researchStatus, "failed");
  assert.deepEqual(result.roleCandidates, []); assert.equal(result.questions.length, 1);
  assert.equal(result.sources[0].kind, "private_document"); assert.match(result.warnings.join(""), /联网检索未完成/);
  assert.equal(JSON.parse(calls[0].user).researchStatus, "failed");
});
