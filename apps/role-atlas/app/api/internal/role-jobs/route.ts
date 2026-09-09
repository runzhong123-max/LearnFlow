import { jobWorkerSecret, listDispatchableJobs } from "@/lib/jobs/dispatch";
import { verifyJobWorkerRequest } from "@/lib/jobs/dispatch-protocol";
import { listAutomaticMounts } from "@/lib/learning-path/automatic";
export async function GET(request: Request) {
  if (!await verifyJobWorkerRequest(request, jobWorkerSecret())) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  // Follow-up enrichment must be queued before a completed kernel becomes eligible for mounting.
  const jobs = await listDispatchableJobs();
  const learningMounts = await listAutomaticMounts();
  return Response.json({ jobs, learningMounts }, { headers: { "cache-control": "no-store" } });
}
