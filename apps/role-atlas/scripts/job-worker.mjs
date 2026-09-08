/** Independent queue consumer. No browser cookies, database files or user-selected URLs. */
import http from "node:http";
import { createHash, createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const base = new URL(process.env.ROLE_ATLAS_INTERNAL_URL || "http://role-atlas:3000");
const secret = process.env.ROLE_ATLAS_GATEWAY_SECRET || "";
if (secret.length < 32 || base.protocol !== "http:" || !["role-atlas", "localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("JOB_WORKER_CONFIGURATION_INVALID");
const signingKey = createHash("sha256").update(`role-job-sign:v1:${secret}`).digest();
const active = new Map();
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { stopping = true; });
function request(path, method, collect = false) {
  const stamp = String(Date.now());
  const signature = createHmac("sha256", signingKey).update(`${method}\n${path}\n${stamp}`).digest("base64");
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, base), { method, headers: { host: "localhost", "x-role-worker-time": stamp, "x-role-worker-signature": signature } }, res => {
      let body = "";
      res.on("data", chunk => { if (collect && body.length < 100_000) body += chunk; });
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("EXECUTION_CONNECTION_LOST")));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(collect ? 15_000 : 90_000, () => req.destroy(new Error("WORKER_IDLE_TIMEOUT")));
    req.on("error", reject); req.end();
  });
}
console.log("Role job consumer started (concurrency=2, automatic recovery <=3 deliveries)");
while (!stopping) {
  try {
    const response = await request("/api/internal/role-jobs", "GET", true);
    if (response.status === 200) for (const id of JSON.parse(response.body).jobs || []) {
      if (active.size >= 2) break;
      if (active.has(id)) continue;
      active.set(id, request(`/api/internal/role-jobs/${encodeURIComponent(id)}`, "POST")
        .catch(() => console.error("Job connection lost; persisted lease determines recovery", id))
        .finally(() => active.delete(id)));
    }
  } catch { console.error("Job service unavailable; retrying discovery"); }
  await delay(5000);
}
await Promise.allSettled(active.values());
