import assert from "node:assert/strict";
import test from "node:test";
import { searchHub, type HubEntry } from "@/lib/hub/discovery";

/**
 * Golden boundary regression for easily confused operations roles.
 * Reported failure: a 云运维 query returned 大模型应用工程师 because shared
 * cloud vocabulary outweighed occupational boundaries. These fixtures pin the
 * intended exclusions so the ranking cannot silently drift back.
 */
const entry = (id: string, patch: Partial<HubEntry> = {}): HubEntry => ({
  id, packageId: `package:${id}`, title: id, summary: "", aliases: [], categories: [], audiences: [],
  maintainerName: "测试维护者", maintenanceKind: "community", protocolRange: "^3", evidencePolicy: "metadata",
  release: { id: `release:${id}`, packageVersion: "1.0.0", snapshotId: `snap:${id}`, rootHash: "b".repeat(64), protocolVersion: "3.0.0", snapshotAsOf: "2026-09-11", publishedAt: null },
  nodeIndex: [], ...patch,
});

const entries = [
  entry("cloud-ops", { title: "云运维工程师", aliases: ["云计算运维", "CloudOps Engineer"], nodeIndex: [
    { id: "task:deliver", label: "云平台资源交付与变更", summary: "按变更单交付云资源并验证可用性", type: "typical_task", aliases: [] },
    { id: "task:monitor", label: "可用性监控与故障恢复", type: "typical_task", aliases: [] },
    { id: "skill:cloud", label: "云平台运维", type: "knowledge_skill", aliases: [] },
  ] }),
  entry("network-ops", { title: "网络运维工程师", nodeIndex: [
    { id: "task:link", label: "网络设备巡检与链路排障", type: "typical_task", aliases: [] },
  ] }),
  entry("security-ops", { title: "安全运维工程师", nodeIndex: [
    { id: "task:soc", label: "安全策略配置与事件响应", type: "typical_task", aliases: [] },
  ] }),
  entry("it-support", { title: "IT技术支持工程师", nodeIndex: [
    { id: "task:desktop", label: "桌面终端故障处理", type: "typical_task", aliases: [] },
  ] }),
  entry("llm", { title: "大模型应用工程师", summary: "使用云平台部署大模型应用", nodeIndex: [
    { id: "skill:deploy", label: "云平台部署", type: "knowledge_skill", aliases: [] },
    { id: "task:prompt", label: "设计并评估提示词应用", type: "typical_task", aliases: [] },
  ] }),
];

test("云运维查询命中云运维岗位，跨领域岗位不进入结果", () => {
  for (const query of ["云运维工程师", "云运维", "云计算运维", "CloudOps Engineer"]) {
    const result = searchHub(entries, { query, target: "role" });
    assert.equal(result.items[0]?.entry.id, "cloud-ops", `query=${query}`);
    assert.ok(!result.items.some(item => item.entry.id === "llm"), `query=${query} 不得返回大模型应用工程师`);
    assert.ok(!result.items.some(item => ["security-ops", "it-support"].includes(item.entry.id)), `query=${query} 不得混入安全运维或IT支持`);
  }
});

test("相邻运维岗位互相排除，共享“运维”动词不构成匹配", () => {
  const network = searchHub(entries, { query: "网络运维工程师", target: "role" });
  assert.deepEqual(network.items.map(item => item.entry.id), ["network-ops"]);
  const security = searchHub(entries, { query: "安全运维工程师", target: "role" });
  assert.deepEqual(security.items.map(item => item.entry.id), ["security-ops"]);
});

test("任务检索仍按任务证据命中，且 roleQuery 过滤是合取约束", () => {
  const result = searchHub(entries, { query: "云平台资源交付与变更", target: "task" });
  assert.equal(result.items[0]?.entry.id, "cloud-ops");
  assert.deepEqual(result.items[0].matchedTasks.map(task => task.id), ["task:deliver"]);
  const constrained = searchHub(entries, { query: "安全策略配置与事件响应", target: "task", roleQuery: "云运维工程师" });
  assert.equal(constrained.total, 0, "安全运维任务不得挂到云运维岗位");
});

test("大模型应用工程师只在 AI 语义查询下出现", () => {
  const result = searchHub(entries, { query: "大模型应用工程师", target: "role" });
  assert.deepEqual(result.items.map(item => item.entry.id), ["llm"]);
  assert.equal(searchHub(entries, { query: "云平台部署", target: "role" }).items.some(item => item.entry.id === "llm"), false);
});
