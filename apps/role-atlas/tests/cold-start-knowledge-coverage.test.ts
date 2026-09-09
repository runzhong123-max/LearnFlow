import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInvoker } from "@/lib/agent/model";
import { createColdStartSkill } from "@/lib/build/graph";
import { semanticDraftFromKernel } from "@/lib/build/kernel";
import { compileSemanticDraft } from "@/lib/build/compiler";
import type { BuildEvent } from "@/lib/build/events";
import type { ColdStartBuildResult, ColdStartRequest } from "@/lib/build/types";

// Synthetic evidence fixtures; no user uploads or production project data.
const cases = [
  { role: "系统运维工程师", tasks: [
    { label: "排查 Linux 服务故障", quote: "根据 Linux 服务退出码和日志时间定位失败进程，并记录故障原因。", knowledge: "Linux 进程退出码与日志时间含义", skill: "对照退出码与日志定位失败进程" },
    { label: "恢复数据库备份", quote: "恢复数据库备份后按主键比对记录数量与字段一致性，并提交校验结果。", knowledge: "主键唯一性与恢复数据一致性规则", skill: "比对备份恢复后的记录与字段" },
    { label: "维护巡检脚本", quote: "巡检脚本通过条件分支处理异常退出码，并输出巡检日志。", knowledge: "条件分支与异常退出码的判断规则", skill: "编写异常退出码检查分支" },
  ] },
  { role: "软件实施工程师", tasks: [
    { label: "部署客户系统", quote: "配置 JDK 环境变量 JAVA_HOME 后启动 Tomcat，并根据启动日志验证配置。", knowledge: "JAVA_HOME 环境变量的解析作用", skill: "配置 JAVA_HOME 并检查启动日志" },
    { label: "校验导入数据", quote: "使用 SQL 多表关联查询，按主键检查导入前后记录的一致性。", knowledge: "主键与多表关联查询规则", skill: "编写多表 SQL 查询校验数据" },
    { label: "交付用户操作手册", quote: "操作手册按用户角色组织步骤，逐项写明前置条件与预期结果。", knowledge: "角色化操作步骤的前置与结果规范", skill: "按用户角色编写带预期结果的操作步骤" },
  ] },
];

for (const fixture of cases) test(`${fixture.role}：知识和技能分别补齐，折叠任务也保留完整支撑与引用`, async () => {
  const calls: Array<{ taskIds: string[]; repair: boolean }> = [];
  const model: ModelInvoker = async function* ({ system, user, maxCompletionTokens }) {
    const payload = JSON.parse(user);
    let response: unknown = {};
    if (system.includes("岗位证据原子抽取器")) {
      response = { mentions: fixture.tasks.flatMap((task, i) => {
        const segment = payload.segments.find((s: { text: string }) => s.text.includes(task.quote));
        return segment ? [{ tempId: `task-${i}`, kind: "task", label: task.label, definitionHint: task.quote,
          attributes: { actorRelation: "target_role", actor: fixture.role, workObject: task.label, action: task.label, deliverable: "可复核的操作记录", acceptance: "结果与原文条件一致" },
          sourceSegmentId: segment.id, evidenceSpan: { segmentId: segment.id, quote: task.quote }, confidence: 0.8 }] : [];
      }), propositions: [] };
    } else if (system.includes("典型工作任务规范化器") || system.includes("典型工作任务全局归并器")) {
      response = { roleSummary: fixture.role, roleContexts: [], tasks: fixture.tasks.map((task, i) => ({
        tempId: `t-${i}`, label: task.label, summary: task.quote, workObject: task.label, action: task.label,
        deliverable: "操作记录", acceptance: "满足原文所述条件", aliases: [],
        mentionIds: (payload.mentions || []).filter((m: { label: string }) => m.label === task.label).map((m: { id: string }) => m.id), confidence: 0.8,
      })) };
    } else if (system.includes("任务导向的知识技能规范化器")) {
      assert.ok(payload.tasks.length <= 2, "知识 Lane 不再让四个任务争抢输出预算");
      assert.ok((maxCompletionTokens || 0) >= 3_600);
      calls.push({ taskIds: payload.tasks.map((task: { id: string }) => task.id), repair: Boolean(payload.repair) });
      if (payload.repair) {
        assert.ok(payload.repair.coverage.every((row: { missingKinds: string[] }) => row.missingKinds.join() === "skill"));
        assert.ok(payload.repair.acceptedPoints.every((point: { learningKind: string }) => point.learningKind === "knowledge"));
      }
      response = { skills: payload.tasks.map((task: { id: string; label: string }, i: number) => {
        const spec = fixture.tasks.find(item => item.label === task.label)!;
        const segment = payload.evidenceSegments.find((s: { text: string }) => s.text.includes(spec.quote));
        assert.ok(segment, `缺少任务原文：${task.label}`);
        return { tempId: `p-${i}`, label: payload.repair ? spec.skill : spec.knowledge, summary: spec.quote,
          learningKind: payload.repair ? "skill" : "knowledge",
          learningDefinition: { scopeNote: `限于${task.label}的输入与条件，不扩展其他产品或平台。`, assessmentCriteria: [`给定案例时${payload.repair ? "完成操作并提交可复核记录" : "说明适用条件与判断依据"}`] },
          taskTempIds: [task.id], evidenceSpans: [{ segmentId: segment.id, quote: spec.quote }], confidence: 0.7 };
      }) };
    }
    yield { type: "text", delta: JSON.stringify(response) };
  };
  const request: ColdStartRequest = { runId: `coverage-${fixture.role}`, projectId: `coverage-${fixture.role}`, roleTitle: fixture.role,
    roleDescription: "岗位知识技能覆盖验收", market: "中国大陆", audience: [], snapshotAsOf: "2026-09-08",
    sources: [{ title: "岗位工作流程", kind: "private_document", content: `工作流程与交付物：\n${fixture.tasks.map(task => `${task.label}：${task.quote}`).join("\n\n")}` }],
  };
  const initial = await createColdStartSkill(model, { execution: "kernel" }).invoke({ request, laneFailures: [] });
  const kernel = structuredClone(initial.result!);
  const tasks = kernel.semantic.nodes.filter(node => node.type === "task");
  assert.equal(tasks.length, fixture.tasks.length);
  tasks[1].defaultVisibility = false;
  tasks[1].parentKernelId = tasks[0].id;
  const events: BuildEvent[] = [];
  const stream = await createColdStartSkill(model, { execution: "enrichment" }).stream(
    { request: { ...request, runId: `${request.runId}-enrich` }, baseResult: kernel, laneFailures: [] }, { streamMode: "custom" });
  for await (const event of stream) events.push(event as BuildEvent);
  const result = events.find(event => event.kind === "build.run.completed")!.payload.result as ColdStartBuildResult;
  const points = result.semantic.nodes.filter(node => node.type === "knowledge_skill");
  assert.equal(points.length, fixture.tasks.length * 2);
  for (const task of tasks) {
    const linked = result.semantic.edges.filter(edge => edge.source === task.id).map(edge => points.find(point => point.id === edge.target)).filter(Boolean);
    assert.deepEqual(new Set(linked.map(point => point!.learningKind)), new Set(["knowledge", "skill"]), task.label);
  }
  for (const point of points) {
    assert.ok(point.evidenceBindingIds.length);
    assert.ok(point.learningDefinition?.assessmentCriteria.length);
    const bindings = result.sources.evidenceBindings.filter(binding => point.evidenceBindingIds.includes(binding.id));
    assert.ok(bindings.some(binding => binding.evidenceSpan));
    for (const binding of bindings) if (binding.evidenceSpan) {
      assert.ok(result.sources.segments.some(s => s.id === binding.evidenceSpan!.segmentId && s.text.includes(binding.evidenceSpan!.quote)));
    }
  }
  assert.equal(calls.filter(call => !call.repair).length, 2);
  assert.equal(calls.filter(call => call.repair).length, 2, "缺少技能也触发一次补齐，无需等到零点或非法输出");
  const quality = events.filter(event => event.kind === "build.lane.completed" && String(event.payload.lane).endsWith(":quality"));
  assert.equal(quality.length, 2);
  assert.ok(quality.every(event => Array.isArray(event.payload.incompleteTaskIds) && event.payload.incompleteTaskIds.length === 0));
  assert.equal(result.audit.issues.some(issue => issue.detail.includes("知识技能覆盖缺口")), false);
  const restored = compileSemanticDraft({ request, draft: semanticDraftFromKernel(result), assets: result.sources.assets, segments: result.sources.segments });
  for (const point of points) {
    const restoredPoint = restored.nodes.find(node => node.id === point.id);
    assert.ok(restoredPoint, "恢复已有语义版本不能改变原子点 ID");
    assert.equal(restoredPoint.learningKind, point.learningKind);
    assert.deepEqual(restoredPoint.learningDefinition, point.learningDefinition);
    const oldQuotes = result.sources.evidenceBindings.filter(binding => point.evidenceBindingIds.includes(binding.id)).flatMap(binding => binding.evidenceSpan ? [binding.evidenceSpan.quote] : []);
    const newQuotes = restored.bindings.filter(binding => restoredPoint.evidenceBindingIds.includes(binding.id)).flatMap(binding => binding.evidenceSpan ? [binding.evidenceSpan.quote] : []);
    for (const quote of oldQuotes) assert.ok(newQuotes.includes(quote), "恢复后仍能核对原文");
  }
});
