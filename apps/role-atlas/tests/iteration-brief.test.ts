import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { conversationIterationRequest, defaultIterationDraft, iterationBriefError, iterationRunBrief } from "@/lib/iteration/brief";
import { createIterationContract, discoverIterationOpportunities, planIterationWork } from "@/lib/iteration/planner";
import { inspectSnapshot } from "@/lib/iteration/inspector";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";
import { learningPathGraphInputSchema } from "@/lib/build/types";

test("对话表单的九种选择进入实际契约和工作计划，保留空目标与学习路径", () => {
  const base = bundledRoleSnapshot();
  const target = base.semantic.nodes.find((node) => node.type === "task")!;
  const context = { roleTitle: base.brief.roleTitle, projectId: "project-brief", conversationId: "conversation-brief", snapshotId: base.snapshot.id, versionId: "version-brief" };
  const learningPathGraph = learningPathGraphInputSchema.parse(JSON.parse(readFileSync("public/data/learnflow-learning-path.json", "utf8")));
  for (const [mode, intent] of [["deep_research", "expand"], ["risk_repair", "repair"], ["freshness", "refresh"]] as const) {
    for (const initiativeProfile of ["autonomous", "co_guided", "user_directed"] as const) {
      const request = conversationIterationRequest({ runId: `brief-${mode}-${initiativeProfile}`, context,
        draft: { mode, initiativeProfile, targetIds: `${target.id}，${target.id}\n`, targetAsOf: "2026-09-07" },
        prompt: "  ", materials: [{ title: "私有资料", content: "不能暴露在任务摘要中的正文", kind: "private_document" }], webResearch: true, learningPathGraph });
      const contract = createIterationContract(request, base);
      const work = planIterationWork({ runId: request.runId, contract, opportunities: discoverIterationOpportunities({ request, contract, inspection: inspectSnapshot(base) }) });
      assert.equal(contract.mode, mode);
      assert.equal(contract.initiativeProfile, initiativeProfile);
      assert.equal(contract.changeIntents[0], intent);
      assert.equal(contract.targetAsOf, "2026-09-07");
      assert.deepEqual(contract.targetIds, [target.id]);
      assert.ok(work.some((item) => item.origin === "user" && item.kind === intent));
      assert.equal(request.prompt, "");
      assert.equal(request.snapshotRef.versionId, context.versionId);
      assert.equal(request.conversationId, context.conversationId);
      assert.deepEqual(request.learningPathGraph, learningPathGraph);
      const brief = iterationRunBrief({ ...request, apiKey: "must-not-leak" });
      assert.equal(brief?.sourceCount, 1);
      assert.equal(brief?.learningPathProvided, true);
      assert.ok(!JSON.stringify(brief).includes("不能暴露"));
      assert.ok(!JSON.stringify(brief).includes("must-not-leak"));
    }
  }
});

test("普通迭代不悄悄限定节点或添加日期，深化预填选中节点，定向和日期输入有校验", () => {
  const base = bundledRoleSnapshot();
  const context = { roleTitle: base.brief.roleTitle, projectId: "project-brief", conversationId: "conversation-brief", snapshotId: base.snapshot.id, versionId: "version-brief", selectedNodeIds: [base.semantic.nodes[0].id] };
  const draft = defaultIterationDraft(false, context.selectedNodeIds);
  const request = conversationIterationRequest({ runId: "brief-default", context, draft, prompt: "", materials: [], webResearch: false });
  assert.deepEqual(request.targetIds, []);
  assert.equal(request.targetAsOf, undefined);
  assert.equal(request.webResearch, false);
  assert.equal(request.initiativeProfile, "co_guided");
  assert.equal(defaultIterationDraft(true, context.selectedNodeIds).targetIds, context.selectedNodeIds[0]);
  assert.match(iterationBriefError({ initiativeProfile: "user_directed", targetIds: [], prompt: " " }), /目标或选择/u);
  for (const date of ["2026-02-30", "2026-13-01", "yesterday"]) assert.match(iterationBriefError({ initiativeProfile: "autonomous", targetIds: [], prompt: "", targetAsOf: date }), /有效日期/u);
  assert.throws(() => conversationIterationRequest({ runId: "brief-missing", context: { roleTitle: base.brief.roleTitle }, draft, prompt: "", materials: [], webResearch: false }), /岗位版本/u);
});
