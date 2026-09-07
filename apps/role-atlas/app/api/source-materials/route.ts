import { authorizeApiRequest } from "@/lib/access";
import { sourceKindSchema } from "@/lib/build/types";
import { MaterialUrlError, readMaterialUrl } from "@/lib/source-url";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const origin = request.headers.get("origin");
  const allowed = [new URL(request.url).origin, process.env.ROLE_ATLAS_PUBLIC_URL].filter(Boolean);
  if (origin && !allowed.includes(origin)) return Response.json({ error: "不允许跨站读取资料。" }, { status: 403 });
  const startedAt = Date.now();
  try {
    const bodyText = await request.text();
    if (bodyText.length > 4096) throw new MaterialUrlError("URL_REQUEST_INVALID", "URL 请求过大。", 400, "url");
    let body: { url?: unknown; title?: unknown; kind?: unknown };
    try { body = JSON.parse(bodyText); } catch { throw new MaterialUrlError("URL_REQUEST_INVALID", "URL 请求格式无效。", 400, "url"); }
    if (!body || typeof body.url !== "string") throw new MaterialUrlError("URL_REQUEST_INVALID", "请输入 URL。", 400, "url");
    const kind = sourceKindSchema.safeParse(body.kind);
    if (!kind.success) throw new MaterialUrlError("URL_REQUEST_INVALID", "请选择有效的资料类型。", 400, "url");
    const source = await readMaterialUrl(body.url, typeof body.title === "string" ? body.title : "", kind.data, request.signal);
    return Response.json({ source, elapsedMs: Date.now() - startedAt }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const known = error instanceof MaterialUrlError;
    return Response.json({
      error: known ? error.message : "读取失败，请检查公开 HTTPS 链接，或改用附件、文本。",
      code: known ? error.code : "URL_READ_FAILED",
      stage: known ? error.stage : "content",
      ...(known && error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}),
      elapsedMs: Date.now() - startedAt,
    }, { status: known ? error.status : 400, headers: { "Cache-Control": "private, no-store" } });
  }
}
