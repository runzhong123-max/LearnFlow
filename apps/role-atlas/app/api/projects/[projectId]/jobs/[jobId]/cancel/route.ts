import { authorizeApiRequest } from "@/lib/access";
import { abortLocalRoleJob } from "@/lib/jobs/execution";
import { cancelRoleJob, getRoleJob } from "@/lib/jobs/repository";

export async function POST(request: Request, context: { params: Promise<{ projectId: string; jobId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const { projectId, jobId } = await context.params;
  const current = await getRoleJob(jobId);
  if (!current || current.projectId !== projectId) return Response.json({ error: "任务不存在。" }, { status: 404 });
  const job = await cancelRoleJob(jobId, projectId);
  if (job?.status === "cancelled") abortLocalRoleJob(jobId);
  return Response.json({ job });
}
