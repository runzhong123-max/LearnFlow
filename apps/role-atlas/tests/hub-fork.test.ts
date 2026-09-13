import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { planHubFork, forkProjectStatements } from "@/lib/hub/fork-plan";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";
import { compileStaticRolePackage } from "@/lib/packages/compiler";
import { validatePackageBundle } from "@/lib/packages/validator";

async function upstream() {
 const result=bundledRoleSnapshot();
 const {bundle}=await compileStaticRolePackage({result,packageId:result.packages.rolePackage.packageId,packageVersion:"1.2.0",visibility:"public",evidencePolicy:"metadata"});
 return {ownerSubjectId:"learnflow:learner:1",releaseId:"release-official",packageLineId:"line-official",license:"CC-BY-4.0",manifest:bundle.manifest,result};
}
test("Fork 生成独立身份、保留来源许可与图谱内容，不改上游；私有副本可重新编译",async()=>{
 const input=await upstream();const before=structuredClone(input.result);
 const fork=await planHubFork(input);
 assert.notEqual(fork.result.snapshot.id,input.result.snapshot.id);
 assert.notEqual(fork.packageId,input.manifest.packageId);
 assert.equal(fork.result.brief.projectId,fork.projectId);
 assert.equal(fork.result.projectId,fork.projectId);
 assert.equal(fork.result.packages.rolePackage.snapshotId,fork.result.snapshot.id);
 assert.deepEqual(fork.result.semantic,input.result.semantic);assert.deepEqual(fork.result.process,input.result.process);
 assert.deepEqual(input.result,before);
 assert.equal(fork.upstream.rootHash,input.manifest.rootHash);assert.equal(fork.upstream.license,"CC-BY-4.0");
 const compiled=await compileStaticRolePackage({result:fork.result,packageId:fork.packageId,packageVersion:"1.0.0",visibility:"private",evidencePolicy:"metadata"});
 assert.equal((await validatePackageBundle(compiled.bundle)).valid,true);
 assert.equal(compiled.bundle.manifest.visibility,"private");
 const stored = JSON.parse(compiled.bundle.components[compiled.bundle.manifest.entrypoints.snapshot]);
 assert.equal(stored.projectId, fork.projectId);
 assert.equal(stored.brief.projectId, fork.projectId);
 assert.notEqual(compiled.bundle.manifest.rootHash,input.manifest.rootHash);
});
test("同一账户和版本的重复 Fork 幂等，不同账户或上游版本独立",async()=>{
 const input=await upstream();const a=await planHubFork(input);
 assert.deepEqual(await planHubFork(input),a);
 assert.notEqual((await planHubFork({...input,ownerSubjectId:"learnflow:learner:2"})).projectId,a.projectId);
 assert.notEqual((await planHubFork({...input,releaseId:"release-new"})).projectId,a.projectId);
 await assert.rejects(planHubFork({...input,manifest:{...input.manifest,visibility:"private"}}),/PUBLIC_RELEASE/);
});
test("重试创建不覆盖已有个人内容，删除后的副本不被隐式恢复",async()=>{
 const input=await upstream();const plan=await planHubFork(input);const db=new DatabaseSync(":memory:");
 db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,title TEXT,description TEXT,market TEXT,status TEXT,owner_subject_id TEXT,deleted_at TEXT);
 CREATE TABLE conversations(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,mode TEXT);`);
 const d1={prepare(sql:string){return{bind(...values:unknown[]){return{sql,values};}};}} as unknown as D1Database;
 const apply=()=>{for(const s of forkProjectStatements(d1,plan,input.ownerSubjectId) as unknown as Array<{sql:string;values:never[]}>){db.prepare(s.sql).run(...s.values);}};
 try{
  apply();assert.equal(db.prepare("SELECT owner_subject_id FROM projects").get()?.owner_subject_id,input.ownerSubjectId);
  db.exec("UPDATE projects SET title='我的维护结果'; UPDATE conversations SET title='我的研究'");apply();
  assert.equal(db.prepare("SELECT title FROM projects").get()?.title,"我的维护结果");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM conversations").get()?.n,1);
  db.exec("DELETE FROM conversations; UPDATE projects SET deleted_at='today'");apply();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM conversations").get()?.n,0);
  assert.equal(db.prepare("SELECT deleted_at FROM projects").get()?.deleted_at,"today");
 }finally{db.close();}
});

test("旧 Fork 的读取投影修复项目路由，不改变历史快照或上游内容", async () => {
 const { projectResultIdentity } = await import("@/lib/projects/result-identity");
 const input = await upstream(), fork = await planHubFork(input);
 const broken = { ...fork.result, projectId: input.result.projectId };
 const before = JSON.stringify(broken);
 const repaired = projectResultIdentity(broken, fork.projectId);
 assert.equal(repaired.projectId, fork.projectId);
 assert.equal(repaired.snapshot, broken.snapshot);
 assert.equal(repaired.semantic, broken.semantic);
 assert.equal(JSON.stringify(broken), before);
 assert.equal(projectResultIdentity(broken, "another-project"), broken);
 assert.equal(projectResultIdentity(input.result, fork.projectId), input.result);
});
