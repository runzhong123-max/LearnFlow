import { authorizeApiRequest, requestActor } from "@/lib/access";
import { getLatestWorkspaceIngestion } from "@/lib/workspaces/repository";

export const runtime = "edge";

export async function GET(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") || undefined;
  const snapshotId = url.searchParams.get("snapshotId") || undefined;
  if (!projectId && !snapshotId) return Response.json({ error: "缺少 projectId 或 snapshotId。" }, { status: 400 });
  try {
    return Response.json({ run: await getLatestWorkspaceIngestion({ projectId, snapshotId, ownerSubjectId: (await requestActor(request)).subjectId }) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "工作区运行读取失败。" }, { status: 500 });
  }
}


/** Ingestion now belongs to a conversation job; existing journals remain readable through GET. */
export async function POST(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  return Response.json({
    error: "LEGACY_MUTATION_ENDPOINT_RETIRED",
    message: "请在项目对话中切换到迭代态，使用接入工作区工具。",
    replacementEndpoint: "/api/workspace-upgrades",
  }, { status: 410, headers: { "Cache-Control": "private, no-store" } });
}
