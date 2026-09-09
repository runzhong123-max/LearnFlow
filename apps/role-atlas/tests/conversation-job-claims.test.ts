import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { roleJobClaimStatements, type JobClaim } from "@/lib/jobs/claim-transaction";

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, deleted_at TEXT);
    CREATE TABLE conversations(id TEXT PRIMARY KEY,project_id TEXT,mode TEXT DEFAULT 'explanation', version_id TEXT);
    CREATE TABLE role_jobs(id TEXT PRIMARY KEY,kind TEXT,thread_id TEXT,project_id TEXT,conversation_id TEXT,base_snapshot_id TEXT,base_version_id TEXT,
      status TEXT,phase TEXT,attempt INTEGER,input_json TEXT,lease_owner TEXT,lease_expires_at TEXT,error TEXT,completed_at TEXT,created_at TEXT,updated_at TEXT);
    CREATE UNIQUE INDEX active_conversation ON role_jobs(conversation_id) WHERE conversation_id IS NOT NULL AND status IN ('running','waiting_user');
    INSERT INTO projects VALUES('p1',NULL),('p2',NULL);
    INSERT INTO conversations VALUES('c1','p1','iteration','v1'),('c2','p1','iteration','v1'),('c3','p2','iteration','v1'),('read','p1','explanation','v1');`);
  const d1 = { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }) } as unknown as D1Database;
  function claim(patch: Partial<JobClaim> = {}) {
    const input: JobClaim = { id: "j1", kind: "snapshot_iteration", threadId: "j1", owner: "worker1", projectId: "p1", conversationId: "c1",
      baseSnapshotId: "s1", baseVersionId: "v1", phase: "contract", payloadJson: "{}", now: "2026-09-07T00:00:00Z", expiresAt: "2026-09-07T00:01:00Z", ...patch };
    db.exec("BEGIN");
    try {
      const changes = roleJobClaimStatements(d1, input).map(value => {
        const statement = value as unknown as { sql: string; values: (string | number | null)[] };
        return db.prepare(statement.sql).run(...statement.values).changes;
      });
      db.exec("COMMIT");
      return Number(changes.at(-1));
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return { db, claim };
}

test("two conversations iterate independently while a second job in the same conversation is refused", () => {
  const { db, claim } = setup();
  try {
    assert.equal(claim(), 1);
    assert.equal(claim({ id: "j2", threadId: "j2", conversationId: "c2", owner: "worker2" }), 1);
    assert.equal(claim({ id: "j3", threadId: "j3", owner: "worker3" }), 0);
    assert.equal(db.prepare("SELECT count(*) n FROM role_jobs WHERE status='running'").get()?.n, 2);
    assert.equal(db.prepare("SELECT id FROM role_jobs WHERE id='j3'").get(), undefined);
  } finally { db.close(); }
});

test("a reused run cannot change project, conversation, kind, baseline or input", () => {
  const { db, claim } = setup();
  try {
    claim();
    db.exec("UPDATE role_jobs SET status='failed',lease_owner=NULL");
    for (const patch of [{ projectId: "p2", conversationId: "c3" }, { conversationId: "c2" }, { kind: "cold_start" }, { baseSnapshotId: "s2" }, { baseVersionId: "v2" }, { payloadJson: '{"new":true}' }]) {
      assert.equal(claim(patch), 0);
    }
    assert.equal(claim({ owner: "retry-worker" }), 1);
    assert.equal(db.prepare("SELECT attempt FROM role_jobs WHERE id='j1'").get()?.attempt, 2);
  } finally { db.close(); }
});

test("explanation conversations, foreign conversations and deleted projects cannot claim mutation work", () => {
  const { db, claim } = setup();
  try {
    assert.equal(claim({ conversationId: "read" }), 0);
    assert.equal(claim({ conversationId: "c3" }), 0);
    db.exec("UPDATE projects SET deleted_at='deleted' WHERE id='p1'");
    assert.equal(claim(), 0);
    assert.equal(db.prepare("SELECT count(*) n FROM role_jobs").get()?.n, 0);
  } finally { db.close(); }
});

test("terminal jobs cannot restart; expired worker loses its fencing token before another job is admitted", () => {
  const { db, claim } = setup();
  try {
    claim();
    assert.equal(claim({ owner: "duplicate" }), 0);
    assert.equal(claim({ id: "j2", threadId: "j2", now: "2026-09-07T00:02:00Z", expiresAt: "2026-09-07T00:03:00Z" }), 1);
    assert.equal(db.prepare("SELECT lease_owner FROM role_jobs WHERE id='j1'").get()?.lease_owner, null);
    db.exec("UPDATE role_jobs SET status='completed',lease_owner=NULL WHERE id='j2'");
    assert.equal(claim({ id: "j2", threadId: "j2" }), 0);
    db.exec("UPDATE role_jobs SET status='cancelled' WHERE id='j1'");
    assert.equal(claim(), 0);
  } finally { db.close(); }
});


test("a changed conversation baseline cannot start a stale job after another task completed", () => {
  const { db, claim } = setup();
  try {
    db.exec("UPDATE conversations SET version_id='v2' WHERE id='c1'");
    assert.equal(claim(), 0);
    assert.equal(db.prepare("SELECT count(*) n FROM role_jobs").get()?.n, 0);
    assert.equal(claim({ baseVersionId: "v2" }), 1);
  } finally { db.close(); }
});

test("confirmation admission is checked in the job insert transaction, while an admitted job keeps its immutable input", () => {
  const { db, claim } = setup();
  try {
    db.exec("CREATE TABLE confirmed_briefs(revision TEXT, run_id TEXT); INSERT INTO confirmed_briefs VALUES('r2','j1')");
    const fence = (revision: string) => ({ sql: "EXISTS(SELECT 1 FROM confirmed_briefs WHERE revision=? AND run_id=?)", bindings: [revision, "j1"] });
    assert.equal(claim({ insertionFence: fence("r1") }), 0);
    assert.equal(db.prepare("SELECT count(*) n FROM role_jobs").get()?.n, 0);
    assert.equal(claim({ insertionFence: fence("r2") }), 1);
    // A later revision cannot retroactively rewrite a previously admitted job.
    db.exec("UPDATE confirmed_briefs SET revision='r3'; UPDATE role_jobs SET status='failed',lease_owner=NULL");
    assert.equal(claim({ owner: "durable-retry" }), 1);
    assert.equal(db.prepare("SELECT input_json FROM role_jobs").get()?.input_json, "{}");
  } finally { db.close(); }
});
