import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";
import type { runAutomaticSnapshotIteration } from "@/lib/iteration/automatic-runner";
import type { IterationEvent, SnapshotIterationResult } from "@/lib/iteration/types";

// Execute the production runner with an in-memory persistence boundary. This
// avoids importing the Cloudflare D1 runtime or touching any tester snapshots.
function fixture(options: { constructError?: Error; persistenceError?: Error; events?: IterationEvent[] } = {}) {
  let status = "absent";
  const trace: string[] = [];
  const failures: Array<{ runId: string; message: string; cancelled: boolean }> = [];
  const dependencies: Record<string, unknown> = {
    "@/lib/jobs/repository": { assertRoleJobLease: async () => { trace.push("lease"); } },
    "@/lib/projects/repository": { saveProjectCandidateFromIteration: async () => { throw new Error("unexpected project write"); } },
    "./graph": { createSnapshotIterationSkill: () => {
      trace.push("construct");
      if (options.constructError) throw options.constructError;
      return { async *stream() { yield* options.events || []; } };
    } },
    "./repository": {
      startSnapshotIteration: async () => { status = "running"; trace.push("start"); },
      failSnapshotIteration: async (runId: string, message: string, cancelled: boolean) => {
        trace.push("fail"); failures.push({ runId, message, cancelled });
        if (options.persistenceError) throw options.persistenceError;
        if (status === "running") status = cancelled ? "cancelled" : "failed";
      },
      completeSnapshotIteration: async (result: SnapshotIterationResult) => { status = result.status; trace.push("complete"); return null; },
      appendIterationEvent: async (event: IterationEvent) => { trace.push(`event:${event.kind}`); },
      saveIterationCheckpoint: async () => undefined,
      attachIterationProjectVersion: async () => { throw new Error("unexpected version attachment"); },
    },
  };
  const source = readFileSync(new URL("../lib/iteration/automatic-runner.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as { runAutomaticSnapshotIteration: typeof runAutomaticSnapshotIteration } };
  new Function("require", "module", "exports", compiled)((id: string) => {
    assert.ok(id in dependencies, `Unexpected production dependency: ${id}`);
    return dependencies[id];
  }, module, module.exports);
  const input: Parameters<typeof runAutomaticSnapshotIteration>[0] = {
    request: { runId: "synthetic:enrichment:deep", snapshotRef: { snapshotId: "snapshot:fixture" }, initiativeProfile: "autonomous", prompt: "", targetIds: [], supplementalSources: [], webResearch: false, maxRounds: 1, sourceLimit: 4, maxWorkItems: 4 },
    base: bundledRoleSnapshot(),
    model: async function* () { throw new Error("unexpected model request"); },
  };
  return { execute: () => module.exports.runAutomaticSnapshotIteration(input), trace, failures, status: () => status };
}

test("自动子迭代没有完成事件便结束时，将已开始的运行终结为失败", async () => {
  const run = fixture();
  await assert.rejects(run.execute, /没有形成可核验结果/);
  assert.equal(run.status(), "failed");
  assert.deepEqual(run.trace, ["start", "construct", "fail"]);
  assert.equal(run.failures[0].runId, "synthetic:enrichment:deep");
  assert.match(run.failures[0].message, /没有形成可核验结果/);
});

test("自动子迭代构造失败发生在持久化开始之后，也必须保存终止状态", async () => {
  const original = new Error("synthetic graph construction failed");
  const run = fixture({ constructError: original });
  await assert.rejects(run.execute, error => error === original);
  assert.equal(run.status(), "failed");
  assert.deepEqual(run.trace, ["start", "construct", "fail"]);
  assert.equal(run.failures[0].message, original.message);
});

test("保存失败状态再次出错时保留两次异常，不伪装已完成收尾", async () => {
  const original = new Error("synthetic graph construction failed");
  const persistenceError = new Error("synthetic D1 unavailable");
  const run = fixture({ constructError: original, persistenceError });
  await assert.rejects(run.execute, error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [original, persistenceError]);
    assert.equal(error.cause, original);
    assert.match(error.message, /未能保存失败状态/);
    assert.match(error.message, /synthetic D1 unavailable/);
    return true;
  });
  assert.equal(run.status(), "running", "测试必须反映失败状态尚未持久化，不能只靠内存声称终结");
});

test("有效 no_change 结果仍正常终结，不被无完成事件检查误判", async () => {
  const result = { status: "no_change", createdSnapshot: false } as SnapshotIterationResult;
  const event: IterationEvent = { version: "1.0", runId: "synthetic:enrichment:deep", snapshotId: "snapshot:fixture", seq: 1, time: "2026-09-08T00:00:00Z", kind: "iteration.run.completed", phase: "system", payload: { result } };
  const run = fixture({ events: [event] });
  assert.equal(await run.execute(), result);
  assert.equal(run.status(), "no_change");
  assert.deepEqual(run.trace, ["start", "construct", "complete", "event:iteration.run.completed"]);
  assert.equal(run.failures.length, 0);
});
