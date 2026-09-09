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
import { validateGraphExtensionProposalV2, validateLearningPathGraphV2, validateRoleLearningAlignmentV2, type GraphExtensionProposalV2, type PathNodeV2, type LearningPathGraphV2 } from "../lib/learning-path/contract";
import { packageLearningSource } from "../lib/learning-path/resolution";
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
test("authorized automatic resolution creates a scoped learning domain without a false official anchor", async () => {
  const { result, graph, point } = fixture(); graph.nodes[0].title = "互不相关的专业容器";
  result.brief.roleTitle = "异领域专业工作";
  const input = { result, graph, packageRef, namespace: "learnflow:extension:test", targetIds: [point.id] };
  assert.equal((await resolveRoleLearningPoints(input)).unresolved[0].reason, "needs_anchor");
  const resolved = await resolveRoleLearningPoints({ ...input, allowStandaloneRoots: true });
  assert.equal(resolved.unresolved.length, 0); assert.equal(resolved.pendingBindings.length, 1);
  const proposal = resolved.extensionProposal!;
  assert.equal(proposal.standaloneRoots?.length, 1);
  assert.equal(proposal.nodes.filter(n => n.kind === "skill_domain").length, 1);
  assert.ok(proposal.edges.every(e => e.from.namespace === input.namespace && e.to.namespace === input.namespace));
  assert.equal(validateGraphExtensionProposalV2(proposal, graph, packageLearningSource(result, packageRef)).valid, true);
  assert.equal(validateGraphExtensionProposalV2({ ...proposal, standaloneRoots: undefined }, graph, packageLearningSource(result, packageRef)).valid, false);
  const pointKey = { namespace: input.namespace, id: proposal.nodes.find(n => n.kind === "knowledge")!.id };
  assert.equal(validateGraphExtensionProposalV2({ ...proposal, standaloneRoots: [pointKey] }, graph, packageLearningSource(result, packageRef)).valid, false);
  assert.equal(validateGraphExtensionProposalV2({ ...proposal, edges: proposal.edges.map(edge => ({ ...edge, kind: "co_learning" })) }, graph, packageLearningSource(result, packageRef)).valid, false);
  const merged = { ...graph, nodes: [...graph.nodes, ...proposal.nodes], edges: [...graph.edges, ...proposal.edges], sources: [...graph.sources, ...proposal.sources] };
  const repeated = await resolveRoleLearningPoints({ ...input, graph: merged, allowStandaloneRoots: true });
  assert.equal(repeated.alignment.bindings.length, 1); assert.equal(repeated.extensionProposal, undefined);
  point.summary = "对相同范围与验收边界的另一段讲解摘要";
  assert.equal((await resolveRoleLearningPoints({ ...input, graph: merged, allowStandaloneRoots: true })).extensionProposal, undefined);
  point.learningDefinition!.scopeNote = "新的明确范围";
  const distinct = await resolveRoleLearningPoints({ ...input, graph: merged, allowStandaloneRoots: true });
  assert.equal(distinct.alignment.bindings.length, 0); assert.equal(distinct.pendingBindings.length, 1);
  assert.notEqual(distinct.pendingBindings[0].target.id, repeated.alignment.bindings[0].target.id);
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
  point.learningCourse = { title: "数据库系统", scopeNote: "数据库原理、方法与实践" };
  const compiled = await compileStaticRolePackage({ result, packageId: result.packages.rolePackage.packageId, packageVersion: "2.0.0", visibility: "private", evidencePolicy: "full" });
  assert.deepEqual(reconstructBuildResult(compiled.bundle).semantic.nodes.find(n => n.id === point.id)?.learningDefinition, point.learningDefinition);
  assert.deepEqual(reconstructBuildResult(compiled.bundle).semantic.nodes.find(n => n.id === point.id)?.learningCourse, point.learningCourse);
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


function materialize(graph: LearningPathGraphV2, proposal: GraphExtensionProposalV2): LearningPathGraphV2 {
  return { ...graph, nodes: [...graph.nodes, ...proposal.nodes], sources: [...graph.sources, ...proposal.sources], edges: [...graph.edges, ...proposal.edges] };
}

test("automatic exact equivalence chooses existing scoped content identity, then official, then stable namespace/id", async () => {
  const { result, graph, point } = fixture();
  const input = { result, graph, packageRef, namespace: "learnflow:extension:test", targetIds: [point.id] };
  const initial = await resolveRoleLearningPoints(input);
  const own = initial.extensionProposal!.nodes.find(n => n.kind === "knowledge")!;
  const official: PathNodeV2 = { ...own, namespace: "learnflow:official", id: "official-point",
    ownership: { system: "learnflow", catalog: "official" }, provenance: graph.nodes[0].provenance };
  const foreignA: PathNodeV2 = { ...own, namespace: "learnflow:extension:aaa", id: "a-point" };
  const foreignZ: PathNodeV2 = { ...own, namespace: "learnflow:extension:aaa", id: "z-point" };
  const localOther: PathNodeV2 = { ...own, id: "locally-authored-point" };
  const source = packageLearningSource(result, packageRef);
  const cases: Array<{ nodes: PathNodeV2[]; expected: PathNodeV2 }> = [
    { nodes: [foreignZ, official, localOther, foreignA, own], expected: own },
    { nodes: [foreignZ, localOther, foreignA, official], expected: official },
    { nodes: [localOther, foreignZ, foreignA], expected: foreignA },
  ];
  for (const row of cases) {
    for (const nodes of [row.nodes, [...row.nodes].reverse()]) {
      const base = { ...graph, sources: [...graph.sources, ...initial.extensionProposal!.sources], nodes: [...graph.nodes, ...nodes] };
      assert.equal(validateLearningPathGraphV2(base).valid, true);
      const before = structuredClone(base);
      const automatic = await resolveRoleLearningPoints({ ...input, graph: base, allowStandaloneRoots: true });
      assert.deepEqual(automatic.unresolved, []);
      assert.equal(automatic.extensionProposal, undefined);
      assert.deepEqual(automatic.alignment.bindings.map(b => b.target), [{ namespace: row.expected.namespace, id: row.expected.id, revision: row.expected.revision }]);
      assert.equal(validateRoleLearningAlignmentV2(automatic.alignment, base, source).valid, true);
      const manual = await resolveRoleLearningPoints({ ...input, graph: base });
      assert.equal(manual.unresolved[0].reason, "ambiguous_definition");
      assert.equal(manual.alignment.bindings.length, 0);
      assert.deepEqual(base, before);
    }
  }
});

test("automatic collision fallback lengthens the content ID without equating or overwriting occupied nodes and is reused", async () => {
  const { result, graph, point } = fixture();
  const input = { result, graph, packageRef, namespace: "learnflow:extension:test", targetIds: [point.id] };
  const initial = await resolveRoleLearningPoints(input);
  const original = initial.extensionProposal!.nodes.find(n => n.kind === "knowledge")!;
  let base = { ...graph, nodes: [...graph.nodes], sources: [...graph.sources, ...initial.extensionProposal!.sources] };
  const source = packageLearningSource(result, packageRef);
  let fullHash = "", collisionSuffix = 0;
  for (const length of [24, 32, 40, 48, 56, 64, 66, 66]) {
    const before = structuredClone(base);
    const resolved = await resolveRoleLearningPoints({ ...input, graph: base, allowStandaloneRoots: true });
    assert.deepEqual(resolved.unresolved, []);
    assert.equal(resolved.alignment.bindings.length, 0);
    assert.equal(resolved.pendingBindings.length, 1);
    const proposal = resolved.extensionProposal!;
    assert.equal(validateGraphExtensionProposalV2(proposal, base, source).valid, true);
    const created = proposal.nodes.find(n => n.kind === "knowledge")!;
    if (length <= 64) {
      assert.equal(created.id.length, "point:".length + length);
      assert.ok(created.id.startsWith(original.id));
      if (length === 64) fullHash = created.id;
    } else {
      assert.equal(created.id, `${fullHash}:${++collisionSuffix}`);
    }
    assert.ok(!base.nodes.some(n => n.namespace === input.namespace && n.id === created.id));
    const merged = materialize(base, proposal);
    assert.equal(validateLearningPathGraphV2(merged).valid, true);
    assert.equal(validateRoleLearningAlignmentV2({ ...resolved.alignment, bindings: resolved.pendingBindings }, merged, source).valid, true);
    const official: PathNodeV2 = { ...created, namespace: "learnflow:official", id: "same-official-point",
      ownership: { system: "learnflow", catalog: "official" }, provenance: graph.nodes[0].provenance };
    const replay = await resolveRoleLearningPoints({ ...input, graph: { ...merged, nodes: [...merged.nodes, official] }, allowStandaloneRoots: true });
    assert.equal(replay.extensionProposal, undefined);
    assert.equal(replay.alignment.bindings[0].target.id, created.id);
    assert.equal(replay.alignment.bindings[0].target.namespace, input.namespace);
    assert.deepEqual(base, before);
    // Materialize a DIFFERENT statement at this ID to force the next candidate.
    base = { ...base, nodes: [...base.nodes, { ...created, title: "另一个占用标识的概念", aliases: [],
      atomic: { scopeNote: "不等价的不同范围", assessmentCriteria: ["执行另一项不同考核"] } } as PathNodeV2] };
    assert.equal((await resolveRoleLearningPoints({ ...input, graph: base })).unresolved[0].reason, "ambiguous_definition");
  }
});

test("course policy reuses official course and keeps independent requirements and evidence", async () => {
  const { result, graph, point } = fixture();
  const before = JSON.stringify(result);
  const resolved = await resolveRoleLearningPoints({ result, graph, packageRef, namespace: "learnflow:extension:test", targetIds: [point.id], groupByCourse: true, allowStandaloneRoots: true });
  assert.equal(resolved.extensionProposal, undefined);
  assert.equal(resolved.alignment.bindings[0].target.id, graph.nodes[0].id);
  assert.equal(resolved.alignment.bindings[0].relation, "narrower_than");
  assert.match(resolved.alignment.bindings[0].rationale, /根据并发时序辨别读现象/);
  assert.equal(resolved.courseTargets?.[0].title, "数据库");
  assert.equal(JSON.stringify(result), before);
});

test("many operational requirements share courses across batches without creating atomic nodes", async () => {
  const { result, graph, point } = fixture(); graph.nodes[0].title = "离散数学"; graph.edges = [];
  const sourceBinding = result.sources.evidenceBindings.find(b => b.id === point.evidenceBindingIds[0])!;
  const labels = ["为云平台设备漏洞打补丁", "排查云平台日常运行中的障碍", "在参考文档基础上完成华为 FusionCompute 云平台环境搭建", "执行机房客户设备上下架", "管理客户进出机房的登记", "执行机房消防安全检查"];
  const points = labels.map((label, i) => ({ ...structuredClone(point), id: `skill:course-${i}`, label, learningKind: "skill" as const, evidenceBindingIds: [`evidence:course-${i}`] }));
  result.semantic.nodes = points;
  result.sources.evidenceBindings.push(...points.map((p, i) => ({ ...sourceBinding, id: `evidence:course-${i}`, targetId: p.id })));
  const input = { result, graph, packageRef, namespace: "learnflow:extension:test", groupByCourse: true, allowStandaloneRoots: true };
  const first = await resolveRoleLearningPoints({ ...input, targetIds: [points[0].id, points[3].id] });
  assert.equal(first.extensionProposal?.nodes.length, 2);
  assert.ok(first.extensionProposal?.nodes.every(n => n.kind === "course"));
  const merged = { ...graph, nodes: [...graph.nodes, ...first.extensionProposal!.nodes], sources: [...graph.sources, ...first.extensionProposal!.sources] };
  const next = await resolveRoleLearningPoints({ ...input, graph: merged });
  assert.equal(next.extensionProposal, undefined);
  assert.equal(next.alignment.bindings.length, 6);
  assert.equal(new Set(next.alignment.bindings.map(b => b.target.id)).size, 2);
  assert.ok(next.alignment.bindings.every(b => b.relation === "narrower_than" && b.evidenceRefs.length));
  points[0].learningDefinition!.assessmentCriteria = ["新的岗位验收要求"];
  assert.equal((await resolveRoleLearningPoints({ ...input, graph: merged })).extensionProposal, undefined);
  points[0].evidenceBindingIds = [];
  assert.equal((await resolveRoleLearningPoints({ ...input, graph: merged })).unresolved[0].reason, "needs_evidence");
});

test("course organization does not bind to equally ranked different subjects", async () => {
  const { result, graph, point } = fixture();
  point.learningCourse = { title: "数据库与网络课程", scopeNote: "数据库和计算机网络学习" };
  graph.nodes.push({ ...graph.nodes[0], id: "course:network", title: "网络课程" });
  const resolved = await resolveRoleLearningPoints({ result, graph, packageRef, namespace: "learnflow:extension:test", targetIds: [point.id], groupByCourse: true, allowStandaloneRoots: true });
  assert.equal(resolved.unresolved[0].reason, "ambiguous_definition");
  assert.equal(resolved.extensionProposal, undefined);
});
