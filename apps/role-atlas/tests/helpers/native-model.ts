import type { ModelInvoker } from "@/lib/agent/model";
/** Translate historical scripted fixtures at the test boundary, never in production. */
export function nativeFixture(base: ModelInvoker): ModelInvoker {
  let index = 0;
  base.chat = async request => {
    let text = "";
    for await (const part of base({ system: request.messages.filter(message => message.role === "system").map(message => message.content).join("\n"), user: request.messages.filter(message => message.role !== "system").map(message => message.content).join("\n"), signal: request.signal })) if (part.type === "text") text += part.delta;
    let value: any;
    try { value = JSON.parse(text); } catch { value = null; }
    const call = value?.action;
    return { message: { role: "assistant", content: call ? null : value && "final" in value ? JSON.stringify(value.final) : text,
      ...(call ? { tool_calls: [{ id: `fixture-${++index}`, type: "function", function: { name: call.tool, arguments: JSON.stringify(call.args || {}) } }] } : {}) },
      finishReason: call ? "tool_calls" : "stop", usage: { inputTokens: 100, outputTokens: 100, estimated: false } };
  };
  return base;
}
