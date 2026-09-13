import { providerChatEndpoint, type ProviderConfig } from "@/lib/providers";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; reasoning_content?: string; tool_calls?: ToolCall[]; tool_call_id?: string };
export type ToolDefinition = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type ChatUsage = { inputTokens: number; outputTokens: number; estimated: boolean };
export type ChatResult = { message: ChatMessage; finishReason: string; usage: ChatUsage };
export type ChatRequest = { messages: ChatMessage[]; tools?: ToolDefinition[]; signal?: AbortSignal; thinking?: "enabled" | "disabled"; maxCompletionTokens?: number; timeoutMs?: number; totalTimeoutMs?: number };
export type ChatInvoker = (request: ChatRequest) => Promise<ChatResult>;

/** Native protocol adapter. Tool arguments are assembled, never executed here. */
export function createChatInvoker(config: ProviderConfig, fetchImpl: typeof fetch = fetch): ChatInvoker {
  return async request => {
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) abort();
    else request.signal?.addEventListener("abort", abort, { once: true });
    let idle: ReturnType<typeof setTimeout>;
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(new Error("模型响应空闲超时")), request.timeoutMs ?? 60_000); };
    const deadline = setTimeout(() => controller.abort(new Error("模型调用超过总时限")), request.totalTimeoutMs ?? 300_000);
    touch();
    const message: ChatMessage = { role: "assistant", content: "" };
    const calls = new Map<number, ToolCall>();
    let finishReason = "", usage: ChatUsage | undefined;
    const accept = (payload: any) => {
      if (payload.error) throw new Error(String(payload.error.message || "Provider error"));
      if (Number.isFinite(payload.usage?.prompt_tokens) && Number.isFinite(payload.usage?.completion_tokens) && payload.usage.prompt_tokens >= 0 && payload.usage.completion_tokens >= 0) usage = { inputTokens: payload.usage.prompt_tokens ?? 0, outputTokens: payload.usage.completion_tokens ?? 0, estimated: false };
      const choice = payload.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const part = choice.delta ?? choice.message ?? {};
      if (typeof part.content === "string") message.content += part.content;
      if (typeof part.reasoning_content === "string") message.reasoning_content = (message.reasoning_content || "") + part.reasoning_content;
      for (const [ordinal, call] of (part.tool_calls || []).entries()) {
        const index = call.index ?? ordinal;
        const current = calls.get(index) || { id: "", type: "function" as const, function: { name: "", arguments: "" } };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.function.name += call.function.name;
        if (call.function?.arguments) current.function.arguments += call.function.arguments;
        calls.set(index, current);
      }
    };
    try {
      const response = await fetchImpl(providerChatEndpoint(config.provider, config.baseUrl), {
        method: "POST", headers: { ...(config.provider === "mimo" ? { "api-key": config.apiKey } : { authorization: `Bearer ${config.apiKey}` }), "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ model: config.model, messages: request.messages, ...(request.tools?.length ? { tools: request.tools } : {}), stream: true, stream_options: { include_usage: true }, thinking: { type: request.thinking ?? (config.thinking ? "enabled" : "disabled") }, ...(config.provider === "deepseek" ? { max_tokens: request.maxCompletionTokens ?? 8192 } : { max_completion_tokens: request.maxCompletionTokens ?? 8192 }) }),
      });
      if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
      if (!response.body) throw new Error("Provider returned an empty response body");
      touch();
      if (!response.headers.get("content-type")?.includes("text/event-stream")) accept(await response.json());
      else {
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = "", received = 0;
        const event = (block: string) => {
          const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n").trim();
          if (data && data !== "[DONE]") accept(JSON.parse(data));
        };
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (value?.length) { touch(); received += value.length; if (received > 16_000_000) { await reader.cancel(); throw new Error("Provider response exceeded 16 MB safety limit"); } }
            buffer += decoder.decode(value, { stream: !done });
            let match: RegExpExecArray | null;
            while ((match = /\r?\n\r?\n/.exec(buffer))) { event(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length); }
            if (done) { if (buffer.trim()) event(buffer); break; }
          }
        } finally { reader.releaseLock(); }
      }
      if (!finishReason) throw new Error("Provider stream ended before finish_reason");
      if (calls.size) {
        message.tool_calls = [...calls.entries()].sort((a,b) => a[0] - b[0]).map(([,call]) => call);
        if (message.tool_calls.some(call => !call.id || !call.function.name)) throw new Error("Incomplete native tool call");
        if (new Set(message.tool_calls.map(call => call.id)).size !== calls.size) throw new Error("Duplicate tool call id");
      }
      return { message, finishReason, usage: usage ?? { inputTokens: JSON.stringify(request.messages).length, outputTokens: JSON.stringify(message).length, estimated: true } };
    } finally { clearTimeout(idle!); clearTimeout(deadline); request.signal?.removeEventListener("abort", abort); }
  };
}
