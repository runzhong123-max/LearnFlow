import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { verifyRolePackageLaunch } from "@/lib/integrations/learnflow/launch-token";

async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

test("cohost 引用按用户或公开范围读取目录、保留 Host 并拒绝目录故障", async (t) => {
  let authStatus = 200;
  let registryStatus = 200;
  let registryCalls = 0;
  const auth = http.createServer((req, res) => {
    assert.equal(req.headers.cookie, "session=test-only");
    res.writeHead(authStatus, { "content-type": "application/json" });
    res.end(JSON.stringify({ learner_id: 7 }));
  });
  const atlas = http.createServer((req, res) => {
    registryCalls++;
    // Reproduce Vite's host gate; localhost is the cohost routing contract.
    assert.equal(req.headers.host, "localhost");
    assert.ok(["/api/registry", "/api/registry?scope=public"].includes(req.url!));
    assert.equal(req.headers.cookie, req.url === "/api/registry" ? "session=test-only" : undefined);
    res.writeHead(registryStatus, { "content-type": "application/json" });
    res.end(JSON.stringify({ packages: [{ title: "测试岗位", packageId: "role.test", visibility: "public", releases: [{ id: "release:test", status: "published", packageVersion: "1.0.0", snapshotId: "snapshot:test", artifactRootHash: "a".repeat(64) }] }] }));
  });
  t.after(() => { auth.close(); atlas.close(); });
  const authPort = await listen(auth);
  const atlasPort = await listen(atlas);
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const secret = "test-only-launch-secret-at-least-32-bytes";
  const proxy = spawn(process.execPath, ["deploy/cohost/launch-proxy.mjs"], {
    env: { ...process.env, PORT: String(port), LEARNFLOW_INTERNAL_URL: `http://127.0.0.1:${authPort}`, ROLE_ATLAS_INTERNAL_URL: `http://127.0.0.1:${atlasPort}`, LEARNFLOW_PUBLIC_URL: "https://learn.example.com", ROLE_ATLAS_PUBLIC_URL: "https://roles.example.com", ROLE_PACKAGE_LAUNCH_SECRET: secret },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => proxy.kill());
  await Promise.race([once(proxy.stdout!, "data"), once(proxy, "exit").then(() => { throw new Error("proxy exited before listening"); })]);
  const launch = (source = "role_atlas", releaseId = "release:test") => fetch(`http://127.0.0.1:${port}/api/integrations/learnflow/launch`, { method: "POST", headers: { cookie: "session=test-only", origin: "https://roles.example.com", "content-type": "application/json" }, body: JSON.stringify({ releaseId, source }) });
  const success = await launch();
  assert.equal(success.status, 200);
  const { launchUrl } = await success.json() as { launchUrl: string };
  const token = launchUrl.split("/role-package/")[1];
  const payload = verifyRolePackageLaunch(token, secret);
  assert.equal(payload.subject, "learnflow:learner:7");
  assert.equal(payload.packageRef.snapshotId, "snapshot:test");
  const publicLaunch = await launch("graph_hub");
  assert.equal(publicLaunch.status, 200);
  const publicToken = (await publicLaunch.json() as { launchUrl: string }).launchUrl.split("/role-package/")[1];
  assert.equal(verifyRolePackageLaunch(publicToken, secret).source, "graph_hub");
  for (const source of ["role_atlas", "graph_hub"]) {
    const inaccessible = await launch(source, "release:another-user-private");
    assert.equal(inaccessible.status, 404);
    assert.deepEqual(await inaccessible.json(), { error: "RELEASE_NOT_LAUNCHABLE" });
  }
  registryStatus = 403;
  const unavailable = await launch();
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "ROLE_ATLAS_REGISTRY_UNAVAILABLE" });
  authStatus = 401;
  const callsBefore = registryCalls;
  assert.equal((await launch()).status, 401);
  assert.equal(registryCalls, callsBefore);
});
