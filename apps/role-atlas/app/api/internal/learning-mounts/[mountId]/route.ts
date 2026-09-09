import { jobWorkerSecret } from "@/lib/jobs/dispatch";
import { verifyJobWorkerRequest } from "@/lib/jobs/dispatch-protocol";
import { executeAutomaticMount } from "@/lib/learning-path/automatic";

export async function POST(request: Request, context: { params: Promise<{ mountId: string }> }) {
  if (!await verifyJobWorkerRequest(request, jobWorkerSecret())) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  return Response.json(await executeAutomaticMount((await context.params).mountId), { headers: { "cache-control": "no-store" } });
}
