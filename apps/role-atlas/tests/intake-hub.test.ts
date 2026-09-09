import assert from "node:assert/strict";
import test from "node:test";
import type { HubEntry } from "@/lib/hub/discovery";
import { suggestIntakeHubMatches, type IntakeHubDependencies } from "@/lib/intake/hub";
import type { StaticRolePackageBundle } from "@/lib/packages/types";

function fixture(id: string) {
  const entry: HubEntry = {
    id: `line:${id}`, packageId: `package:${id}`, title: `软件测试工程师 ${id}`, summary: "目录摘要不作为证据", aliases: [],
    categories: [], audiences: [], maintainerName: "维护者", maintenanceKind: "community", protocolRange: "^3", evidencePolicy: "metadata",
    release: { id: `release:${id}`, packageVersion: "1.2.0", snapshotId: `snapshot:${id}`, rootHash: "a".repeat(64),
      protocolVersion: "3.0.0", snapshotAsOf: "2026-09-09", publishedAt: "2026-09-09T01:00:00Z" }, nodeIndex: [],
  };
  const bundle: StaticRolePackageBundle = {
    manifest: { packageProtocol: "static-role-package", protocolVersion: "3.0.0", packageId: entry.packageId,
      packageVersion: entry.release.packageVersion, snapshotId: entry.release.snapshotId, snapshotAsOf: entry.release.snapshotAsOf,
      roleTitle: `制品岗位标题 ${id}`, visibility: "public", evidencePolicy: "metadata", rootHash: entry.release.rootHash,
      entrypoints: { semanticGraph: "semantic.json", workProcessForest: "process.json", snapshot: "snapshot.json" }, hashes: {} },
    components: {
      "semantic.json": JSON.stringify({ nodes: [
        ...Array.from({ length: 7 }, (_, index) => ({ id: `task:${index}`, type: index % 2 ? "task" : "typical_task", label: `任务 ${index}` })),
        ...Array.from({ length: 6 }, (_, index) => ({ id: `cap:${index}`, type: index % 2 ? "capability" : "capability_unit", label: `能力 ${index}` })),
        { id: "knowledge:1", type: "knowledge_skill", label: "知识不应混入能力" },
      ] }),
      "process.json": JSON.stringify({ scenarios: Array.from({ length: 5 }, (_, index) => ({ label: `场景 ${index}` })) }),
      "snapshot.json": JSON.stringify({ brief: { roleDescription: `固定制品中的职责 ${id}` } }),
    },
  };
  const source = {
    line: { id: entry.id, packageId: entry.packageId, visibility: "public", status: "active", license: "CC-BY-4.0" },
    release: { id: entry.release.id, packageVersion: entry.release.packageVersion, snapshotId: entry.release.snapshotId,
      artifactRootHash: entry.release.rootHash, status: "published", publishedAt: entry.release.publishedAt },
    bundle,
  };
  return { entry, source };
}

function dependencies(fixtures: ReturnType<typeof fixture>[]) {
  const calls: string[] = [];
  const deps: IntakeHubDependencies = {
    listEntries: async () => fixtures.map(item => item.entry),
    requirePublicRelease: async id => { calls.push(`access:${id}`); },
    readRelease: async id => { calls.push(`read:${id}`); return fixtures.find(item => item.entry.release.id === id)?.source ?? null; },
    validateBundle: async () => ({ valid: true }),
  };
  return { deps, calls };
}

test("Hub suggestions inspect at most three fixed public releases without creating a project", async () => {
  const fixtures = ["a", "b", "c", "d"].map(fixture);
  const { deps, calls } = dependencies(fixtures);
  const matches = await suggestIntakeHubMatches("软件测试", { dependencies: deps });
  assert.equal(matches.length, 3);
  assert.deepEqual(calls, ["a", "b", "c"].flatMap(id => [`access:release:${id}`, `read:release:${id}`]));
  assert.deepEqual(matches[0], {
    packageLineId: "line:a", releaseId: "release:a", packageId: "package:a", packageVersion: "1.2.0",
    snapshotId: "snapshot:a", rootHash: "a".repeat(64), title: "制品岗位标题 a", license: "CC-BY-4.0",
    summary: "固定制品中的职责 a", matchReasons: ["匹配岗位名称或包 ID", "匹配分类"],
    tasks: ["任务 0", "任务 1", "任务 2", "任务 3"], capabilities: ["能力 0", "能力 1", "能力 2", "能力 3"],
    scenarios: ["场景 0", "场景 1", "场景 2"], href: "/api/releases/release%3Aa/export?format=json",
  });
  assert.equal(fixtures[0].source.bundle.manifest.packageId, "package:a");
});

test("no matching roles returns an empty result without reading unrelated releases", async () => {
  const { deps, calls } = dependencies([fixture("a")]);
  assert.deepEqual(await suggestIntakeHubMatches("海洋考古", { dependencies: deps }), []);
  assert.deepEqual(calls, []);
});

test("access-denied and identity-drifted releases are skipped while a valid candidate remains", async () => {
  const fixtures = ["a", "b", "c"].map(fixture);
  fixtures[1].source.bundle.manifest.snapshotId = "snapshot:replacement";
  const { deps, calls } = dependencies(fixtures);
  deps.requirePublicRelease = async id => { if (id === "release:a") throw new Error("RELEASE_NOT_FOUND"); };
  const matches = await suggestIntakeHubMatches("软件测试", { dependencies: deps });
  assert.deepEqual(matches.map(match => match.releaseId), ["release:c"]);
  assert.ok(!calls.includes("read:release:a"));
});

test("private, withdrawn, invalid or mismatched artifacts never become intake suggestions", async () => {
  const changes: Array<(item: ReturnType<typeof fixture>) => void> = [
    item => { item.source.line.visibility = "private"; },
    item => { item.source.line.status = "deprecated"; },
    item => { item.source.release.status = "deprecated"; },
    item => { item.source.release.publishedAt = null; },
    item => { item.source.bundle.manifest.visibility = "private"; },
    item => { item.source.bundle.manifest.packageId = "package:other"; },
    item => { item.source.bundle.manifest.packageVersion = "2.0.0"; },
    item => { item.source.bundle.manifest.rootHash = "b".repeat(64); },
    item => { item.source.release.id = "release:other"; },
    item => { item.source.bundle.components["process.json"] = "corrupt"; },
  ];
  for (const change of changes) {
    const item = fixture("a"); change(item);
    await assert.rejects(suggestIntakeHubMatches("软件测试", { dependencies: dependencies([item]).deps }), /INTAKE_HUB_ARTIFACTS_UNAVAILABLE/);
  }
  const { deps } = dependencies([fixture("a")]);
  deps.validateBundle = async () => ({ valid: false });
  await assert.rejects(suggestIntakeHubMatches("软件测试", { dependencies: deps }), /INTAKE_HUB_ARTIFACTS_UNAVAILABLE/);
});

test("catalog failure propagates instead of claiming no roles exist", async () => {
  const { deps, calls } = dependencies([]);
  deps.listEntries = async () => { throw new Error("HUB_DISCOVERY_UNAVAILABLE"); };
  await assert.rejects(suggestIntakeHubMatches("软件测试", { dependencies: deps }), /HUB_DISCOVERY_UNAVAILABLE/);
  assert.deepEqual(calls, []);
});

test("candidate overview text is bounded and duplicate labels do not consume slots", async () => {
  const item = fixture("a");
  item.source.bundle.manifest.roleTitle = "岗".repeat(500);
  item.source.bundle.components["snapshot.json"] = JSON.stringify({ brief: { roleDescription: "描".repeat(1000) } });
  item.source.bundle.components["semantic.json"] = JSON.stringify({ nodes: [
    { type: "task", label: "工作  一" }, { type: "task", label: " 工作 一 " },
    { type: "task", label: "长".repeat(500) }, { type: "task", label: "工作二" },
  ] });
  const [match] = await suggestIntakeHubMatches("软件测试", { dependencies: dependencies([item]).deps });
  assert.equal(match.title.length, 200);
  assert.equal(match.summary.length, 700);
  assert.deepEqual(match.tasks, ["工作 一", "长".repeat(160), "工作二"]);
});
