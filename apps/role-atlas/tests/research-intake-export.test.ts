import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { unzipSync, strFromU8 } from "fflate";
import { exportArchive, type ExportScope } from "@/lib/research-collection/export";
import { projects, runs, detail, runKind } from "@/lib/research-collection/query";
import { collectionSchema } from "@/lib/research-collection/schema";
import { intakeSchema } from "@/lib/intake/schema";
import { pathToken, sha256 } from "@/lib/research-collection/format";

async function harness(withIntake = true) {
  const sql = new DatabaseSync(":memory:"), queries: string[] = [];
  sql.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,title TEXT,owner_subject_id TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,head_version_id TEXT);
    INSERT INTO projects VALUES('project-a','云运维工程师','alice','2026-09-09','2026-09-09',NULL,NULL),('project-b','软件测试工程师','bob','2026-09-09','2026-09-09',NULL,NULL);
    CREATE TABLE conversations(id TEXT PRIMARY KEY,project_id TEXT); INSERT INTO conversations VALUES('chat-a','project-a'),('chat-b','project-b');
    CREATE TABLE messages(id TEXT,conversation_id TEXT);
    CREATE TABLE role_jobs(id TEXT,project_id TEXT,input_json TEXT,conversation_id TEXT,base_version_id TEXT,base_snapshot_id TEXT,kind TEXT,attempt INTEGER);
    CREATE TABLE project_versions(id TEXT,project_id TEXT,source_run_id TEXT,snapshot_id TEXT,parent_version_id TEXT);
    CREATE TABLE semantic_diffs(project_id TEXT); CREATE TABLE project_version_events(project_id TEXT);
    CREATE TABLE package_releases(id TEXT,project_id TEXT,source_project_version_id TEXT); CREATE TABLE release_events(project_id TEXT,release_id TEXT);`);
  for (const name of ["build_runs", "snapshot_iteration_runs", "workspace_ingestion_runs", "snapshot_risk_runs", "risk_runs"])
    sql.exec(`CREATE TABLE ${name}(id TEXT,project_id TEXT,status TEXT,started_at TEXT,completed_at TEXT,error TEXT,input_json TEXT,result_json TEXT,checkpoint_json TEXT,base_snapshot_id TEXT)`);
  for (const name of ["build_events", "snapshot_iteration_events", "workspace_ingestion_events", "snapshot_risk_events", "risk_events"])
    sql.exec(`CREATE TABLE ${name}(run_id TEXT,seq INTEGER,kind TEXT,created_at TEXT)`);
  sql.exec(collectionSchema.join(";"));
  sql.exec("INSERT INTO research_testers VALUES('alice','tester-a','测试员 A','now'),('bob','tester-b','测试员 B','now')");
  const bytes = new TextEncoder().encode("岗位说明原始附件"), hash = await sha256(bytes);
  sql.prepare("INSERT INTO research_attachments VALUES(?,?,?,?,?,?,?,?)").run("attachment-a", "alice", "source.txt", "text/plain", bytes.length, hash, "{}", "2026-09-09");
  if (withIntake) {
    sql.exec(intakeSchema.join(";"));
    const material = { title: "用户材料", kind: "private_document", sourceTier: "contextual", content: "云平台告警处置经验", attachmentId: "attachment-a" };
    const source = { title: "独立招聘资料", kind: "public_document", sourceTier: "primary", content: "云平台监控和告警响应职责", locator: "https://careers.example.org/cloud", queryIds: ["query-one"] };
    const insert = sql.prepare(`INSERT INTO role_intake_revisions(id,conversation_id,project_id,operation_id,input_hash,input_json,base_revision_id,state,result_json,error,confirmed_by,confirmed_at,build_run_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run("intake:one", "chat-a", "project-a", "op-one", "hash-one", JSON.stringify({ action: "clarify", message: "维护云平台是什么岗位", sources: [material], providerConfig: { apiKey: "never-export-provider" } }), null, "ready", JSON.stringify({ phase: "clarifying", questions: [], roleCandidates: [{ title: "云运维工程师", reason: "工作内容相符" }], sources: [material, source], researchSources: [source], researchReport: { queries: [{ id: "query-one" }] } }), null, null, null, null, "2026-09-09T01:00:00Z", "2026-09-09T01:01:00Z");
    insert.run("intake:two", "chat-a", "project-a", "op-two", "hash-two", JSON.stringify({ action: "draft", roleTitle: "云运维工程师", message: "明确职责边界" }), "intake:one", "ready", JSON.stringify({ phase: "review", description: "岗位说明等待确认", sources: [material, source], researchSources: [source] }), null, "alice", "2026-09-09T01:04:00Z", "build-linked", "2026-09-09T01:02:00Z", "2026-09-09T01:04:00Z");
    insert.run("intake:failed", "chat-a", "project-a", "op-three", "hash-three", JSON.stringify({ action: "refine", message: "只保留公有云", sources: [material], searchConfig: { apiKey: "never-export-search" } }), "intake:two", "failed", null, "搜索超时，输入已保留", null, null, null, "2026-09-09T01:05:00Z", "2026-09-09T01:06:00Z");
    insert.run("intake:running", "chat-b", "project-b", "op-other", "hash-other", JSON.stringify({ action: "clarify", message: "软件质量岗位" }), null, "running", null, null, null, null, null, "2026-09-09T01:07:00Z", "2026-09-09T01:07:00Z");
    sql.exec("INSERT INTO role_intakes VALUES('chat-a','project-a','intake:two',NULL,'intake:two','2026-09-09','2026-09-09')");
    sql.exec("INSERT INTO research_run_attachments VALUES('intake:one','project-a','attachment-a'),('intake:failed','project-a','attachment-a')");
    sql.prepare("INSERT INTO research_model_calls(id,run_id,project_id,provider,model,request_json,response_json,status,started_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("call-one", "intake:one", "project-a", "deepseek", "test-model", JSON.stringify({ system: "澄清助手", user: "维护云平台是什么岗位", providerConfig: { apiKey: "never-export-call" } }), JSON.stringify({ text: "候选云运维工程师" }), "completed", "2026-09-09T01:00:01Z", "2026-09-09T01:00:02Z");
  }
  class Statement {
    constructor(readonly query: string, readonly values: unknown[] = []) {}
    bind(...values: unknown[]) { return new Statement(this.query, values); }
    async first() { queries.push(this.query); return sql.prepare(this.query).get(...this.values as never[]) || null; }
    async all() { queries.push(this.query); return { results: sql.prepare(this.query).all(...this.values as never[]), success: true, meta: {} }; }
  }
  const database = async () => ({ prepare(query: string) { return new Statement(query); } }) as unknown as D1Database;
  const dependencies = { database, attachmentBytes: async (requested: string) => { assert.equal(requested, hash); return bytes; } };
  return { sql, queries, database, dependencies, bytes, close() { sql.close(); } };
}
const base = (id: string) => `projects/project-a/runs/intake-${pathToken(id)}`;
async function archive(h: Awaited<ReturnType<typeof harness>>, scope: ExportScope) {
  let audit: unknown;
  const bytes = new Uint8Array(await new Response(exportArchive(scope, async result => { audit = result; }, h.dependencies)).arrayBuffer());
  const files = unzipSync(bytes), json = (path: string) => JSON.parse(strFromU8(files[path]));
  const manifest = json("manifest.json"); assert.equal(manifest.complete, true, JSON.stringify(manifest.errors)); assert.ok(audit);
  for (const entry of manifest.files) assert.equal(await sha256(files[entry.path]), entry.sha256);
  return { files, json, manifest };
}

test("admin project counts and details include all intake states, inputs and confirmation lineage without schema writes", async () => {
  const h = await harness();
  try {
    assert.equal(runKind("intake"), "intake");
    const index = await projects(h.database); assert.equal(index.find(row => row.id === "project-a")?.run_count, 3); assert.equal(index.find(row => row.id === "project-b")?.run_count, 1);
    const list = await runs("project-a", h.database); assert.equal(list.length, 3); assert.equal(list[0].status, "failed"); assert.equal(list[1].action, "draft");
    const d = await detail("intake", "intake:two", h.database) as Record<string, any>; assert.equal(d.base_revision_id, "intake:one"); assert.equal(d.confirmed_by, "alice"); assert.equal(d.build_run_id, "build-linked");
    assert.equal(d.intakeState.confirmed_revision_id, "intake:two"); assert.equal(d.eventCount, 0); assert.equal(d.attachments.length, 1);
    const failed = await detail("intake", "intake:failed", h.database) as Record<string, any>; assert.equal(failed.state, "failed"); assert.match(String(failed.error), /输入已保留/);
    const running = await runs("project-b", h.database); assert.equal(running[0].completed_at, null); assert.ok(h.queries.every(query => /^\s*SELECT\b/iu.test(query)));
  } finally { h.close(); }
});

test("project and one-click ZIP exports retain intake inputs, independent sources, model calls, failed revisions and confirmation links", async () => {
  const h = await harness();
  try {
    const p = await archive(h, { projectId: "project-a", section: "all" });
    assert.equal(p.json(`${base("intake:one")}/inputs.json`).message, "维护云平台是什么岗位");
    assert.equal(p.json(`${base("intake:one")}/sources.json`).independentResearch[0].kind, "public_document");
    assert.equal(p.json(`${base("intake:one")}/model-calls/000001.json`).request.user, "维护云平台是什么岗位");
    assert.equal(p.json(`${base("intake:one")}/research-report.json`).queries[0].id, "query-one");
    assert.equal(p.json(`${base("intake:two")}/run.json`).build_run_id, "build-linked");
    assert.equal(p.json(`${base("intake:failed")}/result.json`), null); assert.equal(p.json(`${base("intake:failed")}/run.json`).state, "failed");
    assert.deepEqual(p.files["attachments/attachment-a/original-source.txt"], h.bytes);
    assert.ok(Object.keys(p.files).every(path => !path.startsWith("projects/project-b")));
    assert.doesNotMatch(Object.values(p.files).map(bytes => strFromU8(bytes)).join("\n"), /never-export-(?:provider|search|call)/);
    const all = await archive(h, { section: "all" }); assert.ok(all.files[`projects/project-b/runs/intake-${pathToken("intake:running")}/inputs.json`]);
  } finally { h.close(); }
});

test("single intake and category exports stay scoped, and pre-intake databases return an empty history", async () => {
  const h = await harness(), legacy = await harness(false);
  try {
    const input = await archive(h, { projectId: "project-a", kind: "intake", runId: "intake:one", section: "inputs" });
    assert.ok(input.files[`${base("intake:one")}/inputs.json`]); assert.ok(input.files[`${base("intake:one")}/sources.json`]);
    assert.ok(!input.files[`${base("intake:one")}/result.json`]); assert.ok(!input.files[`${base("intake:one")}/model-calls/000001.json`]);
    assert.ok(!input.files[`${base("intake:two")}/run.json`]);
    const inherited = await archive(h, { projectId: "project-a", kind: "intake", runId: "intake:two", section: "inputs" });
    assert.deepEqual(inherited.files["attachments/attachment-a/original-source.txt"], h.bytes);
    const calls = await archive(h, { projectId: "project-a", kind: "intake", runId: "intake:one", section: "calls" });
    assert.ok(calls.files[`${base("intake:one")}/model-calls/000001.json`]); assert.ok(!calls.files[`${base("intake:one")}/inputs.json`]);
    assert.deepEqual(await runs("project-a", legacy.database), []); assert.equal(await detail("intake", "missing", legacy.database), null);
    assert.ok((await projects(legacy.database)).every(project => project.run_count === 0));
    await archive(legacy, { projectId: "project-a", section: "all" });
    assert.equal(legacy.sql.prepare("SELECT name FROM sqlite_master WHERE name='role_intake_revisions'").get(), undefined);
    assert.ok(legacy.queries.every(query => /^\s*SELECT\b/iu.test(query)));
  } finally { h.close(); legacy.close(); }
});
