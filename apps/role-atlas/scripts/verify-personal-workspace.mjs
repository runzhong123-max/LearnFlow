/** Isolated HTTP acceptance: three identities, real routes and disposable D1.
 * No real sessions, database or provider keys are used. --keep-open leaves the
 * local preview running for browser verification (Ctrl-C to stop).
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, open, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = await mkdtemp(resolve(tmpdir(), "role-atlas-personal-"));
const keepOpen = process.argv.includes("--keep-open");
const listen = (server) => new Promise((done) => server.listen(0, "127.0.0.1", done));
const auth = createServer((request, response) => {
  const id = Number(/atlas_verify_user=([123])(?:;|$)/.exec(request.headers.cookie || "")?.[1]);
  response.setHeader("Content-Type", "application/json");
  if (request.url !== "/api/auth/me" || !id) {
    response.writeHead(401).end(JSON.stringify({ detail: "TEST_SESSION_REQUIRED" }));
    return;
  }
  response.end(JSON.stringify({ id, learner_id: id, username: `tester${id}`, display_name: `测试员 ${id}`, role: "user" }));
});
await listen(auth);
const portProbe = createServer();
await listen(portProbe);
const port = portProbe.address().port;
await new Promise((done) => portProbe.close(done));
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env };
for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|BASE_URL|PUBLIC_URL/.test(key)) env[key] = "";
for (const key of ["MIMO_API_KEY", "DEEPSEEK_API_KEY", "TAVILY_API_KEY", "EXA_API_KEY", "BOCHA_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY", "ROLE_PACKAGE_LAUNCH_SECRET", "ROLE_ATLAS_GATEWAY_SECRET"]) env[key] = "";
Object.assign(env, { LEARNFLOW_BASE_URL: `http://127.0.0.1:${auth.address().port}`, LEARNFLOW_PUBLIC_URL: `http://127.0.0.1:${auth.address().port}`, ROLE_ATLAS_PUBLIC_URL: base, ROLE_ATLAS_STATE_DIR: stateDir, ROLE_ATLAS_GATEWAY_ONLY: "", NODE_ENV: "development" });
const log = await open(resolve(stateDir, "server.log"), "w");
const server = spawn(process.execPath, ["node_modules/vinext/dist/cli.js", "dev", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: appRoot, env, stdio: ["ignore", log.fd, log.fd], detached: true });
function stop() {
  try { process.kill(-server.pid, "SIGTERM"); } catch { /* already stopped */ }
  auth.close();
  void log.close();
}
process.once("SIGINT", () => { stop(); process.exit(0); });
process.once("SIGTERM", () => { stop(); process.exit(0); });

async function api(user, path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(user ? { cookie: `atlas_verify_user=${user}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), origin: base }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { text: text.slice(0, 400) }; }
  return { status: response.status, data };
}
function status(result, expected, label) {
  assert.equal(result.status, expected, `${label}: ${JSON.stringify(result.data).slice(0, 300)}`);
  return result.data;
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (server.exitCode !== null) throw new Error(`Preview exited: ${server.exitCode}; see ${stateDir}/server.log`);
    try { if ((await fetch(`${base}/api/runtime-config`, { signal: AbortSignal.timeout(2_000) })).ok) { ready = true; break; } } catch { /* server starting */ }
    await delay(1_000);
  }
  assert.ok(ready, `Preview did not start; see ${stateDir}/server.log`);
  console.log(`PREVIEW ${base}\nSTATE ${stateDir}\nBrowser test cookie: atlas_verify_user=1`);
  status(await api(null, "/api/projects"), 401, "anonymous list denied");
  for (const user of [1, 2, 3]) {
    status(await api(user, "/api/projects", "POST", { id: `verify-project-${user}`, conversationId: `verify-conversation-${user}`, title: `测试员 ${user} 的岗位`, market: "中国大陆" }), 201, "owned project created");
  }
  for (const user of [1, 2, 3]) {
    const projects = status(await api(user, "/api/projects"), 200, "personal list").projects;
    assert.deepEqual(projects.map((p) => p.id), [`verify-project-${user}`]);
    for (const owner of [1, 2, 3]) {
      const same = owner === user;
      status(await api(user, `/api/projects/verify-project-${owner}`), same ? 200 : 404, "project ownership");
      status(await api(user, `/api/conversations/verify-conversation-${owner}/messages`), same ? 200 : 404, "conversation ownership");
      if (!same) {
        status(await api(user, `/api/projects/verify-project-${owner}/conversations`, "POST", { id: `foreign-${user}-${owner}` }), 404, "foreign conversation write");
        status(await api(user, `/api/projects/verify-project-${owner}`, "DELETE"), 404, "foreign deletion");
        status(await api(user, `/api/releases?projectId=verify-project-${owner}`), 404, "foreign releases");
      }
    }
    const registry = status(await api(user, "/api/registry"), 200, "personal center");
    assert.deepEqual(registry.projects.map((p) => p.id), [`verify-project-${user}`]);
  }
  for (const mode of ["explanation", "iteration"]) {
    status(await api(1, "/api/projects/verify-project-1/conversations", "POST", { id: `verify-${mode}`, title: mode, mode }), 201, "new conversation mode");
  }
  const workspace = status(await api(1, "/api/projects/verify-project-1"), 200, "conversation reload");
  for (const mode of ["explanation", "iteration"]) assert.equal(workspace.conversations.find((c) => c.id === `verify-${mode}`)?.mode, mode);
  status(await api(1, "/api/projects/verify-project-1", "DELETE"), 200, "soft delete");
  status(await api(1, "/api/projects/verify-project-1"), 404, "deleted project hidden");
  assert.equal(status(await api(1, "/api/projects/trash"), 200, "owned trash").projects.length, 1);
  assert.equal(status(await api(2, "/api/projects/trash"), 200, "other trash").projects.length, 0);
  status(await api(2, "/api/projects/verify-project-1", "PATCH", { action: "restore" }), 404, "foreign restore");
  status(await api(1, "/api/projects/verify-project-1", "PATCH", { action: "restore" }), 200, "owned restore");
  const restored = status(await api(1, "/api/projects/verify-project-1"), 200, "restored project");
  assert.equal(restored.conversations.length, workspace.conversations.length);
  status(await api(null, "/api/hub/search"), 200, "public discovery");
  // A reviewed bundled snapshot is a test fixture, never generated evidence.
  // Seed only the disposable database created above so visual/version checks need no model.
  status(await api(1, "/api/projects", "POST", { id: "verify-graph-project", conversationId: "verify-graph-main", title: "验收图谱 · 大模型应用工程师" }), 201, "graph fixture project");
  status(await api(1, "/api/projects/verify-graph-project/conversations", "POST", { id: "verify-graph-branch", title: "并行候选", mode: "iteration" }), 201, "graph fixture conversation");
  status(await api(2, "/api/projects", "POST", { id: "verify-same-role-project", conversationId: "verify-same-role-chat", title: "验收图谱 · 大模型应用工程师" }), 201, "second owner with identical role");
  const fixture = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "-e", 'import { bundledRoleSnapshot } from "./lib/snapshots/bundled-role-adapter.ts"; console.log(JSON.stringify(bundledRoleSnapshot()))'], { cwd: appRoot, encoding: "utf8", maxBuffer: 10_000_000 }));
  const dbFile = (await readdir(stateDir, { recursive: true })).find((file) => /v3\/d1\/[^/]+\/[a-f0-9]{64}\.sqlite$/.test(file));
  assert.ok(dbFile, "disposable D1 file exists");
  const db = new DatabaseSync(resolve(stateDir, dbFile));
  try {
    assert.equal(db.prepare("SELECT owner_subject_id FROM projects WHERE id='verify-graph-project'").get()?.owner_subject_id, "learnflow:learner:1");
    const now = new Date().toISOString();
    for (const suffix of ["a", "b"]) {
      const id = `verify-graph-version-${suffix}`, run = `verify-graph-run-${suffix}`;
      db.prepare("INSERT INTO build_runs(id,project_id,status,input_json,result_json,started_at,completed_at) VALUES(?,?,'completed','{}',?,?,?)").run(run, "verify-graph-project", JSON.stringify(fixture), now, now);
      db.prepare("INSERT INTO project_versions(id,project_id,build_run_id,source_run_id,source_kind,version,snapshot_id,status,root_hash,message,author_kind,package_json,created_at) VALUES(?,?,?,?,?, ?,?,'ready',?,?, 'system',?,?)").run(id, "verify-graph-project", run, run, "import", `verification-${suffix}`, fixture.snapshot.id, suffix.repeat(64), "隔离验收使用的内置公开样例", JSON.stringify(fixture), now);
    }
    db.prepare("UPDATE projects SET head_version_id=?,active_version_id=?,status='ready' WHERE id=?").run("verify-graph-version-a", "verify-graph-version-a", "verify-graph-project");
    for (const [conversation, suffix] of [["verify-graph-main", "a"], ["verify-graph-branch", "b"]]) db.prepare("UPDATE conversations SET snapshot_id=?,version_id=? WHERE id=?").run(fixture.snapshot.id, `verify-graph-version-${suffix}`, conversation);
    db.prepare("INSERT INTO build_runs(id,project_id,status,input_json,result_json,started_at,completed_at) VALUES('verify-same-role-run','verify-same-role-project','completed','{}',?,?,?)").run(JSON.stringify(fixture), now, now);
    db.prepare("INSERT INTO project_versions(id,project_id,build_run_id,source_run_id,source_kind,version,snapshot_id,status,root_hash,message,author_kind,package_json,created_at) VALUES('verify-same-role-version','verify-same-role-project','verify-same-role-run','verify-same-role-run','import','verification-c',?,'ready',?,'同岗位不同用户隔离验收','system',?,?)").run(fixture.snapshot.id, "c".repeat(64), JSON.stringify(fixture), now);
    db.prepare("UPDATE projects SET head_version_id='verify-same-role-version',active_version_id='verify-same-role-version',status='ready' WHERE id='verify-same-role-project'").run();
    db.prepare("UPDATE conversations SET version_id='verify-same-role-version',snapshot_id=? WHERE id='verify-same-role-chat'").run(fixture.snapshot.id);
  } finally { db.close(); }
  status(await api(2, "/api/projects/verify-graph-project/versions"), 404, "private graph versions isolated");
  status(await api(1, "/api/projects/verify-graph-project/versions/verify-graph-version-b/adopt", "POST", { expectedHeadVersionId: null }), 409, "outdated head preserves candidate");
  const releaseInput = { action: "prepare", projectId: "verify-graph-project", projectVersionId: "verify-graph-version-a", packageVersion: "1.0.0", visibility: "private", evidencePolicy: "metadata" };
  const prepared = status(await api(1, "/api/releases", "POST", releaseInput), 201, "compile private package").release;
  assert.equal(prepared.status, "ready");
  status(await api(1, "/api/releases", "PATCH", { action: "publish", releaseId: prepared.id }), 200, "save private package");
  assert.equal(status(await api(1, "/api/releases", "POST", releaseInput), 201, "same publish request is idempotent").release.id, prepared.id);
  status(await api(1, "/api/releases", "POST", { ...releaseInput, visibility: "public" }), 409, "visibility change cannot reuse old release");
  status(await api(1, "/api/releases", "POST", { ...releaseInput, projectVersionId: "verify-graph-version-b" }), 409, "changed candidate requires new release version");
  status(await api(2, `/api/releases/${prepared.id}/export`), 404, "private package export isolated");
  assert.ok(status(await api(1, "/api/registry"), 200, "private package in personal center").packages.some((p) => p.id === prepared.packageLineId));
  assert.ok(!JSON.stringify(status(await api(null, "/api/hub/search?q=大模型应用工程师"), 200, "public discovery excludes private package")).includes(prepared.id));
  const second = status(await api(2, "/api/releases", "POST", { ...releaseInput, projectId: "verify-same-role-project", projectVersionId: "verify-same-role-version" }), 201, "identical role names have independent package lines").release;
  assert.equal(second.status, "ready");
  assert.notEqual(second.packageLineId, prepared.packageLineId);
  status(await api(2, "/api/releases", "PATCH", { action: "publish", releaseId: second.id }), 200, "second owner saves own role package");
  status(await api(1, `/api/releases/${second.id}/export`), 404, "same-role package remains private");
  console.log("PASS: three-user ownership; private center and exports; same-role independent packages; private publish and retry conflicts; conversation modes; soft delete/restore; expected-HEAD conflicts; public discovery.");
  if (keepOpen) {
    console.log(`Browser entry: ${base}/projects/verify-project-1?conversation=verify-iteration`);
    console.log(`Graph entry: ${base}/projects/verify-graph-project?conversation=verify-graph-main`);
    await new Promise(() => {});
  }
} finally { stop(); }
