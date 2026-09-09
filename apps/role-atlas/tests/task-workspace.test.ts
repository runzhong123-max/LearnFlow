import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TaskWorkspace, { buildTaskViewBundle, type TaskEdge } from "@/app/components/TaskWorkspace";
import type { RoleCardNode } from "@/app/components/RoleCardView";
import type { WorkProcessPayload } from "@/app/components/WorkProcessForestView";
import generated from "@/lib/role-package/generated-data.json";

const nodes = generated.graph.nodes as RoleCardNode[];
const edges = generated.graph.edges as TaskEdge[];
const processPayload: WorkProcessPayload = {
  manifest: generated.workProcessManifest as WorkProcessPayload["manifest"],
  validation: generated.workProcessValidation as WorkProcessPayload["validation"],
  workProcess: generated.workProcess as WorkProcessPayload["workProcess"],
};

test("典型任务投影复用稳定节点，并聚合能力、能力单元与知识技能", () => {
  const bundle = buildTaskViewBundle(nodes, edges, "task:T-03");
  assert.ok(bundle);
  assert.equal(bundle.task.label, "Agent 系统开发（工具调用/编排/MCP）");
  assert.ok(bundle.capabilities.length > 0);
  assert.ok(bundle.capabilityUnits.length > 0);
  assert.ok(bundle.knowledgeSkills.some((node) => node.id === "ks:K-09"));
  assert.ok(bundle.edges.every((edge) => bundle.nodes.some((node) => node.id === edge.source) && bundle.nodes.some((node) => node.id === edge.target)));
});

test("典型任务工作台提供关系雷达、事理流程、证据与引用入口", () => {
  const html = renderToStaticMarkup(createElement(TaskWorkspace, {
    nodes,
    edges,
    workProcess: processPayload,
    taskId: "task:T-03",
    query: "",
    selectedId: "task:T-03",
    perspective: "relations" as const,
    onTaskChange() {},
    onPerspectiveChange() {},
    onSelect() {},
    onReference() {},
    onDragStart() {},
    onDragEnd() {},
    onOpenEvidence() {},
    onConvert() {},
    converting: true,
    conversionHint: "当前版本仅保存为私有岗位包",
  }));

  assert.match(html, /典型工作任务/);
  assert.match(html, /关系雷达/);
  assert.match(html, /事理流程/);
  assert.match(html, /查看证据/);
  assert.match(html, /引用任务/);
  assert.match(html, /disabled="">正在准备转换/);
  assert.match(html, /当前版本仅保存为私有岗位包/);
  assert.match(html, /知识点 \/ 技能点/);
});
