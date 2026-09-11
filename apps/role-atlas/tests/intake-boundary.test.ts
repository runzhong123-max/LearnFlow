import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInvoker } from "@/lib/agent/model";
import type { SourceInput } from "@/lib/build/types";
import { generateIntakeRevision } from "@/lib/intake/generate";
import { formatIntakeDescription } from "@/lib/intake/presentation";
import type { IntakeTurnInput } from "@/lib/intake/types";

const original: SourceInput = { title: "用户岗位线索", content: "我们负责云平台交付、可用性监控与故障排查。", kind: "private_document" };
const jd = (patch: Record<string, unknown> = {}) => ({
  roleTitle: "云运维工程师", summary: "负责云平台交付与运行维护，在明确服务范围内保障系统稳定。",
  tasks: ["完成平台部署与交付验收", "监测可用性并处理异常告警", "定位故障并形成处理记录"].map(text => ({ text, sourceIndexes: [] })),
  capabilities: ["结合监控记录定位故障原因", "协调变更并验证恢复结果"].map(text => ({ text, sourceIndexes: [] })),
  scenarios: [{ text: "平台上线后收到异常告警，检查影响范围、定位并恢复服务，交付故障处理记录。", sourceIndexes: [] }],
  boundaries: ["管理权限与服务范围需由使用者确认"],
  ...patch,
  assistantMessage: "请确认这版岗位说明，或告诉我需要改进的部分。",
});
const turn: IntakeTurnInput = { action: "draft", operationId: "operation-one", message: "请关注真实工作", roleTitle: "云运维工程师", market: "中国大陆", sources: [original] };
const model = (result: unknown): ModelInvoker => async function* () { yield { type: "text", delta: JSON.stringify(result) }; };
const args = (draft: unknown) => ({ projectId: "project-one", revisionId: "intake-revision:one", turn, previous: null,
  project: { title: "云运维工程师", market: "中国大陆", description: "真实交付岗位" }, history: [],
  dependencies: { model: model(draft) } });

test("the draft separates adjacent roles before tasks so the boundary is decidable", async () => {
  const result = await generateIntakeRevision(args(jd({
    adjacentRoles: [
      { title: "网络运维工程师", difference: "负责网络设备与链路可用性，不承担云平台资源交付与变更。" },
      { title: "安全运维工程师", difference: "负责安全策略与事件响应，不承担日常可用性监控值守。" },
    ],
  })));
  const boundaryIndex = result.description.indexOf("相邻岗位边界（本岗位不包含）");
  assert.ok(boundaryIndex > -1, "草稿必须包含相邻岗位边界小节");
  assert.ok(boundaryIndex < result.description.indexOf("主要任务"), "边界小节必须先于任务列表出现");
  assert.match(result.description, /网络运维工程师：负责网络设备与链路可用性/);
  assert.match(result.description, /安全运维工程师：负责安全策略与事件响应/);
});

test("an adjacent role equal to the target role is dropped instead of rendering a self-boundary", async () => {
  const result = await generateIntakeRevision(args(jd({
    adjacentRoles: [
      { title: "云运维工程师", difference: "与目标岗位同名，不应渲染。" },
      { title: " IT支持 ", difference: "负责终端与桌面支持，不负责云平台生产环境变更。" },
    ],
  })));
  assert.doesNotMatch(result.description, /与目标岗位同名/);
  assert.match(result.description, /IT支持：负责终端与桌面支持/);
});

test("a draft without adjacent roles still renders every legacy section", async () => {
  const result = await generateIntakeRevision(args(jd()));
  assert.doesNotMatch(result.description, /相邻岗位边界/);
  for (const title of ["岗位概述", "主要任务", "能力要求", "典型工作场景", "职责边界", "资料索引"]) assert.ok(result.description.includes(title));
});

test("the boundary section becomes a markdown heading in display formatting", async () => {
  const result = await generateIntakeRevision(args(jd({
    adjacentRoles: [{ title: "网络运维工程师", difference: "负责网络设备与链路可用性，不承担云平台资源交付。" }],
  })));
  const formatted = formatIntakeDescription(result.description);
  assert.match(formatted, /### 相邻岗位边界（本岗位不包含）/);
});
