import { authorizeApiRequest } from "@/lib/access";
import { providerModelsEndpoint, PROVIDERS } from "@/lib/providers";
import { resolveProviderConfig } from "@/lib/server-runtime-config";

export const runtime = "edge";

function safeProviderError(status: number) {
  if (status === 401 || status === 403) return "API Key 无效或无权访问该模型。";
  if (status === 429) return "供应商限流，请稍后重试。";
  if (status >= 500) return "供应商服务暂时不可用。";
  return `供应商返回 HTTP ${status}。`;
}

export async function POST(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 16_384) {
    return Response.json({ ok: false, message: "请求体过大。" }, { status: 413 });
  }

  try {
    const body = await request.json() as { config?: unknown };
    const config = resolveProviderConfig(body.config);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);

    let response: Response;
    try {
      response = await fetch(providerModelsEndpoint(config.provider), {
        method: "GET",
        headers: { authorization: `Bearer ${config.apiKey}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return Response.json({ ok: false, message: safeProviderError(response.status) }, { status: 400 });
    }

    const payload = await response.json() as { data?: Array<{ id?: string }> };
    const modelIds = (payload.data || []).map((item) => item.id).filter((id): id is string => Boolean(id));
    const modelAvailable = modelIds.length === 0 || modelIds.includes(config.model);
    const provider = PROVIDERS[config.provider];

    return Response.json({
      ok: modelAvailable,
      provider: config.provider,
      model: config.model,
      latencyMs: Date.now() - startedAt,
      message: modelAvailable ? `${provider.name} 已连接，模型可用` : "连接成功，但账号当前模型列表中没有所选模型。",
    }, { status: modelAvailable ? 200 : 400 });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "连接超时，请检查网络或稍后重试。"
      : error instanceof Error && error.message === "MODEL_NOT_ALLOWED"
        ? "所选模型不在允许列表中。"
        : error instanceof Error && error.message === "SERVER_MODEL_NOT_CONFIGURED"
          ? "服务端 .env.local 尚未配置模型 API Key。"
        : "配置格式无效或连接失败。";
    return Response.json({ ok: false, message }, { status: 400 });
  }
}
