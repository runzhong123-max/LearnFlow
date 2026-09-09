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

test("分类仅使用计算机岗位方向，空目录仍可浏览，筛选与分页独立", () => {
  const entries = Array.from({ length: 17 }, (_, index) => entry(String(index), { title: "前端开发工程师", categories: ["共享", `类别${index}`] }));
  const result = searchHub(entries, { limit: 5 });
  assert.deepEqual(result.categories, ["软件开发", "软件测试", "网络与运维", "云计算", "网络安全", "数据技术", "人工智能", "物联网与嵌入式", "数字媒体与交互设计", "IT技术支持", "待归类"]);
  assert.equal(result.items.length, 5);
  assert.equal(result.nextOffset, 5);
  assert.equal(searchHub(entries, { category: "软件开发" }).total, 17);
  assert.equal(searchHub(entries, { category: "缺失分类" }).total, 0);
  assert.equal(searchHub(entries, { category: "类别12" }).total, 0);
  assert.equal(searchHub(entries, { offset: 15, limit: 5 }).nextOffset, null);
  const empty = searchHub([]);
  assert.deepEqual(empty.categories, result.categories);
  assert.equal(empty.categoryCounts["网络安全"], 0);
  assert.equal(empty.total, 0);
});

test("线上五个岗位按岗位本身分类，历史行业和描述不污染导航", () => {
  const entries = [
    entry("llm", { title: "大模型应用工程师", categories: ["计算机与人工智能"] }),
    entry("test", { title: "软件测试工程师" }),
    entry("network", { title: "网络运维工程师" }),
    entry("cloud", { title: "云计算/云维护工程师", summary: "希望是高职计算机应届，不拼算法", categories: ["人工智能与数据"] }),
    entry("agent", { title: "Agent开发工程师", summary: "负责设计、开发、部署与维护AI智能体，与算法/后端岗位有边界", categories: ["软件与互联网", "人工智能与数据", "产品与设计"] }),
  ];
  const result = searchHub(entries);
  const byId = Object.fromEntries(result.items.map(item => [item.entry.id, item.entry.categories]));
  assert.deepEqual(byId, { llm: ["人工智能"], test: ["软件测试"], network: ["网络与运维"], cloud: ["云计算"], agent: ["人工智能"] });
  assert.equal(result.categoryCounts["人工智能"], 2);
  assert.equal(searchHub(entries, { category: "云计算", query: "云维护" }).total, 1);
  assert.equal(searchHub(entries, { category: "人工智能", query: "Agent" }).items[0].entry.id, "agent");
  assert.deepEqual(entries[0].categories, ["计算机与人工智能"]);
});

test("role precision rejects generic engineer suffixes and incidental cloud skills", () => {
  const llm = entry("llm", { title: "大模型应用工程师", summary: "云部署与数据库应用开发", nodeIndex: [
    { id: "skill:cloud", label: "云计算部署", type: "knowledge_skill", aliases: [] }] });
  const cloud = entry("cloud", { title: "云计算/云维护运维工程师", aliases: ["Cloud Operations Engineer"] });
  for (const query of ["云计算工程师（实施与运维方向）", "云平台工程师", "Cloud Operations Engineer"]) {
    assert.equal(searchHub([llm], { query, target: "role" }).total, 0);
    assert.equal(searchHub([llm], { query, target: "all" }).total, 0);
    assert.equal(searchHub([llm, cloud], { query, target: "role" }).items[0]?.entry.id, "cloud");
  }
  for (const query of ["工程师", "我想了解相关岗位", "量子通信工程师", "DevOps Engineer"]) assert.equal(searchHub([llm, cloud], { query, target: "role" }).total, 0);
});
test("tasks return stable task IDs and release pins; role constraints are conjunctive", () => {
  const entries = [entry("ops", { title: "云运维工程师", nodeIndex: [
    { id: "task:restore", label: "备份数据库并验证恢复", summary: "恢复后校验业务数据完整性", type: "task", aliases: ["数据库备份恢复"] },
    { id: "skill:restore", label: "数据库备份恢复", type: "knowledge_skill", aliases: [] },
    { id: "task:other", label: "培训客户使用软件", type: "task", aliases: [] },
  ] }), entry("test", { title: "软件测试工程师", nodeIndex: [
    { id: "task:test", label: "编写自动化回归测试", type: "typical_task", aliases: [] },
  ] })];
  const result = searchHub(entries, { query: "数据库备份恢复", target: "task", roleQuery: "云运维工程师" });
  assert.equal(result.total, 1); assert.equal(result.strategy, "field-coverage.v2");
  assert.deepEqual(result.items[0].matchedTasks.map(task => task.id), ["task:restore"]);
  assert.equal(result.items[0].entry.release.rootHash, "a".repeat(64));
  assert.equal(searchHub(entries, { query: "数据库备份恢复", target: "task", roleQuery: "软件测试工程师" }).total, 0);
  assert.equal(searchHub(entries, { query: "编写自动化回归测试", target: "task" }).items[0].entry.id, "test");
  assert.equal(searchHub(entries, { query: "数据库备份恢复", target: "role" }).total, 0);
});

test("cloud maintenance retains its cloud scope and direct package identity still resolves", () => {
  const sys = entry("system", { title: "系统运维工程师" });
  assert.equal(searchHub([sys], { query: "云维护工程师", target: "role" }).total, 0);
  assert.equal(searchHub([sys], { query: sys.packageId, target: "role" }).items[0].entry.id, sys.id);
});
