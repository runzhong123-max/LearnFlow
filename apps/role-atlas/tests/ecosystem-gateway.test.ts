import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { PROTOCOL, verifyDelegation, readBoundedBody, type GatewayRequest } from "../lib/ecosystem/protocol";
import { dispatchGateway, type AgentRun, type GatewayRepository } from "../lib/ecosystem/service";
import { createEcosystemRepository } from "../lib/ecosystem/repository-core";
import { resolveRoleLearningPoints } from "../lib/learning-path/resolution";
import { bundledRoleSnapshot } from "../lib/snapshots/bundled-role-adapter";
import { sha256Hex } from "../lib/versioning/canonical";
import type { LearningPathGraphV2 } from "../lib/learning-path/contract";
const actor = { sub: "learnflow:learner:1", role: "user" as const };
const packageRef = { packageId: "role:test", packageVersion: "1.0.0", snapshotId: "snapshot:test", rootHash: "a".repeat(64) };
const secret = "fixture-secret-with-at-least-32-characters";
async function signed(body: string, patch = {}) {
  const data = JSON.parse(body); const claims = { v: 1, iss: "learnflow", aud: "role-atlas", sub: actor.sub, role: actor.role, iat: 100, exp: 160, requestId: data.requestId, bodyHash: await sha256Hex(body), ...patch };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url"); return encoded + "." + createHmac("sha256", secret).update(encoded).digest("hex");
}
test("delegation binds raw bytes, actor, audience, expiry and request identity", async () => {
  const input: GatewayRequest = { protocol: PROTOCOL, requestId: "request:1", operation: "catalog.search", payload: {} };
  const raw = JSON.stringify(input), token = await signed(raw);
  assert.deepEqual(await verifyDelegation(token, raw, input, secret, 120), actor);
  for (const [body, data, signature, now] of [[raw + " ", input, token, 120], [raw, { ...input, requestId: "request:2" }, token, 120], [raw, input, token, 160], [raw, input, await signed(raw, { aud: "other" }), 120], [raw, input, await signed(raw, { exp: 180 }), 120]] as const) {
    await assert.rejects(verifyDelegation(signature, body, data, secret, now));
  }
});
test("actual body bytes are bounded even without content-length", async () => {
  await assert.rejects(readBoundedBody(new Request("http://localhost", { method: "POST", body: "abcdef" }), 5), /BODY_TOO_LARGE/);
});
function fixture() {
  const result = structuredClone(bundledRoleSnapshot());
  const point = result.semantic.nodes.find(n => n.type === "knowledge_skill")!;
  point.label = "数据库事务隔离级别"; point.summary = "说明隔离级别对并发读写可见性的约束。"; point.learningKind = "knowledge";
  point.learningDefinition = { scopeNote: "限于关系数据库事务。", assessmentCriteria: ["根据并发时序辨别读现象。"] };
  const binding = result.sources.evidenceBindings.find(b => b.targetId === point.id)!;
  assert.ok(binding); binding.supportRole = "supports"; binding.assertionType = "direct_fact";
  point.evidenceBindingIds = [binding.id];
  const graph = JSON.parse(readFileSync(new URL("../public/data/learnflow-learning-path.v2.json", import.meta.url), "utf8")) as LearningPathGraphV2;
  const anchor = graph.nodes.find(n => n.kind === "course")!;
  anchor.title = "数据库"; anchor.aliases = []; graph.nodes = [anchor]; graph.edges = [];
  return { result, graph, point };
}
test("explicit atomic point creates additive candidate and only becomes a live binding after materialization", async () => {
  const { result, graph, point } = fixture();
  const input = { result, graph, packageRef, namespace: "learnflow:extension:test", targetIds: [point.id] };
  const resolved = await resolveRoleLearningPoints(input);
  assert.equal(resolved.unresolved.length, 0);
  assert.equal(resolved.alignment.bindings.length, 0);
  assert.equal(resolved.pendingBindings.length, 1);
  const proposal = resolved.extensionProposal!;
  assert.equal(proposal.nodes[0].title, point.label);
  assert.deepEqual(proposal.nodes[0].atomic, point.learningDefinition);
  const merged = { ...graph, nodes: [...graph.nodes, ...proposal.nodes], edges: [...graph.edges, ...proposal.edges], sources: [...graph.sources, ...proposal.sources] };
  const again = await resolveRoleLearningPoints({ ...input, graph: merged });
  assert.equal(again.alignment.bindings.length, 1); assert.equal(again.extensionProposal, undefined);
  point.learningDefinition!.scopeNote = "另一种范围，不能只凭标题等同。";
  const conflict = await resolveRoleLearningPoints({ ...input, graph: merged });
  assert.equal(conflict.unresolved[0].reason, "ambiguous_definition");
});
test("coarse legacy nodes, missing evidence and missing definitions remain explicit unresolved items", async () => {
  const { result, graph, point } = fixture();
  const input = { result, graph, packageRef, namespace: "learnflow:extension:test", targetIds: [point.id] };
  point.learningKind = "hybrid";
  assert.equal((await resolveRoleLearningPoints(input)).unresolved[0].reason, "needs_decomposition");
  point.learningKind = "knowledge"; point.learningDefinition = undefined;
  assert.equal((await resolveRoleLearningPoints(input)).unresolved[0].reason, "needs_definition");
  point.learningDefinition = { scopeNote: "关系数据库", assessmentCriteria: ["解释读现象"] }; point.evidenceBindingIds = [];
  assert.equal((await resolveRoleLearningPoints(input)).unresolved[0].reason, "needs_evidence");
});
test("agent request claims one execution and returns status independently of client lifetime", async () => {
  let executions = 0; let stored: AgentRun | undefined; let fingerprint = ""; let work: Promise<unknown> | undefined;
  const repo: GatewayRepository = { search: async () => [], load: async () => ({ packageRef, title: "fixture", result: bundledRoleSnapshot() }), getRun: async () => stored || null,
    claimRun: async (_a, _r, hash, run) => { if (stored) { assert.equal(hash, fingerprint); return { created: false, run: stored }; } fingerprint = hash; stored = run; return { created: true, run }; }, finishRun: async (_a, run) => { stored = run; } };
  const request: GatewayRequest = { protocol: PROTOCOL, requestId: "agent:1", operation: "agent.run", payload: { packageRef, message: "解释岗位任务" } };
  const deps = { repository: repo, keepAlive: (p: Promise<unknown>) => { work = p; }, runAgent: async () => { executions++; return { packageRef, answer: "有出处的说明", citations: [] }; } };
  const run = await dispatchGateway(request, actor, deps) as AgentRun;
  assert.equal(run.status, "running"); await work;
  const replay = await dispatchGateway(request, actor, deps) as AgentRun;
  assert.equal(replay.status, "completed"); assert.equal(executions, 1);
});
function database() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`CREATE TABLE projects(id TEXT, owner_subject_id TEXT, deleted_at TEXT); CREATE TABLE package_lines(id TEXT,package_id TEXT,title TEXT,visibility TEXT,status TEXT); CREATE TABLE package_releases(id TEXT,package_line_id TEXT,project_id TEXT,package_version TEXT,snapshot_id TEXT,artifact_root_hash TEXT,status TEXT,published_at TEXT);`);
  const db = { prepare(query: string) { const statement = sql.prepare(query); let values: unknown[] = []; const prepared = { bind(...args: unknown[]) { values = args; return prepared; }, async first() { return statement.get(...values as never[]) || null; }, async all() { return { results: statement.all(...values as never[]) }; }, async run() { const result = statement.run(...values as never[]); return { meta: { changes: Number(result.changes) } }; } }; return prepared; } } as unknown as D1Database;
  return { sql, db };
}
test("real catalog SQL isolates private, deleted, unowned and unpublished packages; run reads are owner-scoped", async () => {
  const { sql, db } = database();
  sql.exec(`INSERT INTO projects VALUES('mine','learnflow:learner:1',NULL),('other','learnflow:learner:2',NULL),('deleted','learnflow:learner:1','y');`);
  for (const [id, project, visibility, status] of [["mine", "mine", "private", "ready"], ["other", "other", "private", "ready"], ["public", null, "public", "published"], ["draft", null, "public", "ready"], ["deleted", "deleted", "private", "ready"]]) {
    sql.prepare("INSERT INTO package_lines VALUES(?,?,?,?, 'active')").run(id, id, id, visibility);
    sql.prepare("INSERT INTO package_releases VALUES(?,?,?,'1.0.0',?,?,?,NULL)").run(id, id, project, packageRef.snapshotId, packageRef.rootHash, status);
  }
  const repo = createEcosystemRepository(async () => db, async () => null);
  const catalog = await repo.search(actor, { query: "", offset: 0, limit: 20 }) as { items: { title: string }[] };
  assert.deepEqual(catalog.items.map(r => r.title).sort(), ["mine", "public"]);
  await assert.rejects(repo.load(actor, { ...packageRef, packageId: "other" }), /PACKAGE_NOT_FOUND/);
  await assert.rejects(repo.load(actor, { ...packageRef, packageId: "mine", rootHash: "b".repeat(64) }), /PACKAGE_NOT_FOUND/);
  const run: AgentRun = { runId: "run", status: "running", packageRef, agentVersion: "v1", workflowVersion: "v1" };
  assert.equal((await repo.claimRun(actor, "r", "hash", run)).created, true);
  assert.equal((await repo.claimRun(actor, "r", "hash", run)).created, false);
  await assert.rejects(repo.claimRun(actor, "r", "changed", run), /IDEMPOTENCY_CONFLICT/);
  assert.equal(await repo.getRun({ ...actor, sub: "learnflow:learner:2" }, "run"), null);
  await repo.finishRun({ ...actor, sub: "learnflow:learner:2" }, { ...run, status: "failed" });
  assert.equal((await repo.getRun(actor, "run"))?.status, "running"); sql.close();
});

test("dedicated gateway ingress rejects every legacy route and unsigned method", async () => {
  const { gatewayOnlyReject } = await import("../lib/ecosystem/ingress");
  for (const path of ["/api/projects", "/api/jobs/private", "/api/agent", "/hub", "/api/integrations/learnflow/gateway"]) {
    assert.equal(gatewayOnlyReject(new Request(`https://example.test${path}`), "true")?.status, 404);
  }
  assert.equal(gatewayOnlyReject(new Request("https://example.test/api/integrations/learnflow/gateway", { method: "POST" }), "true"), undefined);
});

test("atomic definitions survive immutable package compilation and reconstruction", async () => {
  const { compileStaticRolePackage, reconstructBuildResult } = await import("../lib/packages/compiler");
  const { result, point } = fixture();
  const compiled = await compileStaticRolePackage({ result, packageId: result.packages.rolePackage.packageId, packageVersion: "2.0.0", visibility: "private", evidencePolicy: "full" });
  assert.deepEqual(reconstructBuildResult(compiled.bundle).semantic.nodes.find(n => n.id === point.id)?.learningDefinition, point.learningDefinition);
});

test("task selection follows declared capability requirements and excludes similarity edges", async () => {
  const { result, graph, point } = fixture();
  const task = result.semantic.nodes.find(n => n.type === "task")!;
  const cap = result.semantic.nodes.find(n => n.type === "capability")!;
  assert.ok(task); assert.ok(cap);
  const base = result.semantic.edges[0];
  result.semantic.edges = [{ ...base, id: "task-cap", source: task.id, target: cap.id, type: "requires_capability", lifecycle: "stable" }, { ...base, id: "cap-point", source: cap.id, target: point.id, type: "requires_knowledge", lifecycle: "stable" }];
  const input = { result, graph, packageRef, namespace: "learnflow:extension:test", targetIds: [task.id] };
  assert.equal((await resolveRoleLearningPoints(input)).pendingBindings[0].roleNodeId, point.id);
  result.semantic.edges[1].type = "similar_to";
  assert.equal((await resolveRoleLearningPoints(input)).pendingBindings.length, 0);
});

test("package resolver verifies every consumed component against the exact pinned manifest", async () => {
  const { compileStaticRolePackage } = await import("../lib/packages/compiler");
  const result = bundledRoleSnapshot();
  const compiled = await compileStaticRolePackage({ result, packageId: result.packages.rolePackage.packageId, packageVersion: "2.0.0", visibility: "private", evidencePolicy: "full" });
  const m = compiled.bundle.manifest;
  const pinned = { packageId: m.packageId, packageVersion: m.packageVersion, snapshotId: m.snapshotId, rootHash: m.rootHash };
  const { sql, db } = database();
  sql.prepare("INSERT INTO projects VALUES('mine',?,NULL)").run(actor.sub);
  sql.prepare("INSERT INTO package_lines VALUES('line',?,'fixture','private','active')").run(m.packageId);
  sql.prepare("INSERT INTO package_releases VALUES('release','line','mine',?,?,?,'ready',NULL)").run(m.packageVersion, m.snapshotId, m.rootHash);
  const repo = createEcosystemRepository(async () => db, async () => ({ bundle: compiled.bundle }));
  assert.deepEqual((await repo.load(actor, pinned)).packageRef, pinned);
  compiled.bundle.components[m.entrypoints.semanticGraph] += " ";
  await assert.rejects(repo.load(actor, pinned), /PACKAGE_INTEGRITY_FAILED/);
  sql.close();
});
