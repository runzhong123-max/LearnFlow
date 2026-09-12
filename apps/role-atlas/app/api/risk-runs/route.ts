import { authorizeApiRequest } from "@/lib/access";

export const runtime = "edge";

/**
 * The legacy risk-repair path is fully retired, reads included.
 *
 * Its writers were removed first because they had no callers, which left the
 * reader answering from tables nothing wrote — an endpoint that always returns
 * `null` reads like "no risks found" rather than "this feature is gone". Risk is
 * owned by the snapshot iteration now, and an honest 410 says so.
 */
function retired() {
  return Response.json({
    error: "LEGACY_MUTATION_ENDPOINT_RETIRED",
    message: "风险检测已并入岗位快照迭代，请在项目对话中切换到迭代态使用完善岗位工具。",
    replacementEndpoint: "/api/snapshot-iterations",
  }, { status: 410, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  return retired();
}

/** The legacy repair path bypassed conversation mode, leases, and candidate adoption. */
export async function POST(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  return retired();
}
