import { authorizeApiRequest } from "@/lib/access";
import { z } from "zod/v4";
import { createConversation } from "@/lib/projects/repository";

export const runtime = "edge";

const schema = z.object({
  id: z.string().min(4).max(100),
  title: z.string().min(1).max(120).default("新对话"),
  mode: z.enum(["explanation", "iteration"]).default("explanation"),
  pinToActive: z.boolean().default(true),
});

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  try {
    const [{ projectId }, input] = await Promise.all([context.params, request.json().then((body) => schema.parse(body))]);
    const conversation = await createConversation({ ...input, projectId });
    if (!conversation) return Response.json({ error: "项目不存在。" }, { status: 404 });
    return Response.json({ conversation }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "新建对话失败。" }, { status: 400 });
  }
}
