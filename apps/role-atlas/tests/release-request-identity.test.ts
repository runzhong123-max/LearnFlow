import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

type TestState = {
  release: Record<string, unknown>;
  line: Record<string, unknown>;
  version: Record<string, unknown>;
  manifest: Record<string, unknown> | null;
};

/** Exercise prepareRelease itself; an unexpected write fails instead of overwriting an immutable release. */
async function releaseHarness() {
  const state: TestState = {
    release: { id: "release-1", projectId: "project-1", sourceProjectVersionId: "version-1", snapshotId: "snapshot-1", packageLineId: "line-1", packageVersion: "1.0.0", artifactRootHash: "artifact-root", status: "published" },
    line: { id: "line-1", packageId: "package-1", visibility: "private", evidencePolicy: "full" },
    version: { id: "version-1", snapshotId: "snapshot-1", rootHash: "source-root", result: {} },
    manifest: { packageId: "package-1", packageVersion: "1.0.0", snapshotId: "snapshot-1", sourceProjectVersionId: "version-1", sourceRootHash: "source-root", rootHash: "artifact-root", visibility: "public", evidencePolicy: "metadata" },
  };
  const key = `__releaseIdentityTest${Math.random().toString(36).slice(2)}`;
  (globalThis as unknown as Record<string, unknown>)[key] = state;
  let source = await readFile(resolve("lib/releases/service.ts"), "utf8");
  source = source.replace(/^import[\s\S]*?;\n/gmu, "");
  const packageIdentity = (await readFile(resolve("lib/releases/package-identity.ts"), "utf8")).replace(/export /gu, "");
  source = `
    ${packageIdentity}
    const state = globalThis[${JSON.stringify(key)}];
    const and = (...value) => value, eq = (...value) => value, desc = value => value;
    const packageReleases = {}, packageLines = {}, releaseEvents = {};
    const getProjectVersionRecord = async () => state.version;
    const getD1 = () => ({ prepare: () => ({ bind: () => ({ first: async () => ({ package_id: state.line.packageId }) }) }) });
    const ensureRegistryPackageLine = async () => state.line;
    const getDb = () => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [state.release] }) }) }), insert: () => { throw new Error("UNEXPECTED_RELEASE_WRITE"); }, update: () => { throw new Error("UNEXPECTED_RELEASE_WRITE"); } });
    const getPackageArtifact = async () => state.manifest ? { bundle: { manifest: state.manifest } } : null;
    ${source}
  `;
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const service = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`) as typeof import("@/lib/releases/service");
  return { state, service, cleanup() { delete (globalThis as unknown as Record<string, unknown>)[key]; } };
}
const input = { projectId: "project-1", projectVersionId: "version-1", packageVersion: "1.0.0", visibility: "public" as const, evidencePolicy: "metadata" as const };

test("prepare reuses an exact immutable release independently of the line's current visibility", async () => {
  const h = await releaseHarness();
  try {
    assert.equal(await h.service.prepareRelease(input), h.state.release);
    h.state.line.visibility = "unlisted";
    h.state.line.evidencePolicy = "redacted";
    assert.equal(await h.service.prepareRelease(input), h.state.release);
    assert.equal(await h.service.prepareRelease({ projectId: "project-1", projectVersionId: "version-1", packageVersion: "1.0.0", registry: { visibility: "public", evidencePolicy: "metadata" } }), h.state.release);
  } finally { h.cleanup(); }
});

test("a previous public release cannot satisfy a private prepare request with the same version number", async () => {
  const h = await releaseHarness();
  try {
    for (const visibility of ["private", "unlisted"] as const) {
      await assert.rejects(h.service.prepareRelease({ ...input, visibility }), /^Error: RELEASE_VERSION_CONFLICT$/u);
    }
    for (const evidencePolicy of ["full", "redacted"] as const) {
      await assert.rejects(h.service.prepareRelease({ ...input, evidencePolicy }), /^Error: RELEASE_VERSION_CONFLICT$/u);
    }
    await assert.rejects(h.service.prepareRelease({ projectId: "project-1", projectVersionId: "version-1", packageVersion: "1.0.0" }), /^Error: RELEASE_VERSION_CONFLICT$/u, "default private is also an explicit effective policy");
  } finally { h.cleanup(); }
});

test("release reuse requires the same source version, snapshot and artifact identity", async () => {
  const h = await releaseHarness();
  try {
    await assert.rejects(h.service.prepareRelease({ ...input, projectVersionId: "version-2" }), /^Error: RELEASE_VERSION_CONFLICT$/u);
    await assert.rejects(h.service.prepareRelease({ ...input, projectId: "project-2" }), /^Error: RELEASE_VERSION_CONFLICT$/u);
    const original = structuredClone(h.state.manifest!);
    for (const [field, value] of [["sourceProjectVersionId", "version-2"], ["sourceRootHash", "other-root"], ["snapshotId", "other-snapshot"], ["rootHash", "other-artifact"], ["packageId", "other-package"], ["packageVersion", "2.0.0"]]) {
      h.state.manifest = { ...original, [field]: value };
      await assert.rejects(h.service.prepareRelease(input), /^Error: RELEASE_VERSION_CONFLICT$/u, field);
    }
    h.state.manifest = null;
    await assert.rejects(h.service.prepareRelease(input), /^Error: RELEASE_VERSION_CONFLICT$/u, "missing or incomplete artifact cannot prove identical disclosure policy");
  } finally { h.cleanup(); }
});

test("default preparation creates separate successful package lines for projects with identical role results", async () => {
  let source = (await readFile(resolve("lib/releases/service.ts"), "utf8")).replace(/^import[\s\S]*?;\n/gmu, "");
  const packageIdentity = (await readFile(resolve("lib/releases/package-identity.ts"), "utf8")).replace(/export /gu, "");
  source = `
    ${packageIdentity}
    const releases = [], lines = [], artifacts = new Map();
    let sequence = 0;
    const packageReleases = new Proxy({}, { get: (_, key) => key });
    const packageLines = {}, releaseEvents = {};
    const eq = (key, value) => row => row[key] === value, and = (...predicates) => row => predicates.every(predicate => predicate(row)), desc = value => value;
    const result = { brief: { roleTitle: "同名运维工程师" }, snapshot: { asOf: "2026-09-07" }, packages: { rolePackage: { packageId: "legacy-global-same-role" } } };
    const getProjectVersionRecord = async (projectId, id) => ({ id, snapshotId: "snapshot-" + projectId, rootHash: "root-" + projectId, result });
    const getD1 = () => ({ prepare: () => ({ bind: projectId => ({ first: async () => {
      const release = releases.filter(row => row.projectId === projectId).at(-1);
      const line = release && lines.find(row => row.id === release.packageLineId);
      return line ? { package_id: line.packageId } : null;
    } }) }) });
    const getDb = () => ({
      select: () => ({ from: () => ({ where: predicate => ({ limit: async count => releases.filter(predicate).slice(0, count) }) }) }),
      insert: () => ({ values: async value => { releases.push({ ...value }); } }),
      update: () => ({ set: changes => ({ where: async predicate => { for (const row of releases.filter(predicate)) Object.assign(row, changes); } }) }),
    });
    const ensureRegistryPackageLine = async ({ packageId }) => {
      let line = lines.find(row => row.packageId === packageId);
      if (!line) { line = { id: "line-" + ++sequence, packageId, recommendedReleaseId: null }; lines.push(line); }
      return line;
    };
    const domainId = prefix => prefix + "-" + ++sequence;
    const canonicalStringify = JSON.stringify, sha256Hex = async value => value;
    const compileStaticRolePackage = async input => ({ validation: { valid: true }, bundle: { manifest: { ...input, snapshotId: "snapshot-" + input.sourceProjectVersionId.replace("version-", ""), rootHash: "artifact-" + ++sequence } } });
    const putPackageArtifact = async bundle => { artifacts.set(bundle.manifest.rootHash, { bundle }); };
    const getPackageArtifact = async root => artifacts.get(root);
    export const inspected = { releases, lines, artifacts, result };
    ${source}
  `;
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const service = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  const first = await service.prepareRelease({ projectId: "project-a", projectVersionId: "version-project-a", packageVersion: "1.0.0" });
  const second = await service.prepareRelease({ projectId: "project-b", projectVersionId: "version-project-b", packageVersion: "1.0.0" });
  assert.equal(first.status, "ready");
  assert.equal(second.status, "ready");
  assert.notEqual(first.packageLineId, second.packageLineId);
  assert.deepEqual(service.inspected.lines.map((line: { packageId: string }) => line.packageId), ["role-package:project:project-a", "role-package:project:project-b"]);
  assert.equal(service.inspected.artifacts.get(first.artifactRootHash).bundle.manifest.visibility, "private");
  assert.equal(service.inspected.artifacts.get(second.artifactRootHash).bundle.manifest.visibility, "private");
  assert.equal(await service.prepareRelease({ projectId: "project-a", projectVersionId: "version-project-a", packageVersion: "1.0.0" }), first);
  assert.equal(service.inspected.result.packages.rolePackage.packageId, "legacy-global-same-role", "source result and snapshot identities are unchanged");
  service.inspected.lines.push({ id: "legacy-line", packageId: "historical-custom-id" });
  service.inspected.releases.push({ id: "legacy-release", projectId: "legacy-project", packageLineId: "legacy-line", packageVersion: "0.9.0" });
  const legacy = await service.prepareRelease({ projectId: "legacy-project", projectVersionId: "version-legacy-project", packageVersion: "1.0.0" });
  assert.equal(legacy.status, "ready");
  assert.equal(legacy.packageLineId, "legacy-line", "existing project retains its previous package lineage");
});
