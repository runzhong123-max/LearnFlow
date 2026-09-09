import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { compileStaticRolePackage } from "@/lib/packages/compiler";
import { publicationBlockers } from "@/lib/packages/validator";
import { refreshRolePackageManifest } from "@/lib/packages/role-package-manifest";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";
import { assertReleaseQuality, validateReleaseArtifact } from "@/lib/releases/quality";
import { releaseAction, releaseStatusLabel } from "@/lib/releases/presentation";
import { sourceUsage } from "@/lib/sources/presentation";

function reviewedResult() {
  const result = bundledRoleSnapshot();
  // The fixture models a version whose separate review has been completed.
  result.validation.publishable = true;
  return result;
}

function rootOnlyResult() {
  const result = reviewedResult();
  result.semantic.nodes = result.semantic.nodes.filter((node) => node.type === "market_role");
  result.semantic.edges = []; result.semantic.claims = [];
  result.process = { scenarios: [], nodes: [], edges: [], bridges: [] };
  result.sources.evidenceBindings = [];
  result.snapshot.sections = [];
  return refreshRolePackageManifest(result);
}

const compile = (result = reviewedResult(), visibility: "private" | "public" = "private") => compileStaticRolePackage({ result, packageId: "role-package:project:test", packageVersion: "1.0.0", visibility, evidencePolicy: "metadata" });

test("root-only files may compile for diagnosis but cannot become ready even with stale success flags", async () => {
  for (const visibility of ["private", "public"] as const) {
    const compiled = await compile(rootOnlyResult(), visibility);
    assert.equal(compiled.validation.valid, true, "file integrity is separate from usable content");
    assert.equal(compiled.validation.publishable, false);
    assert.equal(compiled.result.packages.rolePackage.status, "candidate");
    assert.match(compiled.validation.publicationBlockers!.join(" "), /典型任务.*能力.*知识技能/u);
    assert.equal((await validateReleaseArtifact(compiled.bundle)).publishable, false);
  }
});

test("release quality respects each failed axis, audit blockers and the original publishable decision", async () => {
  const reviewed = await compile();
  assert.equal(reviewed.validation.publishable, true);
  assert.equal((await validateReleaseArtifact(reviewed.bundle)).publishable, true);
  for (const axis of ["structural", "semantic", "evidence", "temporal", "process"] as const) {
    const result = reviewedResult();
    result.validation[axis].passed = false;
    result.validation[axis].issues = [`${axis} missing`];
    assert.ok(publicationBlockers(result).includes(`${axis} missing`));
  }
  const pending = reviewedResult(); pending.validation.publishable = false;
  assert.match(publicationBlockers(pending).join(" "), /尚未通过发布质量校验/u);
  const error = reviewedResult(); error.audit.issues.push({ id: "blocker", code: "INVALID", severity: "error", title: "实际阻塞", detail: "缺少可靠依据", targetIds: [], repair: "research" });
  assert.match(publicationBlockers(error).join(" "), /实际阻塞/u);
});

test("excluded sources are never labeled adopted and their bindings block publication", () => {
  assert.equal(sourceUsage({ status: "rejected", evidenceBindingCount: 0 }).group, "excluded");
  assert.equal(sourceUsage({ status: "quarantined", evidenceBindingCount: 1 }).group, "excluded");
  assert.equal(sourceUsage({ status: "accepted", evidenceBindingCount: 0 }).group, "pending");
  assert.equal(sourceUsage({ status: "accepted" }).group, "pending", "unknown usage must not imply acceptance");
  assert.equal(sourceUsage({ status: "limited", evidenceBindingCount: 2 }).group, "bound");
  const result = reviewedResult();
  const source = result.sources.assets.find((asset) => result.sources.evidenceBindings.some((binding) => binding.sourceId === asset.id))!;
  source.qualification = { status: "quarantined", reasons: ["BIM 岗位与当前岗位不符"], evidenceRoles: [] };
  assert.match(publicationBlockers(result).join(" "), /已排除的来源仍被用作证据/u);
});

test("release actions distinguish private storage from public publication using immutable visibility", () => {
  assert.deepEqual(releaseAction("private"), { action: "save_private", label: "保存到我的岗位包" });
  assert.deepEqual(releaseAction("public"), { action: "publish", label: "发布到公开图谱市场" });
  assert.equal(releaseAction(null), null);
  assert.equal(releaseStatusLabel("published", "private"), "已私有保存");
  assert.equal(releaseStatusLabel("published", "public"), "已公开发布");
});

test("public metadata and redacted artifacts remove private raw quotes as well as segment text", async () => {
  const result = reviewedResult();
  const binding = result.sources.evidenceBindings[0];
  const source = result.sources.assets.find((asset) => asset.id === binding.sourceId)!;
  const segment = result.sources.segments.find((item) => item.id === binding.segmentId)!;
  source.visibility = "project_private";
  const secret = "PRIVATE-WORKSPACE-QUOTE-DO-NOT-EXPORT";
  segment.text = secret; segment.locator = "private/internal/path";
  binding.evidenceSpan = { segmentId: segment.id, quote: secret, start: 0, end: secret.length };
  result.semantic.edges[0].evidenceSpans = [{ segmentId: segment.id, quote: secret }];
  for (const evidencePolicy of ["metadata", "redacted"] as const) {
    const compiled = await compileStaticRolePackage({ result, packageId: "package", packageVersion: "1.0.0", visibility: "public", evidencePolicy });
    assert.equal(JSON.stringify(compiled.bundle).includes(secret), false);
    assert.equal(JSON.stringify(compiled.bundle).includes("private/internal/path"), false);
    assert.equal((await validateReleaseArtifact(compiled.bundle)).publishable, true);
  }
  assert.equal(binding.evidenceSpan.quote, secret, "private source version is unchanged");
  assert.equal((await compile(result, "private")).bundle.components["sources.json"].includes(secret), true);
});

async function serviceHarness(result = reviewedResult(), visibility: "private" | "public" = "private") {
  const compiled = await compile(result, visibility);
  const state = { artifactAvailable: true, compileCount: 0, release: { id: "release-1", packageLineId: "line-1", projectId: "project-1", sourceProjectVersionId: "version-1", status: "ready", artifactRootHash: compiled.bundle.manifest.rootHash }, line: { id: "line-1", packageId: "role-package:project:test", visibility, recommendedReleaseId: null as string | null }, compiled, batches: [] as unknown[][] };
  const key = `__releaseQuality${Math.random().toString(36).slice(2)}`;
  (globalThis as unknown as Record<string, unknown>)[key] = { state, validateReleaseArtifact, assertReleaseQuality };
  let code = (await readFile(resolve("lib/releases/service.ts"), "utf8")).replace(/^import[\s\S]*?;\n/gmu, "");
  code = `
    const { state, validateReleaseArtifact, assertReleaseQuality } = globalThis[${JSON.stringify(key)}];
    const packageReleases = { id: "id", packageLineId: "packageLineId", packageVersion: "packageVersion" }, packageLines = { id: "id" }, releaseEvents = {};
    const eq = (key, value) => row => row[key] === value, and = (...checks) => row => checks.every(check => check(row));
    const ensureAppSchema = async () => {};
    const getDb = () => ({
      select: () => ({ from: table => ({ where: check => ({ limit: async () => [table === packageLines ? state.line : state.release].filter(check) }) }) }),
      insert: () => ({ values: async row => { state.release = row; } }),
      update: () => ({ set: patch => ({ where: async () => Object.assign(state.release, patch) }) }),
    });
    const getD1 = () => ({ prepare: sql => ({ bind: (...args) => ({ sql, args }) }), batch: async statements => {
      state.batches.push(statements); state.release.status = "published"; state.line.recommendedReleaseId = state.release.id;
      return statements.map(() => ({ meta: { changes: 1 } }));
    } });
    const getPackageArtifact = async () => state.artifactAvailable ? ({ bundle: state.compiled.bundle }) : null;
    const putPackageArtifact = async () => { state.artifactAvailable = true; };
    const getProjectVersionRecord = async () => ({ id: "version-1", snapshotId: "snapshot-1", result: state.compiled.result });
    const projectReleasePackageId = async () => state.line.packageId;
    const ensureRegistryPackageLine = async () => state.line;
    const compileStaticRolePackage = async () => { state.compileCount++; return state.compiled; };
    const canonicalStringify = JSON.stringify, sha256Hex = async () => "hash", domainId = () => "prepared-new";
    ${code}`;
  const compiledCode = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const service = await import(`data:text/javascript;base64,${Buffer.from(compiledCode).toString("base64")}`) as typeof import("@/lib/releases/service");
  return { state, service, cleanup() { delete (globalThis as unknown as Record<string, unknown>)[key]; } };
}

test("legacy ready rows are rechecked before any publication write", async () => {
  const h = await serviceHarness(rootOnlyResult(), "public");
  try {
    await assert.rejects(h.service.publishRelease({ releaseId: "release-1" }), /RELEASE_QUALITY_BLOCKED/u);
    assert.equal(h.state.batches.length, 0);
    assert.equal(h.state.release.status, "ready");
    assert.equal((await h.service.describeRelease(h.state.release as never)).canPublish, false);
  } finally { h.cleanup(); }
});

test("prepare retains a failed diagnostic artifact instead of marking an empty role package ready", async () => {
  const h = await serviceHarness(rootOnlyResult());
  try {
    // No existing row matches this package-version lookup.
    const release = await h.service.prepareRelease({ projectId: "project-1", projectVersionId: "version-1", packageVersion: "1.0.0" });
    assert.equal(release.status, "failed");
    assert.match(release.error!, /典型任务/u);
    assert.ok(release.artifactRootHash);
    assert.equal(h.state.batches.length, 0);
  } finally { h.cleanup(); }
});

test("visibility mismatch is rejected without writes, while valid private and public packages retain their chosen scope", async () => {
  for (const visibility of ["private", "public"] as const) {
    const h = await serviceHarness(reviewedResult(), visibility);
    try {
      await assert.rejects(h.service.publishRelease({ releaseId: "release-1", expectedVisibility: visibility === "private" ? "public" : "private" }), /RELEASE_VISIBILITY_CONFLICT/u);
      assert.equal(h.state.batches.length, 0);
      assert.equal((await h.service.publishRelease({ releaseId: "release-1", expectedVisibility: visibility })).status, "published");
      const lineWrite = h.state.batches[0][1] as { args: unknown[] };
      assert.equal(lineWrite.args[1], visibility);
    } finally { h.cleanup(); }
  }
});

test("rolling back a previously public artifact cannot silently undo its current private withdrawal", async () => {
  const h = await serviceHarness(reviewedResult(), "public");
  try {
    h.state.release.status = "published";
    h.state.line.visibility = "private";
    await h.service.rollbackRelease({ packageLineId: "line-1", targetReleaseId: "release-1" });
    const lineWrite = h.state.batches[0][0] as { args: unknown[] };
    assert.equal(lineWrite.args[1], "private");
  } finally { h.cleanup(); }
});


test("authorized learning source prepares a valid private artifact without weakening publication quality", async () => {
  const h = await serviceHarness(rootOnlyResult());
  try {
    assert.equal(h.state.compiled.validation.valid, true);
    assert.equal(h.state.compiled.validation.publishable, false);
    const input = { projectId: "project-1", projectVersionId: "version-1", packageVersion: "1.0.0", sourceUse: "learning_path" as const };
    await assert.rejects(h.service.prepareRelease({ ...input, visibility: "public" }), /LEARNING_SOURCE_MUST_BE_PRIVATE/u);
    await assert.rejects(h.service.prepareRelease({ ...input, evidencePolicy: "full" }), /LEARNING_SOURCE_MUST_BE_PRIVATE/u);
    const release = await h.service.prepareRelease(input);
    assert.equal(release.status, "ready");
    assert.equal(h.state.compiled.bundle.manifest.visibility, "private");
    assert.equal(h.state.batches.length, 0);
    await assert.rejects(h.service.publishRelease({ releaseId: release.id }), /RELEASE_QUALITY_BLOCKED/u);
    assert.equal(h.state.batches.length, 0, "source readiness never publishes the package or changes its recommendation");
  } finally { h.cleanup(); }
});

test("an interrupted private source compilation resumes only the exact original version", async () => {
  const h = await serviceHarness(reviewedResult());
  try {
    Object.assign(h.state.release, { status: "validating", snapshotId: "snapshot-1", packageVersion: "1.0.0", artifactRootHash: null });
    h.state.artifactAvailable = false;
    const input = { projectId: "project-1", projectVersionId: "version-1", packageVersion: "1.0.0", sourceUse: "learning_path" as const };
    await assert.rejects(h.service.prepareRelease({ ...input, projectVersionId: "other-version" }), /RELEASE_VERSION_CONFLICT/u);
    assert.equal(h.state.compileCount, 0);
    const release = await h.service.prepareRelease(input);
    assert.equal(release.id, "release-1"); assert.equal(release.status, "ready"); assert.equal(h.state.compileCount, 1);
    assert.ok(release.artifactRootHash); assert.equal(h.state.batches.length, 0);
  } finally { h.cleanup(); }
});
