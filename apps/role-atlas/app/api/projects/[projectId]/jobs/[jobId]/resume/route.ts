import { authorizeApiRequest } from "@/lib/access";
import { resumeRoleJob } from "@/lib/jobs/dispatch";
export async function POST(request: Request, context: { params: Promise<{ projectId: string; jobId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const { projectId, jobId } = await context.params;
  return resumeRoleJob(request, jobId, projectId);
}
