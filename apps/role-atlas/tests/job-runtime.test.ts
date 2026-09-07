import assert from "node:assert/strict";
import test from "node:test";
import { DurableJobJournal, createDurableJobStream, startRoleJobHeartbeat } from "@/lib/jobs/runtime";

type Event = { runId: string; seq: number; time: string; kind: string };

test("普通事件立即展示但始终按序持久化", async () => {
  const visible: number[] = [];
  const durable: number[] = [];
  const journal = new DurableJobJournal<Event>(async (event) => {
    if (event.seq === 1) await new Promise((resolve) => setTimeout(resolve, 10));
    durable.push(event.seq);
  }, (event) => visible.push(event.seq));
  const event = (seq: number): Event => ({ runId: "run:1", seq, time: new Date(0).toISOString(), kind: "progress" });
  journal.publish(event(1));
  journal.publish(event(2));
  assert.deepEqual(visible, [1, 2]);
  await journal.flush();
  assert.deepEqual(durable, [1, 2]);
});

test("提交边界只在之前事件与自身持久化后可见", async () => {
  const trace: string[] = [];
  const journal = new DurableJobJournal<Event>(async (event) => {
    trace.push(`persist:${event.seq}`);
  }, (event) => trace.push(`visible:${event.seq}`));
  const event = (seq: number): Event => ({ runId: "run:1", seq, time: new Date(0).toISOString(), kind: "milestone" });
  journal.publish(event(1));
  await journal.commit(event(2));
  assert.deepEqual(trace, ["visible:1", "persist:1", "persist:2", "visible:2"]);
});

test("运行失败也进入统一失败回调并关闭流", async () => {
  const persisted: string[] = [];
  const stream = createDurableJobStream<Event>({
    async *execute() {
      yield { runId: "run:1", seq: 1, time: new Date(0).toISOString(), kind: "started" };
      throw new Error("boom");
    },
    persist: async (event) => { persisted.push(event.kind); },
    handle: (raw, journal) => journal.publish(raw as Event),
    onFailure: async (_error, journal) => journal.commit({ runId: "run:1", seq: 2, time: new Date(0).toISOString(), kind: "failed" }),
  });
  const body = await new Response(stream).text();
  assert.match(body, /"kind":"started"/);
  assert.match(body, /"kind":"failed"/);
  assert.deepEqual(persisted, ["started", "failed"]);
});

test("客户端断开只分离实时视图，keepAlive 中的后台执行仍完成持久化", async () => {
  const persisted: string[] = [];
  let completion: Promise<void> | undefined;
  const stream = createDurableJobStream<Event>({
    async *execute() {
      yield { runId: "run:bg", seq: 1, time: new Date(0).toISOString(), kind: "started" };
      await new Promise((resolve) => setTimeout(resolve, 8));
      yield { runId: "run:bg", seq: 2, time: new Date(0).toISOString(), kind: "completed" };
    },
    persist: async (event) => { persisted.push(event.kind); },
    handle: (raw, journal) => journal.publish(raw as Event),
    onFailure: async () => undefined,
    keepAlive: (execution) => { completion = execution; },
  });
  const reader = stream.getReader();
  await reader.read();
  await reader.cancel();
  await completion;
  assert.deepEqual(persisted, ["started", "completed"]);
});

test("租约心跳在停止后不再续期，并等待在途续期完成", async () => {
  let pulses = 0;
  const stop = startRoleJobHeartbeat({
    intervalMs: 4,
    renew: async () => { pulses += 1; return true; },
  });
  await new Promise((resolve) => setTimeout(resolve, 14));
  await stop();
  const stoppedAt = pulses;
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.ok(stoppedAt >= 1);
  assert.equal(pulses, stoppedAt);
});


test("领域写入失败不会在可重放日志中留下成功完成事件", async () => {
  const persisted: Event[] = [];
  const visible: Event[] = [];
  const journal = new DurableJobJournal<Event>(async event => { persisted.push(event); }, event => { visible.push(event); });
  await assert.rejects(() => journal.commit({ runId: "run:fail", seq: 1, time: "now", kind: "completed" }, async () => { throw new Error("write failed"); }), /write failed/);
  assert.equal(persisted.length, 0);
  assert.equal(visible.length, 0);
});
