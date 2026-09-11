import assert from "node:assert/strict";
import test from "node:test";
import {
  budgetLedgerConfigSchema,
  createBudgetLedger,
  defaultReviewReserve,
  type BudgetAmount,
} from "@/lib/iteration/budget-ledger";

function amount(queries: number, tokens = queries * 100, turns = queries): BudgetAmount {
  return { queries, tokens, turns };
}

function ledger(overrides: Partial<Parameters<typeof createBudgetLedger>[0]> = {}) {
  return createBudgetLedger({
    total: amount(100),
    reviewReserve: amount(20),
    ...overrides,
  });
}

test("复核预留不可被研究消耗：研究花光全部额度后复核仍有余额", () => {
  const book = ledger();
  const spend = book.charge("general", amount(100));
  assert.equal(spend.granted.queries, 80, "研究只能用总额减去预留的部分");
  assert.equal(spend.truncated, true);
  assert.match(String(spend.reason), /研究总预算不足/u);

  const afterResearch = book.snapshot();
  assert.equal(afterResearch.spent.queries, 80);
  assert.equal(afterResearch.remainingReserve.queries, 20, "复核预留不能被研究挤占");

  const review = book.charge("evidence_review", amount(20));
  assert.equal(review.granted.queries, 20);
  assert.equal(review.truncated, false);
  assert.equal(book.snapshot().remainingReserve.queries, 0);
});

test("复核预留只对 evidence_review 开放，其它产品一律拿不到", () => {
  const book = ledger();
  // 先把研究池花光。
  book.charge("general", amount(100));
  for (const product of ["risk_package", "deepening_radar", "augmentation", "learning_mount"] as const) {
    const result = book.charge(product, amount(5));
    assert.equal(result.granted.queries, 0, `${product} 不得动用复核预留`);
  }
  assert.equal(book.snapshot().remainingReserve.queries, 20);
});

test("超支由代码截断并说明原因，不抛错也不静默成功", () => {
  const book = ledger();
  // 研究池 = 100 - 20 = 80。
  const first = book.charge("risk_package", amount(60));
  assert.equal(first.truncated, false);
  assert.equal(first.granted.queries, 60);

  const second = book.charge("risk_package", amount(60));
  assert.equal(second.truncated, true);
  assert.equal(second.granted.queries, 20, "只发放池中剩下的部分");
  assert.match(String(second.reason), /总预算不足/u);

  const third = book.charge("risk_package", amount(1));
  assert.equal(third.granted.queries, 0);
  assert.equal(third.truncated, true);
});

test("产品各自额度独立生效，先到者不能吃光后来者", () => {
  const book = ledger({
    perProduct: { risk_package: amount(10), deepening_radar: amount(10) },
  });
  const risk = book.charge("risk_package", amount(50));
  assert.equal(risk.granted.queries, 10);
  assert.match(String(risk.reason), /risk_package 已达到自身额度上限/u);

  // 风险包被截断不影响雷达的独立额度。
  const radar = book.charge("deepening_radar", amount(10));
  assert.equal(radar.granted.queries, 10);
  assert.equal(radar.truncated, false);
  assert.equal(book.snapshot().byProduct.deepening_radar.queries, 10);
});

test("总量仍是硬上限：多个产品合计不能越过研究池", () => {
  const book = ledger({
    perProduct: { risk_package: amount(60), deepening_radar: amount(60) },
  });
  assert.equal(book.charge("risk_package", amount(60)).granted.queries, 60);
  const radar = book.charge("deepening_radar", amount(60));
  assert.equal(radar.granted.queries, 20, "自身额度还有 60，但研究池只剩 20");
  assert.equal(radar.truncated, true);
  assert.match(String(radar.reason), /总预算不足/u);
  assert.equal(book.snapshot().remainingResearch.queries, 0);
});

test("快照按产品记账，且返回副本不会串改内部状态", () => {
  const book = ledger();
  book.charge("augmentation", amount(5));
  const first = book.snapshot();
  first.byProduct.augmentation.queries = 999;
  first.spent.queries = 999;
  const second = book.snapshot();
  assert.equal(second.byProduct.augmentation.queries, 5);
  assert.equal(second.spent.queries, 5);
});

test("未登记额度的产品共享研究池，仍受总量约束", () => {
  const book = ledger();
  assert.equal(book.charge("general", amount(10)).granted.queries, 10);
  assert.equal(book.charge("general", amount(10)).granted.queries, 10);
  assert.equal(book.snapshot().byProduct.general.queries, 20);
});

test("默认预留为总额的五分之一", () => {
  const reserve = defaultReviewReserve(amount(100, 1000, 100));
  assert.deepEqual(reserve, { queries: 20, tokens: 200, turns: 20 });
});

test("账本契约拒绝未知产品名，避免无法执行的分账", () => {
  assert.throws(() => budgetLedgerConfigSchema.parse({
    total: amount(10), reviewReserve: amount(2), perProduct: { unknown_product: amount(1) },
  }), /invalid|unknown_product/u);
  const parsed = budgetLedgerConfigSchema.parse({ total: amount(10), reviewReserve: amount(2) });
  assert.equal(parsed.perProduct, undefined);
});
