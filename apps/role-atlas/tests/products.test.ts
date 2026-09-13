import assert from "node:assert/strict";
import test from "node:test";
import type { RiskIssue } from "@/lib/risk/types";
import { claimSchema, type Claim } from "@/lib/iteration/evidence-review";
import {
  buildProposal,
  buildRiskPackage,
  decideAcceptance,
  proposalSchema,
  radarItemSchema,
  rankRadarItems,
  riskClaimTier,
  severityBasis,
  type RadarItem,
} from "@/lib/iteration/products";
import { researchTaskCardSchema } from "@/lib/iteration/worker";

function radarItem(overrides: Partial<RadarItem> = {}): RadarItem {
  return radarItemSchema.parse({
    id: "radar-1",
    axis: "knowledge_novelty",
    direction: "补齐边界值选取规则",
    gapSignal: "6/12 份 JD 提到边界值分析，图谱无对应节点",
    affectedNodeIds: ["task-1"],
    expectedGain: { score: 90, basis: "覆盖多份招聘要求" },
    requiredEvidence: "权威测试标准中关于边界值的规定",
    ...overrides,
  });
}

function claim(id: string, overrides: Partial<Claim> = {}): Claim {
  return claimSchema.parse({
    id,
    statement: `断言 ${id}`,
    kind: "observed",
    evidenceSpans: [{ segmentId: "segment-1", quote: "原文。" }],
    falsifier: "权威标准不含该职责",
    ...overrides,
  });
}

test("信号闸：缺信号或指向不存在的节点一律不上雷达", () => {
  // 空白信号在 schema 层就被拒绝，比闸门更早；两层都拦得住，避免放宽 schema 后失守。
  assert.throws(() => radarItem({ gapSignal: "   " }), /gapSignal|too_small/u);

  const result = rankRadarItems({
    items: [
      radarItem({ id: "ghost", affectedNodeIds: ["task-does-not-exist"] }),
      radarItem({ id: "good" }),
    ],
    knownNodeIds: new Set(["task-1"]),
  });
  assert.deepEqual(result.ranked.map(item => item.id), ["good"]);
  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0].gate, "signal");
  assert.match(result.rejections[0].reason, /不存在/u);
});

test("增益闸：排序由代码复算，模型自报的分数不参与排序", () => {
  const result = rankRadarItems({
    items: [
      // 模型给高分，但只影响 1 个 warning 节点。
      radarItem({ id: "overstated", expectedGain: { score: 100, basis: "模型认为很重要" }, affectedNodeIds: ["task-1"] }),
      // 模型给低分，但影响 3 个 error 节点。
      radarItem({
        id: "understated", direction: "补齐事理场景", expectedGain: { score: 10, basis: "模型认为次要" },
        affectedNodeIds: ["task-1", "task-2", "task-3"],
      }),
    ],
    knownNodeIds: new Set(["task-1", "task-2", "task-3"]),
    nodeSeverity: new Map([["task-1", "warning"], ["task-2", "error"], ["task-3", "error"]]),
  });
  assert.deepEqual(result.ranked.map(item => item.id), ["understated", "overstated"]);
  assert.equal(result.ranked[0].rank, 1);
  // 模型分数被保留以便解释，但不作为排序依据。
  assert.equal(result.ranked[0].expectedGain.score, 10);
  assert.ok(result.ranked[0].recomputedGain > result.ranked[1].recomputedGain);
});

test("防反复闸：已决定的方向与同批重复方向都被剔除", () => {
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const result = rankRadarItems({
    items: [
      radarItem({ id: "repeat" }),
      radarItem({ id: "same-batch" }),
      radarItem({ id: "fresh", direction: "补齐等价类划分原则" }),
    ],
    knownNodeIds: new Set(["task-1"]),
    decidedDirections: new Set([normalize("补齐边界值选取规则")]),
  });
  assert.deepEqual(result.ranked.map(item => item.id), ["fresh"]);
  assert.equal(result.rejections.length, 2);
  assert.ok(result.rejections.every(item => item.gate === "dedupe"));
});

test("风险包：确定性发现与假设分级，假设永不被提升为发现", () => {
  const issue = { id: "i1", severity: "error", impact: "任务层缺少技能覆盖", detail: "" } as unknown as RiskIssue;
  const built = buildRiskPackage({
    baseSnapshotId: "snapshot:role@2026-08-19",
    generatedAt: "2026-09-11T00:00:00.000Z",
    issues: [issue],
    domains: [{ domain: "覆盖缺口", claims: [claim("c1"), claim("c2", { kind: "inferred", evidenceSpans: [] })] }],
    researchAgenda: [researchTaskCardSchema.parse({ id: "card", question: "补齐技能覆盖", sourceClass: "official_standard" })],
  });
  assert.equal(built.package.packageProtocol, "learnflow.risk-package.v1");
  assert.equal(built.counts.deterministic, 1);
  assert.equal(built.counts.evidencedHypothesis, 2);
  assert.equal(built.counts.bareHypothesis, 0);
  // 领域内的假设带 tier，读者能直接分辨哪些是代码算出来的。
  assert.deepEqual(built.domains[0].claims.map(item => item.tier), ["evidenced_hypothesis", "evidenced_hypothesis"]);
  // 风险包是下一轮的燃料，不是终点。
  assert.equal(built.package.researchAgenda.length, 1);
});

test("无证据的 observed 假设仍被保留，但标记为 bare_hypothesis", () => {
  assert.equal(riskClaimTier(claim("x", { evidenceSpans: [] })), "bare_hypothesis");
  assert.equal(riskClaimTier(claim("y")), "evidenced_hypothesis");
  assert.equal(riskClaimTier(claim("z", { kind: "absence", evidenceSpans: [] })), "evidenced_hypothesis");
});

test("severity 必须给出依据，不能只给一个词", () => {
  assert.deepEqual(severityBasis({ severity: "error", impact: "任务无技能覆盖", detail: "" }), { severity: "error", basis: "任务无技能覆盖" });
  assert.throws(() => severityBasis({ severity: "error", impact: "  ", detail: "" }), /必须给出依据/u);
});

test("批准权在代码：非 autonomous 一律需要用户确认", () => {
  for (const profile of ["co_guided", "user_directed"] as const) {
    const decision = decideAcceptance({ initiativeProfile: profile, auditClean: true, claims: [{ verification: "verified" }] });
    assert.equal(decision.acceptance, "needs_user");
    assert.match(decision.reason, /需要用户确认/u);
  }
});

test("批准权在代码：autonomous 也必须审计干净且断言全部通过复核", () => {
  assert.equal(decideAcceptance({ initiativeProfile: "autonomous", auditClean: false, claims: [{ verification: "verified" }] }).acceptance, "needs_user");
  assert.equal(decideAcceptance({ initiativeProfile: "autonomous", auditClean: true, claims: [{ verification: "unverified" }] }).acceptance, "needs_user");
  assert.equal(decideAcceptance({ initiativeProfile: "autonomous", auditClean: true, claims: [{ verification: "uncertain" }] }).acceptance, "needs_user");
  assert.equal(decideAcceptance({ initiativeProfile: "autonomous", auditClean: true, claims: [{ verification: "verified" }] }).acceptance, "auto");

  const reasons = decideAcceptance({ initiativeProfile: "autonomous", auditClean: true, claims: [{ verification: "unverified" }, { verification: "verified" }] });
  assert.match(reasons.reason, /1 条断言未通过复核/u);
});

test("提案把断言与复核结论一起带上，且 scope 与 acceptance 不可由自由文本决定", () => {
  const built = buildProposal({
    kind: "augmentation",
    motivation: "补齐边界值知识点",
    claims: [
      { claim: claim("c1"), verification: "verified", note: "片段直接支持" },
      { claim: claim("c2"), verification: "unverified", note: "复核不支持" },
    ],
    scope: { targetIds: ["task-1"], radius: 1 },
    plan: [],
    rollbackNote: "丢弃该 GraphPatch，候选快照不变",
    initiativeProfile: "autonomous",
    auditClean: true,
  });
  // 有一条未通过复核 → 不能自动接受，即使处于 autonomous。
  assert.equal(built.decision.acceptance, "needs_user");
  assert.equal(built.proposal.acceptance, "needs_user");
  assert.equal(built.proposal.claims.length, 2);
  assert.deepEqual(built.proposal.scope, { targetIds: ["task-1"], radius: 1 });
});

test("提案契约要求动机与回滚说明，acceptance 只接受两个枚举值", () => {
  assert.throws(() => proposalSchema.parse({ kind: "augmentation", motivation: "", scope: {}, acceptance: "auto", rollbackNote: "x" }), /motivation/u);
  assert.throws(() => proposalSchema.parse({ kind: "augmentation", motivation: "m", scope: {}, acceptance: "yes", rollbackNote: "x" }), /acceptance|invalid/u);
  assert.throws(() => proposalSchema.parse({ kind: "unknown", motivation: "m", scope: {}, acceptance: "auto", rollbackNote: "x" }), /kind|invalid/u);
  const parsed = proposalSchema.parse({ kind: "radar_item", motivation: "m", scope: {}, acceptance: "needs_user", rollbackNote: "r" });
  assert.deepEqual(parsed.claims, []);
  assert.deepEqual(parsed.plan, []);
});
