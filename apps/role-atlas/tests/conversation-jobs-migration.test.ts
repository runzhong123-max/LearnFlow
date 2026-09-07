import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { conversationJobsMigration } from "@/db/migrations";

test("conversation/job migration defaults legacy chats to explanation and is repeatable without claiming old jobs", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,project_id TEXT);
    CREATE TABLE role_jobs(id TEXT PRIMARY KEY, project_id TEXT, status TEXT, updated_at TEXT);
    INSERT INTO conversations VALUES('legacy','p1'); INSERT INTO role_jobs VALUES('legacy-job','p1','completed','now');`);
  type Bound = { run: () => Promise<unknown>; all: () => Promise<{ results: unknown[] }> };
  const d1 = {
    prepare(sql: string) {
      const bound = (...values: (string | number | null)[]): Bound => ({
        run: async () => db.prepare(sql).run(...values),
        all: async () => ({ results: db.prepare(sql).all(...values) }),
      });
      return { ...bound(), bind: bound };
    },
    batch: async (statements: Bound[]) => Promise.all(statements.map(statement => statement.run())),
  } as unknown as D1Database;
  try {
    await conversationJobsMigration.apply(d1);
    await conversationJobsMigration.apply(d1);
    assert.equal(db.prepare("SELECT mode FROM conversations WHERE id='legacy'").get()?.mode, "explanation");
    assert.equal(db.prepare("SELECT conversation_id FROM role_jobs WHERE id='legacy-job'").get()?.conversation_id, null);
    assert.throws(() => db.exec("UPDATE conversations SET mode='autonomous'"), /CHECK/);
    db.exec("UPDATE conversations SET mode='iteration'");
    assert.equal(db.prepare("SELECT mode FROM conversations").get()?.mode, "iteration");
  } finally { db.close(); }
});
