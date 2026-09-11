import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInvoker } from "@/lib/agent/model";
import { boundaryHardRejects, boundaryScoreAdjustment, createBoundaryVerifier, type BoundaryVerdict } from "@/lib/search/boundary-verdicts";
import { researchRoleSources } from "@/lib/search/web-research";
import { coldStartRequestSchema, type WebSearchCategory } from "@/lib/build/types";

const request = coldStartRequestSchema.parse({ runId: "boundary-run", projectId: "boundary-project", roleTitle: "云运维工程师", market: "中国大陆", snapshotAsOf: "2026-09-11" });
const query = { id: "query:one", category: "job_market" as WebSearchCategory, query: "云运维工程师 岗位职责", priority: 9 };

const core = { title: "云运维工程师岗位职责与任职要求", link: "https://careers.example.org/cloud-ops", content: `云运维工程师岗位职责：${"围绕云平台交付、可用性监控与故障排查展开。".repeat(40)}`, publish_date: "2026-08-01" };
// No occupation suffix in the title and no target-role substance: the
// deterministic title heuristic cannot see this page, only the model can.
const foreign = { title: "2026年热门证书培训推荐", link: "https://ads.example.net/certificate-ads", content: `会计从业与教师资格培训课程介绍，报名优惠。${"培训课程与报名咨询。".repeat(50)}`, publish_date: "2026-08-01" };
const adjacent = { title: "网络运维工程师职业概述", link: "https://jobs.example.org/network-ops", content: `网络运维工程师负责机房布线、设备巡检与链路排障，与云平台交付协同。${"网络设备巡检与链路排障。".repeat(40)}`, publish_date: "2026-08-01" };

function searchStub(results: Array<typeof core>) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /bigmodel\.cn/);
    return Response.json({ request_id: "req-boundary-model", search_result: results });
  };
  return () => { globalThis.fetch = previous; };
}

function verdictModel(verdicts: BoundaryVerdict[], calls?: { count: number }): ModelInvoker {
  return async function* () {
    if (calls) calls.count += 1;
    yield { type: "text", delta: JSON.stringify({ verdicts }) };
  };
}

test("boundary verdict scoring only demotes or rejects, never promotes", () => {
  const foreignVerdict: BoundaryVerdict = { url: "https://x.example.com", relation: "foreign", note: "", confidence: 0.9 };
  const adjacentVerdict: BoundaryVerdict = { url: "https://x.example.com", relation: "adjacent", note: "", confidence: 0.8 };
  const coreVerdict: BoundaryVerdict = { url: "https://x.example.com", relation: "core", note: "", confidence: 1 };
  assert.ok(boundaryScoreAdjustment(foreignVerdict) < 0);
  assert.ok(boundaryScoreAdjustment(adjacentVerdict) < 0);
  assert.equal(boundaryScoreAdjustment(coreVerdict), 0, "core 判定不得加分扩权");
  assert.equal(boundaryScoreAdjustment({ ...foreignVerdict, confidence: 0.5 }), 0, "低置信 foreign 只降权不否决");
  assert.equal(boundaryHardRejects(foreignVerdict, "contextual"), true);
  assert.equal(boundaryHardRejects(foreignVerdict, "secondary"), true);
  assert.equal(boundaryHardRejects(foreignVerdict, "authoritative"), false, "权威标准命名相邻岗位不得被模型否决");
  assert.equal(boundaryHardRejects(foreignVerdict, "primary"), false);
  assert.equal(boundaryHardRejects(adjacentVerdict, "contextual"), false);
});

test("model boundary pass rejects foreign pages the title heuristic cannot see", async () => {
  const restore = searchStub([core, foreign]);
  try {
    const model = verdictModel([
      { url: core.link, relation: "core", note: "目标岗位职责", confidence: 0.95 },
      { url: foreign.link, relation: "foreign", note: "证书培训广告，与云运维无关", confidence: 0.92 },
    ]);
    const { sources, report } = await researchRoleSources({
      request, config: { provider: "glm", apiKey: "test-only-key" }, queries: [query],
      verifyBoundaries: createBoundaryVerifier(model),
    });
    assert.deepEqual(sources.map(source => source.locator), [core.link]);
    const rejected = report.candidates.find(candidate => candidate.url === foreign.link);
    assert.equal(rejected?.disposition, "foreign_occupation");
    assert.equal(rejected?.boundaryVerdict?.relation, "foreign");
    assert.match(rejected?.boundaryVerdict?.note || "", /证书培训/);
  } finally { restore(); }
});

test("adjacent verdict demotes but keeps the candidate auditable", async () => {
  const restore = searchStub([core, adjacent]);
  try {
    const withoutModel = await researchRoleSources({ request, config: { provider: "glm", apiKey: "test-only-key" }, queries: [query] });
    const baseline = withoutModel.report.candidates.find(candidate => candidate.url === adjacent.link)!;
    const model = verdictModel([
      { url: core.link, relation: "core", note: "目标岗位", confidence: 0.9 },
      { url: adjacent.link, relation: "adjacent", note: "相邻网络运维岗位", confidence: 0.8 },
    ]);
    const { report } = await researchRoleSources({
      request, config: { provider: "glm", apiKey: "test-only-key" }, queries: [query],
      verifyBoundaries: createBoundaryVerifier(model),
    });
    const demoted = report.candidates.find(candidate => candidate.url === adjacent.link)!;
    assert.ok(demoted.rankingScore < baseline.rankingScore, `${demoted.rankingScore} < ${baseline.rankingScore}`);
    assert.equal(demoted.boundaryVerdict?.relation, "adjacent");
  } finally { restore(); }
});

test("model failure falls back to deterministic heuristics unchanged", async () => {
  const restore = searchStub([core, foreign]);
  try {
    const failing: ModelInvoker = async function* () { throw new Error("MODEL_TIMEOUT"); };
    const { sources, report } = await researchRoleSources({
      request, config: { provider: "glm", apiKey: "test-only-key" }, queries: [query],
      verifyBoundaries: createBoundaryVerifier(failing),
    });
    assert.ok(sources.some(source => source.locator === core.link), "模型失败不得拖垮检索");
    assert.ok(report.candidates.every(candidate => candidate.boundaryVerdict === undefined));
  } finally { restore(); }
});

test("verdicts for unknown urls are dropped and cannot fabricate sources", async () => {
  const restore = searchStub([core]);
  try {
    const model = verdictModel([
      { url: "https://invented.example.com/fake", relation: "core", note: "模型编造的 url", confidence: 1 },
    ]);
    const { sources, report } = await researchRoleSources({
      request, config: { provider: "glm", apiKey: "test-only-key" }, queries: [query],
      verifyBoundaries: createBoundaryVerifier(model),
    });
    assert.ok(!sources.some(source => source.locator?.includes("invented.example.com")));
    assert.ok(!report.candidates.some(candidate => candidate.url.includes("invented.example.com")));
  } finally { restore(); }
});

test("verifier memoizes per content hash across repeated research runs", async () => {
  const restore = searchStub([core]);
  try {
    const calls = { count: 0 };
    const verifier = createBoundaryVerifier(verdictModel([{ url: core.link, relation: "core", note: "", confidence: 0.9 }], calls));
    const config = { provider: "glm" as const, apiKey: "test-only-key" };
    await researchRoleSources({ request, config, queries: [query], verifyBoundaries: verifier });
    await researchRoleSources({ request, config, queries: [query], verifyBoundaries: verifier });
    assert.equal(calls.count, 1, "相同候选内容重复运行不得重复调用模型");
  } finally { restore(); }
});
