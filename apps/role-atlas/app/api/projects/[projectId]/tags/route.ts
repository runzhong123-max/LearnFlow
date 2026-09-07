import { authorizeApiRequest } from "@/lib/access";
import { z } from "zod/v4";
import { createProjectTag, deleteProjectTag, listProjectTags } from "@/lib/versioning/tags";

export const runtime = "edge";

const createSchema = z.object({
  name: z.string().min(1).max(80),
  targetVersionId: z.string().min(4).max(220),
  description: z.string().max(500).optional(),
});

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const { projectId } = await context.params;
  return Response.json({ tags: await listProjectTags(projectId) });
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  try {
    const { projectId } = await context.params;
    const input = createSchema.parse(await request.json());
    return Response.json({ tag: await createProjectTag({ projectId, ...input }) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tag 创建失败。";
    const status = /UNIQUE|constraint/u.test(message) ? 409 : message === "VERSION_NOT_FOUND" ? 404 : 400;
    return Response.json({ error: message }, { status });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const { projectId } = await context.params;
  const tagId = new URL(request.url).searchParams.get("tagId");
  if (!tagId) return Response.json({ error: "缺少 tagId。" }, { status: 400 });
  const deleted = await deleteProjectTag({ projectId, tagId });
  return Response.json({ deleted }, { status: deleted ? 200 : 404 });
}
