import assert from "node:assert/strict";
import test from "node:test";
import { iterationOutcome, iterationOutcomePresentation, loadIterationOutcome } from "@/lib/jobs/iteration-outcome";

function result(createdSnapshot = false) {
  const gap = { code: "TASK_SKILL_GAP", title: "部署环境缺少知识技能支撑", targetIds: ["task-env"], severity: "warning" };
  return {
    runId: "run-a", projectId: "project-a", status: createdSnapshot ? "completed" : "no_change", createdSnapshot,
    inspectionBefore: { coverage: { tasks: 6, knowledgeSkills: 1, tasksWithoutSkills: 4, tasksWithoutProcess: 1 }, findings: [
      { ...gap, layer: "protocol" }, { ...gap, layer: "coverage" },
      { code: "NO_OBSERVED_EPISODE", title: "需要真实工作资料", severity: "info", targetIds: [] },
    ] },
    inspectionAfter: { coverage: { tasks: 6, knowledgeSkills: 12, tasksWithoutSkills: 0, tasksWithoutProcess: 0 }, findings: [] },
    evaluation: { reasons: ["没有可证明的风险降低或信息增量"], apiKey: "secret-evaluation" },
    summary: ["当前版本未更新"], workItems: [], researchReports: [],
    candidate: { secret: "must-not-return-candidate" }, sources: ["private-attachment-body"],
  };
}

test("旧风险修复空跑保留真实 no_change，显示已保存基线的缺口，而非拒绝候选的覆盖率", () => {
  const outcome = iterationOutcome(result())!;
  assert.equal(outcome.status, "no_change");
  assert.equal(outcome.coverage?.knowledgeSkills, 1);
  assert.equal(outcome.coverage?.tasksWithoutSkills, 4);
  assert.deepEqual(outcome.work, { total: 0, completed: 0, unresolved: 0 });
  assert.deepEqual(outcome.research, { queries: 0, selectedSources: 0, failures: 0 });
  assert.equal(outcome.remainingGapCount, 1, "同一问题不因来自两层检查而重复计数");
  assert.equal(iterationOutcomePresentation(outcome)?.label, "未生成新版本");
  assert.deepEqual(outcome.reasons, ["没有可证明的风险降低或信息增量"]);
  assert.ok(!JSON.stringify(outcome).includes("must-not-return"));
  assert.ok(!JSON.stringify(outcome).includes("private-attachment"));
  assert.ok(!JSON.stringify(outcome).includes("secret-evaluation"));
});

test("生成新版本后仍有未完成工作或覆盖缺口时展示部分完成，检索次数来自实际报告", () => {
  const value = { ...result(true), workItems: [{ status: "completed" }, { status: "known_gap" }, { status: "skipped" }],
    researchPlans: [{ queries: Array.from({ length: 12 }, () => ({})) }],
    researchReports: [{ queries: [{ query: "private-query" }, {}], selectedSourceCount: 3, failures: [{}] }] };
  const partial = iterationOutcome(value)!;
  assert.equal(partial.coverage?.knowledgeSkills, 12);
  assert.deepEqual(partial.work, { total: 3, completed: 1, unresolved: 2 });
  assert.deepEqual(partial.research, { queries: 2, selectedSources: 3, failures: 1 });
  assert.equal(iterationOutcomePresentation(partial)?.label, "已更新 · 仍有缺口");
  assert.equal(iterationOutcomePresentation(iterationOutcome(result(true)))?.label, "已生成新版本");
  assert.equal(iterationOutcomePresentation(iterationOutcome({ ...result(), status: "waiting_user" }))?.label, "需要补充资料");
  assert.equal(iterationOutcomePresentation(), undefined);
});

test("旧运行候选未被保存时，不把提前 completed 的检索工作误报为已修复", () => {
  const outcome = iterationOutcome({ ...result(), workItems: [{ status: "completed" }, { status: "known_gap" }] })!;
  assert.deepEqual(outcome.work, { total: 2, completed: 0, unresolved: 2 });
  assert.equal(iterationOutcomePresentation(outcome)?.label, "未生成新版本");
});

test("无节点目标的不同来源问题及不同 Lane 降级均保留，重复投影仍去重", () => {
  const findings = [
    { code: "FUTURE_SOURCE", title: "来源晚于快照：来源 A", targetIds: [], severity: "error" },
    { code: "FUTURE_SOURCE", title: "来源晚于快照：来源 B", targetIds: [], severity: "error" },
    { code: "LANE_FALLBACK", title: "模型降级", detail: "knowledge lane", targetIds: ["task-a"], severity: "warning" },
    { code: "LANE_FALLBACK", title: "模型降级", detail: "process lane", targetIds: ["task-a"], severity: "warning" },
  ];
  const outcome = iterationOutcome({ ...result(), inspectionBefore: { findings: [...findings, { ...findings[0], layer: "temporal" }] } })!;
  assert.equal(outcome.remainingGapCount, 4);
});

test("摘要有界、非法计数归零，不把原始来源或模型响应放入任务列表", () => {
  const value = result(true);
  const outcome = iterationOutcome({ ...value, summary: Array.from({ length: 20 }, (_, i) => `${i}${"x".repeat(2000)}`),
    inspectionAfter: { coverage: { tasks: -1, knowledgeSkills: Infinity }, findings: Array.from({ length: 100 }, (_, i) => ({ code: "GAP", title: `gap${i}`, severity: "warning", targetIds: [`task${i}`] })) } })!;
  assert.equal(outcome.summary.length, 6);
  assert.ok(outcome.summary.every(line => line.length <= 600));
  assert.equal(outcome.remainingGapCount, 100);
  assert.equal(outcome.remainingGaps.length, 8);
  assert.equal(outcome.coverage?.tasks, 0);
  assert.equal(outcome.coverage?.knowledgeSkills, 0);
  assert.equal(iterationOutcome({ status: "running" }), undefined);
});

test("历史补齐严格绑定运行与项目，仅查询已完成的迭代，不借用其他会话结果", async () => {
  const job = { id: "run-a", projectId: "project-a", kind: "snapshot_iteration", status: "completed" };
  let calls = 0;
  const lookup = async (id: string, projectId: string) => {
    calls++;
    assert.equal(id, job.id); assert.equal(projectId, job.projectId);
    return { id, project_id: projectId, result_json: JSON.stringify(result()) };
  };
  assert.equal((await loadIterationOutcome(job, lookup))?.status, "no_change");
  for (const change of [{ kind: "cold_start" }, { status: "running" }, { projectId: undefined }]) assert.equal(await loadIterationOutcome({ ...job, ...change }, lookup), undefined);
  assert.equal(calls, 1);
  for (const row of [
    { id: "run-b", project_id: job.projectId, result_json: JSON.stringify(result()) },
    { id: job.id, project_id: "project-b", result_json: JSON.stringify(result()) },
    { id: job.id, project_id: job.projectId, result_json: JSON.stringify({ ...result(), runId: "run-b" }) },
    { id: job.id, project_id: job.projectId, result_json: JSON.stringify({ ...result(), projectId: "project-b" }) },
    { id: job.id, project_id: job.projectId, result_json: "not-json" },
  ]) assert.equal(await loadIterationOutcome(job, async () => row), undefined);
});
