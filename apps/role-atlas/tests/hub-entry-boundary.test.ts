import assert from "node:assert/strict";
import test from "node:test";
import { searchHub, type HubBoundaryVerdict, type HubEntry } from "../lib/hub/discovery";
import { createHubBoundaryVerifier, readCachedHubBoundary } from "../lib/hub/boundary";
import { suggestIntakeHubMatches, type IntakeHubDependencies } from "../lib/intake/hub";
import type { ModelInvoker } from "../lib/agent/model";
import type { StaticRolePackageBundle } from "../lib/packages/types";

/**
 * Generic entry-boundary verdicts for hub retrieval. Unlike the fixed
 * vocabulary heuristics, these verdicts come from a model judging the relation
 * between the query and each candidate — the mechanism works for any
 * occupation, and every test below pins a contract (demote-only, fail-open,
 * cached, audit-friendly), not a hand-picked ranking.
 */
const entry = (id: string, patch: Partial<HubEntry> = {}): HubEntry => ({
  id, packageId: `package:${id}`, title: id, summary: "", aliases: [], categories: [], audiences: [],
  maintainerName: "测试维护者", maintenanceKind: "community", protocolRange: "^3", evidencePolicy: "metadata",
  release: { id: `release:${id}`, packageVersion: "1.0.0", snapshotId: `snap:${id}`, rootHash: "a".repeat(64), protocolVersion: "3.0.0", snapshotAsOf: "2026-09-11", publishedAt: null },
  nodeIndex: [], ...patch,
});

const verdict = (relation: HubBoundaryVerdict["relation"], confidence = 0.9, note = "测试判定"): HubBoundaryVerdict => ({ relation, confidence, note });
const model = (value: unknown): ModelInvoker => async function* () { yield { type: "text", delta: JSON.stringify(value) }; };

test("foreign verdict excludes a listed entry; adjacent demotes without excluding; core changes nothing", () => {
  const a = entry("hub-boundary-a", { title: "数据分析师甲", aliases: ["数据洞察甲"] });
  const b = entry("hub-boundary-b", { title: "数据平台工程师乙", aliases: ["数据洞察乙"] });
  const query = "数据洞察";
  const baseline = searchHub([a, b], { query });
  assert.equal(baseline.items.length, 2);
  assert.equal(baseline.boundary, undefined);
  const before = baseline.items.find(item => item.entry.id === b.id)!.score;
  assert.ok(before > 0, "词法阶段两个候选都必须有正分数");

  const foreign = searchHub([a, b], { query }, { boundary: new Map([[b.id, verdict("foreign")]]) });
  assert.deepEqual(foreign.items.map(item => item.entry.id), [a.id]);
  assert.equal(foreign.boundary, "hub-boundary.v1");

  const adjacent = searchHub([a, b], { query }, { boundary: new Map([[b.id, verdict("adjacent")]]) });
  assert.equal(adjacent.items.length, 2, "相邻岗位降权但保留");
  const after = adjacent.items.find(item => item.entry.id === b.id)!.score;
  assert.ok(after < before, "相邻判定必须降分");
  assert.ok(adjacent.items.find(item => item.entry.id === b.id)!.reasons.some(reason => reason.includes("相邻岗位")));

  const core = searchHub([a, b], { query }, { boundary: new Map([[b.id, verdict("core", 1)]]) });
  assert.equal(core.items.find(item => item.entry.id === b.id)!.score, before, "core 判定不得改变分数");
});

test("verdicts never admit entries that fail the deterministic gates", () => {
  const a = entry("hub-gate-a", { title: "冷启动查询岗位", aliases: ["唯一别名xyz"] });
  const b = entry("hub-gate-b", { title: "不相干岗位" });
  const boundary = new Map([[b.id, verdict("core", 1)]]);
  const result = searchHub([a, b], { query: "唯一别名xyz", target: "role" }, { boundary });
  assert.deepEqual(result.items.map(item => item.entry.id), [a.id], "判定不得把不满足词法门槛的条目拉进结果");
});

test("model verdicts drop invented ids, warm the cache, and exclude generically", async () => {
  const target = entry("hub-cache-target", { title: "仓储物流专员" });
  const foreign = entry("hub-cache-foreign", { title: "仓储机器人算法工程师" });
  const query = "仓储物流专员";
  let calls = 0;
  const invoke: ModelInvoker = async function* () {
    calls += 1;
    yield { type: "text", delta: JSON.stringify({ verdicts: [
      { id: target.id, relation: "core", note: "就是目标岗位", confidence: 0.95 },
      { id: foreign.id, relation: "foreign", note: "属于机器人算法岗位", confidence: 0.92 },
      { id: "ghost-entry", relation: "foreign", note: "模型编造的 id", confidence: 1 },
    ] }) };
  };
  const verifier = createHubBoundaryVerifier(invoke);
  const verdicts = await verifier({ query, entries: [target, foreign] });
  assert.equal(calls, 1);
  assert.ok(verdicts && !verdicts.has("ghost-entry"), "编造的 id 必须丢弃");
  assert.equal(verdicts!.get(foreign.id)?.relation, "foreign");

  // The cache now serves the same verdicts to any later, model-free caller.
  const cached = readCachedHubBoundary(query, [target, foreign]);
  assert.equal(cached.get(foreign.id)?.relation, "foreign");
  const ranked = searchHub([target, foreign], { query, target: "role" }, { boundary: cached });
  assert.deepEqual(ranked.items.map(item => item.entry.id), [target.id]);
});

test("verifier failure returns undefined and callers keep lexical ranking", async () => {
  const verifier = createHubBoundaryVerifier(async function* () { throw new Error("provider down"); });
  const a = entry("hub-fail-a", { title: "供电运维工程师" });
  const result = await verifier({ query: "供电运维", entries: [a] });
  assert.equal(result, undefined, "模型失败必须失败开放到词法排序");
  assert.equal(readCachedHubBoundary("供电运维", [a]).size, 0, "失败结果不得写缓存");
});

function intakeDeps(fixtures: Array<{ entry: HubEntry }>) {
  const bundle = (item: { entry: HubEntry }): StaticRolePackageBundle => ({
    manifest: { packageProtocol: "static-role-package", protocolVersion: "3.0.0", packageId: item.entry.packageId,
      packageVersion: item.entry.release.packageVersion, snapshotId: item.entry.release.snapshotId, snapshotAsOf: item.entry.release.snapshotAsOf,
      roleTitle: item.entry.title, visibility: "public", evidencePolicy: "metadata", rootHash: item.entry.release.rootHash,
      entrypoints: { semanticGraph: "semantic.json", workProcessForest: "process.json", snapshot: "snapshot.json" }, hashes: {} },
    components: {
      "semantic.json": JSON.stringify({ nodes: [{ id: "task:1", type: "typical_task", label: "任务一" }] }),
      "process.json": JSON.stringify({ scenarios: [{ label: "场景一" }] }),
      "snapshot.json": JSON.stringify({ brief: { roleDescription: `职责 ${item.entry.title}` } }),
    },
  });
  const deps: IntakeHubDependencies = {
    listEntries: async () => fixtures.map(item => item.entry),
    requirePublicRelease: async () => undefined,
    readRelease: async id => {
      const item = fixtures.find(f => f.entry.release.id === id);
      return item ? { line: { id: item.entry.id, packageId: item.entry.packageId, status: "active", visibility: "public", license: "CC-BY-4.0" },
        release: { id: item.entry.release.id, packageVersion: item.entry.release.packageVersion, snapshotId: item.entry.release.snapshotId,
          status: "published", artifactRootHash: item.entry.release.rootHash, publishedAt: "2026-09-11T00:00:00Z" },
        bundle: bundle(item) } : null;
    },
    validateBundle: async () => ({ valid: true }),
  };
  return deps;
}

test("intake suggestions apply boundary verdicts and degrade gracefully without one", async () => {
  const target = entry("hub-intake-target", { title: "售前解决方案工程师" });
  const foreign = entry("hub-intake-foreign", { title: "售前客服专员", aliases: ["售前解决方案工程师"] });
  const deps = intakeDeps([{ entry: target }, { entry: foreign }]);
  const query = "售前解决方案工程师";

  const boundaryFree = await suggestIntakeHubMatches(query, { dependencies: deps });
  assert.equal(boundaryFree.length, 2, "词法阶段两个候选都可见");

  const verifier = createHubBoundaryVerifier(model({ verdicts: [
    { id: target.id, relation: "core", note: "目标岗位", confidence: 0.95 },
    { id: foreign.id, relation: "foreign", note: "客服岗位混用相同别名", confidence: 0.93 },
  ] }));
  const bounded = await suggestIntakeHubMatches(query, { dependencies: deps, boundaryVerifier: verifier });
  assert.deepEqual(bounded.map(match => match.packageLineId), [target.id], "边界判定排除混用别名的岗位");

  // Isolated query: a failing verifier must not hide recommendations. Note this
  // case uses a fresh query because verdicts cached above legitimately apply.
  const other = entry("hub-intake-down", { title: "售后技术支持工程师" });
  const downDeps = intakeDeps([{ entry: other }]);
  const failing = await suggestIntakeHubMatches("售后技术支持工程师", { dependencies: downDeps,
    boundaryVerifier: async () => { throw new Error("provider down"); } });
  assert.equal(failing.length, 1, "判定器异常不得让推荐消失");
});
