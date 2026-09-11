import assert from "node:assert/strict";
import test from "node:test";
import {
  augmentationProposalSchema,
  validateAugmentation,
  type AugmentationProposal,
} from "@/lib/iteration/augmentation";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";

function proposal(overrides: Partial<AugmentationProposal> = {}): AugmentationProposal {
  return augmentationProposalSchema.parse({
    baseSnapshotId: bundledRoleSnapshot().snapshot.id,
    motivation: "补齐边界值设计相关的知识点与技能点",
    nodes: [],
    edges: [],
    ...overrides,
  });
}

function base() {
  return bundledRoleSnapshot();
}

function atomicNode(segmentId: string, overrides: Record<string, unknown> = {}) {
  return {
    tempId: "new-point",
    type: "knowledge_skill" as const,
    label: "边界值选取规则",
    summary: "说明边界及边界附近数据的选取依据。",
    aliases: [] as string[],
    confidence: 0.6,
    evidenceSegmentIds: [segmentId],
    learningKind: "knowledge" as const,
    learningDefinition: {
      scopeNote: "限于输入范围边界附近的取值判断",
      assessmentCriteria: ["能说明边界与边界附近数据的选取依据"],
    },
    ...overrides,
  };
}

test("四道闸全过的原子点与关系被接受", () => {
  const snapshot = base();
  const segmentId = snapshot.sources.segments[0].id;
  const task = snapshot.semantic.nodes.find(node => node.type === "task")!;
  const report = validateAugmentation({
    base: snapshot,
    proposal: proposal({
      nodes: [atomicNode(segmentId)],
      edges: [{ from: task.id, to: "new-point", type: "requires_skill", evidenceSegmentIds: [segmentId], confidence: 0.6 }],
    }),
  });
  assert.equal(report.complete, true);
  assert.equal(report.acceptedNodes.length, 1);
  assert.equal(report.acceptedEdges.length, 1);
  assert.deepEqual(report.rejections, []);
});

test("契约文档里的合法知识点不会被粒度闸误杀", () => {
  const snapshot = base();
  const segmentId = snapshot.sources.segments[0].id;
  // 「等价类划分原则」是 v2 契约给出的知识点范例：短、不含动作动词，
  // 但它必须是合法原子点，不能被课程名启发式误判。
  const report = validateAugmentation({
    base: snapshot,
    proposal: proposal({ nodes: [atomicNode(segmentId, { label: "等价类划分原则" })] }),
  });
  assert.equal(report.complete, true, JSON.stringify(report.rejections));
  assert.deepEqual(report.acceptedNodes.map(node => node.label), ["等价类划分原则"]);
});

test("schema 闸：学习点必须带可考核定义，粗粒度节点不得冒充原子点", () => {
  const snapshot = base();
  const segmentId = snapshot.sources.segments[0].id;
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ learningKind: undefined }, /必须声明 learningKind/u],
    [{ learningKind: "hybrid" }, /混合类型/u],
    [{ learningDefinition: undefined }, /必须提供 learningDefinition/u],
  ];
  for (const [patch, expected] of cases) {
    const report = validateAugmentation({ base: snapshot, proposal: proposal({ nodes: [atomicNode(segmentId, patch)] }) });
    assert.equal(report.acceptedNodes.length, 0, JSON.stringify(patch));
    assert.match(report.rejections[0].reason, expected);
    assert.equal(report.rejections[0].gate, "schema");
  }

  // 空的 assessmentCriteria 在 schema 层就被拒绝，比闸门更早；这里断言两层
  // 都拦得住，避免将来有人放宽 schema 后悄然失守。
  assert.throws(
    () => proposal({ nodes: [atomicNode(segmentId, { learningDefinition: { scopeNote: "x", assessmentCriteria: [] } })] }),
    /assessmentCriteria|too_small/u,
  );

  const coarse = validateAugmentation({
    base: snapshot,
    proposal: proposal({ nodes: [{
      tempId: "task-dup", type: "task" as const, label: "核验迁移后的业务数据",
      summary: "重复的任务层节点", aliases: [], confidence: 0.6,
      evidenceSegmentIds: [segmentId], learningKind: "knowledge" as const,
    }] }),
  });
  assert.match(coarse.rejections[0].reason, /只有 knowledge_skill 才能携带学习定义/u);
});

test("证据闸：片段必须存在于基线，且新增节点不得无证据", () => {
  const snapshot = base();
  const segmentId = snapshot.sources.segments[0].id;
  const absent = validateAugmentation({
    base: snapshot,
    proposal: proposal({ nodes: [atomicNode("segment-does-not-exist")] }),
  });
  assert.equal(absent.rejections[0].gate, "evidence");
  assert.match(absent.rejections[0].reason, /基线中不存在的片段/u);

  const bare = validateAugmentation({
    base: snapshot,
    proposal: proposal({ nodes: [atomicNode(segmentId, { evidenceSegmentIds: [] })] }),
  });
  assert.equal(bare.rejections[0].gate, "evidence");
  assert.match(bare.rejections[0].reason, /至少引用一条基线原文片段/u);
});

test("结构闸：语义重复的节点被退回，并说明应补证据而非新增", () => {
  const snapshot = base();
  const segmentId = snapshot.sources.segments[0].id;
  const existing = snapshot.semantic.nodes.find(node => node.type === "knowledge_skill") || snapshot.semantic.nodes[1];
  const report = validateAugmentation({
    base: snapshot,
    proposal: proposal({ nodes: [atomicNode(segmentId, { label: existing.label })] }),
  });
  assert.equal(report.acceptedNodes.length, 0);
  assert.equal(report.rejections[0].gate, "structure");
  assert.match(report.rejections[0].reason, /语义重复/u);
  assert.match(report.rejections[0].reason, /补充证据而非新增/u);
});

test("结构闸：端点无法解析的关系被退回，不静默丢弃", () => {
  const snapshot = base();
  const segmentId = snapshot.sources.segments[0].id;
  const report = validateAugmentation({
    base: snapshot,
    proposal: proposal({
      nodes: [atomicNode(segmentId)],
      edges: [
        { from: "node-that-does-not-exist", to: "new-point", type: "requires_skill", evidenceSegmentIds: [segmentId], confidence: 0.6 },
        { from: "new-point", to: "also-missing", type: "requires_skill", evidenceSegmentIds: [segmentId], confidence: 0.6 },
      ],
    }),
  });
  assert.equal(report.acceptedEdges.length, 0);
  assert.equal(report.rejections.length, 2);
  assert.ok(report.rejections.every(item => item.gate === "structure"));
  assert.match(report.rejections[0].reason, /node-that-does-not-exist/u);
});

test("结构闸：本批关系成环时整批关系被拒，节点仍保留", () => {
  const snapshot = base();
  const segmentId = snapshot.sources.segments[0].id;
  const report = validateAugmentation({
    base: snapshot,
    proposal: proposal({
      nodes: [
        atomicNode(segmentId, { tempId: "a", label: "边界值选取规则" }),
        atomicNode(segmentId, { tempId: "b", label: "等价类划分原则" }),
      ],
      edges: [
        { from: "a", to: "b", type: "requires_skill", evidenceSegmentIds: [segmentId], confidence: 0.6 },
        { from: "b", to: "a", type: "requires_skill", evidenceSegmentIds: [segmentId], confidence: 0.6 },
      ],
    }),
  });
  assert.equal(report.acceptedEdges.length, 0);
  assert.equal(report.acceptedNodes.length, 2, "成环只否决关系，不该连带丢弃节点");
  assert.match(report.rejections.at(-1)!.reason, /成环/u);
});

test("基线不一致时整份提案被拒，避免把证据绑到不存在的节点上", () => {
  const snapshot = base();
  const segmentId = snapshot.sources.segments[0].id;
  const report = validateAugmentation({
    base: snapshot,
    proposal: proposal({ baseSnapshotId: "snapshot:stale", nodes: [atomicNode(segmentId)] }),
  });
  assert.equal(report.complete, false);
  assert.equal(report.acceptedNodes.length, 0);
  assert.equal(report.rejections[0].scope, "proposal");
  assert.match(report.rejections[0].reason, /必须基于当前基线重新生成/u);
});

test("提案契约要求动机与基线，且节点上限有界", () => {
  assert.throws(() => augmentationProposalSchema.parse({ baseSnapshotId: "x", motivation: "" }), /motivation/u);
  const parsed = augmentationProposalSchema.parse({ baseSnapshotId: "x", motivation: "m" });
  assert.deepEqual(parsed.nodes, []);
  assert.deepEqual(parsed.attachedTo, []);
  assert.throws(() => augmentationProposalSchema.parse({
    baseSnapshotId: "x", motivation: "m",
    nodes: Array.from({ length: 41 }, (_, index) => atomicNodeLike(index)),
  }), /too_big|array/u);
});

function atomicNodeLike(index: number) {
  return {
    tempId: `n-${index}`, type: "knowledge_skill" as const, label: `点 ${index}`, summary: "s",
    aliases: [] as string[], confidence: 0.6,
    evidenceSegmentIds: ["segment-1"], learningKind: "knowledge" as const,
    learningDefinition: { scopeNote: "x", assessmentCriteria: ["c"] },
  };
}
