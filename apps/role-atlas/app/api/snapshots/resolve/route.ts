import { authorizeApiRequest, requestActor, resolveAccessibleSnapshot } from "@/lib/access";

export const runtime = "edge";

export async function GET(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const snapshotId = params.get("snapshotId") || undefined;
  const packageVersion = params.get("packageVersion") || undefined;
  const projectId = params.get("projectId") || undefined;
  const versionId = params.get("versionId") || undefined;
  if (!snapshotId && !projectId) return Response.json({ error: "缺少 snapshotId 或 projectId。" }, { status: 400 });
  try {
    const snapshot = await resolveAccessibleSnapshot(await requestActor(request).catch(() => null), { snapshotId, packageVersion, projectId, versionId });
    if (!snapshot) return Response.json({ error: "岗位快照不存在。" }, { status: 404 });
    return Response.json(snapshot);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "岗位快照读取失败。" }, { status: 500 });
  }
}
