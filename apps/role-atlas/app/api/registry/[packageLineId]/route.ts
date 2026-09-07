import { authorizeApiRequest, requestActor } from "@/lib/access";
import { getRegistryPackage } from "@/lib/registry/repository";

export const runtime = "edge";

export async function GET(request: Request, context: { params: Promise<{ packageLineId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const { packageLineId } = await context.params;
  const actor = await requestActor(request).catch(() => null);
  const own = actor ? await getRegistryPackage(packageLineId, { ownerSubjectId: actor.subjectId }) : null;
  const item = own || await getRegistryPackage(packageLineId, { scope: "public" });
  return item ? Response.json({ package: item }) : Response.json({ error: "岗位包线不存在。" }, { status: 404 });
}
