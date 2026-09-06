import assert from "node:assert/strict";
import test from "node:test";
import { classifyHubEntry } from "@/lib/hub/taxonomy";
import { searchGraphHubCatalog } from "@/lib/graph-hub/file-graph-hub";
import type { GraphHubCatalog } from "@/lib/graph-hub/types";

test("计算机岗位中英文别名、专门岗位和无法识别时的保守归类", () => {
  for (const [title, category] of [
    ["后端开发工程师", "软件开发"], ["QA Engineer", "软件测试"],
    ["DevOps工程师", "云计算"], ["云运维工程师", "云计算"],
    ["网络安全工程师", "网络安全"], ["大数据开发工程师", "数据技术"],
    ["Agent开发工程师", "人工智能"], ["AI Engineer", "人工智能"],
    ["嵌入式软件工程师", "物联网与嵌入式"], ["UI设计师", "数字媒体与交互设计"],
    ["软件实施工程师", "IT技术支持"], ["护士", "待归类"],
    ["未知岗位", "待归类"], ["Retail Specialist", "待归类"],
  ]) {
    const result = classifyHubEntry({ title });
    assert.deepEqual(result, [category], title);
    assert.deepEqual(classifyHubEntry({ title, categories: result }), result, `idempotent: ${title}`);
  }
  assert.deepEqual(classifyHubEntry({ title: "新岗位", aliases: ["Cloud Engineer"] }), ["云计算"]);
  assert.deepEqual(classifyHubEntry({ title: "新岗位", categories: ["网络安全"] }), ["网络安全"]);
  assert.deepEqual(classifyHubEntry({ title: "新岗位", summary: "不拼算法，负责设计系统" }), ["待归类"]);
  assert.deepEqual(classifyHubEntry({ title: "云计算工程师", aliases: ["算法工程师"] }), ["云计算"]);
});

test("旧文件目录重新投影分类，不沿用误分类、不暴露私有图谱", () => {
  const catalog = { protocol: "graph-hub-catalog.v1", entries: [{
    graphId: "cloud", title: "云计算/云维护工程师", summary: "不拼算法", keywords: ["Agent"],
    categories: ["人工智能与数据"], nodeIndex: [], access: "public",
  }, { graphId: "private", title: "云计算工程师", summary: "", keywords: [], nodeIndex: [], access: "owner", ownerSubjectId: "alice" }],
  } as unknown as GraphHubCatalog;
  const result = searchGraphHubCatalog(catalog, { query: "", category: "云计算" });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].entry.categories, ["云计算"]);
  assert.deepEqual(catalog.entries[0].categories, ["人工智能与数据"]);
});
