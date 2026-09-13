import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  LARGE_TEXT_CHUNK_BYTES,
  LARGE_TEXT_THRESHOLD_BYTES,
  chunkLargeText,
  isChunkedLargeText,
  loadLargeText,
  storeLargeText,
} from "@/db/large-text";

function d1Harness(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        async all(...values: unknown[]) { return { results: db.prepare(sql).all(...values as never[]) }; },
        async run(...values: unknown[]) { return { success: true, meta: db.prepare(sql).run(...values as never[]) }; },
        bind(...values: unknown[]) { return { all: () => statement.all(...values), run: () => statement.run(...values) }; },
      };
      return statement;
    },
    async batch(statements: { run: () => Promise<unknown> }[]) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  } as unknown as D1Database;
}

function schema(db: DatabaseSync) {
  db.exec(`CREATE TABLE chunked_blobs(owner_table TEXT, owner_id TEXT, column_name TEXT, seq INTEGER, chunk TEXT,
    created_at TEXT DEFAULT 'now', PRIMARY KEY(owner_table, owner_id, column_name, seq));
    CREATE TABLE runs(id TEXT PRIMARY KEY, result_json TEXT);`);
}

test("中文与 emoji 混合文本按 UTF-8 边界分块且无损还原", () => {
  const unit = "岗位能力图谱🌲";
  const text = unit.repeat(Math.ceil((LARGE_TEXT_CHUNK_BYTES * 2.5) / new TextEncoder().encode(unit).byteLength));
  const chunks = chunkLargeText(text, LARGE_TEXT_CHUNK_BYTES);
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) assert.ok(new TextEncoder().encode(chunk).byteLength <= LARGE_TEXT_CHUNK_BYTES);
  assert.equal(chunks.join(""), text);
  assert.deepEqual(chunkLargeText("短文本"), ["短文本"]);
});

test("小值原样内联，大值分块并清理过期块", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    schema(db);
    const d1 = d1Harness(db);
    const owner = { table: "runs", id: "run-1", column: "result_json" };
    assert.equal(await storeLargeText(d1, owner, '{"small":true}'), '{"small":true}');
    assert.equal(db.prepare("SELECT count(*) n FROM chunked_blobs").get()?.n, 0);

    const big = JSON.stringify({ text: "证据".repeat(400_000) });
    assert.ok(new TextEncoder().encode(big).byteLength > LARGE_TEXT_THRESHOLD_BYTES);
    const marker = await storeLargeText(d1, owner, big);
    assert.ok(isChunkedLargeText(marker));
    assert.ok(new TextEncoder().encode(marker!).byteLength < 100);
    assert.equal(await loadLargeText(d1, owner, marker), big);

    // Overwriting with a small value clears stale chunks so they never accumulate.
    assert.equal(await storeLargeText(d1, owner, '{"done":true}'), '{"done":true}');
    assert.equal(db.prepare("SELECT count(*) n FROM chunked_blobs").get()?.n, 0);
    assert.equal(await loadLargeText(d1, owner, '{"done":true}'), '{"done":true}');

    // Null clears chunks and stays null.
    await storeLargeText(d1, owner, big);
    assert.equal(await storeLargeText(d1, owner, null), null);
    assert.equal(db.prepare("SELECT count(*) n FROM chunked_blobs").get()?.n, 0);
    assert.equal(await loadLargeText(d1, owner, null), null);
  } finally { db.close(); }
});

test("缺块时明确报错而不是拼出残缺内容", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    schema(db);
    const d1 = d1Harness(db);
    const owner = { table: "runs", id: "run-2", column: "result_json" };
    const big = "x".repeat(LARGE_TEXT_THRESHOLD_BYTES + LARGE_TEXT_CHUNK_BYTES);
    const marker = await storeLargeText(d1, owner, big);
    db.prepare("DELETE FROM chunked_blobs WHERE owner_id='run-2' AND seq=1").run();
    await assert.rejects(() => loadLargeText(d1, owner, marker), /CHUNKED_BLOB_INCOMPLETE/);
  } finally { db.close(); }
});
