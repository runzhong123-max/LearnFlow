import { createChatInvoker, type ChatInvoker } from "./native-model";
import { validateProviderConfig } from "@/lib/provider-validation";
import { providerChatEndpoint, type ProviderConfig } from "@/lib/providers";

export type ModelStreamPart = {
  type: "reasoning" | "text";
  delta: string;
};

export type ModelInvoker = { (input: {
  system: string;
  user: string;
  signal?: AbortSignal;
  thinking?: "enabled" | "disabled";
  maxCompletionTokens?: number;
  /** Idle timeout. Streaming activity refreshes this deadline. */
  timeoutMs?: number;
  /** Hard wall-clock deadline. Streaming activity never refreshes it. */
  totalTimeoutMs?: number;
}): AsyncIterable<ModelStreamPart>; chat?: ChatInvoker };

type FetchLike = typeof fetch;

type ChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      reasoning_content?: unknown;
      content?: unknown;
    };
    message?: {
      reasoning_content?: unknown;
      content?: unknown;
    };
  }>;
};

function partsFromPayload(payload: ChatCompletionChunk): ModelStreamPart[] {
  const choice = payload.choices?.[0];
  const message = choice?.delta ?? choice?.message;
  if (!message) return [];
  const parts: ModelStreamPart[] = [];
  if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    parts.push({ type: "reasoning", delta: message.reasoning_content });
  }
  if (typeof message.content === "string" && message.content) {
    parts.push({ type: "text", delta: message.content });
  }
  return parts;
}

function parseSseEvent(block: string): { done: boolean; parts: ModelStreamPart[] } {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data) return { done: false, parts: [] };
  if (data === "[DONE]") return { done: true, parts: [] };
  try {
    return { done: false, parts: partsFromPayload(JSON.parse(data) as ChatCompletionChunk) };
  } catch {
    throw new Error("Provider returned an invalid SSE event");
  }
}

export async function* parseOpenAICompatibleStream(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<ModelStreamPart> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value?.byteLength) onActivity?.();
      buffer += decoder.decode(value, { stream: !done });
      let separator = buffer.search(/\r?\n\r?\n/);
      while (separator >= 0) {
        const block = buffer.slice(0, separator);
        const separatorLength = buffer.slice(separator).startsWith("\r\n\r\n") ? 4 : 2;
        buffer = buffer.slice(separator + separatorLength);
        const event = parseSseEvent(block);
        for (const part of event.parts) yield part;
        if (event.done) return;
        separator = buffer.search(/\r?\n\r?\n/);
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const event = parseSseEvent(buffer);
      for (const part of event.parts) yield part;
    }
  } finally {
    reader.releaseLock();
  }
}

function requestSignal(upstream?: AbortSignal, timeoutMs = 60_000, totalTimeoutMs?: number) {
  const controller = new AbortController();
  let timeoutKind: "idle" | "total" | null = null;
  let idleTimeout: ReturnType<typeof setTimeout> | undefined;
  const totalTimeout = totalTimeoutMs ? setTimeout(() => {
    timeoutKind = "total";
    controller.abort();
  }, totalTimeoutMs) : undefined;
  const onAbort = () => controller.abort(upstream?.reason);
  if (upstream?.aborted) onAbort();
  else upstream?.addEventListener("abort", onAbort, { once: true });
  const touch = () => {
    if (idleTimeout) clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => {
      timeoutKind = "idle";
      controller.abort();
    }, timeoutMs);
  };
  touch();
  return {
    signal: controller.signal,
    timeoutKind: () => timeoutKind,
    touch,
    cleanup() {
      if (idleTimeout) clearTimeout(idleTimeout);
      if (totalTimeout) clearTimeout(totalTimeout);
      upstream?.removeEventListener("abort", onAbort);
    },
  };
}

export function createModelInvoker(input: ProviderConfig, fetchImpl: FetchLike = fetch): ModelInvoker {
  const config = validateProviderConfig(input);

  const invoke: ModelInvoker = async function* ({ system, user, signal, thinking = "enabled", maxCompletionTokens, timeoutMs, totalTimeoutMs }) {
    const scopedSignal = requestSignal(signal, timeoutMs, totalTimeoutMs);
    try {
      const body: Record<string, unknown> = {
        model: config.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        thinking: { type: thinking },
        stream: true,
      };
      if (maxCompletionTokens) body.max_completion_tokens = maxCompletionTokens;
      if (config.provider === "deepseek") body.reasoning_effort = "high";

      const response = await fetchImpl(providerChatEndpoint(config.provider, config.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: scopedSignal.signal,
      });
      if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
      if (!response.body) throw new Error("Provider returned an empty response body");
      scopedSignal.touch();

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        for await (const part of parseOpenAICompatibleStream(response.body, scopedSignal.touch)) {
          yield part;
        }
        return;
      }

      const payload = await response.json() as ChatCompletionChunk;
      scopedSignal.touch();
      for (const part of partsFromPayload(payload)) yield part;
    } catch (error) {
      if (scopedSignal.timeoutKind() === "total") throw new Error("Provider request exceeded total time limit");
      if (scopedSignal.timeoutKind() === "idle") throw new Error("Provider response became idle and timed out");
      throw error;
    } finally {
      scopedSignal.cleanup();
    }
  };
  invoke.chat = createChatInvoker(config, fetchImpl);
  return invoke;
}
