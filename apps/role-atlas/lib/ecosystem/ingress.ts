/** A dedicated multi-client gateway deployment must not expose legacy authoring APIs. */
export function gatewayOnlyReject(request: Request, mode: unknown): Response | undefined {
  if (mode !== "true") return;
  if (request.method === "POST" && new URL(request.url).pathname === "/api/integrations/learnflow/gateway") return;
  return Response.json({ error: "GATEWAY_ONLY" }, { status: 404, headers: { "Cache-Control": "no-store" } });
}
