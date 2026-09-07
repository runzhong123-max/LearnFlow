import { authorizeApiRequest } from "@/lib/access";
import { z } from "zod/v4";
import { listProjectVersions, restoreProjectVersion } from "@/lib/versioning/commit";

export const runtime = "edge";

const restoreSchema = z.object({
  action: z.literal("restore"),
  targetVersionId: z.string().min(4).max(220),
  message: z.string().max(240).optional(),
});

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  try {
    const { projectId } = await context.params;
    const versions = await listProjectVersions(projectId);
    return Response.json({ versions: versions.map((version) => {
      const summary: Partial<typeof version> = { ...version };
      delete summary.result;
      return summary;
    }) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "版本列表读取失败。" }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  try {
    const { projectId } = await context.params;
    const input = restoreSchema.parse(await request.json());
    const version = await restoreProjectVersion({ projectId, targetVersionId: input.targetVersionId, message: input.message });
    return Response.json({ version }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "历史版本恢复失败。";
    return Response.json({ error: message }, { status: message === "VERSION_NOT_FOUND" ? 404 : 400 });
  }
}
