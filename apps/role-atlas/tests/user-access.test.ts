import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Run the production authorization policy against SQLite; only the D1 binding and identity transport are substituted.
async function policyHarness() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, owner_subject_id TEXT, deleted_at TEXT);
    CREATE TABLE conversations(id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY, conversation_id TEXT);
    CREATE TABLE project_versions(id TEXT PRIMARY KEY, project_id TEXT, snapshot_id TEXT, package_json TEXT);
    CREATE TABLE package_lines(id TEXT PRIMARY KEY, package_id TEXT, visibility TEXT);
    CREATE TABLE package_artifacts(root_hash TEXT PRIMARY KEY, content TEXT);
    CREATE TABLE package_releases(id TEXT PRIMARY KEY, project_id TEXT, package_line_id TEXT, snapshot_id TEXT, status TEXT, artifact_root_hash TEXT, published_at TEXT, package_version TEXT);
    INSERT INTO projects VALUES ('project-a','learnflow:learner:1',NULL),('project-b','learnflow:learner:2',NULL),('project-c','learnflow:learner:3',NULL),('ownerless',NULL,NULL),('deleted','learnflow:learner:1','yesterday');
    INSERT INTO conversations VALUES ('chat-a','project-a'),('chat-b','project-b'),('chat-c','project-c');
    INSERT INTO messages VALUES ('message-b','chat-b'),('message-b:user','chat-b');
    INSERT INTO project_versions VALUES ('version-a','project-a','snapshot-a','{}'),('version-b','project-b','snapshot-b','{}'),('version-c','project-c','snapshot-c','{}');
    INSERT INTO package_lines VALUES ('line-a','package-a','private'),('line-b','package-b','private'),('line-public','package-public','public');
    INSERT INTO package_artifacts VALUES ('root-a','{"manifest":{"visibility":"private"}}'),('root-public','{"manifest":{"visibility":"public"}}');
    INSERT INTO package_releases VALUES ('release-a','project-a','line-a','snapshot-a','ready','root-a',NULL,'1.0.0'),('release-b','project-b','line-b','snapshot-b','ready','root-a',NULL,'1.0.0'),('release-public',NULL,'line-public','snapshot-public','published','root-public','today','1.0.0'),('release-public-private-old','project-b','line-public','snapshot-private-old','published','root-a','yesterday','0.9.0');`);
  db.exec("ALTER TABLE package_releases ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
  for (const table of ["build_runs", "risk_runs", "snapshot_risk_runs", "snapshot_iteration_runs", "workspace_ingestion_runs", "role_jobs"]) {
    db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY, project_id TEXT); INSERT INTO ${table} VALUES ('run-b','project-b');`);
  }
  const binding = {
    prepare(sql: string) {
      return { bind(...values: unknown[]) {
        return { async first() { return db.prepare(sql).get(...values as never[]) || null; }, async all() { return { results: db.prepare(sql).all(...values as never[]) }; } };
      } };
    },
  };
  const key = `__roleAccessTest${Math.random().toString(36).slice(2)}`;
  (globalThis as unknown as Record<string, unknown>)[key] = binding;
  let source = await readFile(resolve("lib/access.ts"), "utf8");
  source = source.replace(/let database:[\s\S]*?\n\nexport class AccessError/u, `const ensureAppSchema = async () => {}; const getD1 = () => globalThis[${JSON.stringify(key)}];\n\nexport class AccessError`);
  source = source.replace(/(["'])@\/([^"']+)\1/gu, (_, _quote, path) => JSON.stringify(pathToFileURL(resolve(`${path}.ts`)).href));
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const policyUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
  const policy = await import(policyUrl) as typeof import("@/lib/access");
  const oldFetch = globalThis.fetch;
  const oldBase = process.env.LEARNFLOW_BASE_URL;
  process.env.LEARNFLOW_BASE_URL = "http://127.0.0.1:38123";
  let authCalls = 0;
  globalThis.fetch = async (_url, init) => {
    authCalls++;
    const user = Number(new Headers(init?.headers).get("cookie")?.match(/atlas-test-user=(\d+)/u)?.[1]);
    if (!user) return Response.json({}, { status: 401 });
    return Response.json({ id: user, learner_id: user, username: `tester${user}`, display_name: `Tester ${user}`, role: user === 9 ? "admin" : "user" });
  };
  return { db, policy, policyUrl, authCalls: () => authCalls, cleanup() { db.close(); globalThis.fetch = oldFetch; if (oldBase === undefined) delete process.env.LEARNFLOW_BASE_URL; else process.env.LEARNFLOW_BASE_URL = oldBase; delete (globalThis as unknown as Record<string, unknown>)[key]; } };
}
function request(path: string, user?: number, body?: unknown, method = body ? "POST" : "GET") {
  return new Request(`https://roles.example${path}`, { method, headers: { ...(user ? { cookie: `atlas-test-user=${user}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
}

test("three actors cannot read or mutate each other's project, conversation, versions, runs, or packages", async () => {
  const h = await policyHarness();
  try {
    for (const user of [1, 2, 3]) {
      const own = ["a", "b", "c"][user - 1];
      assert.equal(await h.policy.authorizeApiRequest(request(`/api/projects/project-${own}`, user)), undefined);
      for (const other of ["a", "b", "c"].filter(id => id !== own)) {
        for (const path of [`/api/projects/project-${other}`, `/api/projects/project-${other}/versions`, `/api/projects/project-${other}/tags`, `/api/conversations/chat-${other}/messages`, `/api/snapshots/resolve?snapshotId=snapshot-${other}`]) {
          assert.equal((await h.policy.authorizeApiRequest(request(path, user)))?.status, 404, path);
        }
        assert.equal((await h.policy.authorizeApiRequest(request(`/api/projects/project-${other}`, user, {}, "DELETE")))?.status, 404);
      }
    }
    assert.equal((await h.policy.authorizeApiRequest(request("/api/projects/project-a")))?.status, 401);
    assert.equal((await h.policy.authorizeApiRequest(request("/api/jobs/run-b", 1)))?.status, 404);
    assert.equal(await h.policy.authorizeApiRequest(request("/api/jobs/run-b", 2)), undefined);
    assert.equal((await h.policy.authorizeApiRequest(request("/api/releases/release-b/export", 1)))?.status, 404);
    assert.equal(await h.policy.authorizeApiRequest(request("/api/releases/release-b/export", 2)), undefined);
    assert.equal((await h.policy.authorizeApiRequest(request("/api/projects/ownerless", 1)))?.status, 404);
    assert.equal((await h.policy.authorizeApiRequest(request("/api/projects/ownerless", 9)))?.status, 404);
    assert.equal(await h.policy.authorizeApiRequest(request("/api/projects/ownerless?scope=maintenance", 9)), undefined);
    assert.equal((await h.policy.authorizeApiRequest(request("/api/projects/deleted", 1)))?.status, 404);
    assert.equal(await h.policy.authorizeApiRequest(request("/api/projects/deleted", 1, { action: "restore" }, "PATCH")), undefined);
  } finally { h.cleanup(); }
});

test("public immutable artifacts can be read without granting project writes or leaking old private releases", async () => {
  const h = await policyHarness();
  try {
    assert.equal(await h.policy.authorizeApiRequest(request("/api/releases/release-public/export")), undefined);
    assert.equal(await h.policy.authorizeApiRequest(request("/api/snapshots/resolve?snapshotId=snapshot-public")), undefined);
    assert.equal(await h.policy.authorizeApiRequest(request("/api/registry/line-public")), undefined);
    assert.equal((await h.policy.authorizeApiRequest(request("/api/releases/release-public-private-old/export", 1)))?.status, 404);
    assert.equal((await h.policy.authorizeApiRequest(request("/api/snapshots/resolve?snapshotId=snapshot-private-old", 1)))?.status, 404);
    assert.equal((await h.policy.authorizeApiRequest(request("/api/releases", 1, { action: "publish", releaseId: "release-public" }, "PATCH")))?.status, 404);
    assert.equal((await h.policy.authorizeApiRequest(request("/api/snapshot-iterations", 1, { iteration: { runId: "new", snapshotRef: { snapshotId: "snapshot-public" } } })))?.status, 404);
  } finally { h.cleanup(); }
});

test("Graph Hub launch requires an explicitly public immutable artifact even for its owner", async () => {
  const h = await policyHarness();
  const oldSecret = process.env.ROLE_PACKAGE_LAUNCH_SECRET;
  process.env.ROLE_PACKAGE_LAUNCH_SECRET = "test-only-launch-secret-at-least-32-bytes";
  try {
    let source = await readFile(resolve("app/api/integrations/learnflow/launch/route.ts"), "utf8");
    source = source.replace('"@/lib/access"', JSON.stringify(h.policyUrl));
    source = source.replace('import { getReleaseWithArtifact } from "@/lib/releases/resolver";', `const getReleaseWithArtifact = async () => ({
      release: { status: "published", artifactRootHash: "a".repeat(64), packageVersion: "1.0.0", snapshotId: "snapshot:test" },
      line: { visibility: "public", title: "Test role", packageId: "role.test" },
      bundle: { manifest: { rootHash: "a".repeat(64) } }
    });`);
    source = source.replace(/(["'])@\/([^"']+)\1/gu, (_, _quote, path) => JSON.stringify(pathToFileURL(resolve(`${path}.ts`)).href));
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const route = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
    const launch = (releaseId: string, source: string) => route.POST(request("/api/integrations/learnflow/launch", 2, { releaseId, source }));
    assert.equal((await launch("release-public-private-old", "role_atlas")).status, 200);
    const privatePublicLaunch = await launch("release-public-private-old", "graph_hub");
    assert.equal(privatePublicLaunch.status, 401);
    assert.deepEqual(await privatePublicLaunch.json(), { error: "LOGIN_REQUIRED" });
    assert.equal((await launch("release-public", "graph_hub")).status, 200);
  } finally {
    if (oldSecret === undefined) delete process.env.ROLE_PACKAGE_LAUNCH_SECRET;
    else process.env.ROLE_PACKAGE_LAUNCH_SECRET = oldSecret;
    h.cleanup();
  }
});

test("mixed resource scopes, replay takeover, and message overwrite are rejected before provider work", async () => {
  const h = await policyHarness();
  try {
    const invalid = [
      ["/api/build-runs", { build: { projectId: "project-a", runId: "new-run" }, conversationId: "chat-b" }],
      ["/api/build-runs", { build: { projectId: "project-a", runId: "run-b" }, conversationId: "chat-a" }],
      ["/api/snapshot-iterations", { iteration: { projectId: "project-a", snapshotRef: { snapshotId: "snapshot-b", projectId: "project-b" } } }],
      ["/api/projects/project-a/versions", { targetVersionId: "version-b" }],
      ["/api/agent", { projectId: "project-a", sessionId: "chat-a", runId: "new", messageId: "message-b" }],
      ["/api/agent", { sessionId: "chat-b", runId: "new" }],
      ["/api/agent", { projectId: "project-a", sessionId: "chat-a", runId: "new", references: [{ snapshotId: "snapshot-b" }] }],
      ["/api/releases", { projectId: "project-a", projectVersionId: "version-a", packageId: "package-b" }],
    ] as const;
    for (const [path, body] of invalid) assert.ok([403, 404].includes((await h.policy.authorizeApiRequest(request(path, 1, body)))?.status || 0), path);
    const create = request("/api/projects", 1, { id: "new-project", conversationId: "new-chat", title: "New" });
    assert.equal(await h.policy.authorizeApiRequest(create), undefined);
    assert.equal(((await create.json()) as { title: string }).title, "New", "guard must not consume original request body");
    const cached = request("/api/projects/project-a", 1);
    const count = h.authCalls();
    assert.equal(await h.policy.authorizeApiRequest(cached), undefined);
    await h.policy.requestActor(cached);
    assert.equal(h.authCalls(), count + 1, "identity cached only for same Request");
    const crossSite = request("/api/projects", 1, { id: "new" });
    crossSite.headers.set("origin", "https://attacker.example");
    assert.equal((await h.policy.authorizeApiRequest(crossSite))?.status, 403);
  } finally { h.cleanup(); }
});

test("missing identity configuration fails closed; client display name never becomes an owner", async () => {
  const h = await policyHarness();
  try {
    delete process.env.LEARNFLOW_BASE_URL;
    assert.equal((await h.policy.authorizeApiRequest(request("/api/projects", 1, { ownerSubjectId: "learnflow:learner:1", actor: "admin" })))?.status, 503);
    assert.equal(await h.policy.authorizeApiRequest(request("/api/releases/release-public/export")), undefined);
  } finally { h.cleanup(); }
});


test("retired mutation endpoints keep authorization and return a plugin redirect without running legacy work", async () => {
  const h = await policyHarness();
  try {
    for (const [path, replacement, readHelper, repository] of [
      ["/api/risk-runs", "/api/snapshot-iterations", "getLatestSnapshotRiskRun", "snapshots"],
      ["/api/workspaces/ingest", "/api/workspace-upgrades", "getLatestWorkspaceIngestion", "workspaces"],
    ]) {
      let source = await readFile(resolve(`app${path}/route.ts`), "utf8");
      source = source.replace('"@/lib/access"', JSON.stringify(h.policyUrl));
      source = source.replace(`import { ${readHelper} } from "@/lib/${repository}/repository";`, `const ${readHelper} = async () => { throw new Error("UNEXPECTED_LEGACY_READ"); };`);
      const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
      const route = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
      const denied = await route.POST(request(path, 2, { projectId: "project-a" }));
      assert.equal(denied.status, 404);
      const response = await route.POST(request(path, 1, { projectId: "project-a" }));
      assert.equal(response.status, 410);
      assert.equal((await response.json()).replacementEndpoint, replacement);
      assert.equal(typeof route.GET, "function", "historical read endpoint remains available");
    }
  } finally { h.cleanup(); }
});

test("registry status updates return the requesting owner's projection, never global taxonomy metadata", async () => {
  const h = await policyHarness();
  try {
    let source = await readFile(resolve("app/api/registry/route.ts"), "utf8");
    source = source.replace('"@/lib/access"', JSON.stringify(h.policyUrl)).replace('"zod/v4"', JSON.stringify(pathToFileURL(resolve("node_modules/zod/v4/index.js")).href));
    source = source.replace('import { listProjects } from "@/lib/projects/repository";', 'const listProjects = async () => [];');
    source = source.replace('import { bootstrapBundledRegistryPackage } from "@/lib/registry/bootstrap";', 'const bootstrapBundledRegistryPackage = async () => {};');
    source = source.replace('import { getRegistryPackage, listRegistryPackages, updateRegistryPackageStatus } from "@/lib/registry/repository";', `
      const listRegistryPackages = async () => [];
      const updateRegistryPackageStatus = async () => ({ roleIdentity: { description: "OTHER_OWNER_PRIVATE_DESCRIPTION" } });
      const getRegistryPackage = async (_id, scope) => ({ roleIdentity: { description: scope?.ownerSubjectId === "learnflow:learner:1" ? "" : "OTHER_OWNER_PRIVATE_DESCRIPTION" } });`);
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const route = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
    const response = await route.PATCH(request("/api/registry", 1, { packageLineId: "line-a", status: "disputed" }, "PATCH"));
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /OTHER_OWNER_PRIVATE_DESCRIPTION/u);
  } finally { h.cleanup(); }
});

test("an owned historical release cannot mutate a package line shared with another owner", async () => {
  const h = await policyHarness();
  try {
    h.db.exec(`INSERT INTO package_releases(id,project_id,package_line_id,snapshot_id,status,artifact_root_hash,published_at,package_version) VALUES ('historical-shared-a','project-a','line-b','snapshot-a','ready','root-a',NULL,'2.0.0');`);
    assert.equal((await h.policy.authorizeApiRequest(request("/api/releases", 1, { action: "publish", releaseId: "historical-shared-a" }, "PATCH")))?.status, 404);
    assert.equal(await h.policy.authorizeApiRequest(request("/api/releases", 1, { action: "publish", releaseId: "release-a" }, "PATCH")), undefined);
  } finally { h.cleanup(); }
});


test("same role results can be prepared independently by two owners using project package identities", async () => {
  const h = await policyHarness();
  try {
    h.db.exec(`INSERT INTO projects VALUES ('same-role-a','learnflow:learner:1',NULL),('same-role-b','learnflow:learner:2',NULL);
      INSERT INTO project_versions VALUES ('same-version-a','same-role-a','same-snapshot-a','{"packages":{"rolePackage":{"packageId":"package-a"}}}'),
      ('same-version-b','same-role-b','same-snapshot-b','{"packages":{"rolePackage":{"packageId":"package-a"}}}');`);
    for (const [user, suffix] of [[1, "a"], [2, "b"]] as const) {
      assert.equal(await h.policy.authorizeApiRequest(request("/api/releases", user, { projectId: `same-role-${suffix}`, projectVersionId: `same-version-${suffix}`, packageVersion: "1.0.0" })), undefined);
    }
    assert.equal((await h.policy.authorizeApiRequest(request("/api/releases", 2, { projectId: "same-role-b", projectVersionId: "same-version-b", packageVersion: "1.0.0", packageId: "package-a" })))?.status, 404, "explicit foreign package remains protected");
    assert.equal((await h.policy.authorizeApiRequest(request("/api/releases", 2, { projectId: "same-role-b", projectVersionId: "same-version-b", packageVersion: "1.0.0", packageId: "role-package:project:same-role-a" })))?.status, 403, "cannot reserve another project's future default namespace");
  } finally { h.cleanup(); }
});

test("Hub 撤回仅允许所有者操作，撤回后匿名导出与快照访问被拒绝", async () => {
  const h = await policyHarness();
  try {
    h.db.exec(`UPDATE package_lines SET visibility='public' WHERE id='line-a';
      UPDATE package_releases SET status='published',published_at='today',artifact_root_hash='root-public' WHERE id='release-a';`);
    const body = { action: "withdraw_from_hub", packageLineId: "line-a", expectedReleaseId: "release-a", expectedRegistryVersion: 1 };
    assert.equal(await h.policy.authorizeApiRequest(request("/api/releases", 1, body, "PATCH")), undefined);
    assert.equal((await h.policy.authorizeApiRequest(request("/api/releases", 2, body, "PATCH")))?.status, 404);
    assert.equal((await h.policy.authorizeApiRequest(request("/api/releases", undefined, body, "PATCH")))?.status, 401);
    assert.equal(await h.policy.authorizeApiRequest(request("/api/releases/release-a/export")), undefined);
    h.db.exec("UPDATE package_lines SET visibility='private' WHERE id='line-a'");
    assert.equal((await h.policy.authorizeApiRequest(request("/api/releases/release-a/export")))?.status, 401);
    assert.equal((await h.policy.authorizeApiRequest(request("/api/snapshots/resolve?snapshotId=snapshot-a")))?.status, 401);
    assert.equal(await h.policy.authorizeApiRequest(request("/api/releases/release-a/export", 1)), undefined);
  } finally { h.cleanup(); }
});

test("Fork 入口允许登录用户复制公共来源，但不能伪造目标所有者或跨站写入", async () => {
  const h = await policyHarness();
  try {
    let source = await readFile(resolve("app/api/hub/fork/route.ts"), "utf8");
    source = source.replace('from "zod/v4"', `from ${JSON.stringify(pathToFileURL(resolve("node_modules/zod/v4/index.js")).href)}`);
    source = source.replace('from "@/lib/access"', `from ${JSON.stringify(h.policyUrl)}`);
    source = source.replace('import { forkPublicRelease } from "@/lib/hub/fork";', `const forkPublicRelease = async input => ({projectId: input.ownerSubjectId,conversationId: "chat-fork"});`);
    source = source.replace(/(["'])@\/([^"']+)\1/gu, (_, _quote, path) => JSON.stringify(pathToFileURL(resolve(`${path}.ts`)).href));
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const route = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
    assert.equal((await route.POST(request("/api/hub/fork",undefined,{releaseId:"release-public"}))).status,401);
    const success=await route.POST(request("/api/hub/fork",2,{releaseId:"release-public"}));
    assert.equal(success.status,200);assert.equal((await success.json()).projectId,"learnflow:learner:2");
    assert.equal((await route.POST(request("/api/hub/fork",2,{releaseId:"release-public",ownerSubjectId:"learnflow:learner:1"}))).status,400);
    const cross=request("/api/hub/fork",2,{releaseId:"release-public"});cross.headers.set("origin","https://foreign.example");
    assert.equal((await route.POST(cross)).status,403);
  } finally {h.cleanup();}
});
