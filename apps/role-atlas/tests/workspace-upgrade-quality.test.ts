import assert from "node:assert/strict";
import test from "node:test";
import { emptyWorkspaceUpgradeOutcome, usableWorkspaceObservations, workspaceIterationRequest, workspaceUpgradeIterationSchema } from "@/lib/skills/workspace-upgrade";
import { iterationOutcomePresentation } from "@/lib/jobs/iteration-outcome";
import { ingestWorkspacePackage } from "@/lib/workspaces/ingest";
import { normalizeWorkspaceConnection } from "@/lib/workspaces/adapters";
import { workspaceIngestionRequestSchema, workspacePackageSchema } from "@/lib/workspaces/types";
import { createIterationContract, discoverIterationOpportunities, planIterationResearch, planIterationWork } from "@/lib/iteration/planner";
import { inspectSnapshot } from "@/lib/iteration/inspector";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";

function workspace(content?: string) {
  const input = workspaceIngestionRequestSchema.parse({ runId: "workspace-quality", projectId: "project:quality", connection: { adapterId: "generic_package", payload: {}, provenance: { capturedAt: "2026-09-08T00:00:00Z" } } });
  const pkg = workspacePackageSchema.parse({ protocolVersion: "1.0", id: "workspace:quality", title: "组织内部工作区", adapterId: "generic_package", evidenceClass: "production_trace", visibility: "project_private", provenance: { capturedAt: "2026-09-08T00:00:00Z" },
    resources: content === undefined ? [] : [{ id: "artifact:one", kind: "document", title: "交付记录", content }] });
  return ingestWorkspacePackage(input, pkg);
}

for (const content of [undefined, "", "[REDACTED_SECRET]"]) test(`工作区空内容 ${String(content)} 不凭生成的元数据冒充可用观察`, () => {
  const result = workspace(content);
  assert.equal(usableWorkspaceObservations(result).length, 0);
  const outcome = emptyWorkspaceUpgradeOutcome(result);
  assert.equal(outcome.createdSnapshot, false);
  assert.equal(iterationOutcomePresentation(outcome)?.label, "需要补充资料");
  assert.equal(outcome.work.completed, 0);
  assert.equal(outcome.research.queries, 0);
  assert.throws(() => workspaceIterationRequest({ runId: "iterate-empty", snapshotRef: { snapshotId: "snapshot:base" }, projectId: "project:quality", conversationId: "conversation:quality", result, iteration: workspaceUpgradeIterationSchema.parse({}) }), /WORKSPACE_NO_USABLE_OBSERVATIONS/);
});

test("带正文的工作区保留只读学习路径和联网核验，用户目标不会覆盖组织实例边界", () => {
  const result = workspace("检查服务启动日志，修复环境变量后重启服务，并保存验收日志。客户编号 ABC-PRIVATE-031。");
  const base = bundledRoleSnapshot();
  const learningPathGraph = { protocolVersion: "learnflow-learning-path/v1" as const, nodes: [], edges: [] };
  const request = workspaceIterationRequest({ runId: "iterate-workspace", snapshotRef: { snapshotId: base.snapshot.id }, projectId: "project:quality", conversationId: "conversation:quality", result,
    iteration: workspaceUpgradeIterationSchema.parse({ learningPathGraph, webResearch: true, prompt: "优先核验服务恢复步骤" }) });
  assert.deepEqual(request.learningPathGraph, learningPathGraph);
  assert.equal(request.supplementalSources.length, 1);
  assert.equal(request.webResearch, true);
  assert.match(request.prompt, /优先核验服务恢复步骤/);
  assert.match(request.prompt, /只有得到岗位级证据时/);
  const contract = createIterationContract(request, base);
  const opportunities = discoverIterationOpportunities({ request, contract, inspection: { ...inspectSnapshot(base), findings: [] } });
  const workItems = planIterationWork({ runId: request.runId, contract, opportunities });
  const sourceWork = workItems.find(item => item.origin === "workspace")!;
  assert.equal(sourceWork.requiresResearch, true);
  for (const round of [1, 2]) {
    const plan = planIterationResearch({ runId: request.runId, round, result: base, request, contract, workItems: [sourceWork] });
    assert.ok(plan.queries.length > 0);
    assert.ok(plan.queries.every(query => query.category && !query.query.includes("ABC-PRIVATE-031")));
  }
});

test("观察必须回溯本工作区原件，悬空和跨包引用不能进入升级", () => {
  const result = workspace("记录系统部署故障及修复验证结果。");
  assert.equal(usableWorkspaceObservations(result).length, 1);
  const missing = structuredClone(result);
  missing.observations[0].resourceIds = ["artifact:missing"];
  assert.equal(usableWorkspaceObservations(missing).length, 0);
  const other = structuredClone(result);
  other.observations[0].source.workspaceEvidence!.workspacePackageId = "workspace:other";
  assert.equal(usableWorkspaceObservations(other).length, 0);
});

test("事件日志真实经过可用于升级，只有事件标题仍要求补正文", () => {
  for (const detail of ["", "从监控告警定位连接池耗尽，调整配置后验证错误率恢复。"]) {
    const request = workspaceIngestionRequestSchema.parse({ runId: "workspace-event", projectId: "project:event", connection: { adapterId: "event_log", payload: { datasetId: "event-fixture", title: "故障处理", events: [{ id: "event1", caseId: "case1", activity: "排查故障", detail }] }, provenance: { capturedAt: "2026-09-08T00:00:00Z" } } });
    const result = ingestWorkspacePackage(request, normalizeWorkspaceConnection(request.connection));
    assert.equal(usableWorkspaceObservations(result).length, detail ? 1 : 0);
  }
});
