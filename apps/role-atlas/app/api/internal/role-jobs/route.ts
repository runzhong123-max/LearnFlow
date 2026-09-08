import { jobWorkerSecret, listDispatchableJobs } from "@/lib/jobs/dispatch";
import { verifyJobWorkerRequest } from "@/lib/jobs/dispatch-protocol";
export async function GET(request: Request) {
  if (!await verifyJobWorkerRequest(request, jobWorkerSecret())) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  return Response.json({ jobs: await listDispatchableJobs() }, { headers: { "cache-control": "no-store" } });
}
