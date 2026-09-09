import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { automaticMountDelegation, automaticMountEndpoint, requestAutomaticMount } from "@/lib/learning-path/automatic-client";
import { automaticMountEnqueueStatement, automaticMountSchema, eligibleAutomaticMount, supersedeAutomaticMounts } from "@/lib/learning-path/automatic-schema";
import { AUTOMATIC_MOUNT_POLICY, learningMountFeedback } from "@/lib/learning-path/automatic-contract";
import { sha256Hex } from "@/lib/versioning/canonical";

const secret = "fixture-only-automatic-learning-secret-32";
const packageRef = { packageId: "role:one", packageVersion: "1.0.0", snapshotId: "snapshot:one", rootHash: "a".repeat(64) };
const input = { requestId: "mount:version1", packageRef, projectId: "project:one", projectVersionId: "version1", sourceRunId: "run1", policyVersion: AUTOMATIC_MOUNT_POLICY };

test("automatic delegation has distinct direction and binds exact body, actor, expiry and request", async () => {
  const body = JSON.stringify(input), token = await automaticMountDelegation(secret, "learnflow:learner:7", input.requestId, body, 100);
  const [encoded, signature] = token.split(".");
  assert.equal(signature, createHmac("sha256", secret).update(encoded).digest("hex"));
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64url").toString()), { v: 1, iss: "role-atlas", aud: "learnflow-curriculum", sub: "learnflow:learner:7", iat: 100, exp: 160, requestId: input.requestId, bodyHash: await sha256Hex(body) });
  await assert.rejects(automaticMountDelegation(secret, "admin", input.requestId, body));
  for (const url of ["https://user:pass@learnflow.club", "https://learnflow.club/path", "http://unknown.example", "https://learnflow.club?target=other"]) assert.throws(() => automaticMountEndpoint(url));
  assert.equal(automaticMountEndpoint("http://learnflow-backend:8000").pathname, "/api/ecosystem/learning-path/automatic");
});

test("automatic client never sends credentials and rejects another version or mutation-bearing receipt", async () => {
  const data = { status: "completed", packageRef, points: [], receipts: [{ receiptId: "receipt1", graphRef: { graphId: "graph", revision: "rev" }, addedNodeIds: [], masteryUnchanged: true }], unresolved: [] };
  const config = { baseUrl: "https://learnflow.club", subject: "learnflow:learner:7", secret };
  let calls = 0;
  const fetcher = async function(this: unknown, path: RequestInfo | URL, init?: RequestInit) {
    assert.equal(this, undefined); calls++;
    assert.equal(String(path), "https://learnflow.club/api/ecosystem/learning-path/automatic");
    const headers = new Headers(init?.headers);
    assert.equal(headers.has("cookie"), false); assert.equal(headers.has("authorization"), false);
    assert.ok(headers.has("x-role-atlas-delegation")); assert.equal(init?.redirect, "manual");
    return Response.json({ protocol: "learnflow-ecosystem/v1", requestId: input.requestId, ok: true, data });
  };
  assert.deepEqual(await requestAutomaticMount(input, config, fetcher), data); assert.equal(calls, 1);
  await assert.rejects(requestAutomaticMount(input, config, async () => Response.json({ protocol: "learnflow-ecosystem/v1", requestId: input.requestId, ok: true, data: { ...data, packageRef: { ...packageRef, snapshotId: "other" } } })), /版本或协议/);
  await assert.rejects(requestAutomaticMount(input, config, async () => Response.json({ protocol: "learnflow-ecosystem/v1", requestId: input.requestId, ok: true, data: { ...data, receipts: [{ masteryUnchanged: false }] } })), /版本或协议/);
});

test("version outbox insertion is idempotent, excludes restores and follows durable ownership fences", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,owner_subject_id TEXT,deleted_at TEXT);
    CREATE TABLE conversations(id TEXT PRIMARY KEY,project_id TEXT,version_id TEXT);
    CREATE TABLE role_jobs(id TEXT PRIMARY KEY,project_id TEXT,conversation_id TEXT,status TEXT);
    CREATE TABLE project_versions(id TEXT PRIMARY KEY,project_id TEXT,snapshot_id TEXT,source_run_id TEXT,source_kind TEXT);
    ${automaticMountSchema};
    INSERT INTO projects VALUES('p','learnflow:learner:1',NULL);
    INSERT INTO project_versions VALUES('v','p','s','r','iteration'),('restored','p','s','r2','restore');`);
  const d1 = { prepare(query: string) { const statement = db.prepare(query); return { bind(...values: unknown[]) { return { run: async () => statement.run(...values as never[]) }; } }; } } as unknown as D1Database;
  for (const versionId of ["v", "v", "restored"]) await automaticMountEnqueueStatement(d1, { versionId, projectId: "p", now: "2026-01-01" }).run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM role_learning_mounts").get()?.n, 1);
  const eligible = () => db.prepare(`SELECT m.id FROM role_learning_mounts m JOIN projects p ON p.id=m.project_id JOIN project_versions v ON v.id=m.project_version_id WHERE ${eligibleAutomaticMount}`).all("2026-01-02", "2026-01-02").length;
  assert.equal(eligible(), 1);
  db.exec("INSERT INTO role_jobs VALUES('job','p',NULL,'running')"); assert.equal(eligible(), 0);
  db.exec("UPDATE role_jobs SET status='completed'"); assert.equal(eligible(), 1);
  for (const [mutation, restore] of [
    ["UPDATE projects SET owner_subject_id='learnflow:learner:2'", "UPDATE projects SET owner_subject_id='learnflow:learner:1'"],
    ["UPDATE projects SET deleted_at='2026-01-01'", "UPDATE projects SET deleted_at=NULL"],
    ["UPDATE role_learning_mounts SET status='running',lease_expires_at='2026-01-03'", "UPDATE role_learning_mounts SET status='queued',lease_expires_at=NULL"],
    ["UPDATE role_learning_mounts SET attempt=8", "UPDATE role_learning_mounts SET attempt=0"],
    ["UPDATE role_learning_mounts SET status='completed'", "UPDATE role_learning_mounts SET status='queued'"],
  ]) { db.exec(mutation); assert.equal(eligible(), 0); db.exec(restore); }
  db.exec("UPDATE role_learning_mounts SET status='running',lease_expires_at='2026-01-01'");
  assert.equal(eligible(), 1, "worker restart recovers the same outbox identity"); db.close();
});

test("research feedback keeps unresolved node identities and never invents mastery", () => {
  const feedback = learningMountFeedback({ id: "m", projectVersionId: "v", snapshotId: "s", attempt: 1, status: "partial", result: { status: "partial", packageRef, points: [], receipts: [], unresolved: [{ roleNodeId: "skill:one", reason: "needs_evidence" }] } });
  assert.equal(feedback[0].roleNodeId, "skill:one"); assert.match(feedback[0].researchGoal, /证据/); assert.equal("mastery" in feedback[0], false);
});


test("multi-stage production waits for the final conversation version and keeps prior committed bindings", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,owner_subject_id TEXT,deleted_at TEXT);
    CREATE TABLE conversations(id TEXT PRIMARY KEY,project_id TEXT,version_id TEXT);
    CREATE TABLE role_jobs(id TEXT PRIMARY KEY,project_id TEXT,conversation_id TEXT,status TEXT);
    CREATE TABLE project_versions(id TEXT PRIMARY KEY,project_id TEXT,snapshot_id TEXT,source_run_id TEXT,source_kind TEXT);
    ${automaticMountSchema};
    INSERT INTO projects VALUES('p','learnflow:learner:1',NULL);
    INSERT INTO conversations VALUES('c','p','kernel');
    INSERT INTO role_jobs VALUES('job','p','c','running');`);
  const d1 = { prepare(query: string) { const statement = db.prepare(query); return { bind(...values: unknown[]) { return { run: async () => statement.run(...values as never[]) }; } }; } } as unknown as D1Database;
  const eligible = () => db.prepare(`SELECT m.project_version_id FROM role_learning_mounts m JOIN projects p ON p.id=m.project_id JOIN project_versions v ON v.id=m.project_version_id WHERE ${eligibleAutomaticMount}`).all("2026-01-02", "2026-01-02").map(row => row.project_version_id);
  for (const versionId of ["before", "kernel", "full", "deep", "repair"]) {
    db.prepare("INSERT INTO project_versions VALUES(?,'p',?,'r','cold_start')").run(versionId, "s:" + versionId);
    await automaticMountEnqueueStatement(d1, { versionId, projectId: "p", conversationId: "c", now: "2026-01-01" }).run();
    if (versionId === "before") db.exec("UPDATE role_learning_mounts SET status='completed',result_json='immutable-old-receipt' WHERE project_version_id='before'");
    db.prepare("UPDATE conversations SET version_id=? WHERE id='c'").run(versionId);
    assert.deepEqual(eligible(), []);
  }
  db.prepare(supersedeAutomaticMounts).run("2026-01-02");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM role_learning_mounts WHERE status='superseded'").get()?.n, 3);
  assert.equal(db.prepare("SELECT result_json FROM role_learning_mounts WHERE project_version_id='before'").get()?.result_json, "immutable-old-receipt");
  db.exec("UPDATE role_jobs SET status='completed'"); assert.deepEqual(eligible(), ["repair"]);
  db.exec("INSERT INTO conversations VALUES('other','p','parallel'); INSERT INTO project_versions VALUES('parallel','p','s:p','r:p','iteration'); INSERT INTO role_jobs VALUES('other-job','p','other','running')");
  await automaticMountEnqueueStatement(d1, { versionId: "parallel", projectId: "p", conversationId: "other", now: "2026-01-01" }).run();
  db.prepare(supersedeAutomaticMounts).run("2026-01-02");
  assert.deepEqual(eligible(), ["repair"], "another conversation neither supersedes nor blocks this final version");
  db.close();
});
