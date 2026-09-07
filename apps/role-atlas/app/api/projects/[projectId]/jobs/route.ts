import { authorizeApiRequest } from "@/lib/access";
import { listRoleJobs } from "@/lib/jobs/repository";

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const { projectId } = await context.params;
  const conversationId = new URL(request.url).searchParams.get("conversationId") || undefined;
  return Response.json({ jobs: await listRoleJobs(projectId, conversationId) }, { headers: { "cache-control": "no-store" } });
}
