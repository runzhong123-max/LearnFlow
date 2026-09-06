import assert from "node:assert/strict";
import test from "node:test";
import { searchHub, type HubEntry } from "@/lib/hub/discovery";

const entry = (id: string, patch: Partial<HubEntry> = {}): HubEntry => ({
  id, packageId: `package:${id}`, title: id, summary: "", aliases: [], categories: [], audiences: [],
  maintainerName: "测试维护者", maintenanceKind: "community", protocolRange: "^3", evidencePolicy: "metadata",
  release: { id: `release:${id}`, packageVersion: "1.0.0", snapshotId: `snap:${id}`, rootHash: "a".repeat(64), protocolVersion: "3.0.0", snapshotAsOf: "2026-09-04", publishedAt: null },
  nodeIndex: [], ...patch,
});

test("岗位名称、别名、知识技能使用同一检索排序且返回匹配依据", () => {
  const entries = [entry("test", { title: "软件测试工程师", aliases: ["QA Engineer"], categories: ["软件工程"],
    nodeIndex: [{ id: "skill:1", label: "自动化回归测试", type: "knowledge_skill", aliases: [] }] }), entry("other", { title: "云平台工程师" })];
  for (const query of ["我想了解软件测试工程师", "ＱＡ Engineer", "自动化回归测试"]) {
    const result = searchHub(entries, { query });
    assert.equal(result.items[0]?.entry.id, "test");
    assert.ok(result.items[0].reasons.length);
  }
  assert.equal(searchHub(entries, { query: "不存在的量子主题" }).total, 0);
});

test("分类来自全部目录数据，去重不截断；过滤、分页和空结果明确", () => {
  const entries = Array.from({ length: 17 }, (_, index) => entry(String(index), { categories: ["共享", `类别${index}`] }));
  const result = searchHub(entries, { limit: 5 });
  assert.ok(result.categories.length >= 18);
  assert.equal(result.items.length, 5);
  assert.equal(result.nextOffset, 5);
  assert.equal(searchHub(entries, { category: "类别12" }).total, 1);
  assert.equal(searchHub(entries, { category: "缺失分类" }).total, 0);
  assert.equal(searchHub(entries, { offset: 15, limit: 5 }).nextOffset, null);
});

 test("空目录也有固定分类；自动归类保留人工标签且不将空分类伪装成岗位包", () => {
  const empty = searchHub([]);
  assert.ok(empty.categories.includes("医疗与健康"));
  assert.equal(empty.categoryCounts["医疗与健康"], 0);
  assert.equal(empty.total, 0);
  const entries = [entry("ai", { title: "大模型应用工程师", categories: ["企业服务"] }), entry("nurse", { title: "护士" }), entry("unknown", { title: "未识别岗位" })];
  const ai = searchHub(entries, { category: "人工智能与数据" });
  assert.equal(ai.total, 1);
  assert.ok(ai.items[0].entry.categories.includes("企业服务"));
  assert.equal(searchHub(entries, { query: "医疗与健康" }).items[0].entry.id, "nurse");
  assert.equal(searchHub(entries, { category: "其他／待归类" }).items[0].entry.id, "unknown");
  assert.deepEqual(entries[0].categories, ["企业服务"]);
});
