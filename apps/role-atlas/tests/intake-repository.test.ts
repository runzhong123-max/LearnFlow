import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { IntakeRepository } from "@/lib/intake/repository";
import { intakeBuildGuard } from "@/lib/intake/build-guard";
import type { IntakeRevisionContent, IntakeScope, IntakeTurnInput } from "@/lib/intake/types";

async function harness() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,owner_subject_id TEXT,deleted_at TEXT,title TEXT,description TEXT,market TEXT,status TEXT,updated_at TEXT DEFAULT '');
    CREATE TABLE conversations(id TEXT PRIMARY KEY,project_id TEXT,updated_at TEXT);
    CREATE TABLE role_jobs(id TEXT PRIMARY KEY,project_id TEXT,conversation_id TEXT,status TEXT);
    CREATE TABLE build_runs(id TEXT PRIMARY KEY,project_id TEXT);
    CREATE TABLE project_versions(id TEXT PRIMARY KEY,project_id TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,text TEXT,status TEXT,created_at TEXT,activities_json TEXT,citations_json TEXT);
    INSERT INTO projects(id,owner_subject_id,deleted_at,title,description,market,status) VALUES ('project-a','alice',NULL,'云运维工程师','希望了解交付工作','中国大陆','draft'),
      ('project-b','bob',NULL,'软件测试工程师','','中国大陆','draft'),('project-c','carol',NULL,'数据工程师','','中国大陆','draft'),
      ('ownerless',NULL,NULL,'旧项目','','中国大陆','draft'),('deleted','alice','today','已删除','','中国大陆','draft');
    INSERT INTO conversations VALUES('chat-a','project-a',''),('chat-a2','project-a',''),('chat-b','project-b',''),('chat-c','project-c',''),('chat-ownerless','ownerless',''),('chat-deleted','deleted','');`);
  class Statement {
    constructor(readonly query: string, readonly values: Array<string | number | null> = []) {}
    bind(...values: Array<string | number | null>) { return new Statement(this.query, values); }
    async first() { return sql.prepare(this.query).get(...this.values) || null; }
    async all() { return { results: sql.prepare(this.query).all(...this.values), success: true, meta: {} }; }
    execute() { const result = sql.prepare(this.query).run(...this.values); return { results: [], success: true, meta: { changes: Number(result.changes) } }; }
    async run() { return this.execute(); }
  }
  const d1 = {
    prepare(query: string) { return new Statement(query); },
    async batch(statements: Statement[]) {
      sql.exec("BEGIN");
      try { const results = statements.map(statement => statement.execute()); sql.exec("COMMIT"); return results; }
      catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  let now = new Date("2026-09-09T00:00:00.000Z");
  const repository = new IntakeRepository(d1, () => now);
  await repository.ensure();
  return { sql, repository, advance(ms: number) { now = new Date(now.getTime() + ms); }, close() { sql.close(); } };
}
const alice: IntakeScope = { projectId: "project-a", conversationId: "chat-a", subjectId: "alice" };
const turn = (patch: Partial<IntakeTurnInput> = {}): IntakeTurnInput => ({ action: "draft", operationId: "operation-one", message: "希望理解实际交付工作", roleTitle: "云运维工程师", market: "中国大陆", sources: [], ...patch });
const content = (patch: Partial<IntakeRevisionContent> = {}): IntakeRevisionContent => ({ phase: "review", roleTitle: "云运维工程师", market: "中国大陆", goal: "实际交付工作", description: "岗位概述\n云平台运行维护\n主要任务\n部署、监控、故障处理\n能力要求\n诊断与协作\n典型工作场景\n上线与故障恢复", assistantMessage: "请确认范围或提出改进。", questions: [], sources: [], hubMatches: [], warnings: [], researchStatus: "complete", ...patch });
async function draft(h: Awaited<ReturnType<typeof harness>>, scope = alice, input = turn()) {
  const result = await h.repository.begin(scope, input);
  assert.ok("claim" in result);
  const view = await h.repository.complete(scope, result.claim, content());
  return { claim: result.claim, view };
}

test("intake reads and operations isolate three actors, ownerless, deleted, and mixed conversations", async () => {
  const h = await harness();
  try {
    for (const [subjectId, key] of [["alice", "a"], ["bob", "b"], ["carol", "c"]]) {
      const scope = { subjectId, projectId: `project-${key}`, conversationId: `chat-${key}` };
      assert.equal((await h.repository.get(scope)).revisionId, null);
      for (const other of ["a", "b", "c"].filter(id => id !== key)) {
        const foreign = { ...scope, projectId: `project-${other}`, conversationId: `chat-${other}` };
        await assert.rejects(h.repository.get(foreign), { code: "INTAKE_NOT_FOUND" });
        await assert.rejects(h.repository.begin(foreign, turn()), { code: "INTAKE_NOT_FOUND" });
      }
    }
    for (const scope of [{ ...alice, conversationId: "chat-b" }, { ...alice, projectId: "ownerless", conversationId: "chat-ownerless" }, { ...alice, projectId: "deleted", conversationId: "chat-deleted" }]) await assert.rejects(h.repository.get(scope), { code: "INTAKE_NOT_FOUND" });
    const { view } = await draft(h);
    await assert.rejects(h.repository.confirm({ ...alice, subjectId: "bob" }, { revisionId: view.revisionId!, contentHash: view.contentHash!, operationId: "confirm-one" }), { code: "INTAKE_NOT_FOUND" });
    await assert.rejects(h.repository.requireConfirmed({ ...alice, subjectId: "carol" }, { revisionId: view.revisionId!, contentHash: view.contentHash!, runId: "run-one" }), { code: "INTAKE_NOT_FOUND" });
  } finally { h.close(); }
});

test("lost success responses replay one revision and credentials never enter persisted input", async () => {
  const h = await harness();
  try {
    const input = turn({ providerConfig: { apiKey: "private-provider-secret" }, searchConfig: { apiKey: "private-search-secret" } });
    const { view } = await draft(h, alice, input);
    const retry = await h.repository.begin(alice, { ...input, providerConfig: { apiKey: "rotated-secret" } });
    assert.ok("completed" in retry);
    assert.equal(retry.completed.revisionId, view.revisionId);
    assert.equal(retry.completed.contentHash, view.contentHash);
    assert.equal(h.sql.prepare("SELECT count(*) n FROM role_intake_revisions").get()?.n, 1);
    assert.equal(h.sql.prepare("SELECT count(*) n FROM messages").get()?.n, 2);
    assert.doesNotMatch(String(h.sql.prepare("SELECT input_json FROM role_intake_revisions").get()?.input_json), /secret|apiKey|providerConfig|searchConfig/);
    await assert.rejects(h.repository.begin(alice, { ...input, message: "改为算法研发" }), { code: "INTAKE_OPERATION_CONFLICT" });
  } finally { h.close(); }
});

test("failed generation retains original materials and retries the same operation without another revision", async () => {
  const h = await harness();
  try {
    const input = turn({ sources: [{ title: "公司资料", content: "原始岗位要求，需进一步核实。", kind: "private_document" }] });
    const begin = await h.repository.begin(alice, input); assert.ok("claim" in begin);
    await h.repository.fail(alice, begin.claim, "本轮超时，资料已保留。");
    const saved = await h.repository.get(alice);
    assert.deepEqual(saved.sources, input.sources);
    assert.match(saved.warnings.join(""), /资料已保留/);
    const retry = await h.repository.begin(alice, input); assert.ok("claim" in retry);
    assert.equal(retry.claim.revisionId, begin.claim.revisionId);
    await h.repository.complete(alice, retry.claim, content({ sources: input.sources! }));
    assert.equal(h.sql.prepare("SELECT count(*) n FROM role_intake_revisions").get()?.n, 1);
    assert.equal(h.sql.prepare("SELECT count(*) n FROM messages WHERE role='user'").get()?.n, 1);
  } finally { h.close(); }
});

test("one live operation owns a conversation and expired attempts cannot publish late results", async () => {
  const h = await harness();
  try {
    const first = await h.repository.begin(alice, turn()); assert.ok("claim" in first);
    await assert.rejects(h.repository.begin(alice, turn({ operationId: "operation-two" })), { code: "INTAKE_OPERATION_ACTIVE" });
    await assert.rejects(h.repository.begin(alice, turn()), { code: "INTAKE_OPERATION_ACTIVE" });
    h.advance(181_000);
    const resumed = await h.repository.begin(alice, turn()); assert.ok("claim" in resumed);
    await assert.rejects(h.repository.complete(alice, first.claim, content({ roleTitle: "迟到旧结果" })), { code: "INTAKE_STALE_OPERATION" });
    const view = await h.repository.complete(alice, resumed.claim, content({ roleTitle: "恢复后的结果" }));
    assert.equal(view.roleTitle, "恢复后的结果");
  } finally { h.close(); }
});

test("confirmation binds exact content and a stable build ID across repeated clicks and operation IDs", async () => {
  const h = await harness();
  try {
    const { view } = await draft(h);
    const ref = { revisionId: view.revisionId!, contentHash: view.contentHash!, operationId: "confirm-one", buildRunId: "build-one" };
    await assert.rejects(h.repository.confirm(alice, { ...ref, contentHash: "f".repeat(64) }), { code: "INTAKE_REVISION_CONFLICT" });
    const confirmed = await h.repository.confirm(alice, ref);
    assert.equal(confirmed.phase, "confirmed");
    assert.equal(confirmed.buildRunId, "build-one");
    const repeated = await h.repository.confirm(alice, { ...ref, operationId: "confirm-two", buildRunId: "build-two" });
    assert.equal(repeated.buildRunId, "build-one");
    assert.equal((await h.repository.requireConfirmed(alice, { ...ref, runId: "build-one" })).description, content().description);
    await assert.rejects(h.repository.requireConfirmed(alice, { ...ref, runId: "build-two" }), { code: "INTAKE_BUILD_ID_CONFLICT" });
    h.sql.prepare("UPDATE role_intake_revisions SET result_json=? WHERE id=?").run(JSON.stringify(content({ description: "altered" })), ref.revisionId);
    await assert.rejects(h.repository.requireConfirmed(alice, { ...ref, runId: "build-one" }), { code: "INTAKE_CONTENT_MISMATCH" });
  } finally { h.close(); }
});

test("refresh restores failed refinement and expired input without replacing the completed draft", async () => {
  const h = await harness();
  try {
    const { view } = await draft(h);
    const input = turn({ action: "refine", operationId: "refine-recover", expectedRevisionId: view.revisionId,
      roleTitle: "云平台交付工程师", message: "按新上传资料改进", sources: [{ title: "新增资料", content: "交付与支持的原始记录。", kind: "private_document" }] });
    const begin = await h.repository.begin(alice, input); assert.ok("claim" in begin);
    await h.repository.fail(alice, begin.claim, "整理失败，输入已保留。");
    const refreshed = await h.repository.get(alice);
    assert.equal(refreshed.roleTitle, view.roleTitle);
    assert.deepEqual(refreshed.sources, view.sources);
    assert.deepEqual(refreshed.recovery?.input, input);
    assert.equal(refreshed.recovery?.state, "failed");
    const resumed = await h.repository.begin(alice, refreshed.recovery!.input); assert.ok("claim" in resumed);
    assert.equal(resumed.claim.revisionId, begin.claim.revisionId);
    const final = await h.repository.complete(alice, resumed.claim, content({ sources: input.sources! }));
    assert.equal(final.recovery, undefined);

    const other = { ...alice, conversationId: "chat-a2" };
    const initial = turn({ operationId: "initial-interrupted", sources: input.sources, providerConfig: { apiKey: "secret" } });
    const pending = await h.repository.begin(other, initial); assert.ok("claim" in pending);
    assert.equal((await h.repository.get(other)).recovery, undefined);
    h.advance(181_000);
    const interrupted = await h.repository.get(other);
    assert.equal(interrupted.recovery?.state, "interrupted");
    assert.equal(interrupted.recovery?.revisionId, pending.claim.revisionId);
    assert.deepEqual(interrupted.sources, input.sources);
    assert.equal(interrupted.recovery?.input.operationId, initial.operationId);
    assert.doesNotMatch(JSON.stringify(interrupted.recovery), /apiKey|secret/);
    await assert.rejects(h.repository.get({ ...other, subjectId: "bob" }), { code: "INTAKE_NOT_FOUND" });
  } finally { h.close(); }
});

test("refinement invalidates confirmation and the atomic build predicate rejects the stale admission", async () => {
  const h = await harness();
  try {
    const { view } = await draft(h);
    const ref = { revisionId: view.revisionId!, contentHash: view.contentHash!, operationId: "confirm-one", buildRunId: "build-one" };
    await h.repository.confirm(alice, ref);
    const guard = intakeBuildGuard({ ...alice, ...ref, runId: "build-one" });
    const eligible = () => h.sql.prepare(`SELECT 1 AS ok WHERE ${guard.sql}`).get(...guard.bindings)?.ok || 0;
    const insert = (patch: Partial<Parameters<typeof intakeBuildGuard>[0]> = {}) => {
      const fence = intakeBuildGuard({ ...alice, ...ref, runId: "build-one", ...patch });
      return h.sql.prepare(`INSERT OR IGNORE INTO role_jobs(id,project_id,conversation_id,status)
        SELECT 'build-one','project-a','chat-a','queued' WHERE ${fence.sql}`).run(...fence.bindings).changes;
    };
    assert.equal(eligible(), 1);
    assert.equal(insert({ subjectId: "bob" }), 0);
    assert.equal(insert({ runId: "forged-run" }), 0);
    assert.equal(insert({ conversationId: "chat-a2" }), 0);
    assert.equal(insert(), 1);
    await assert.rejects(h.repository.begin(alice, turn({ action: "refine", operationId: "queued-refine", expectedRevisionId: view.revisionId })), { code: "INTAKE_BUILD_ACTIVE" });
    h.sql.exec("DELETE FROM role_jobs WHERE id='build-one'");
    const next = await h.repository.begin(alice, turn({ action: "refine", operationId: "refine-one", expectedRevisionId: view.revisionId, message: "只看公有云交付" }));
    assert.ok("claim" in next);
    assert.equal(eligible(), 0);
    assert.equal(insert(), 0, "an already-read confirmation cannot enqueue after a refinement claimed the head");
    await assert.rejects(h.repository.requireConfirmed(alice, { ...ref, runId: "build-one" }), { code: "INTAKE_CONFIRMATION_REQUIRED" });
    await assert.rejects(h.repository.confirm(alice, ref), { code: "INTAKE_REVISION_CONFLICT" });
    const changed = await h.repository.complete(alice, next.claim, content({ description: content().description + "\n范围仅公有云" }));
    assert.notEqual(changed.contentHash, view.contentHash);
    await assert.rejects(h.repository.confirm(alice, ref), { code: "INTAKE_REVISION_CONFLICT" });
    await assert.rejects(h.repository.begin(alice, turn({ operationId: "stale-new", expectedRevisionId: view.revisionId })), { code: "INTAKE_REVISION_CONFLICT" });
  } finally { h.close(); }
});

test("confirming an empty project saves the chosen role boundary but does not rename an existing snapshot project", async () => {
  const h = await harness();
  try {
    h.sql.exec("UPDATE projects SET title='待明确的岗位' WHERE id='project-a'");
    const { view } = await draft(h);
    assert.equal(h.sql.prepare("SELECT title FROM projects WHERE id='project-a'").get()?.title, "待明确的岗位");
    await h.repository.confirm(alice, { revisionId: view.revisionId!, contentHash: view.contentHash!, operationId: "confirm-one", buildRunId: "build-one" });
    assert.deepEqual({ ...h.sql.prepare("SELECT title,description,market FROM projects WHERE id='project-a'").get() }, { title: content().roleTitle, description: content().description, market: content().market });
    h.sql.exec("INSERT INTO project_versions VALUES ('version-one','project-a')");
    const next = await h.repository.begin(alice, turn({ operationId: "next-turn", expectedRevisionId: view.revisionId })); assert.ok("claim" in next);
    const nextView = await h.repository.complete(alice, next.claim, content({ roleTitle: "另一岗位方向" }));
    await h.repository.confirm(alice, { revisionId: nextView.revisionId!, contentHash: nextView.contentHash!, operationId: "confirm-next", buildRunId: "build-next" });
    assert.equal(h.sql.prepare("SELECT title FROM projects WHERE id='project-a'").get()?.title, content().roleTitle);
  } finally { h.close(); }
});

test("queued/running work and changed ownership prevent edits and late writes", async () => {
  const h = await harness();
  try {
    for (const status of ["queued", "running", "waiting_user"]) {
      h.sql.prepare("INSERT OR REPLACE INTO role_jobs VALUES ('active','project-a','chat-a',?)").run(status);
      await assert.rejects(h.repository.begin(alice, turn()), { code: "INTAKE_BUILD_ACTIVE" });
    }
    h.sql.exec("DELETE FROM role_jobs; UPDATE projects SET status='building' WHERE id='project-a'");
    await assert.rejects(h.repository.begin(alice, turn()), { code: "INTAKE_BUILD_ACTIVE" });
    h.sql.exec("UPDATE projects SET status='draft' WHERE id='project-a'");
    const begun = await h.repository.begin(alice, turn()); assert.ok("claim" in begun);
    h.sql.exec("UPDATE projects SET owner_subject_id='bob' WHERE id='project-a'");
    await assert.rejects(h.repository.complete(alice, begun.claim, content()), { code: "INTAKE_STALE_OPERATION" });
    assert.equal(h.sql.prepare("SELECT count(*) n FROM messages WHERE role='assistant'").get()?.n, 0);
  } finally { h.close(); }
});

test("clarification results cannot be confirmed or substituted across same-owner conversations", async () => {
  const h = await harness();
  try {
    const begun = await h.repository.begin(alice, turn({ action: "clarify" })); assert.ok("claim" in begun);
    const view = await h.repository.complete(alice, begun.claim, content({ phase: "clarifying", questions: ["更偏研发还是运维？"] }));
    const ref = { revisionId: view.revisionId!, contentHash: view.contentHash!, operationId: "confirm-one" };
    await assert.rejects(h.repository.confirm(alice, ref), { code: "INTAKE_NOT_REVIEWABLE" });
    await assert.rejects(h.repository.confirm({ ...alice, conversationId: "chat-a2" }, ref), { code: "INTAKE_NOT_FOUND" });
    await assert.rejects(h.repository.confirm({ subjectId: "bob", projectId: "project-b", conversationId: "chat-b" }, ref), { code: "INTAKE_NOT_FOUND" });
  } finally { h.close(); }
});
