import { authorizeApiRequest } from "@/lib/access";
import { sourceKindSchema } from "@/lib/build/types";
import { readMaterialUrl } from "@/lib/source-url";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const origin = request.headers.get("origin");
  const allowed = [new URL(request.url).origin, process.env.ROLE_ATLAS_PUBLIC_URL].filter(Boolean);
  if (origin && !allowed.includes(origin)) return Response.json({ error: "不允许跨站读取资料。" }, { status: 403 });
  try {
    const bodyText = await request.text();
    if (bodyText.length > 4096) throw new Error("URL 请求过大。");
    const body = JSON.parse(bodyText);
    if (typeof body.url !== "string") throw new Error("请输入 URL。");
    const source = await readMaterialUrl(body.url, typeof body.title === "string" ? body.title : "", sourceKindSchema.parse(body.kind), AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]));
    return Response.json({ source }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error && /[\u4e00-\u9fff]/.test(error.message) ? error.message : "读取失败，请检查公开 HTTPS 链接，或改用附件、文本。" }, { status: 400 });
  }
}
