import type { ModelInvoker } from "@/lib/agent/model";
import type { BudgetLedger, BudgetProduct } from "@/lib/iteration/budget-ledger";
/** Every caller uses the same run ledger, including planning and synthesis. */
export function meteredModel(base: ModelInvoker, ledger: BudgetLedger, product: BudgetProduct = "general", persist?: () => Promise<void>): ModelInvoker {
  const reserve = (inputSize: number, output: number) => {
    const ticket = ledger.reserve(product, { tokens: inputSize + output, turns: 1 });
    if (ticket.granted.turns < 1 || ticket.granted.tokens <= inputSize) { ticket.settle({}); throw new Error("RESEARCH_BUDGET_EXHAUSTED"); }
    return { ticket, output: Math.min(output, ticket.granted.tokens - inputSize) };
  };
  const invoke: ModelInvoker = async function* (request) {
    const inputSize = request.system.length + request.user.length;
    const { ticket, output } = reserve(inputSize, request.maxCompletionTokens ?? 8192);
    await persist?.();
    let outputSize = 0, completed = false;
    try {
      for await (const part of base({ ...request, maxCompletionTokens: output })) { outputSize += part.delta.length; yield part; }
      completed = true;
    } finally { if (completed) ticket.settle({ tokens: inputSize + outputSize, turns: 1 }); await persist?.(); }
  };
  if (base.chat) invoke.chat = async request => {
    const inputSize = JSON.stringify({ messages: request.messages, tools: request.tools }).length;
    const { ticket, output } = reserve(inputSize, request.maxCompletionTokens ?? 8192);
    await persist?.();
    // Failed/uncertain calls retain their reservation: retries cannot spend it twice.
    const result = await base.chat!({ ...request, maxCompletionTokens: output });
    ticket.settle({ tokens: result.usage.inputTokens + result.usage.outputTokens, turns: 1 });
    await persist?.();
    return result;
  };
  return invoke;
}
