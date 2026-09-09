import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ResearchAudit from "@/app/components/ResearchAudit";
import EvidenceSourceView from "@/app/components/EvidenceSourceView";
import type { WebResearchReport } from "@/lib/build/types";

test("来源审计同时展示类别覆盖、查询追踪与未入选原因", () => {
  const report: WebResearchReport = {
    provider: "tavily",
    providerName: "Tavily",
    startedAt: "2026-08-21T00:00:00.000Z",
    completedAt: "2026-08-21T00:00:01.000Z",
    queries: [{
      id: "query:standard",
      category: "official_standard",
      query: "工业机器人系统运维员 国家职业标准",
      resultCount: 2,
      requestId: "request-search-1",
      responseTimeMs: 240,
      credits: 2,
    }],
    selectedSourceCount: 1,
    candidateCount: 2,
    deduplicatedCount: 0,
    candidates: [
      {
        title: "国家职业技能标准",
        url: "https://example.gov.cn/standard",
        domain: "example.gov.cn",
        queryIds: ["query:standard"],
        categories: ["official_standard"],
        relevanceScore: 1,
        rankingScore: 0.98,
        disposition: "selected",
      },
      {
        title: "无关榜单",
        url: "https://example.com/list",
        domain: "example.com",
        queryIds: ["query:standard"],
        categories: ["official_standard"],
        relevanceScore: 0,
        rankingScore: 0.32,
        disposition: "low_relevance",
      },
    ],
    categoryCoverage: [{ category: "official_standard", queryCount: 1, candidateCount: 2, selectedSourceCount: 1, status: "covered" }],
    failures: [],
    extraction: { requestCount: 1, requestedSourceCount: 1, extractedSourceCount: 1, failedSourceCount: 0, requestIds: ["request-extract-1"] },
    usage: { searchCredits: 2, extractCredits: 1, totalCredits: 3 },
  };

  const html = renderToStaticMarkup(createElement(ResearchAudit, { report }));
  assert.match(html, /标准政策/);
  assert.match(html, /request-search-1/);
  assert.match(html, /岗位相关性不足/);
  assert.match(html, /1\/2 进入研究/);
  assert.match(html, /未入选的结果不属于已采纳证据/);
});

test("来源页将BIM排除记录与真实绑定证据分组，资格通过不等于采纳", () => {
  const html = renderToStaticMarkup(createElement(EvidenceSourceView, { query: "", sources: [
    { id: "real", title: "当前岗位真实JD", kind: "public_document", status: "accepted", evidenceBindingCount: 2 },
    { id: "pending", title: "尚未绑定的资料", kind: "public_document", status: "accepted", evidenceBindingCount: 0 },
    { id: "bim", title: "BIM应用工程师", kind: "public_document", status: "rejected", evidenceBindingCount: 0, qualificationReasons: ["岗位相关性不足"] },
  ] }));
  assert.match(html, /data-source-usage="bound"[^]*?当前岗位真实JD/u);
  assert.match(html, /data-source-usage="pending"[^]*?资格通过，尚未绑定/u);
  assert.match(html, /data-source-usage="excluded"[^]*?BIM应用工程师[^]*?不作为已采纳证据/u);
  assert.match(html, /资格说明：岗位相关性不足/u);
  assert.match(html, /<b>1<\/b><small>实际绑定来源/u);
});
