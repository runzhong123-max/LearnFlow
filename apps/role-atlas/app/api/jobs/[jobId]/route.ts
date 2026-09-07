import { authorizeApiRequest } from "@/lib/access";
import { getRoleJob } from "@/lib/jobs/repository";

export const runtime = "edge";

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  try {
    const { jobId } = await context.params;
    const job = await getRoleJob(jobId);
    if (!job) return Response.json({ error: "任务不存在。" }, { status: 404 });
    return Response.json({ job });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "任务状态读取失败。" }, { status: 500 });
  }
}
