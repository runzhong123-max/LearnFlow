import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { progressForJob, researchStage } from "../lib/jobs/research-progress";
test("durable phases restore research stages across kernel and enrichment jobs", () => {
  assert.equal(researchStage("build.search.started"), 0);
  assert.equal(researchStage("build.boundary.stabilized"), 1);
  assert.equal(researchStage("build.enrichment.semantic.completed"), 2);
  assert.equal(researchStage("build.process.patch"), 3);
  assert.equal(researchStage("build.followup.risk_repair.started"), 4);
  assert.equal(progressForJob({ status: "running", phase: "semantic.enrichment" }).active, true);
  assert.equal(progressForJob({ status: "recovering", phase: "semantic.enrichment" }).status, "recovering");
  assert.equal(progressForJob({ status: "completed", phase: "followup.completed" }).active, false);
});
test("workspace is a subscriber and progress is outside the scrolling transcript", () => {
  const source = readFileSync(new URL("../app/RoleWorkspace.tsx", import.meta.url), "utf8");
  assert.ok(!source.includes('fetch("/api/build-runs/enrich"'));
  assert.ok(source.indexOf("<ResearchStages") < source.indexOf('<div className="messages">'));
});


test("progress replay skips reasoning backlog without losing audit records or cursor identity", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { roleJobEventsQuery } = await import("../lib/jobs/journal-query");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE role_job_events(cursor INTEGER PRIMARY KEY,job_id TEXT,kind TEXT,event_json TEXT)");
  const insert = db.prepare("INSERT INTO role_job_events VALUES(?,?,?,?)");
  for (let i = 1; i <= 600; i++) insert.run(i, "job", "build.reasoning.delta", "{}");
  insert.run(601, "job", "build.enrichment.semantic.completed", '{"kind":"build.enrichment.semantic.completed"}');
  insert.run(602, "other-job", "build.run.completed", "{}");
  const progress = db.prepare(roleJobEventsQuery(true)).all("job", 0);
  assert.equal(progress.length, 1); assert.equal(progress[0].cursor, 601);
  assert.equal(db.prepare(roleJobEventsQuery()).all("job", 0).length, 200);
  assert.equal(db.prepare(roleJobEventsQuery(true)).all("job", 601).length, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM role_job_events").get()!.n, 602);
  db.close();
});
