/** Dynamic app responses may contain actor-scoped data, including RSC payloads. */
export function privateAppResponse(request: Request, response: Response): Response {
  // The discovery API returns only explicitly published immutable artifacts.
  if (new URL(request.url).pathname === "/api/hub/search") return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("CDN-Cache-Control", "no-store");
  const vary = new Set((headers.get("Vary") ?? "").split(",").map((part) => part.trim()).filter(Boolean));
  if (![...vary].some((part) => part.toLowerCase() === "cookie")) vary.add("Cookie");
  headers.set("Vary", [...vary].join(", "));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
