import { authorizeApiRequest, requestActor } from "@/lib/access";
import { z } from "zod/v4";
import { createProject, listProjects } from "@/lib/projects/repository";
import { projectActor } from "@/lib/projects/lifecycle-api";

export const runtime = "edge";

const createSchema = z.object({
  id: z.string().min(4).max(100),
  conversationId: z.string().min(4).max(100).default(() => crypto.randomUUID()),
  conversationMode: z.enum(["explanation", "iteration"]).default("explanation"),
  title: z.string().min(2).max(120),
  description: z.string().max(8_000).default(""),
  market: z.string().min(1).max(120).default("中国大陆"),
});

export async function GET(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  try {
    const actor = await requestActor(request);
    return Response.json({ projects: await listProjects(actor.subjectId), actorSubjectId: actor.subjectId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "项目列表读取失败。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  try {
    const input = createSchema.parse(await request.json());
    const actor = await projectActor(request);
    if (actor instanceof Response) return actor;
    const created = await createProject({ ...input, ownerSubjectId: actor.subjectId });
    return Response.json(created, { status: 201 });
  } catch (error) {
    const duplicate = error instanceof Error && /UNIQUE|constraint/i.test(error.message);
    return Response.json({ error: duplicate ? "项目已经存在。" : error instanceof Error ? error.message : "项目创建失败。" }, { status: duplicate ? 409 : 400 });
  }
}
