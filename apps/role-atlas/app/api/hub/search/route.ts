import { listPublicHubEntries } from "@/lib/hub/repository";
import { searchHub } from "@/lib/hub/discovery";
import { bootstrapBundledRegistryPackage } from "@/lib/registry/bootstrap";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  try {
    // Match the Hub page: a bundled example conflict must not hide published entries.
    // Directory failures still propagate to the unavailable response below.
    await bootstrapBundledRegistryPackage().catch(() => null);
    const entries = await listPublicHubEntries();
    const result = searchHub(entries, { query: params.get("q") || "", category: params.get("category") || undefined,
      limit: Number(params.get("limit") || 20), offset: Number(params.get("offset") || 0) });
    return Response.json({ protocol: "graph-hub.discovery.v1", status: result.total ? "available" : "not_found",
      ...result, visibleEntries: entries.length,
      items: result.items.map(({ entry: { nodeIndex: _nodeIndex, ...entry }, ...match }) => ({ ...entry, ...match })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ protocol: "graph-hub.discovery.v1", status: "unavailable", error: "HUB_DISCOVERY_UNAVAILABLE" },
      { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
