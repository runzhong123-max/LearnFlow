import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ITERATION_BUDGET, snapshotIterationRequestSchema } from "@/lib/iteration/types";

/**
 * Budget limits used to be literals scattered across the graph, the planner,
 * the brief and two follow-up paths. Making "more budget" reachable must not
 * change what any existing caller gets, so these tests pin both halves: the
 * defaults stay exactly what the literals were, and only the ceilings moved.
 */
test("默认预算与历史字面量逐字一致", () => {
  assert.equal(DEFAULT_ITERATION_BUDGET.maxRounds, 12);
  assert.equal(DEFAULT_ITERATION_BUDGET.sourceLimit, 64);
  assert.equal(DEFAULT_ITERATION_BUDGET.maxWorkItems, 32);
  assert.equal(DEFAULT_ITERATION_BUDGET.queryBudget, 192);
  assert.equal(DEFAULT_ITERATION_BUDGET.stagnantRoundLimit, 2);
});

test("不含新字段的旧请求仍然合法，且解析后不凭空补出字段", () => {
  const parsed = snapshotIterationRequestSchema.parse({
    runId: "budget-compat",
    snapshotRef: { snapshotId: "snapshot:role@2026-08-19" },
    maxRounds: 12,
    sourceLimit: 64,
    maxWorkItems: 32,
  });
  // 旧调用方构造的字面量必须继续编译与通过校验。
  assert.equal(parsed.maxRounds, 12);
  assert.equal(parsed.sourceLimit, 64);
  assert.equal(parsed.maxWorkItems, 32);
  // 新字段保持缺省，由读取点回退到 DEFAULT_ITERATION_BUDGET，而不是在 schema
  // 里补默认值（那会让既有 SnapshotIterationRequest 字面量变成类型错误）。
  assert.equal(parsed.queryBudget, undefined);
  assert.equal(parsed.stagnantRoundLimit, undefined);
  assert.equal(parsed.queryBudget ?? DEFAULT_ITERATION_BUDGET.queryBudget, 192);
});

test("上限已放宽到远超默认：深度研究不该被 schema 拦下", () => {
  const parsed = snapshotIterationRequestSchema.parse({
    runId: "budget-large",
    snapshotRef: { snapshotId: "snapshot:role@2026-08-19" },
    maxRounds: 400,
    sourceLimit: 4_000,
    maxWorkItems: 1_000,
    queryBudget: 20_000,
    stagnantRoundLimit: 64,
  });
  assert.equal(parsed.maxRounds, 400);
  assert.equal(parsed.sourceLimit, 4_000);
  assert.equal(parsed.maxWorkItems, 1_000);
  assert.equal(parsed.queryBudget, 20_000);
  assert.equal(parsed.stagnantRoundLimit, 64);
  // 上限抬高不等于默认抬高：不指定时仍是保守值。
  const defaults = snapshotIterationRequestSchema.parse({
    runId: "budget-defaults",
    snapshotRef: { snapshotId: "snapshot:role@2026-08-19" },
  });
  assert.equal(defaults.maxRounds, DEFAULT_ITERATION_BUDGET.maxRounds);
  assert.equal(defaults.sourceLimit, DEFAULT_ITERATION_BUDGET.sourceLimit);
  assert.equal(defaults.maxWorkItems, DEFAULT_ITERATION_BUDGET.maxWorkItems);
});

test("旧上限仍被接受，放宽不引入新的拒绝面", () => {
  for (const budget of [
    { maxRounds: 1, sourceLimit: 4, maxWorkItems: 3, queryBudget: 8, stagnantRoundLimit: 1 },
    { maxRounds: 12, sourceLimit: 64, maxWorkItems: 32, queryBudget: 192, stagnantRoundLimit: 2 },
  ]) {
    const parsed = snapshotIterationRequestSchema.safeParse({
      runId: "budget-old-bounds",
      snapshotRef: { snapshotId: "snapshot:role@2026-08-19" },
      ...budget,
    });
    assert.equal(parsed.success, true, JSON.stringify(budget));
  }
});

test("超出新上限仍被拒绝，预算始终有硬边界", () => {
  for (const budget of [
    { maxRounds: 401 },
    { sourceLimit: 4_001 },
    { maxWorkItems: 1_001 },
    { queryBudget: 20_001 },
    { stagnantRoundLimit: 65 },
  ]) {
    const parsed = snapshotIterationRequestSchema.safeParse({
      runId: "budget-over-limit",
      snapshotRef: { snapshotId: "snapshot:role@2026-08-19" },
      ...budget,
    });
    assert.equal(parsed.success, false, `${JSON.stringify(budget)} 必须被拒绝`);
  }
});
