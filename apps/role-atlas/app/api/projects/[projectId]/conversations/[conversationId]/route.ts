import { z } from "zod/v4";
import { authorizeApiRequest } from "@/lib/access";
import { getConversation, setConversationMode } from "@/lib/projects/repository";
export async function PATCH(request: Request, context: { params: Promise<{ projectId: string; conversationId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const input = z.object({ mode: z.enum(["explanation", "iteration"]) }).safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: "INVALID_CONVERSATION_MODE" }, { status: 400 });
  const { projectId, conversationId } = await context.params;
  if (!await setConversationMode({ projectId, conversationId, mode: input.data.mode })) return Response.json({ error: "CONVERSATION_JOB_ACTIVE" }, { status: 409 });
  return Response.json({ conversation: (await getConversation(conversationId))?.conversation }, { headers: { "Cache-Control": "private, no-store" } });
}
