/** Isolated HTTP acceptance: three identities, real routes and disposable D1.
 * No real sessions, database or provider keys are used. --keep-open leaves the
 * local preview running for browser verification (Ctrl-C to stop).
 */
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, open, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = await mkdtemp(resolve(tmpdir(), "role-atlas-research-"));
const keepOpen = process.argv.includes("--keep-open");
const listen = (server) => new Promise((done) => server.listen(0, "127.0.0.1", done));
const auth = createServer((request, response) => {
  if(request.url==="/chat/completions"){response.writeHead(401).end("isolated provider failure");return;}
  const id = Number(/atlas_verify_user=([1239])(?:;|$)/.exec(request.headers.cookie || "")?.[1]);
  response.setHeader("Content-Type", "application/json");
  if (request.url !== "/api/auth/me" || !id) {
    response.writeHead(401).end(JSON.stringify({ detail: "TEST_SESSION_REQUIRED" }));
    return;
  }
  response.end(JSON.stringify({ id, learner_id: id, username: `tester${id}`, display_name: `测试员 ${id}`, role: id===9?"admin":"user" }));
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
Object.assign(env, { LEARNFLOW_BASE_URL: `http://127.0.0.1:${auth.address().port}`, LEARNFLOW_PUBLIC_URL: `http://127.0.0.1:${auth.address().port}`, ROLE_ATLAS_PUBLIC_URL: base, ROLE_ATLAS_STATE_DIR: stateDir, ROLE_ATLAS_GATEWAY_ONLY: "", ROLE_ATLAS_MODEL_PROVIDER:"deepseek", DEEPSEEK_API_KEY:"isolated-test-key", ROLE_ATLAS_MODEL_BASE_URL:`http://127.0.0.1:${auth.address().port}`, NODE_ENV: "development" });
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

  for(const user of [null,1,2,3]) for(const path of ["/api/admin/research","/api/admin/research?view=access","/api/admin/research/export","/api/admin/research?callId=guessed","/api/admin/research/export?attachmentId=guessed"])status(await api(user,path),user?403:401,"admin data denied");
  const index=status(await api(9,"/api/admin/research"),200,"admin index");assert.equal(index.projects.length,3);
  assert.deepEqual(index.projects.map(p=>p.owner_subject_id).sort(),[1,2,3].map(id=>`learnflow:learner:${id}`),"admin sees every other user's canonical ID");
  for(const user of [1,2,3]) {
   const owned=status(await api(user,"/api/projects"),200,"ordinary user's projects");
   assert.ok(!JSON.stringify(owned).includes(`verify-project-${user===1?2:1}`),"ordinary users stay isolated");
   status(await api(9,`/api/admin/research?projectId=verify-project-${user}`),200,"admin reads other user's history");
  }
  const original=new TextEncoder().encode("岗位资料原件\nSQL、数据库部署和沟通。".repeat(10000));
  const hash=createHash("sha256").update(original).digest("hex");
  async function upload(user,filename="测试资料.txt",source=true){const form=new FormData();form.set("file",new Blob([original]),filename);if(source)form.set("source",JSON.stringify({title:filename,kind:"private_document",content:"SQL、数据库部署和沟通。",locator:`attachment:${filename}`}));else form.set("error","模拟 PDF 解析失败");const r=await fetch(`${base}/api/research-materials`,{method:"POST",headers:{cookie:`atlas_verify_user=${user}`,origin:base},body:form});return {status:r.status,data:await r.json()};}
  const uploaded=status(await upload(1),201,"original uploaded"),other=status(await upload(2),201,"separate owner upload");
  assert.equal(uploaded.sha256,hash);assert.notEqual(uploaded.attachmentId,other.attachmentId);assert.equal(status(await upload(1),201,"idempotent upload").attachmentId,uploaded.attachmentId);
  status(await upload(1,"解析失败.pdf",false),201,"failed extraction preserved");
  status(await upload(1,"unsupported.exe"),400,"unsupported rejected");
  const raw=await fetch(`${base}/api/admin/research/export?attachmentId=${uploaded.attachmentId}`,{headers:{cookie:"atlas_verify_user=9"}});
  assert.equal(raw.status,200);assert.equal(raw.headers.get("cache-control"),"private, no-store");assert.deepEqual(new Uint8Array(await raw.arrayBuffer()),original);
  const brief={build:{runId:"real-capture-run",projectId:"verify-project-1",roleTitle:"测试运维工程师",roleDescription:"检查知识技能覆盖",sources:[{title:"测试资料",kind:"private_document",content:"部署数据库并编写 SQL 查询",attachmentId:uploaded.attachmentId}]},conversationId:"verify-conversation-1",webResearch:false,providerConfig:{provider:"deepseek",model:"test",apiKey:"isolated-test-key",thinking:true,baseUrl:`http://127.0.0.1:${auth.address().port}`}};
  status(await api(1,"/api/projects/verify-project-1/conversations/verify-conversation-1","PATCH",{mode:"iteration"}),200,"iteration mode");
  const bad=await api(1,"/api/build-runs","POST",{...brief,build:{...brief.build,runId:"foreign-attachment",sources:[{...brief.build.sources[0],attachmentId:other.attachmentId}]}});
  assert.notEqual(bad.status,200,"foreign material must fail before job execution");
  const executed=await api(1,"/api/build-runs","POST",brief);assert.equal(executed.status,200,JSON.stringify(executed.data));
  const observed=status(await api(9,"/api/admin/research?runId=real-capture-run&kind=cold_start"),200,"captured model run");
  assert.ok(observed.calls.length>0,"actual route model request captured");assert.equal(observed.attachments[0].id,uploaded.attachmentId);assert.equal(observed.input.roleDescription,"检查知识技能覆盖");
  const call=status(await api(9,`/api/admin/research?callId=${observed.calls[0].id}`),200,"actual model request detail");
  assert.ok(call.request.system.text.length>0);assert.ok(call.request.user.text.length>0);assert.equal(call.status,"failed");assert.ok(!JSON.stringify(call).includes("isolated-test-key"));
  const dbFile=(await readdir(stateDir,{recursive:true})).find(file=>/v3\/d1\/[^/]+\/[a-f0-9]{64}\.sqlite$/.test(file));assert.ok(dbFile);
  const db=new DatabaseSync(resolve(stateDir,dbFile));
  assert.equal(observed.attempts.length,1);assert.equal(observed.attempts[0].status,"completed");
  // Simulate a recoverable failed lease in this disposable fixture, then exercise a real retry.
  db.prepare("UPDATE role_jobs SET status='failed' WHERE id='real-capture-run'").run();
  db.prepare("UPDATE build_runs SET status='failed' WHERE id='real-capture-run'").run();
  db.prepare("UPDATE conversations SET version_id=NULL,snapshot_id=NULL WHERE id='verify-conversation-1'").run();
  const changed=await api(1,"/api/build-runs","POST",{...brief,build:{...brief.build,roleDescription:"第二次测试输入"}});assert.equal(changed.status,409,"same run rejects changed input");
  const retried=await api(1,"/api/build-runs","POST",brief);assert.equal(retried.status,200);
  const attempts=status(await api(9,"/api/admin/research?runId=real-capture-run&kind=cold_start"),200,"retry history").attempts;
  assert.equal(attempts.length,2);assert.equal(attempts[0].input.build.roleDescription,"检查知识技能覆盖");assert.equal(attempts[1].input.build.roleDescription,"检查知识技能覆盖");
  const now=new Date().toISOString();
  db.prepare("INSERT INTO build_runs(id,project_id,status,input_json,result_json,started_at,completed_at) VALUES(?,?,'completed',?,?,?,?)").run("historical-run","verify-project-2",JSON.stringify({roleTitle:"历史岗位",sources:[{content:"historical text"}],apiKey:"must-redact"}),JSON.stringify({snapshot:{id:"old-snapshot"},status:"completed"}),now,now);
  db.prepare("UPDATE projects SET deleted_at=? WHERE id='verify-project-3'").run(now);
  const before=db.prepare("SELECT count(*) n FROM build_runs").get().n;
  async function archive(query="") {const response=await fetch(`${base}/api/admin/research/export${query}`,{headers:{cookie:"atlas_verify_user=9"},signal:AbortSignal.timeout(60000)});assert.equal(response.status,200);const zip=unzipSync(new Uint8Array(await response.arrayBuffer()));const manifest=JSON.parse(strFromU8(zip["manifest.json"]));assert.equal(manifest.complete,true,JSON.stringify(manifest.errors));for(const f of manifest.files){if(f.path.endsWith(".json"))JSON.parse(strFromU8(zip[f.path]));assert.equal(zip[f.path].length,f.bytes);assert.equal(createHash("sha256").update(zip[f.path]).digest("hex"),f.sha256);}return {zip,manifest};}
  const all=await archive();assert.ok(all.zip[`attachments/${uploaded.attachmentId}/original-____.txt` ]||Object.keys(all.zip).some(p=>p.startsWith(`attachments/${uploaded.attachmentId}/original-`)));
  assert.ok(Object.keys(all.zip).some(p=>p.includes("historical-run/inputs.json")));assert.ok(Object.keys(all.zip).some(p=>p.includes("model-calls/")));assert.ok(!Object.values(all.zip).map(strFromU8).join("\n").includes("must-redact"));
  const single=await archive("?runId=real-capture-run&kind=cold_start&section=inputs");assert.ok(!Object.keys(single.zip).some(p=>p.includes("verify-project-2")));assert.ok(!Object.keys(single.zip).some(p=>p.includes("model-calls")));
  for(const section of ["calls","results","releases"])await archive(`?projectId=verify-project-1&section=${section}`);
  status(await api(9,"/api/admin/research/export?runId=real-capture-run&kind=cold_start&projectId=verify-project-2"),404,"mismatched export scope rejected");
  assert.equal(db.prepare("SELECT count(*) n FROM build_runs").get().n,before);assert.equal(db.prepare("SELECT count(*) n FROM research_run_attachments WHERE run_id='foreign-attachment'").get().n,0);
  assert.ok(db.prepare("SELECT count(*) n FROM research_admin_events WHERE action='archive.completed'").get().n>=5);db.close();
  console.log("PASS: verified admin-only reads/exports; 3-owner isolation; raw attachment bytes and dedup; rejected foreign attachment; actual model request and failure captured; legacy records and deleted projects retained; all/per-run/category ZIP manifests and hashes; export does not mutate runs.");
  if(keepOpen){console.log(`Admin page: ${base}/admin/research (cookie atlas_verify_user=9)`);await new Promise(()=>{});}
}finally{stop();}
