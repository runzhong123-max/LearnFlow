import { authorizeApiRequest } from "@/lib/access";
import { SEARCH_PROVIDERS } from "@/lib/search/providers";
import { testSearchProvider } from "@/lib/search/web-research";
import { resolveSearchProviderConfig } from "@/lib/server-runtime-config";

export const runtime = "edge";

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "SEARCH_FAILED";
  if (/401|403/.test(message)) return "API Key 无效或无权调用搜索服务。";
  if (/429/.test(message)) return "搜索厂商正在限流，请稍后再试。";
  if (/abort/i.test(message)) return "连接测试超时。";
  if (/SERVER_SEARCH_NOT_CONFIGURED/.test(message)) return "服务端 .env.local 尚未配置联网搜索 API Key。";
  return "搜索服务连接失败。";
}

export async function POST(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  try {
    const body = await request.json() as { config?: unknown };
    const config = resolveSearchProviderConfig(body.config);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await testSearchProvider(config, controller.signal);
      return Response.json({
        ok: result.resultCount > 0,
        message: result.resultCount > 0
          ? `${SEARCH_PROVIDERS[config.provider].name} 已连接，返回 ${result.resultCount} 条测试结果`
          : "连接成功，但测试查询没有返回结果。",
        ...result,
      }, { status: result.resultCount > 0 ? 200 : 400 });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return Response.json({ ok: false, message: safeError(error) }, { status: 400 });
  }
}
