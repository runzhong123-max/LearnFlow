import { authorizeApiRequest } from "@/lib/access";
import { resolveReferenceMigration } from "@/lib/versioning/diff";

export const runtime = "edge";

export async function GET(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const fromSnapshotId = params.get("fromSnapshotId");
  const toSnapshotId = params.get("toSnapshotId");
  const targetId = params.get("targetId");
  if (!fromSnapshotId || !toSnapshotId || !targetId) return Response.json({ error: "缺少引用迁移参数。" }, { status: 400 });
  const migration = await resolveReferenceMigration({ fromSnapshotId, toSnapshotId, targetId });
  return migration ? Response.json({ migration }) : Response.json({ migration: null }, { status: 404 });
}
