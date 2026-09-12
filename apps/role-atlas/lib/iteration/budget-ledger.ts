import { z } from "zod";

/**
 * Layered budget ledger for agent research.
 *
 * "Give it a bigger budget" only helps if the ledger is hard. This module is
 * the arithmetic that makes it hard: the model may spend a budget, but it may
 * never compute one, move one, or spend the share reserved for review.
 *
 * Three rules, each enforced here rather than by convention:
 *
 *   1. The reserve is untouchable. Verification is the foundation of every
 *      claim downstream, so the review share can never be consumed by research
 *      — a study that spends its whole budget leaves review budget intact.
 *   2. Over-spend truncates, it never throws and never silently succeeds. A
 *      caller receives the amount actually granted plus the reason it was cut,
 *      so a partial study is reported as partial.
 *   3. Per-product caps bind independently of the total, so one product cannot
 *      starve the others simply by asking first.
 */

export const budgetAmountSchema = z.object({
  queries: z.number().int().min(0).max(20_000).default(0),
  tokens: z.number().int().min(0).max(20_000_000).default(0),
  turns: z.number().int().min(0).max(1_000_000).default(0),
});
export type BudgetAmount = z.infer<typeof budgetAmountSchema>;

/**
 * Products are named, not free-form: a ledger that accepts any label cannot
 * enforce a per-product cap.
 */
export const budgetProductSchema = z.enum([
  "risk_package",
  "deepening_radar",
  "augmentation",
  "learning_mount",
  "evidence_review",
  "general",
]);
export type BudgetProduct = z.infer<typeof budgetProductSchema>;

export const budgetLedgerConfigSchema = z.object({
  total: budgetAmountSchema,
  /**
   * Withheld from every research product and released only to `evidence_review`.
   * A ratio is expressed by the caller as an absolute amount so the ledger needs
   * no floating-point policy of its own.
   */
  reviewReserve: budgetAmountSchema,
  /**
   * Optional: products without an entry share the research pool under the total
   * ceiling. `partialRecord` (not `record`) because a full enum record would
   * demand every product key, which is not what a caller configuring one cap
   * means.
   */
  perProduct: z.partialRecord(budgetProductSchema, budgetAmountSchema).optional(),
});
export type BudgetLedgerConfig = z.infer<typeof budgetLedgerConfigSchema>;

export type BudgetChargeResult = {
  granted: BudgetAmount;
  truncated: boolean;
  reason?: string;
};

export type BudgetLedgerSnapshot = {
  spent: BudgetAmount;
  reserveSpent: BudgetAmount;
  byProduct: Record<string, BudgetAmount>;
  remainingResearch: BudgetAmount;
  remainingReserve: BudgetAmount;
};

const ZERO: BudgetAmount = { queries: 0, tokens: 0, turns: 0 };
const FIELDS = ["queries", "tokens", "turns"] as const;

function add(left: BudgetAmount, right: Partial<BudgetAmount>): BudgetAmount {
  return {
    queries: left.queries + (right.queries || 0),
    tokens: left.tokens + (right.tokens || 0),
    turns: left.turns + (right.turns || 0),
  };
}

function subtract(left: BudgetAmount, right: BudgetAmount): BudgetAmount {
  return {
    queries: Math.max(0, left.queries - right.queries),
    tokens: Math.max(0, left.tokens - right.tokens),
    turns: Math.max(0, left.turns - right.turns),
  };
}

function minAmount(left: BudgetAmount, right: BudgetAmount): BudgetAmount {
  return {
    queries: Math.min(left.queries, right.queries),
    tokens: Math.min(left.tokens, right.tokens),
    turns: Math.min(left.turns, right.turns),
  };
}

export function createBudgetLedger(config: BudgetLedgerConfig, restored?: BudgetLedgerSnapshot) {
  const parsed = budgetLedgerConfigSchema.parse(config);
  const perProduct: Partial<Record<BudgetProduct, BudgetAmount>> = parsed.perProduct || {};
  // The reserve is subtracted from the research ceiling once, at construction;
  // it is not "available until needed", it is never available to research.
  const researchCeiling = subtract(parsed.total, parsed.reviewReserve);
  let researchSpent: BudgetAmount = { ...ZERO, ...restored?.spent };
  let reserveSpent: BudgetAmount = { ...ZERO, ...restored?.reserveSpent };
  const byProduct: Record<string, BudgetAmount> = structuredClone(restored?.byProduct || {});

  const spentFor = (product: BudgetProduct) => byProduct[product] || { ...ZERO };

  /**
   * Request budget for one product. Returns what was actually granted.
   *
   * `evidence_review` draws on the reserve instead of the research pool, and no
   * other product can draw on the reserve at all.
   */
  const charge = (product: BudgetProduct, requested: Partial<BudgetAmount>): BudgetChargeResult => {
    const want = budgetAmountSchema.parse(add(ZERO, requested));
    const fromReserve = product === "evidence_review";
    const pool = fromReserve ? parsed.reviewReserve : researchCeiling;
    const spentInPool = fromReserve ? reserveSpent : researchSpent;
    const poolRemaining = subtract(pool, spentInPool);
    const productCap = fromReserve ? undefined : perProduct[product];
    const productRemaining = productCap ? subtract(productCap, spentFor(product)) : undefined;

    const available = productRemaining ? minAmount(poolRemaining, productRemaining) : poolRemaining;
    const granted = minAmount(want, available);
    const truncated = FIELDS.some(field => granted[field] < want[field]);

    if (fromReserve) reserveSpent = add(reserveSpent, granted);
    else researchSpent = add(researchSpent, granted);
    byProduct[product] = add(spentFor(product), granted);

    if (!truncated) return { granted, truncated: false };
    // Report which ceiling actually bound, so a partial study explains itself.
    const boundByProduct = Boolean(productRemaining) && FIELDS.some(field =>
      productRemaining![field] < want[field] && productRemaining![field] <= poolRemaining[field]);
    const reason = fromReserve
      ? "复核预留额度不足，已按剩余量截断"
      : boundByProduct
        ? `${product} 已达到自身额度上限，已按剩余量截断`
        : "研究总预算不足，已按剩余量截断";
    return { granted, truncated, reason };
  };

  const snapshot = (): BudgetLedgerSnapshot => ({
    spent: { ...researchSpent },
    reserveSpent: { ...reserveSpent },
    byProduct: Object.fromEntries(Object.entries(byProduct).map(([key, value]) => [key, { ...value }])),
    remainingResearch: subtract(researchCeiling, researchSpent),
    remainingReserve: subtract(parsed.reviewReserve, reserveSpent),
  });

  const reserve = (product: BudgetProduct, requested: Partial<BudgetAmount>) => {
    const result = charge(product, requested);
    let settled = false;
    const settle = (actual: Partial<BudgetAmount>) => {
      if (settled) return;
      settled = true;
      const used = budgetAmountSchema.parse(add(ZERO, actual));
      const refund = subtract(result.granted, used);
      if (product === "evidence_review") reserveSpent = subtract(reserveSpent, refund);
      else researchSpent = subtract(researchSpent, refund);
      byProduct[product] = subtract(spentFor(product), refund);
      // Unexpected provider excess is recorded as debt, never silently lost.
      const excess = subtract(used, result.granted);
      if (product === "evidence_review") reserveSpent = add(reserveSpent, excess);
      else researchSpent = add(researchSpent, excess);
      byProduct[product] = add(spentFor(product), excess);
    };
    return { ...result, settle };
  };
  const restore = (value: BudgetLedgerSnapshot) => {
    researchSpent = budgetAmountSchema.parse(value.spent);
    reserveSpent = budgetAmountSchema.parse(value.reserveSpent);
    Object.keys(byProduct).forEach(key => delete byProduct[key]);
    Object.assign(byProduct, structuredClone(value.byProduct));
  };
  return { charge, reserve, snapshot, restore };
}

export type BudgetLedger = ReturnType<typeof createBudgetLedger>;

/** Default split: withhold a fifth of the query budget for evidence review. */
export function defaultReviewReserve(total: BudgetAmount): BudgetAmount {
  return {
    queries: 0,
    tokens: Math.ceil(total.tokens * 0.2),
    turns: Math.ceil(total.turns * 0.2),
  };
}
