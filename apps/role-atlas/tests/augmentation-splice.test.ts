import assert from "node:assert/strict";
import test from "node:test";
import { augmentationProposalSchema, type AugmentationProposal } from "@/lib/iteration/augmentation";
import { applyAugmentation } from "@/lib/iteration/augmentation-splice";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";

function base() {
  return bundledRoleSnapshot();
}

function proposal(snapshot: ReturnType<typeof base>, overrides: Partial<AugmentationProposal> = {}): AugmentationProposal {
  const segmentId = snapshot.sources.segments[0].id;
  const task = snapshot.semantic.nodes.find(node => node.type === "task")!;
  return augmentationProposalSchema.parse({
    baseSnapshotId: snapshot.snapshot.id,
    motivation: "补齐边界值设计相关的知识点",
    nodes: [{
      tempId: "new-point",
      type: "knowledge_skill",
      label: "边界值选取规则",
      summary: "说明边界及边界附近数据的选取依据。",
      aliases: [],
      confidence: 0.6,
      evidenceSegmentIds: [segmentId],
      learningKind: "knowledge",
      learningDefinition: { scopeNote: "限于输入范围边界附近的取值判断", assessmentCriteria: ["能说明边界数据的选取依据"] },
    }],
    edges: [{ from: task.id, to: "new-point", type: "requires_skill", evidenceSegmentIds: [segmentId], confidence: 0.6 }],
    ...overrides,
  });
}

test("校验通过的增量经编译器拼接进候选，且不产生新的审计错误", () => {
  const snapshot = base();
  const result = applyAugmentation({ base: snapshot, proposal: proposal(snapshot) });

  assert.equal(result.auditClean, true, `拼接不得引入新错误：${result.newErrors.join("；")}`);
  assert.deepEqual(result.newErrors, []);
  assert.equal(result.candidate.semantic.nodes.length, snapshot.semantic.nodes.length + 1);

  const added = result.candidate.semantic.nodes.find(node => node.label === "边界值选取规则");
  assert.ok(added, "新增节点必须出现在候选里");
  // 关键：节点必须带着编译器生成的证据绑定；裸插入的节点不会有，审计会以
  // UNSUPPORTED_TARGET 拒绝它。
  assert.ok(added.evidenceBindingIds.length > 0, "编译器必须为新增节点建立证据绑定");
  assert.ok(result.candidate.sources.evidenceBindings.some(binding => added.evidenceBindingIds.includes(binding.id)));
  assert.equal(added.learningDefinition?.scopeNote, "限于输入范围边界附近的取值判断");
});

test("关系同样由编译器生成并带证据绑定", () => {
  const snapshot = base();
  const result = applyAugmentation({ base: snapshot, proposal: proposal(snapshot) });
  const newEdges = result.candidate.semantic.edges.filter(edge => !snapshot.semantic.edges.some(existing => existing.id === edge.id));
  assert.equal(newEdges.length, 1);
  assert.equal(newEdges[0].type, "requires_skill");
  assert.ok(newEdges[0].evidenceBindingIds.length > 0, "新增关系必须带证据绑定");
});

test("受影响的 section 成员被重算，新增点进入知识技能章节", () => {
  const snapshot = base();
  const result = applyAugmentation({ base: snapshot, proposal: proposal(snapshot) });
  const before = snapshot.snapshot.sections.find(section => section.id === "knowledge-skills")!;
  const after = result.candidate.snapshot.sections.find(section => section.id === "knowledge-skills")!;

  const added = result.candidate.semantic.nodes.find(node => node.label === "边界值选取规则")!;
  assert.ok(after.itemIds.includes(added.id), "新增点必须进入知识技能章节，否则章节会漏报覆盖范围");
  assert.equal(after.itemIds.length, before.itemIds.length + 1);
  assert.ok(after.evidenceBindingIds.length >= before.evidenceBindingIds.length);
  assert.equal(after.status, "candidate");
});

test("未受影响的 section 逐字不变", () => {
  const snapshot = base();
  const result = applyAugmentation({ base: snapshot, proposal: proposal(snapshot) });
  for (const id of ["overview", "role-context", "work-process", "evidence-risks"]) {
    const before = snapshot.snapshot.sections.find(section => section.id === id)!;
    const after = result.candidate.snapshot.sections.find(section => section.id === id)!;
    assert.deepEqual(after, before, `${id} 不应被增补改动`);
  }
});

test("增补不创建新快照，基线身份保持不变", () => {
  const snapshot = base();
  const result = applyAugmentation({ base: snapshot, proposal: proposal(snapshot) });
  assert.equal(result.candidate.snapshot.id, snapshot.snapshot.id);
  assert.equal(result.candidate.snapshot.asOf, snapshot.snapshot.asOf);
  assert.equal(result.candidate.brief.roleTitle, snapshot.brief.roleTitle);
  assert.equal(result.candidate.brief.projectId, snapshot.brief.projectId);
});

test("没有可接受内容时原样返回，不做任何改动", () => {
  const snapshot = base();
  const result = applyAugmentation({
    base: snapshot,
    proposal: proposal(snapshot, { nodes: [], edges: [] }),
  });
  assert.equal(result.candidate, snapshot, "空增补必须返回同一个对象，避免无谓的图变动");
  assert.equal(result.auditClean, true);
  assert.deepEqual(result.report.rejections, []);
});

test("被闸门退回的增量不会被拼接，退回理由随报告返回", () => {
  const snapshot = base();
  const result = applyAugmentation({
    base: snapshot,
    proposal: proposal(snapshot, {
      nodes: [{
        tempId: "bad", type: "knowledge_skill", label: "边界值选取规则", summary: "缺定义",
        aliases: [], confidence: 0.6, evidenceSegmentIds: [snapshot.sources.segments[0].id],
      }],
      edges: [],
    } as unknown as Partial<AugmentationProposal>),
  });
  assert.equal(result.candidate.semantic.nodes.length, snapshot.semantic.nodes.length, "被拒内容不得进入候选");
  assert.equal(result.candidate, snapshot);
  // learningKind 是可选字段，缺它不会被 schema 拦下，必须由 schema 闸拒绝。
  assert.equal(result.report.rejections.length, 1);
  assert.match(result.report.rejections[0].reason, /必须声明 learningKind/u);
});

test("重复节点被结构闸退回时，候选保持原样并给出理由", () => {
  const snapshot = base();
  const existing = snapshot.semantic.nodes.find(node => node.type === "knowledge_skill")!;
  const result = applyAugmentation({
    base: snapshot,
    proposal: proposal(snapshot, {
      nodes: [{
        tempId: "dup", type: "knowledge_skill", label: existing.label, summary: "重复",
        aliases: [], confidence: 0.6, evidenceSegmentIds: [snapshot.sources.segments[0].id],
        learningKind: "knowledge",
        learningDefinition: { scopeNote: "x", assessmentCriteria: ["c"] },
      }],
      edges: [],
    } as unknown as Partial<AugmentationProposal>),
  });
  assert.equal(result.candidate, snapshot);
  assert.match(result.report.rejections[0].reason, /语义重复/u);
});

test("拼接后的候选自身通过一次完整审计，不出现协议或章节错误", () => {
  const snapshot = base();
  const result = applyAugmentation({ base: snapshot, proposal: proposal(snapshot) });
  const added = result.candidate.semantic.nodes.find(node => node.label === "边界值选取规则")!;
  const codes = new Set(result.candidate.audit?.issues?.map(issue => issue.code) || []);
  assert.equal(codes.has("MISSING_SNAPSHOT_SECTION"), false, "章节必须完整");
  assert.ok(result.candidate.snapshot.sections.some(section => section.itemIds.includes(added.id)));
});
