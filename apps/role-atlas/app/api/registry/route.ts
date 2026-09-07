import { listProjects } from "@/lib/projects/repository";
import { authorizeApiRequest, requestActor } from "@/lib/access";
import { z } from "zod/v4";
import { bootstrapBundledRegistryPackage } from "@/lib/registry/bootstrap";
import { getRegistryPackage, listRegistryPackages, updateRegistryPackageStatus } from "@/lib/registry/repository";

export const runtime = "edge";

export async function GET(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  await bootstrapBundledRegistryPackage().catch(() => null);
  const params = new URL(request.url).searchParams;
  const actor = params.get("scope") === "public" ? null : await requestActor(request);
  const packages = await listRegistryPackages({
    ownerSubjectId: actor?.subjectId,
    scope: actor ? "mine" : "public",
    query: params.get("q") || undefined,
    visibility: params.get("visibility") || undefined,
    status: params.get("status") || undefined,
  });
  return Response.json({ packages, projects: actor ? await listProjects(actor.subjectId) : [], graphHubBaseUrl: process.env.GRAPH_HUB_PUBLIC_URL || "" }, { headers: { "Cache-Control": "private, no-store" } });
}

const patchSchema = z.object({
  packageLineId: z.string().min(4),
  status: z.enum(["active", "disputed", "deprecated", "superseded"]),
  supersededByPackageLineId: z.string().min(4).nullable().optional(),
});

export async function PATCH(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  try {
    const input = patchSchema.parse(await request.json());
    await updateRegistryPackageStatus(input);
    const actor = await requestActor(request);
    return Response.json({ package: await getRegistryPackage(input.packageLineId, { ownerSubjectId: actor.subjectId }) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Registry 更新失败。" }, { status: 400 });
  }
}
