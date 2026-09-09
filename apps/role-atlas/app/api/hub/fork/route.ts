import { z } from "zod/v4";
import { AccessError, accessErrorResponse, requestActor } from "@/lib/access";
import { forkPublicRelease } from "@/lib/hub/fork";
import { roleAtlasHref } from "@/lib/public-links";
export const runtime = "edge";
const inputSchema = z.object({ releaseId: z.string().min(4).max(220) }).strict();
export async function POST(request: Request) {
  let actor;
  try { actor = await requestActor(request); } catch(error) { return accessErrorResponse(error); }
  try {
    const input = inputSchema.parse(await request.json());
    const fork = await forkPublicRelease({ ...input, ownerSubjectId: actor.subjectId });
    return Response.json({ ...fork, projectUrl: roleAtlasHref(process.env.ROLE_ATLAS_PUBLIC_URL,
      `/projects/${encodeURIComponent(fork.projectId)}?conversation=${encodeURIComponent(fork.conversationId)}`) }, { headers: { "Cache-Control":"private, no-store" } });
  } catch(error) {
    if (error instanceof AccessError) return accessErrorResponse(error);
    const code = error instanceof Error ? error.message : "FORK_FAILED";
    return Response.json({ error: code === "FORK_IN_RECYCLE_BIN" ? "此版本的 Fork 已在回收站，请先恢复项目。" : code === "FORK_RETRY_REQUIRED" ? "正在创建相同副本，请稍后重试。" : "Fork 未完成，请稍后重试；原仓库不会被修改。" }, { status: /RECYCLE|RETRY/.test(code) ? 409 : 400 });
  }
}
