import assert from "node:assert/strict";
import test from "node:test";
import { projectRunStatus } from "@/lib/jobs/run-status";
import { researchStages, type ResearchProgress } from "@/lib/jobs/research-progress";
import type { AutomaticMountRecord } from "@/lib/learning-path/automatic-contract";

const progress = (patch: Partial<ResearchProgress> = {}): ResearchProgress => ({ active: true, stage: 2, message: "正在梳理任务与能力", status: "running", ...patch });
const mount = (status: AutomaticMountRecord["status"], patch: Partial<AutomaticMountRecord> = {}): AutomaticMountRecord => ({
  id: "mount:one", projectVersionId: "version:one", snapshotId: "snapshot:one", status, attempt: 1, ...patch,
});

test("active research drives one active stage and one headline", () => {
  const status = projectRunStatus({ progress: progress() })!;
  assert.equal(status.stages.length, researchStages.length);
  assert.deepEqual(status.stages.map(stage => stage.state), ["done", "done", "active", "pending", "pending", "pending"]);
  assert.equal(status.headline, "正在梳理任务与能力");
  assert.equal(status.tone, "active");
});

test("finished research folds the course mount into the final stage instead of a second status line", () => {
  const status = projectRunStatus({ progress: progress({ active: false, stage: 4, status: "completed", message: "研究结果已保存" }), mount: mount("running") })!;
  assert.equal(status.stages[4].state, "done");
  assert.equal(status.stages[5].state, "active");
  assert.equal(status.headline, "正在匹配已有课程，并合并未覆盖的要求");
  assert.equal(status.tone, "active");
});

test("completed mount closes the whole pipeline with a single done headline", () => {
  const status = projectRunStatus({ progress: progress({ active: false, stage: 4, status: "completed", message: "研究结果已保存" }), mount: mount("completed") })!;
  assert.ok(status.stages.every(stage => stage.state === "done"));
  assert.equal(status.headline, "研究与课程挂载已完成");
  assert.equal(status.tone, "done");
});

test("a failed run keeps its own attention headline; a healthy mount must not paint over it", () => {
  const status = projectRunStatus({ progress: progress({ active: false, stage: 4, status: "failed", message: "已有成果已保留，请查看任务记录" }), mount: mount("completed") })!;
  assert.equal(status.tone, "attention");
  assert.equal(status.stages[4].state, "blocked");
  assert.equal(status.headline, "已有成果已保留，请查看任务记录");
});

test("a failed mount blocks the final stage with its error, not a generic running message", () => {
  const status = projectRunStatus({ progress: progress({ active: false, stage: 4, status: "completed", message: "研究结果已保存" }), mount: mount("failed", { error: "自动挂载服务暂时不可用，已有岗位版本已保留。" }) })!;
  assert.equal(status.stages[5].state, "blocked");
  assert.equal(status.tone, "attention");
  assert.match(status.headline, /自动挂载服务暂时不可用/);
});

test("without progress there is nothing to project", () => {
  assert.equal(projectRunStatus({}), null);
});
