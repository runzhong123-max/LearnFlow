import { authorizeApiRequest } from "@/lib/access";
import { conversationExists, listMessages } from "@/lib/projects/repository";

export const runtime = "edge";

export async function GET(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  try {
    const { conversationId } = await context.params;
    if (!await conversationExists(conversationId)) return Response.json({ error: "会话不存在。" }, { status: 404 });
    return Response.json({ messages: await listMessages(conversationId) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "会话消息读取失败。" }, { status: 500 });
  }
}
