import assert from "node:assert/strict";
import test from "node:test";
import { presentIterationProducts, radarAxisLabel } from "@/lib/iteration/product-presentation";
import { radarItemSchema, rankRadarItems, riskPackageSchema, type RadarItem } from "@/lib/iteration/products";
import { augmentationProposalSchema } from "@/lib/iteration/augmentation";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";
import type { IterationProducts } from "@/lib/iteration/types";

function radarItem(overrides: Partial<RadarItem> = {}): RadarItem {
  return radarItemSchema.parse({
    id: "radar-1",
    axis: "knowledge_novelty",
    direction: "补齐边界值选取规则",
    gapSignal: "6/12 份 JD 提到边界值分析，图谱无对应节点",
    affectedNodeIds: ["task-1"],
    expectedGain: { score: 99, basis: "模型认为很重要" },
    requiredEvidence: "权威测试标准中关于边界值的规定",
    ...overrides,
  });
}

test("雷达展示使用代码复算的增益，而不是模型自报的分数", () => {
  const ranked = rankRadarItems({
    items: [radarItem()],
    knownNodeIds: new Set(["task-1"]),
    nodeSeverity: new Map([["task-1", "error"]]),
  }).ranked;
  const view = presentIterationProducts({ products: { radarItems: ranked } });
  assert.equal(view.radar.length, 1);
  assert.equal(view.radar[0].axis, "知识新颖度", "轴必须显示成人读得懂的中文");
  assert.notEqual(view.radar[0].gain, "99.0", "不得显示模型自报分数");
  assert.equal(view.radar[0].gain, (ranked[0].recomputedGain).toFixed(1));
  assert.match(view.radar[0].cost, /次检索/u);
  assert.match(view.radar[0].gapSignal, /图谱无对应节点/u);
});

test("风险包分别呈现确定性发现与两类假设，不把假设混进发现", () => {
  const base = bundledRoleSnapshot();
  const products: IterationProducts = {
    riskPackage: riskPackageSchema.parse({
      packageProtocol: "learnflow.risk-package.v1",
      baseSnapshotId: base.snapshot.id,
      generatedAt: "2026-09-11T00:00:00.000Z",
      deterministicIssues: [{ code: "TASK_SKILL_GAP" }],
      domains: [{
        domain: "覆盖缺口",
        claims: [
          { id: "a", statement: "有证据的断言", kind: "observed", evidenceSpans: [{ segmentId: "s1", quote: "q" }], falsifier: "f", confidence: 0.5, affectedNodeIds: [] },
          { id: "b", statement: "无证据的断言", kind: "observed", evidenceSpans: [], falsifier: "f", confidence: 0.5, affectedNodeIds: [] },
        ],
      }],
    }),
  };
  const view = presentIterationProducts({ products });
  assert.equal(view.risk?.deterministicCount, 1);
  assert.equal(view.risk?.evidencedHypothesisCount, 2);
  assert.equal(view.risk?.bareHypothesisCount, 1, "无证据的假设必须单独计数");
  assert.equal(view.risk?.domains[0].bare, 1);
});

test("增补展示节点与关系数量，并给出证据片段总数", () => {
  const base = bundledRoleSnapshot();
  const segmentId = base.sources.segments[0].id;
  const products: IterationProducts = {
    augmentations: [augmentationProposalSchema.parse({
      baseSnapshotId: base.snapshot.id,
      motivation: "补齐边界值知识点",
      nodes: [{
        tempId: "p", type: "knowledge_skill", label: "边界值选取规则", summary: "s",
        aliases: [], confidence: 0.6, evidenceSegmentIds: [segmentId],
        learningKind: "knowledge", learningDefinition: { scopeNote: "x", assessmentCriteria: ["c"] },
      }],
      edges: [{ from: "task-1", to: "p", type: "requires_skill", evidenceSegmentIds: [segmentId], confidence: 0.6 }],
    })],
  };
  const view = presentIterationProducts({ products });
  assert.equal(view.augmentations.length, 1);
  assert.equal(view.augmentations[0].nodeCount, 1);
  assert.equal(view.augmentations[0].edgeCount, 1);
  assert.deepEqual(view.augmentations[0].nodeLabels, ["边界值选取规则"]);
  assert.equal(view.augmentations[0].evidenceSegmentCount, 1);
});

test("被拒绝的内容与理由必须出现在展示模型里", () => {
  const view = presentIterationProducts({
    products: { radarItems: [] },
    withheld: ["p: 引用了基线中不存在的片段：segment-x", "本批新增关系自身成环，整批关系被拒绝"],
  });
  assert.equal(view.withheld.length, 2);
  assert.ok(view.withheld.some(note => /成环/u.test(note)));
  // 全是空产物时视为空，避免页面渲染一个没有内容的空壳面板。
  assert.equal(view.isEmpty, true);
});

test("没有任何产物时返回空模型而不是抛出", () => {
  const view = presentIterationProducts({});
  assert.equal(view.isEmpty, true);
  assert.deepEqual(view.radar, []);
  assert.deepEqual(view.augmentations, []);
  assert.equal(view.risk, undefined);
});

test("未知轴名原样回落，不显示成空白", () => {
  assert.equal(radarAxisLabel("knowledge_novelty"), "知识新颖度");
  assert.equal(radarAxisLabel("some_future_axis"), "some_future_axis");
});
