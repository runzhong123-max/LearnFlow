import { authorizeApiRequest } from "@/lib/access";
import { createSemanticDiff } from "@/lib/versioning/diff";

export const runtime = "edge";

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  try {
    const { projectId } = await context.params;
    const params = new URL(request.url).searchParams;
    const fromVersionId = params.get("from");
    const toVersionId = params.get("to");
    if (!fromVersionId || !toVersionId) return Response.json({ error: "缺少 from 或 to 版本 ID。" }, { status: 400 });
    return Response.json({ diff: await createSemanticDiff({ projectId, fromVersionId, toVersionId }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "版本 Diff 失败。";
    return Response.json({ error: message }, { status: message === "VERSION_NOT_FOUND" ? 404 : 400 });
  }
}
