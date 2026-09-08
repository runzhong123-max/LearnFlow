import assert from "node:assert/strict";
import test from "node:test";
import { mergeResearchReports } from "@/lib/build/graph";
import type { WebResearchReport } from "@/lib/build/types";
import { currentIterationResearchReport } from "@/lib/iteration/graph";
import type { IterationResearchPlan } from "@/lib/iteration/types";

function report(id: string, requestId: string | undefined = `request:${id}`, completedAt = "2026-09-08T00:00:01Z"): WebResearchReport {
  return { provider: "tavily", providerName: "fixture", startedAt: "2026-09-08T00:00:00Z", completedAt,
    queries: [{ id, requestId, category: "technology", query: "服务部署 操作指南", resultCount: 1, credits: 2 }],
    candidateCount: 1, selectedSourceCount: 1, deduplicatedCount: 0, candidates: [], failures: [],
    categoryCoverage: [{ category: "technology", queryCount: 1, candidateCount: 1, selectedSourceCount: 1, status: "covered" }],
    usage: { searchCredits: 2, extractCredits: 0, totalCredits: 2 } };
}
function plan(ids: string[]): IterationResearchPlan {
  return { id: "plan:second-round", round: 2, workItemIds: [], rationale: [], stopConditions: [],
    queries: ids.map(id => ({ id, query: "服务部署 操作指南", category: "technology", priority: 1 })) };
}

test("无新查询、缺少计划及尚未执行的当前计划不会把上轮报告当作本轮报告", () => {
  const old = report("query:round-1");
  assert.equal(currentIterationResearchReport(undefined, [old]), undefined);
  assert.equal(currentIterationResearchReport(plan([]), [old]), undefined);
  assert.equal(currentIterationResearchReport(plan(["query:round-2"]), [old]), undefined);
  const current = report("query:round-2");
  assert.equal(currentIterationResearchReport(plan(["query:round-2"]), [old, current]), current);
});

test("恢复的累计报告已经包含本轮请求时，重建不重复累计查询、来源、分类或费用", () => {
  const first = report("query:round-1");
  const second = report("query:round-2");
  const cumulative = mergeResearchReports(first, second);
  assert.equal(cumulative.queries.length, 2);
  assert.equal(cumulative.usage?.totalCredits, 4);
  assert.equal(mergeResearchReports(cumulative, structuredClone(second)), cumulative);
  assert.equal(cumulative.categoryCoverage[0].queryCount, 2);
  assert.equal(cumulative.selectedSourceCount, 2);
  assert.equal(first.queries.length, 1, "原报告不可修改");
});

test("同一 query ID 的新供应商请求是真实执行，不能去掉其检索次数与费用", () => {
  const first = report("same-query", "request:first");
  const retry = report("same-query", "request:retry");
  const cumulative = mergeResearchReports(first, retry);
  assert.deepEqual(cumulative.queries.map(query => query.requestId), ["request:first", "request:retry"]);
  assert.equal(cumulative.usage?.totalCredits, 4);
});

test("没有供应商 request ID 时用报告完成时间区分执行，空查询报告不触发包含去重", () => {
  const first = report("same-query", undefined, "2026-09-08T00:00:01Z");
  delete first.queries[0].requestId;
  const retry = structuredClone(first);
  retry.completedAt = "2026-09-08T00:00:02Z";
  const cumulative = mergeResearchReports(first, retry);
  assert.equal(cumulative.queries.length, 2);
  assert.equal(mergeResearchReports(cumulative, retry), cumulative);
  const queryless = { ...report("old-format"), queries: [] };
  assert.equal(mergeResearchReports(cumulative, queryless).usage?.totalCredits, 6);
});

test("相同查询之后新发生的正文提取请求不会误被识别为重复执行", () => {
  const first = report("same-query");
  const withExtraction = { ...first, extraction: { requestCount: 1, requestedSourceCount: 1, extractedSourceCount: 1, failedSourceCount: 0, requestIds: ["extract:new"] }, usage: { searchCredits: 0, extractCredits: 1, totalCredits: 1 } };
  assert.equal(mergeResearchReports(first, withExtraction).usage?.totalCredits, 3);
});
