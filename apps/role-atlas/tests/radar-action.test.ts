import assert from "node:assert/strict";
import test from "node:test";
import {
  iterationModeForSelection,
  MAX_SELECTED_TARGETS,
  radarSelectionSchema,
  radarSelectionToIteration,
} from "@/lib/iteration/radar-action";
import type { RadarPresentation } from "@/lib/iteration/product-presentation";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";

function direction(overrides: Partial<RadarPresentation & { id: string }> = {}): RadarPresentation & { id: string } {
  return {
    id: "radar-1",
    rank: 1,
    axisId: "knowledge_novelty",
    axis: "知识新颖度",
    direction: "补齐边界值选取规则",
    gapSignal: "6/12 份 JD 提到边界值分析，图谱无对应节点",
    gain: "9.0",
    cost: "约 4 次检索",
    requiredEvidence: "权威测试标准",
    affectedNodeIds: [],
    ...overrides,
  };
}

function baseWithTasks() {
  const snapshot = bundledRoleSnapshot();
  const ids = snapshot.semantic.nodes.map(node => node.id);
  return { snapshot, ids };
}

test("确认的方向变成 user_directed 请求，范围只取所选方向指向的节点", () => {
  const { snapshot, ids } = baseWithTasks();
  const presented = [direction({ affectedNodeIds: [ids[0]] }), direction({ id: "radar-2", affectedNodeIds: [ids[1]] })];
  const result = radarSelectionToIteration({
    base: snapshot,
    selection: radarSelectionSchema.parse({ directionIds: ["radar-1"] }),
    presented,
  });
  assert.equal(result.request.initiativeProfile, "user_directed", "用户挑选的研究绝不能变成 autonomous");
  assert.deepEqual(result.request.targetIds, [ids[0]], "未选中的方向不得带入范围");
  assert.match(result.request.prompt, /补齐边界值选取规则/u);
  // 缺口信号必须随请求带走，否则下一轮只剩一句口号。
  assert.match(result.request.prompt, /6\/12 份 JD/u);
});

test("范围不会超出所选方向给出的节点，也不会重复", () => {
  const { snapshot, ids } = baseWithTasks();
  const presented = [
    direction({ affectedNodeIds: [ids[0], ids[1]] }),
    direction({ id: "radar-2", affectedNodeIds: [ids[0], ids[2]] }),
  ];
  const result = radarSelectionToIteration({
    base: snapshot,
    selection: radarSelectionSchema.parse({ directionIds: ["radar-1", "radar-2"] }),
    presented,
  });
  assert.deepEqual(result.request.targetIds, [ids[0], ids[1], ids[2]]);
});

test("不在展示清单里的方向被拒绝，不能凭空发起研究", () => {
  const { snapshot, ids } = baseWithTasks();
  const result = radarSelectionToIteration({
    base: snapshot,
    selection: radarSelectionSchema.parse({ directionIds: ["radar-invented"] }),
    presented: [direction({ affectedNodeIds: [ids[0]] })],
  });
  assert.deepEqual(result.request.targetIds, []);
  assert.equal(result.droppedDirections.length, 1);
  assert.match(result.droppedDirections[0].reason, /不在本次雷达展示的清单里/u);
});

test("指向已消失节点的方向被如实报告，而不是悄悄丢掉", () => {
  const { snapshot } = baseWithTasks();
  const result = radarSelectionToIteration({
    base: snapshot,
    selection: radarSelectionSchema.parse({ directionIds: ["radar-1"] }),
    presented: [direction({ affectedNodeIds: ["node-that-vanished"] })],
  });
  assert.deepEqual(result.request.targetIds, []);
  assert.ok(result.droppedDirections.some(item => /已不在当前快照中/u.test(item.reason)));
});

test("模式按轴确定性映射，混合选择回落到常规深耕", () => {
  assert.equal(iterationModeForSelection([{ axisId: "freshness_signal" }]), "freshness");
  assert.equal(iterationModeForSelection([{ axisId: "boundary_drift" }]), "risk_repair");
  assert.equal(iterationModeForSelection([{ axisId: "task_coverage" }]), "deep_research");
  assert.equal(iterationModeForSelection([{ axisId: "freshness_signal" }, { axisId: "task_coverage" }]), "deep_research", "混合选择不得贸然套用某个专用模式");
});

test("目标数量有上限，全选不会变成无界研究", () => {
  const { snapshot } = baseWithTasks();
  const manyNodes = Array.from({ length: 200 }, (_, index) => `node-${index}`);
  const wide = { ...bundledRoleSnapshot() };
  wide.semantic.nodes = manyNodes.map(id => ({ id, type: "task" as const, label: id, summary: "s", aliases: [], lifecycle: "candidate" as const, confidence: 0.6, evidenceSegmentIds: [], evidenceBindingIds: [], ring: 0 }));
  const result = radarSelectionToIteration({
    base: wide,
    selection: radarSelectionSchema.parse({ directionIds: ["radar-1"] }),
    presented: [direction({ affectedNodeIds: manyNodes })],
  });
  assert.equal(result.request.targetIds.length, MAX_SELECTED_TARGETS, "必须被上限截断");
  void snapshot;
});

test("选择契约要求至少一个方向，且数量有上限", () => {
  assert.throws(() => radarSelectionSchema.parse({ directionIds: [] }), /too_small|directionIds/u);
  assert.throws(() => radarSelectionSchema.parse({ directionIds: Array.from({ length: 9 }, (_, i) => `d-${i}`) }), /too_big/u);
});
