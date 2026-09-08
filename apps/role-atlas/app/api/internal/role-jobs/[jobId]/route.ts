import { claimDispatch, dispatchRequest, jobWorkerSecret, settleDispatch } from "@/lib/jobs/dispatch";
import { verifyJobWorkerRequest } from "@/lib/jobs/dispatch-protocol";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  if (!await verifyJobWorkerRequest(request, jobWorkerSecret())) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  const { jobId } = await context.params;
  const delivery = await claimDispatch(jobId);
  if (!delivery) return Response.json({ skipped: true }, { status: 409 });
  try {
    const replay = await dispatchRequest(jobId, delivery);
    // Fixed allow-list: a stored envelope cannot become an arbitrary authenticated request.
    const handler = delivery.endpoint === "/api/snapshot-iterations" ? (await import("@/app/api/snapshot-iterations/route")).POST
      : delivery.endpoint === "/api/build-runs" ? (await import("@/app/api/build-runs/route")).POST
      : delivery.endpoint === "/api/build-runs/enrich" ? (await import("@/app/api/build-runs/enrich/route")).POST
      : delivery.endpoint === "/api/workspace-upgrades" ? (await import("@/app/api/workspace-upgrades/route")).POST : null;
    if (!handler) throw new Error("INVALID_JOB_ENDPOINT");
    const response = await handler(replay);
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      await settleDispatch(jobId, delivery.token, payload.error || "后台任务提交失败。");
      return Response.json({ accepted: false }, { status: response.status });
    }
    // The independent consumer owns this connection; browser lifetime never reaches it.
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { await settleDispatch(jobId, delivery.token); controller.close(); }
          else controller.enqueue(next.value);
        } catch {
          await settleDispatch(jobId, delivery.token, "执行连接中断，等待检查点恢复。");
          controller.error(new Error("JOB_EXECUTION_DISCONNECTED"));
        }
      },
      cancel() { return reader.cancel(); },
    });
    return new Response(body, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
  } catch {
    await settleDispatch(jobId, delivery.token, "后台执行准备失败，请检查服务配置后继续。");
    return Response.json({ error: "JOB_DISPATCH_FAILED" }, { status: 503 });
  }
}
