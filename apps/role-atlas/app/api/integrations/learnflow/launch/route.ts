import { accessErrorResponse, requireReleaseAccess } from "@/lib/access";
import { getReleaseWithArtifact } from "@/lib/releases/resolver";
import { resolveLearnFlowIdentity } from "@/lib/integrations/learnflow/auth";
import { signRolePackageLaunch } from "@/lib/integrations/learnflow/launch-token";

function publicBaseUrl(value: string) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new Error("LEARNFLOW_PUBLIC_URL_INVALID");
  }
  url.pathname = url.pathname.replace(/\/$/u, "");
  url.search = "";
  url.hash = "";
  return url;
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    const allowedOrigins = [process.env.GRAPH_HUB_PUBLIC_URL, process.env.ROLE_ATLAS_PUBLIC_URL]
      .flatMap((value) => { try { return value ? [new URL(value).origin] : []; } catch { return []; } });
    if (origin && !new Set([new URL(request.url).origin, ...allowedOrigins]).has(origin)) {
      return Response.json({ error: "CROSS_ORIGIN_LAUNCH_REJECTED" }, { status: 403 });
    }
    const authBaseUrl = process.env.LEARNFLOW_BASE_URL || "";
    const learnFlowPublicUrl = process.env.LEARNFLOW_PUBLIC_URL || authBaseUrl;
    const secret = process.env.ROLE_PACKAGE_LAUNCH_SECRET || "";
    if (!authBaseUrl || !learnFlowPublicUrl) {
      return Response.json({ error: "LEARNFLOW_LAUNCH_NOT_CONFIGURED" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    if (Buffer.byteLength(secret, "utf8") < 32) {
      return Response.json({ error: "ROLE_PACKAGE_LAUNCH_SECRET_INVALID" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    const identity = await resolveLearnFlowIdentity({ request, baseUrl: authBaseUrl });
    if (!identity) return Response.json({ error: "LEARNFLOW_LOGIN_REQUIRED" }, { status: 401 });
    const input = await request.json() as { releaseId?: unknown; source?: unknown };
    if (typeof input.releaseId !== "string" || input.releaseId.length > 240) {
      return Response.json({ error: "RELEASE_ID_REQUIRED" }, { status: 400 });
    }
    const source = input.source === "role_atlas" ? "role_atlas" : "graph_hub";
    try { await requireReleaseAccess(source === "graph_hub" ? null : identity, input.releaseId); }
    catch (error) { return accessErrorResponse(error); }
    const resolved = await getReleaseWithArtifact(input.releaseId);
    if (!resolved || !["ready", "published", "deprecated"].includes(resolved.release.status)) {
      return Response.json({ error: "RELEASE_NOT_LAUNCHABLE" }, { status: 404 });
    }
    if (!resolved.line || (source === "graph_hub" && resolved.line.visibility !== "public")) {
      return Response.json({ error: "RELEASE_NOT_VISIBLE" }, { status: 403 });
    }
    const rootHash = resolved.release.artifactRootHash || "";
    if (rootHash !== resolved.bundle.manifest.rootHash) throw new Error("RELEASE_ARTIFACT_IDENTITY_MISMATCH");
    const token = signRolePackageLaunch({
      secret,
      subject: identity.subjectId,
      source,
      roleTitle: resolved.line.title,
      packageRef: {
        packageId: resolved.line.packageId,
        packageVersion: resolved.release.packageVersion,
        snapshotId: resolved.release.snapshotId,
        rootHash,
      },
    });
    const base = publicBaseUrl(learnFlowPublicUrl);
    const launchUrl = new URL(`${base.pathname}/launch/role-package/${token}`, base).toString();
    return Response.json({ launchUrl }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "LEARNFLOW_LAUNCH_FAILED";
    const status = message.startsWith("LEARNFLOW_AUTH_UNAVAILABLE") ? 503 : 500;
    return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
