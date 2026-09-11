import assert from "node:assert/strict";
import test from "node:test";
import { foreignOccupationPenalty, researchRoleSources, stalenessPenalty, titledOccupations } from "@/lib/search/web-research";
import { coldStartRequestSchema, type WebSearchCategory } from "@/lib/build/types";

const request = coldStartRequestSchema.parse({ runId: "test-run", projectId: "test-project", roleTitle: "云运维工程师", market: "中国大陆", snapshotAsOf: "2026-09-11" });

test("titled occupations expose the page's own occupational claim", () => {
  assert.deepEqual(titledOccupations("资深系统架构师成长路线"), ["资深系统"]);
  assert.deepEqual(titledOccupations("云计算平台最佳实践"), []);
  assert.deepEqual(titledOccupations("云运维工程师岗位职责（2026版）"), ["云运维"]);
});

test("foreign occupation pages are penalized unless the body leads with the target role", () => {
  const target = "云运维工程师";
  assert.equal(foreignOccupationPenalty({ title: "云运维工程师岗位职责", content: "负责云平台交付。" }, target), 0);
  assert.equal(foreignOccupationPenalty({ title: "云计算平台最佳实践", content: "云资源编排与变更。" }, target), 0);
  // Body never leads with the target role: another occupation's page.
  assert.equal(foreignOccupationPenalty({ title: "系统架构师职业发展报告", content: "架构治理、技术选型与团队协同。" }, target), 0.24);
  // Comparison material still leads with the target role: halved penalty only.
  assert.equal(foreignOccupationPenalty({ title: "安全运维工程师与云运维工程师的职责差异", content: "云运维工程师负责云平台可用性，云运维边界如下。" }, target), 0.12);
});

test("staleness decay applies only to time-sensitive categories", () => {
  const stale = { publishedAt: "2020-03-01" };
  assert.equal(stalenessPenalty(stale, "job_market", 2026), 0.16);
  assert.equal(stalenessPenalty(stale, "future_signal", 2026), 0.16);
  assert.equal(stalenessPenalty(stale, "technology", 2026), 0);
  assert.equal(stalenessPenalty({ publishedAt: "2025-06-01" }, "job_market", 2026), 0);
  assert.equal(stalenessPenalty({}, "job_market", 2026), 0);
});

test("foreign occupation sources are rejected from selection with an auditable disposition", async () => {
  const previous = globalThis.fetch;
  const filler = "围绕云平台交付、可用性监控与故障排查展开。".repeat(40);
  try {
    globalThis.fetch = async (url) => {
      assert.match(String(url), /bigmodel\.cn/);
      return Response.json({ request_id: "req-boundary", search_result: [
        { title: "云运维工程师岗位职责与任职要求", link: "https://careers.example.org/cloud-ops", content: `云运维工程师岗位职责：${filler}`, publish_date: "2026-08-01" },
        { title: "网络运维工程师培训机构招生简章", link: "https://ads.example.net/network-ops", content: `网络运维工程师课程介绍，涉及机房布线、设备巡检与链路排障，与云平台交付无关。${"网络设备巡检与链路排障。".repeat(40)}`, publish_date: "2026-08-01" },
      ] });
    };
    const { sources, report } = await researchRoleSources({
      request, config: { provider: "glm", apiKey: "test-only-key" },
      queries: [{ id: "query:one", category: "job_market" as WebSearchCategory, query: "云运维工程师 岗位职责", priority: 9 }],
    });
    assert.deepEqual(sources.map(source => source.locator), ["https://careers.example.org/cloud-ops"]);
    const rejected = report.candidates.find(candidate => candidate.url === "https://ads.example.net/network-ops");
    assert.equal(rejected?.disposition, "foreign_occupation");
  } finally { globalThis.fetch = previous; }
});
