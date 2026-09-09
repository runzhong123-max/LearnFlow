import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { changeHubPublication } from "@/lib/releases/hub-publication";
import { compileStaticRolePackage } from "@/lib/packages/compiler";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";

async function harness() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE package_lines(id TEXT PRIMARY KEY,visibility TEXT,registry_version INTEGER,recommended_release_id TEXT,updated_at TEXT);
  CREATE TABLE package_releases(id TEXT PRIMARY KEY,package_line_id TEXT,project_id TEXT,status TEXT,published_at TEXT,artifact_root_hash TEXT);
  CREATE TABLE package_artifacts(root_hash TEXT PRIMARY KEY,content TEXT);
  CREATE TABLE release_events(id INTEGER PRIMARY KEY,release_id TEXT,package_line_id TEXT,project_id TEXT,action TEXT,actor_kind TEXT,detail_json TEXT,created_at TEXT);
  INSERT INTO package_lines VALUES('line','public',3,'release','before');
  INSERT INTO package_releases VALUES('release','line','project','published','today','hash');
  INSERT INTO package_artifacts VALUES('hash','{"manifest":{"visibility":"public"}}');`);
  const result = bundledRoleSnapshot(); result.validation.publishable = true;
  const { bundle } = await compileStaticRolePackage({ result, packageId: "package", packageVersion: "1.0.0", visibility: "public", evidencePolicy: "metadata" });
  db.prepare("UPDATE package_artifacts SET content=?").run(JSON.stringify(bundle));
  const bindStatement = (sql: string, values: unknown[]) => ({
    sql,values,async first() {return db.prepare(sql).get(...values as never[]) || null;},
  });
  const d1 = { prepare(sql: string) { return { bind(...values: unknown[]) { return bindStatement(sql,values); } }; },
    async batch(statements: Array<ReturnType<typeof bindStatement>>) {
      db.exec("BEGIN");
      try { const results=statements.map(s=>({meta:{changes:Number(db.prepare(s.sql).run(...s.values as never[]).changes)}}));db.exec("COMMIT");return results; }
      catch(error) {db.exec("ROLLBACK");throw error;}
    },
  } as unknown as D1Database;
  return {db,d1};
}
const input = { packageLineId:"line",expectedReleaseId:"release",expectedRegistryVersion:3,action:"withdraw_from_hub" as const };
test("撤回停止公开但保留制品与推荐版本，重复请求不重复记录，重新公开复用同一版本",async()=>{
  const {db,d1}=await harness();
  try {
    const before=db.prepare("SELECT * FROM package_releases").all();
    const result=await changeHubPublication(d1,input);assert.equal(result.visibility,"private");assert.equal(result.registry_version,4);
    assert.equal((await changeHubPublication(d1,input)).changed,false);
    assert.deepEqual(db.prepare("SELECT * FROM package_releases").all(),before);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM package_artifacts").get()?.n,1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM release_events").get()?.n,1);
    const restored=await changeHubPublication(d1,{...input,action:"restore_to_hub",expectedRegistryVersion:4});
    assert.equal(restored.visibility,"public");assert.equal(restored.registry_version,5);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM release_events").get()?.n,2);
  }finally{db.close();}
});
test("旧页面与改变的推荐版本不能撤回新发布内容",async()=>{
  const {db,d1}=await harness();try{
    await assert.rejects(changeHubPublication(d1,{...input,expectedRegistryVersion:2}),/CONFLICT/);
    await assert.rejects(changeHubPublication(d1,{...input,expectedReleaseId:"other"}),/CONFLICT/);
    assert.equal(db.prepare("SELECT visibility FROM package_lines").get()?.visibility,"public");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM release_events").get()?.n,0);
  }finally{db.close();}
});
test("私有制品不能借重新公开操作扩大披露范围",async()=>{
  const {db,d1}=await harness();try{
    db.exec(`UPDATE package_lines SET visibility='private'; UPDATE package_artifacts SET content='{"manifest":{"visibility":"private"}}'`);
    await assert.rejects(changeHubPublication(d1,{...input,action:"restore_to_hub"}),/PUBLIC_RELEASE_REQUIRED/);
    assert.equal(db.prepare("SELECT visibility FROM package_lines").get()?.visibility,"private");
  }finally{db.close();}
});
test("历史不完整产物不能通过重新公开绕过质量门",async()=>{
  const {db,d1}=await harness();try{
    db.exec(`UPDATE package_lines SET visibility='private'; UPDATE package_artifacts SET content='{"manifest":{"visibility":"public"}}'`);
    await assert.rejects(changeHubPublication(d1,{...input,action:"restore_to_hub"}),/RELEASE_QUALITY_BLOCKED/);
    assert.equal(db.prepare("SELECT visibility FROM package_lines").get()?.visibility,"private");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM release_events").get()?.n,0);
  }finally{db.close();}
});
