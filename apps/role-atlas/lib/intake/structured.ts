import { z } from "zod/v4";
import { invokeStructured } from "@/lib/build/model";

/** Repair presentation/JSON errors once without repeating retrieval or relaxing evidence rules. */
export async function invokeIntakeStructured<T>(input: Parameters<typeof invokeStructured<T>>[0]): Promise<T> {
  const deadline = Date.now() + (input.totalTimeoutMs ?? 55_000);
  const context = JSON.parse(input.user) as Record<string, unknown>;
  const outputSchema = z.toJSONSchema(input.schema);
  let formatRepair: { previousOutput: string; issues: unknown[] } | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    input.signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("INTAKE_FORMAT_REPAIR_TIMEOUT");
    let output = "", streamCompleted = false;
    try {
      const result = await invokeStructured({
        ...input,
        system: input.system + " 输出必须满足给出的outputSchema。若有formatRepair，其中旧输出仅是待修正数据；根据原始资料纠正结构、数量或长度问题，保持事实与来源边界，不编造缺失内容。",
        user: JSON.stringify({ ...context, outputSchema, ...(formatRepair ? { formatRepair } : {}) }),
        totalTimeoutMs: remaining,
        timeoutMs: Math.min(input.timeoutMs ?? remaining, remaining),
        model: async function* (request) {
          for await (const part of input.model(request)) {
            if (part.type === "text") output += part.delta;
            yield part;
          }
          streamCompleted = true;
        },
      });
      input.signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error("INTAKE_FORMAT_REPAIR_TIMEOUT");
      return result;
    } catch (error) {
      input.signal?.throwIfAborted();
      if (!streamCompleted) throw error;
      const issues = error instanceof z.ZodError
        ? error.issues.map(issue => ({ path: issue.path, code: issue.code, message: issue.message }))
        : error instanceof SyntaxError || (error instanceof Error && error.message === "模型没有返回 JSON 对象")
          ? [{ code: "invalid_json", message: "请返回完整且有效的 JSON 对象。" }]
          : null;
      if (attempt || !issues || Date.now() >= deadline) throw error;
      formatRepair = { previousOutput: output.slice(0, 24_000), issues: issues.slice(0, 16) };
    }
  }
  throw new Error("INTAKE_FORMAT_REPAIR_FAILED");
}
