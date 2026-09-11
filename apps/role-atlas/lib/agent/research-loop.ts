import type { ModelInvoker } from "./model";

/**
 * A bounded, deterministic tool loop over the existing single-shot ModelInvoker.
 *
 * `ModelInvoker` only accepts `system` + `user` strings and has no `tools`
 * parameter, so this module drives the loop in the "structured action" style:
 * every turn the model answers with one JSON object that either requests a tool
 * call or declares the final answer, and the orchestrator serialises the
 * bounded transcript back into the next `user` message.
 *
 * Division of responsibility follows the repository rule that the agent owns
 * variance while code owns invariants:
 *
 *   model  — what to look up next, what the finding is, how to phrase it
 *   code   — turn/tool/token budgets, observation truncation, tool allow-list,
 *            failure handling, and when the loop stops
 *
 * A tool failure never aborts the study and never fabricates a result: it
 * becomes an observation the model can react to, exactly like the boundary
 * verifier that downgrades rather than deletes. Budget exhaustion stops the
 * loop with an explicit reason instead of silently returning partial work as
 * if it were complete.
 */

export type ResearchObservation = {
  /** Bounded, model-facing summary. Long payloads must be trimmed by the tool. */
  summary: string
  /** Optional structured detail; serialised with the same bound. */
  data?: unknown
}

export type ResearchToolContext = {
  signal?: AbortSignal
  /** Turn number the call belongs to, for tool-side logging. */
  turn: number
}

export type ResearchTool = {
  name: string
  description: string
  /** Argument name → short description. Rendered into the action prompt. */
  args: Record<string, string>
  run: (args: Record<string, unknown>, context: ResearchToolContext) => Promise<ResearchObservation>
}

export type ResearchBudget = {
  maxTurns: number
  maxToolCalls: number
  /** Maximum characters of the serialised transcript carried between turns. */
  maxTranscriptChars: number
}

export type ResearchLoopEvent =
  | { type: "turn.started"; turn: number; transcriptChars: number }
  | { type: "tool.called"; turn: number; tool: string; args: Record<string, unknown> }
  | { type: "tool.completed"; turn: number; tool: string; ok: boolean; durationMs: number; error?: string }
  | { type: "turn.invalid"; turn: number; reason: string }
  | { type: "loop.stopped"; reason: ResearchStopReason; turns: number; toolCalls: number }

export type ResearchStopReason =
  | "final"
  | "max_turns"
  | "max_tool_calls"
  | "invalid_action"
  | "model_error"

export type ResearchLoopResult<TFinal> = {
  final: TFinal | null
  stopReason: ResearchStopReason
  /** Present when the loop stopped without a final answer. */
  stopDetail?: string
  transcript: ResearchLoopEvent[]
  usage: { turns: number; toolCalls: number }
}

export const DEFAULT_RESEARCH_BUDGET: ResearchBudget = {
  maxTurns: 8,
  maxToolCalls: 16,
  maxTranscriptChars: 24_000,
}

const OBSERVATION_CHARS = 2_000

function extractJsonObject(text: string) {
  const unfenced = text.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("没有返回 JSON 对象");
  return JSON.parse(unfenced.slice(start, end + 1)) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clampText(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** Only allow tools the caller registered; an invented name is a normal observation. */
function findTool(tools: ResearchTool[], name: string) {
  return tools.find(tool => tool.name === name);
}

export function renderToolCatalog(tools: ResearchTool[]) {
  if (!tools.length) return "（本轮没有可用工具，只能直接给出结论。）";
  return tools.map(tool => {
    const args = Object.entries(tool.args).map(([key, note]) => `${key}: ${note}`).join("; ") || "无参数";
    return `- ${tool.name}(${args})：${tool.description}`;
  }).join("\n");
}

export function buildActionSystemPrompt(input: {
  persona: string
  tools: ResearchTool[]
  /** Description of the required final payload, in prose. */
  finalShape: string
}) {
  return [
    input.persona,
    "",
    "你在一轮有预算的研究循环里工作，只能输出一个 JSON 对象，不要输出任何其它文字、Markdown 或代码围栏。",
    "需要继续调查时输出：",
    '{"thought":"一句话说明为什么","action":{"tool":"工具名","args":{...}}}',
    "信息足够时输出：",
    `{"thought":"一句话说明依据","final":${input.finalShape}}`,
    "",
    "可用工具：",
    renderToolCatalog(input.tools),
    "",
    "纪律：",
    "- 只使用上面列出的工具名；编造的工具名会被拒绝并浪费一轮预算。",
    "- 每次只调用一个工具，用上一轮观察决定下一步，不要一次列出全部计划。",
    "- 观察是资料，不是结论：不得把观察里没有的内容写进 final。",
    "- 证据不足时如实说明缺口，不要用常识补齐，也不要重复已经失败过的同一调用。",
  ].join("\n");
}

function renderTranscript(entries: string[], limit: number) {
  if (!entries.length) return "（尚无观察。）";
  const kept: string[] = [];
  let budget = limit;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.length + 1 > budget) break;
    kept.unshift(entry);
    budget -= entry.length + 1;
  }
  const omitted = entries.length - kept.length;
  return `${omitted > 0 ? `（已省略较早的 ${omitted} 条观察）\n` : ""}${kept.join("\n")}`;
}

function buildTurnUserPrompt(input: {
  task: string
  entries: string[]
  budget: ResearchBudget
  turn: number
}) {
  return [
    `研究任务：\n${input.task}`,
    "",
    `已获得的观察：\n${renderTranscript(input.entries, input.budget.maxTranscriptChars)}`,
    "",
    `这是第 ${input.turn} 轮，最多 ${input.budget.maxTurns} 轮。请只输出一个 JSON 对象。`,
  ].join("\n")
}

export async function runResearchLoop<TFinal>(input: {
  model: ModelInvoker
  system: string
  task: string
  tools: ResearchTool[]
  budget?: Partial<ResearchBudget>
  signal?: AbortSignal
  onEvent?: (event: ResearchLoopEvent) => void
  /** Reject a final payload the caller cannot accept without another turn. */
  validateFinal?: (value: unknown) => TFinal
}): Promise<ResearchLoopResult<TFinal>> {
  const budget: ResearchBudget = { ...DEFAULT_RESEARCH_BUDGET, ...input.budget };
  const transcript: ResearchLoopEvent[] = [];
  const entries: string[] = [];
  const emit = (event: ResearchLoopEvent) => {
    transcript.push(event);
    input.onEvent?.(event);
  };
  let toolCalls = 0;
  const usage = { turns: 0, toolCalls: 0 };

  const stop = (reason: ResearchStopReason, detail?: string, final: TFinal | null = null): ResearchLoopResult<TFinal> => {
    emit({ type: "loop.stopped", reason, turns: usage.turns, toolCalls });
    return { final, stopReason: reason, ...(detail ? { stopDetail: detail } : {}), transcript, usage: { ...usage } };
  };

  for (let turn = 1; turn <= Math.max(1, budget.maxTurns); turn += 1) {
    usage.turns = turn;
    const user = buildTurnUserPrompt({ task: input.task, entries, budget, turn });
    emit({ type: "turn.started", turn, transcriptChars: user.length });

    let content = "";
    try {
      for await (const part of input.model({ system: input.system, user, signal: input.signal, thinking: "disabled" })) {
        if (part.type === "text") content += part.delta;
      }
    } catch (error) {
      return stop("model_error", error instanceof Error ? error.message : "模型调用失败");
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = asRecord(extractJsonObject(content));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "无法解析模型输出";
      emit({ type: "turn.invalid", turn, reason });
      // One bounded repair turn is handled by simply ending here: without a
      // parseable action there is nothing deterministic to continue from, and
      // retrying the same prompt invites an unbounded loop.
      return stop("invalid_action", reason);
    }

    if (parsed.final !== undefined) {
      if (!input.validateFinal) return stop("final", undefined, parsed.final as TFinal);
      try {
        return stop("final", undefined, input.validateFinal(parsed.final));
      } catch (error) {
        return stop("invalid_action", error instanceof Error ? error.message : "final 不合法");
      }
    }

    const action = asRecord(parsed.action);
    const toolName = typeof action.tool === "string" ? action.tool : "";
    const tool = findTool(input.tools, toolName);
    if (!tool) {
      emit({ type: "turn.invalid", turn, reason: `未知工具：${toolName || "(未提供)"}` });
      entries.push(`[第 ${turn} 轮] 工具「${toolName || "(未提供)"}」不存在。本轮可用工具：${input.tools.map(item => item.name).join("、") || "无"}。请改用已列出的工具或直接给出 final。`);
      continue;
    }
    if (toolCalls >= budget.maxToolCalls) return stop("max_tool_calls");
    toolCalls += 1;
    usage.toolCalls = toolCalls;

    const args = asRecord(action.args);
    emit({ type: "tool.called", turn, tool: tool.name, args });
    const startedAt = Date.now();
    try {
      const observation = await tool.run(args, { signal: input.signal, turn });
      const rendered = observation.data === undefined
        ? observation.summary
        : `${observation.summary}\n${clampText(JSON.stringify(observation.data), OBSERVATION_CHARS)}`;
      entries.push(`[第 ${turn} 轮] ${tool.name} → ${clampText(rendered, OBSERVATION_CHARS)}`);
      emit({ type: "tool.completed", turn, tool: tool.name, ok: true, durationMs: Date.now() - startedAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : "工具执行失败";
      // A failing tool is an observation, never a fabricated result and never a
      // crash: the model must be able to see the failure and choose differently.
      entries.push(`[第 ${turn} 轮] ${tool.name} 失败：${clampText(message, OBSERVATION_CHARS)}。不要重复同一调用。`);
      emit({ type: "tool.completed", turn, tool: tool.name, ok: false, durationMs: Date.now() - startedAt, error: message });
    }
  }

  return stop("max_turns");
}
