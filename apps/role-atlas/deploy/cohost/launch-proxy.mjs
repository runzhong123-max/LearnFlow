import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";

const port = Number(process.env.PORT || 3010);
const roleAtlasUrl = process.env.ROLE_ATLAS_INTERNAL_URL || "http://role-atlas:3000";
const learnFlowUrl = process.env.LEARNFLOW_INTERNAL_URL || "http://learnflow-backend:8010";
const publicLearnFlowUrl = process.env.LEARNFLOW_PUBLIC_URL;
const publicRoleAtlasUrl = process.env.ROLE_ATLAS_PUBLIC_URL;
const publicGraphHubUrl = process.env.GRAPH_HUB_PUBLIC_URL;
const allowedOrigins = new Set([publicRoleAtlasUrl, publicGraphHubUrl].filter(Boolean).map(value => new URL(value).origin));
const secret = (process.env.ROLE_PACKAGE_LAUNCH_SECRET || "").trim();

function b64(value) { return Buffer.from(value, "utf8").toString("base64url"); }
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body);
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
async function upstream(url, options = {}) {
  // Node fetch does not honor a custom Host header. The internal Atlas Vite
  // server expects localhost, just like the existing Caddy upstream route.
  const { status, text } = await new Promise((resolve, reject) => {
    const transport = new URL(url).protocol === "https:" ? https : http;
    const request = transport.get(url, options, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode || 502, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.setTimeout(10_000, () => request.destroy(new Error("UPSTREAM_TIMEOUT")));
    request.on("error", reject);
  });
  let data = null;
  try { data = JSON.parse(text); } catch { /* handled as upstream failure */ }
  return { response: { status, ok: status >= 200 && status < 300 }, data };
}
function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/api/integrations/learnflow/launch") {
    return json(res, 404, { error: "NOT_FOUND" });
  }
  try {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return json(res, 403, { error: "CROSS_ORIGIN_LAUNCH_REJECTED" });
    if (Buffer.byteLength(secret, "utf8") < 32 || !publicLearnFlowUrl) throw new Error("LEARNFLOW_LAUNCH_NOT_CONFIGURED");
    const body = await readBody(req);
    if (typeof body.releaseId !== "string" || body.releaseId.length > 240) return json(res, 400, { error: "RELEASE_ID_REQUIRED" });
    const source = body.source === "role_atlas" ? "role_atlas" : "graph_hub";
    const forwarded = {};
    for (const name of ["cookie", "authorization", "x-learnflow-desktop-token"]) {
      if (req.headers[name]) forwarded[name] = req.headers[name];
    }
    if (!Object.keys(forwarded).length) return json(res, 401, { error: "LEARNFLOW_LOGIN_REQUIRED" });
    const auth = await upstream(`${learnFlowUrl}/api/auth/me`, { headers: { accept: "application/json", ...forwarded } });
    if (auth.response.status === 401) return json(res, 401, { error: "LEARNFLOW_LOGIN_REQUIRED" });
    if (!auth.response.ok || !auth.data) return json(res, 503, { error: "LEARNFLOW_AUTH_UNAVAILABLE" });
    const learnerId = Number(auth.data.learner_id);
    if (!Number.isInteger(learnerId) || learnerId <= 0) return json(res, 502, { error: "LEARNFLOW_AUTH_RESPONSE_INVALID" });
    const catalogPath = source === "graph_hub" ? "/api/registry?scope=public" : "/api/registry";
    const catalog = await upstream(`${roleAtlasUrl}${catalogPath}`, { headers: { host: "localhost", ...(source === "role_atlas" ? forwarded : {}) } });
    if (!catalog.response.ok || !catalog.data?.packages) return json(res, 503, { error: "ROLE_ATLAS_REGISTRY_UNAVAILABLE" });
    const item = catalog.data.packages.find((pkg) => pkg.releases?.some((release) => release.id === body.releaseId));
    const release = item?.releases?.find((candidate) => candidate.id === body.releaseId);
    if (!item || !release || !["ready", "published", "deprecated"].includes(release.status) || !release.artifactRootHash) return json(res, 404, { error: "RELEASE_NOT_LAUNCHABLE" });
    if (source === "graph_hub" && item.visibility !== "public") return json(res, 403, { error: "RELEASE_NOT_VISIBLE" });
    const token = sign({ protocol: "role-package-launch.v1", launchId: randomUUID(), subject: `learnflow:learner:${learnerId}`, issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 300, source, roleTitle: item.title, packageRef: { packageId: item.packageId, packageVersion: release.packageVersion, snapshotId: release.snapshotId, rootHash: release.artifactRootHash } });
    return json(res, 200, { launchUrl: `${publicLearnFlowUrl.replace(/\/$/u, "")}/launch/role-package/${token}` });
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : "LEARNFLOW_LAUNCH_FAILED" });
  }
});
server.listen(port, "0.0.0.0", () => console.log(`launch proxy listening on ${port}`));
