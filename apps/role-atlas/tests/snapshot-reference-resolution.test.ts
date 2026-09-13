import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";

test("精确项目引用不能落入其他命名空间；同快照发布新版不被内置旧版本遮蔽", async () => {
 const result = bundledRoleSnapshot();
 const key = "__snapshotReferenceTest";
 const state = { result, workspace: null as any, releaseReads: 0 };
 (globalThis as any)[key] = state;
 try {
  let source = await readFile("lib/snapshots/resolver.ts", "utf8");
  source = source.replace('import { getProjectWorkspace } from "@/lib/projects/repository";', `const getProjectWorkspace=async()=>globalThis.${key}.workspace;`)
   .replace('import { rolePackageRuntime } from "@/lib/role-package/runtime";', `const rolePackageRuntime={package:{manifest:{snapshot_id:globalThis.${key}.result.snapshot.id}}};`)
   .replace('import { bundledRoleSnapshot } from "./bundled-role-adapter";', `const bundledRoleSnapshot=()=>globalThis.${key}.result;`)
   .replace('import { getStoredSnapshot } from "./repository";', 'const getStoredSnapshot=async()=>null;')
   .replace('import { findReleaseBySnapshot } from "@/lib/releases/resolver";', `const findReleaseBySnapshot=async()=>{globalThis.${key}.releaseReads++;return {result:globalThis.${key}.result,release:{id:'published',packageVersion:'9.0.0',status:'published'}};};`);
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { resolveSnapshot } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  assert.equal(await resolveSnapshot({ projectId: "missing-project", snapshotId: result.snapshot.id }), null);
  assert.equal(await resolveSnapshot({ versionId: "orphan-version", snapshotId: result.snapshot.id }), null);
  assert.equal(state.releaseReads, 0);
  const published = await resolveSnapshot({ snapshotId: result.snapshot.id, packageVersion: "9.0.0" });
  assert.equal(published.source, "registry");
  assert.equal(published.reference.packageVersion, "9.0.0");
  assert.equal(state.releaseReads, 1);
  assert.equal((await resolveSnapshot({ snapshotId: result.snapshot.id })).source, "bundled");
 } finally { delete (globalThis as any)[key]; }
});
