import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ProjectJobOutcome, { projectJobResultPresentation } from "@/app/components/ProjectJobOutcome";
import { iterationOutcome, iterationOutcomePresentation, normalizeIterationOutcome, projectJobResult } from "@/lib/jobs/iteration-outcome";

test("旧冷启动字符串 outcome 不再使项目页面崩溃，草稿展示真实缺口", () => {
  for (const result of [
    { outcome: "budget_exhausted", draft: true, blockers: ["核心任务缺少交付物"] },
    { stopReason: "budget_exhausted", draft: true, blockers: ["核心任务缺少交付物"] },
  ]) {
    const html = renderToStaticMarkup(createElement(ProjectJobOutcome, { result }));
    assert.match(html, /待完善内容/); assert.match(html, /预算已用完/); assert.match(html, /核心任务缺少交付物/);
    assert.doesNotMatch(html, /个工作项完成|已生成新版本/);
    assert.equal(projectJobResultPresentation(result)?.label, "草稿已保存 · 待完善");
  }
});
test("损坏、部分及未来格式的结果均安全降级，不虚构零计数", () => {
  for (const outcome of ["insufficient_material", [], {}, { status: "completed", createdSnapshot: true }, { work: null }, 5]) {
    assert.equal(normalizeIterationOutcome(outcome), undefined);
    assert.equal(iterationOutcomePresentation(outcome), undefined);
    assert.equal(renderToStaticMarkup(createElement(ProjectJobOutcome, { result: { outcome } })), "");
    assert.equal(projectJobResultPresentation({ outcome })?.label, "结果摘要不完整");
  }
  assert.doesNotThrow(() => renderToStaticMarkup(createElement(ProjectJobOutcome, { result: { draft: true, blockers: [null, {}, "缺少证据"] } })));
});
test("有效旧迭代结果继续显示计数、来源和未解决项，读取不修改原记录", () => {
  const outcome = iterationOutcome({ status: "completed", createdSnapshot: true, workItems: [{ status: "completed" }, { status: "known_gap" }], researchReports: [{ queries: [{}], selectedSourceCount: 2, failures: [] }], summary: ["已补齐任务输入"], inspectionAfter: { findings: [{ code: "TASK_GAP", title: "仍缺交接条件", severity: "warning" }] } })!;
  const before = JSON.stringify(outcome);
  const html = renderToStaticMarkup(createElement(ProjectJobOutcome, { result: { outcome } }));
  assert.match(html, /1\/2 个工作项完成/); assert.match(html, /仍缺交接条件/); assert.match(html, /选用 2 份来源/);
  assert.equal(projectJobResultPresentation({ outcome })?.label, "已更新 · 仍有缺口");
  assert.equal(JSON.stringify(outcome), before);
});

test("API 读取投影去除旧字符串 outcome，旧客户端安全且保存的草稿记录不变", () => {
  const raw = { draft: true, outcome: "budget_exhausted", blockers: ["缺少任务接口"] };
  const projected = projectJobResult(raw)!;
  assert.equal(projected.outcome, undefined);
  assert.equal(projected.stopReason, "budget_exhausted");
  assert.equal(raw.outcome, "budget_exhausted");
  assert.match(renderToStaticMarkup(createElement(ProjectJobOutcome, { result: projected })), /预算已用完/);
  const partial = projectJobResult({ outcome: { status: "completed" } })!;
  assert.equal(partial.outcome, undefined);
  assert.equal(projectJobResultPresentation(partial)?.label, "结果摘要不完整");
  assert.doesNotThrow(() => renderToStaticMarkup(createElement(ProjectJobOutcome, { result: { draft: true, stopReason: "__proto__" } })));
});


test("草稿区分保存状态、暂停原因和可理解的局部缺口，不改写原始判定", () => {
  const result = { draft: true, stopReason: "no_progress", blockers: ["云平台文档与方案编写: inputs", "基础检查未通过：process", "部署: deliverables:review", "部署: actors:evidence"] };
  const before = JSON.stringify(result);
  const html = renderToStaticMarkup(createElement(ProjectJobOutcome, { result }));
  assert.match(html, /待完善内容.*4 项/);
  assert.match(html, /本轮研究已暂停；已有成果仍保留/);
  assert.match(html, /云平台文档与方案编写：需补充或明确开展工作所需的输入资料/);
  assert.match(html, /工作流程仍有待核查项/);
  assert.match(html, /此记录未提供具体问题/);
  assert.match(html, /需核实交付物/);
  assert.match(html, /需补充来源依据：参与人员与职责/);
  assert.doesNotMatch(html, /inputs|process|首版未完成|未形成有效进展/);
  assert.equal(JSON.stringify(result), before);
  assert.match(projectJobResultPresentation(result)!.message, /校验所选内容/);
});

test("未知缺口保留，缺少详情不虚构原因，长列表说明截断", () => {
  const result = { draft: true, blockers: ["未来规则：需人工核对", ...Array.from({length: 21}, (_, i) => `任务${i}: goal`)] };
  const html = renderToStaticMarkup(createElement(ProjectJobOutcome, { result }));
  assert.match(html, /未来规则：需人工核对/);
  assert.match(html, /22 项/);
  assert.match(html, /仅展示前 20 项/);
  const empty = renderToStaticMarkup(createElement(ProjectJobOutcome, { result: { draft: true } }));
  assert.match(empty, /没有提供具体待完善项/);
  assert.doesNotMatch(empty, /预算|最近几轮/);
});
