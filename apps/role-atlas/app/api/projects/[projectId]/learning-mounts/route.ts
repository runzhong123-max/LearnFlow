import { accessErrorResponse, authorizeApiRequest, requestActor, requireSnapshotAccess } from "@/lib/access";
import { readAutomaticMount, retryAutomaticMount } from "@/lib/learning-path/automatic";

async function handle(request: Request, context: { params: Promise<{ projectId: string }> }, retry: boolean) {
  const denied = await authorizeApiRequest(request); if (denied) return denied;
  const { projectId } = await context.params;
  const versionId = new URL(request.url).searchParams.get("versionId");
  if (!versionId) return Response.json({ error: "VERSION_REQUIRED" }, { status: 400 });
  try {
    await requireSnapshotAccess(await requestActor(request), { projectId, versionId }, true);
    const mount = retry ? await retryAutomaticMount(projectId, versionId) : await readAutomaticMount(projectId, versionId);
    return Response.json({ mount }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return accessErrorResponse(error); }
}
export const GET = (request: Request, context: { params: Promise<{ projectId: string }> }) => handle(request, context, false);
export const POST = (request: Request, context: { params: Promise<{ projectId: string }> }) => handle(request, context, true);
