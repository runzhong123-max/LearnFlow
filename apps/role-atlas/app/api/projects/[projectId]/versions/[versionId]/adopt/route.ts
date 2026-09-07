import { z } from "zod/v4";
import { authorizeApiRequest } from "@/lib/access";
import { adoptProjectVersion } from "@/lib/versioning/commit";

export async function POST(request: Request, context: { params: Promise<{ projectId: string; versionId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const { projectId, versionId } = await context.params;
  const parsed = z.object({ expectedHeadVersionId: z.string().nullable(), conversationId: z.string().min(4).max(100).optional() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "请明确提交本次比较的项目版本。" }, { status: 400 });
  try {
    const result = await adoptProjectVersion({ projectId, versionId, ...parsed.data });
    return Response.json(result.adopted ? result : { ...result, code: "ADOPTION_CONFLICT", error: "项目版本已改变，或目标对话仍有运行任务；请刷新后重试。" }, { status: result.adopted ? 200 : 409 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "采用版本失败。" }, { status: 404 });
  }
}
