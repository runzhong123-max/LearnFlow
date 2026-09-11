import { listPublicHubEntries } from "@/lib/hub/repository";
import { searchHub, type HubSearchTarget } from "@/lib/hub/discovery";
import { readCachedHubBoundary } from "@/lib/hub/boundary";
import { bootstrapBundledRegistryPackage } from "@/lib/registry/bootstrap";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const target = params.get("target") || "all";
  if (!["all", "role", "task"].includes(target)) return Response.json({ error: "INVALID_SEARCH_TARGET" }, { status: 400 });
  try {
    // Match the Hub page: a bundled example conflict must not hide published entries.
    // Directory failures still propagate to the unavailable response below.
    await bootstrapBundledRegistryPackage().catch(() => null);
    const entries = await listPublicHubEntries();
    const query = params.get("q") || "";
    // Public search never calls the model; verdicts warmed by authenticated
    // intake sessions still narrow the ranking deterministically.
    const boundary = query ? readCachedHubBoundary(query, entries) : undefined;
    const result = searchHub(entries, { query, target: target as HubSearchTarget, roleQuery: params.get("role") || undefined, category: params.get("category") || undefined,
      limit: Number(params.get("limit") || 20), offset: Number(params.get("offset") || 0) }, boundary?.size ? { boundary } : {});
    return Response.json({ protocol: "graph-hub.discovery.v1", status: result.total ? "available" : "not_found",
      ...result, visibleEntries: entries.length,
      items: result.items.map(({ entry: { nodeIndex: _nodeIndex, ...entry }, ...match }) => ({ ...entry, ...match })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ protocol: "graph-hub.discovery.v1", status: "unavailable", error: "HUB_DISCOVERY_UNAVAILABLE" },
      { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
