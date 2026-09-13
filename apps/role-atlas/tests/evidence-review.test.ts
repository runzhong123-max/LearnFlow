import assert from "node:assert/strict";
import test from "node:test";
import type { ModelInvoker } from "@/lib/agent/model";
import {
  applyEvidenceReview,
  claimSchema,
  createEvidenceReviewer,
  evidenceReviewPrompt,
  isReviewableClaim,
  type Claim,
} from "@/lib/iteration/evidence-review";

function claim(overrides: Partial<Claim> = {}): Claim {
  return claimSchema.parse({
    id: "claim-1",
    statement: "软件测试技术员需要按等价类划分设计用例",
    kind: "observed",
    evidenceSpans: [{ segmentId: "segment-1", quote: "按等价类划分设计测试用例并记录依据。" }],
    falsifier: "若权威岗位标准中不存在用例设计职责，则该断言不成立",
    ...overrides,
  });
}

/** Answers with a fixed verdict payload and records the prompts it received. */
function verdictModel(payload: unknown, prompts: string[] = []): ModelInvoker {
  return async function* (input) {
    prompts.push(input.user);
    yield { type: "text", delta: JSON.stringify(payload) };
  };
}

test("supported 断言升级为 verified，且理由可追溯", async () => {
  const reviewer = createEvidenceReviewer(verdictModel({
    verdicts: [{ claimId: "claim-1", verdict: "supported", note: "片段直接写明按等价类划分设计用例" }],
  }));
  const review = await reviewer({ claims: [claim()] });
  assert.ok(review);
  const [applied] = applyEvidenceReview([claim()], review);
  assert.equal(applied.verification, "verified");
  assert.match(applied.note, /等价类划分/u);
});

test("unsupported 只降级不删除：断言仍返回并保留复核理由", async () => {
  const target = claim();
  const review = await createEvidenceReviewer(verdictModel({
    verdicts: [{ claimId: "claim-1", verdict: "unsupported", note: "片段只提到测试执行，未涉及用例设计" }],
  }))({ claims: [target] });
  const applied = applyEvidenceReview([target], review);
  assert.equal(applied.length, 1, "复核不通过的内容必须保留在候选层，不能删除");
  assert.equal(applied[0].verification, "unverified");
  assert.match(applied[0].note, /复核不支持/u);
  assert.match(applied[0].note, /未涉及用例设计/u);
  assert.equal(applied[0].claim.statement, target.statement);
});

test("uncertain 与 unsupported 区分，不冒充已核实", async () => {
  const review = await createEvidenceReviewer(verdictModel({
    verdicts: [{ claimId: "claim-1", verdict: "uncertain", note: "片段相关但未覆盖判定条件" }],
  }))({ claims: [claim()] });
  const [applied] = applyEvidenceReview([claim()], review);
  assert.equal(applied.verification, "uncertain");
});

test("observed 但没有任何片段：由代码拒绝，不交给模型辩解", async () => {
  const prompts: string[] = [];
  const reviewer = createEvidenceReviewer(verdictModel({ verdicts: [] }, prompts));
  const bare = claim({ id: "claim-bare", evidenceSpans: [] });
  assert.equal(isReviewableClaim(bare), false);
  const review = await reviewer({ claims: [bare] });
  assert.ok(review);
  assert.deepEqual(review.unverifiable, ["claim-bare"]);
  assert.equal(prompts.length, 0, "无证据的 observed 断言不得消耗模型调用");
  const [applied] = applyEvidenceReview([bare], review);
  assert.equal(applied.verification, "unverified");
  assert.match(applied.note, /缺少原文/u);

  // inferred / absence 是合法类型，照常复核。
  assert.equal(isReviewableClaim(claim({ kind: "inferred", evidenceSpans: [] })), true);
  assert.equal(isReviewableClaim(claim({ kind: "absence", evidenceSpans: [] })), true);
});

test("模型编造的 claimId 被丢弃，不能影响未提交的断言", async () => {
  const submitted = claim({ id: "claim-real" });
  const review = await createEvidenceReviewer(verdictModel({
    verdicts: [
      { claimId: "claim-invented", verdict: "supported", note: "凭空产物" },
      { claimId: "claim-real", verdict: "unsupported", note: "证据不足" },
    ],
  }))({ claims: [submitted] });
  assert.ok(review);
  assert.equal(review.verdicts.size, 1);
  assert.equal(review.verdicts.has("claim-invented"), false);
  const applied = applyEvidenceReview([submitted], review);
  assert.equal(applied[0].verification, "unverified");
});

test("复核失败按不可用处理：全部保持待核实，不升级也不删除", async () => {
  const failing: ModelInvoker = async function* () { throw new Error("provider_down"); yield { type: "text", delta: "" }; };
  const claims = [claim({ id: "a" }), claim({ id: "b" })];
  const review = await createEvidenceReviewer(failing)({ claims });
  assert.equal(review, undefined, "失败必须返回 undefined，交由调用方失败开放");
  const applied = applyEvidenceReview(claims, review);
  assert.equal(applied.length, 2);
  assert.ok(applied.every(item => item.verification === "unverified"));
  assert.ok(applied.every(item => /复核不可用/u.test(item.note)));
});

test("同样的断言集合只调用模型一次（按内容 memoize）", async () => {
  let calls = 0;
  const model: ModelInvoker = async function* () {
    calls += 1;
    yield { type: "text", delta: JSON.stringify({ verdicts: [{ claimId: "claim-1", verdict: "supported", note: "ok" }] }) };
  };
  const reviewer = createEvidenceReviewer(model);
  await reviewer({ claims: [claim()] });
  await reviewer({ claims: [claim()] });
  assert.equal(calls, 1);
  // 内容变化必须重新复核，不能命中旧结论。
  await reviewer({ claims: [claim({ statement: "完全不同的断言内容" })] });
  assert.equal(calls, 2);
});

test("复核提示只包含已提交的片段与断言，并要求逐条理由", () => {
  const prompt = evidenceReviewPrompt([{ claim: claim() }]);
  assert.match(prompt.system, /只能依据提交给你的片段判断/u);
  assert.match(prompt.system, /supported：原文支持/u);
  assert.match(prompt.system, /unsupported：片段与断言不符/u);
  assert.match(prompt.system, /uncertain/u);
  const payload = JSON.parse(prompt.user) as { claims: Array<Record<string, unknown>> };
  assert.equal(payload.claims.length, 1);
  assert.equal(payload.claims[0].claimId, "claim-1");
  assert.deepEqual(payload.claims[0].evidenceSpans, [{ segmentId: "segment-1", quote: "按等价类划分设计测试用例并记录依据。" }]);
  // falsifier 一并交给复核员，复核才能针对“什么会推翻它”判断。
  assert.match(String(payload.claims[0].falsifier), /权威岗位标准/u);
});

test("claim 保留非空断言约束，核查条件可选", () => {
  assert.equal(claimSchema.parse({ id: "x", statement: "s", kind: "observed" }).falsifier, undefined);
  assert.throws(() => claimSchema.parse({ id: "x", statement: "", kind: "observed", falsifier: "f" }), /statement|too_small/u);
  const parsed = claimSchema.parse({ id: "x", statement: "s", kind: "inferred", falsifier: "f" });
  assert.deepEqual(parsed.evidenceSpans, []);
  assert.equal(parsed.confidence, 0.5);
});
