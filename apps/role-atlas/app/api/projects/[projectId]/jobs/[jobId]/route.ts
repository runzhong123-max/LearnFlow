import { authorizeApiRequest } from "@/lib/access";
import { getRoleJob, readRoleJobEvents } from "@/lib/jobs/repository";

export async function GET(request: Request, context: { params: Promise<{ projectId: string; jobId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const { projectId, jobId } = await context.params;
  const job = await getRoleJob(jobId);
  if (!job || job.projectId !== projectId) return Response.json({ error: "任务不存在。" }, { status: 404 });
  const after = Math.max(0, Number(new URL(request.url).searchParams.get("after")) || 0);
  return Response.json({ job, ...await readRoleJobEvents(jobId, after) }, { headers: { "cache-control": "no-store" } });
}
