import { authorizeApiRequest } from "@/lib/access";
import { bundleToJson, bundleToZip } from "@/lib/packages/archive";
import { getReleaseWithArtifact } from "@/lib/releases/resolver";

export const runtime = "edge";

export async function GET(request: Request, context: { params: Promise<{ releaseId: string }> }) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const { releaseId } = await context.params;
  const resolved = await getReleaseWithArtifact(releaseId);
  if (!resolved) return Response.json({ error: "发布制品不存在。" }, { status: 404 });
  if (!["ready", "published", "deprecated"].includes(resolved.release.status)) {
    return Response.json({ error: "该 Release 未通过校验，不能作为岗位包导出。" }, { status: 409 });
  }
  const format = new URL(request.url).searchParams.get("format") === "json" ? "json" : "zip";
  const safeName = resolved.bundle.manifest.packageId.replace(/[^0-9A-Za-z._-]+/gu, "-");
  if (format === "json") {
    return new Response(bundleToJson(resolved.bundle), {
      headers: {
        "Content-Type": "application/vnd.role-atlas.package+json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeName}-${resolved.release.packageVersion}.json"`,
      },
    });
  }
  return new Response(bundleToZip(resolved.bundle) as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeName}-${resolved.release.packageVersion}.zip"`,
    },
  });
}
