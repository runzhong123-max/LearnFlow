import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  ITERATION_INTERRUPTED_ERROR,
  ITERATION_RUN_STALE_AFTER_MS,
  interruptedIterationRunIds,
  iterationParentRunId,
  parseActivityTime,
  reapInterruptedSnapshotIterations,
} from "@/lib/iteration/reaper";

const NOW = new Date("2026-09-11T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
const STALE = iso(ITERATION_RUN_STALE_AFTER_MS + 60_000);
const FRESH = iso(5 * 60_000);

test("自动跟进运行的父任务 id 为去掉最后一段", () => {
  assert.equal(iterationParentRunId("job-1:enrichment:deep"), "job-1:enrichment");
  assert.equal(iterationParentRunId("job-1:repair"), "job-1");
  assert.equal(iterationParentRunId("nocolon"), null);
});

test("两种时间戳格式都能解析", () => {
  assert.equal(parseActivityTime("2026-09-11T12:00:00.000Z"), Date.parse("2026-09-11T12:00:00.000Z"));
  assert.equal(parseActivityTime("2026-09-11 12:00:00"), Date.parse("2026-09-11T12:00:00Z"));
  assert.equal(parseActivityTime("not-a-date"), null);
});

test("父任务终态的自动跟进运行被标记中断", () => {
  const runs = [{ id: "job-1:deep", startedAt: FRESH }];
  for (const status of ["failed", "cancelled", "completed"]) {
    const jobs = new Map([["job-1", { status, leaseExpiresAt: null }]]);
    assert.deepEqual(interruptedIterationRunIds({ runs, jobs, lastEventAt: new Map(), now: NOW }), ["job-1:deep"], status);
  }
});

test("路由驱动的运行使用自身 id 的角色任务判定", () => {
  const runs = [{ id: "run-1", startedAt: FRESH }];
  const jobs = new Map([["run-1", { status: "failed", leaseExpiresAt: null }]]);
  assert.deepEqual(interruptedIterationRunIds({ runs, jobs, lastEventAt: new Map(), now: NOW }), ["run-1"]);
});

test("持有有效租约的执行器永远不被回收，无论运行多久", () => {
  const runs = [{ id: "run-1", startedAt: iso(24 * 60 * 60_000) }, { id: "job-1:deep", startedAt: iso(24 * 60 * 60_000) }];
  const jobs = new Map([
    ["run-1", { status: "running", leaseExpiresAt: iso(-10 * 60_000) }],
    ["job-1", { status: "running", leaseExpiresAt: iso(-10 * 60_000) }],
  ]);
  assert.deepEqual(interruptedIterationRunIds({ runs, jobs, lastEventAt: new Map(), now: NOW }), []);
});

test("无任务记录且超过静默阈值才回收；最近事件视为活跃", () => {
  const runs = [
    { id: "stale-no-events", startedAt: STALE },
    { id: "stale-start-fresh-events", startedAt: STALE },
    { id: "fresh", startedAt: FRESH },
  ];
  const lastEventAt = new Map([["stale-start-fresh-events", FRESH]]);
  assert.deepEqual(interruptedIterationRunIds({ runs, jobs: new Map(), lastEventAt, now: NOW }), ["stale-no-events"]);
});

test("租约已过期但未终态的运行按静默阈值判定", () => {
  const runs = [{ id: "run-1", startedAt: STALE }, { id: "run-2", startedAt: FRESH }];
  const jobs = new Map([
    ["run-1", { status: "running", leaseExpiresAt: iso(5 * 60_000) }],
    ["run-2", { status: "running", leaseExpiresAt: iso(5 * 60_000) }],
  ]);
  assert.deepEqual(interruptedIterationRunIds({ runs, jobs, lastEventAt: new Map(), now: NOW }), ["run-1"]);
});

test("回收器对内存 SQLite 幂等执行，只动 running 行", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE snapshot_iteration_runs(id TEXT PRIMARY KEY, status TEXT, error TEXT, started_at TEXT, completed_at TEXT);
      CREATE TABLE snapshot_iteration_events(run_id TEXT, created_at TEXT);
      CREATE TABLE role_jobs(id TEXT PRIMARY KEY, status TEXT, lease_expires_at TEXT);
      INSERT INTO snapshot_iteration_runs VALUES
        ('job-1:deep','running',NULL,'${STALE}',NULL),
        ('run-live','running',NULL,'${iso(24 * 60 * 60_000)}',NULL),
        ('run-done','completed',NULL,'${STALE}','${STALE}');
      INSERT INTO role_jobs VALUES
        ('job-1','failed',NULL),
        ('run-live','running','${iso(-10 * 60_000)}');`);
    const binding = {
      prepare(sql: string) {
        const statement = {
          async all(...values: unknown[]) { return { results: db.prepare(sql).all(...values as never[]) }; },
          async run(...values: unknown[]) { return { success: true, meta: db.prepare(sql).run(...values as never[]) }; },
          bind(...values: unknown[]) { return { all: () => statement.all(...values), run: () => statement.run(...values) }; },
        };
        return statement;
      },
    } as unknown as D1Database;
    const reaped = await reapInterruptedSnapshotIterations(binding, NOW);
    assert.deepEqual(reaped, ["job-1:deep"]);
    const zombie = db.prepare("SELECT status,error,completed_at FROM snapshot_iteration_runs WHERE id='job-1:deep'").get() as Record<string, string>;
    assert.equal(zombie.status, "interrupted");
    assert.equal(zombie.error, ITERATION_INTERRUPTED_ERROR);
    assert.equal(zombie.completed_at, NOW.toISOString());
    assert.equal((db.prepare("SELECT status FROM snapshot_iteration_runs WHERE id='run-live'").get() as { status: string }).status, "running");
    assert.equal((db.prepare("SELECT status FROM snapshot_iteration_runs WHERE id='run-done'").get() as { status: string }).status, "completed");
    assert.deepEqual(await reapInterruptedSnapshotIterations(binding, NOW), []);
  } finally { db.close(); }
});
