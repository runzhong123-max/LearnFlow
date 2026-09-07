import { authorizeApiRequest, requestActor } from "@/lib/access";
import { getLatestSnapshotRiskRun } from "@/lib/snapshots/repository";

export const runtime = "edge";

export async function GET(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const snapshotId = new URL(request.url).searchParams.get("snapshotId");
  if (!snapshotId) return Response.json({ error: "缺少 snapshotId。" }, { status: 400 });
  try {
    return Response.json({ run: await getLatestSnapshotRiskRun(snapshotId, (await requestActor(request)).subjectId) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "风险运行读取失败。" }, { status: 500 });
  }
}


/** The legacy repair path bypassed conversation mode, leases, and candidate adoption. */
export async function POST(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  return Response.json({
    error: "LEGACY_MUTATION_ENDPOINT_RETIRED",
    message: "请在项目对话中切换到迭代态，使用完善岗位工具。",
    replacementEndpoint: "/api/snapshot-iterations",
  }, { status: 410, headers: { "Cache-Control": "private, no-store" } });
}
