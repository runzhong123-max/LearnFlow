import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { dispatchSchema, eligibleDispatch } from "@/lib/jobs/dispatch-schema";
import { sealJobEnvelope, openJobEnvelope, signJobWorkerRequest, verifyJobWorkerRequest } from "@/lib/jobs/dispatch-protocol";
import { jobDisplayStatus, jobConnectionMessage } from "@/lib/jobs/presentation";
const secret = "test-only-worker-secret-32-characters-long";

test("internal dispatch signature binds method/path/time and rejects browser identity headers", async () => {
  const path = "/api/internal/role-jobs/j1", time = String(Date.now());
  const signature = await signJobWorkerRequest(secret, "POST", path, time);
  const headers = { "x-role-worker-time": time, "x-role-worker-signature": signature };
  assert.equal(await verifyJobWorkerRequest(new Request(`http://localhost${path}`, { method: "POST", headers }), secret), true);
  for (const [method, target] of [["GET",path],["POST",path+"2"]]) assert.equal(await verifyJobWorkerRequest(new Request(`http://localhost${target}`, { method, headers }), secret), false);
  assert.equal(await verifyJobWorkerRequest(new Request(`http://localhost${path}`, { method: "POST", headers }), secret, Number(time)+61_000), false);
  assert.equal(await verifyJobWorkerRequest(new Request(`http://localhost${path}`, { headers: { "x-role-admin": "true" } }), secret), false);
});

test("execution credentials are encrypted and bound to one job; tamper and key rotation fail closed", async () => {
  const value = { providerConfig: { apiKey: "private-override" }, iteration: { prompt: "研究" } };
  const cipher = await sealJobEnvelope(value,secret,"job1");
  assert.ok(!cipher.includes("private-override"));
  assert.deepEqual(await openJobEnvelope(cipher,secret,"job1"),value);
  await assert.rejects(openJobEnvelope(cipher,secret,"job2"));
  await assert.rejects(openJobEnvelope(cipher,secret+"changed","job1"));
});

test("queue recovery survives consumer restart but excludes live, cancelled, stale-base, foreign and exhausted jobs", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,owner_subject_id TEXT,deleted_at TEXT);
    CREATE TABLE conversations(id TEXT PRIMARY KEY,project_id TEXT,mode TEXT,version_id TEXT);
    CREATE TABLE role_jobs(id TEXT PRIMARY KEY,project_id TEXT,conversation_id TEXT,status TEXT,lease_expires_at TEXT,base_version_id TEXT);
    ${dispatchSchema};
    INSERT INTO projects VALUES('p','alice',NULL);
    INSERT INTO conversations VALUES('c','p','iteration','v1');
    INSERT INTO role_jobs VALUES('j','p','c','running','2026-01-01','v1');
    INSERT INTO role_job_dispatch(job_id,endpoint,actor_json,envelope,state,deliveries,available_at,claimed_until,created_at,updated_at)
    VALUES('j','/api/snapshot-iterations','{"subjectId":"alice"}','encrypted','active',1,'2026-01-01','2026-01-01','2026-01-01','2026-01-01');`);
  const eligible = () => db.prepare(`SELECT d.job_id FROM role_job_dispatch d JOIN role_jobs j ON j.id=d.job_id JOIN projects p ON p.id=j.project_id JOIN conversations c ON c.id=j.conversation_id WHERE ${eligibleDispatch}`).all("2026-01-02","2026-01-02","2026-01-02").length;
  assert.equal(eligible(),1);
  for (const [mutation,restore] of [
    ["UPDATE role_jobs SET lease_expires_at='2026-01-03'","UPDATE role_jobs SET lease_expires_at='2026-01-01'"],
    ["UPDATE role_jobs SET status='cancelled'","UPDATE role_jobs SET status='running'"],
    ["UPDATE role_jobs SET status='completed'","UPDATE role_jobs SET status='running'"],
    ["UPDATE role_jobs SET status='failed'","UPDATE role_jobs SET status='running'"],
    ["UPDATE conversations SET version_id='v2'","UPDATE conversations SET version_id='v1'"],
    ["UPDATE projects SET owner_subject_id='bob'","UPDATE projects SET owner_subject_id='alice'"],
    ["UPDATE projects SET deleted_at='2026-01-02'","UPDATE projects SET deleted_at=NULL"],
    ["UPDATE role_job_dispatch SET deliveries=3","UPDATE role_job_dispatch SET deliveries=1"],
  ]) { db.exec(mutation); assert.equal(eligible(),0,mutation); db.exec(restore); }
  db.close();
});

test("interruption never looks completed; known queued recovery and fetch errors are explicit", () => {
  assert.equal(jobDisplayStatus({status:"running",resumable:true}),"interrupted");
  assert.equal(jobDisplayStatus({status:"running",resumable:true,recovery:{state:"active",deliveries:1}}),"recovering");
  assert.equal(jobDisplayStatus({status:"running",resumable:true,recovery:{state:"active",deliveries:3}}),"interrupted");
  assert.equal(jobDisplayStatus({status:"completed"}),"completed");
  assert.match(jobConnectionMessage(new TypeError("Load failed")),/正在核对后台任务状态/);
});
