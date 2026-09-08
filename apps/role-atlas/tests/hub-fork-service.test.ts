import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";
import { compileStaticRolePackage } from "@/lib/packages/compiler";

test("Fork 服务保留真实公开制品内容，幂等建立个人项目和私有岗位包，拒绝撤回来源",async()=>{
 const db=new DatabaseSync(":memory:");
 db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,title TEXT,description TEXT,market TEXT,status TEXT,owner_subject_id TEXT,deleted_at TEXT);
 CREATE TABLE conversations(id TEXT PRIMARY KEY,project_id TEXT,title TEXT,mode TEXT);
 CREATE TABLE package_releases(id TEXT PRIMARY KEY,project_id TEXT,source_project_version_id TEXT,package_version TEXT,status TEXT);`);
 const d1={prepare(sql:string){return{bind(...values:unknown[]){return{sql,values,async first(){return db.prepare(sql).get(...values as never[])||null;}};}};},async batch(statements:Array<{sql:string;values:never[]}>){return statements.map(s=>db.prepare(s.sql).run(...s.values));}};
 const result=bundledRoleSnapshot();
 const {bundle}=await compileStaticRolePackage({result,packageId:result.packages.rolePackage.packageId,packageVersion:"1.2.0",visibility:"public",evidencePolicy:"metadata"});
 const source={line:{id:"source-line",packageId:bundle.manifest.packageId,status:"active",visibility:"public",license:"CC-BY-4.0"},release:{packageVersion:bundle.manifest.packageVersion,snapshotId:bundle.manifest.snapshotId,status:"published",artifactRootHash:bundle.manifest.rootHash,publishedAt:"today"},bundle,result};
 const calls:Array<Record<string,unknown>>=[];
 const key="__forkServiceTest";
 (globalThis as unknown as Record<string,unknown>)[key]={d1,source,
  commit:async(input:Record<string,unknown>)=>{calls.push(input);return{id:"version-"+input.projectId};},
  prepare:async(input:Record<string,unknown>)=>{calls.push(input);assert.equal(input.visibility,"private");const id="release-"+input.projectId;db.prepare("INSERT INTO package_releases VALUES(?,?,?,?,?)").run(id,String(input.projectId),String(input.projectVersionId),"1.0.0","ready");return{id,status:"ready"};},
  publish:async(input:{releaseId:string})=>{db.prepare("UPDATE package_releases SET status='published' WHERE id=?").run(input.releaseId);},
 };
 try{
  let code=await readFile(resolve("lib/hub/fork.ts"),"utf8");
  code=code.replace('import { ensureAppSchema, getD1 } from "@/db";',`const ensureAppSchema=async()=>{};const getD1=()=>globalThis.${key}.d1;`)
   .replace('import { getReleaseWithArtifact } from "@/lib/releases/resolver";',`const getReleaseWithArtifact=async()=>globalThis.${key}.source;`)
   .replace('import { prepareRelease, publishRelease } from "@/lib/releases/service";',`const prepareRelease=input=>globalThis.${key}.prepare(input);const publishRelease=input=>globalThis.${key}.publish(input);`)
   .replace('import { commitProjectVersion } from "@/lib/versioning/commit";',`const commitProjectVersion=input=>globalThis.${key}.commit(input);`)
   .replace('from "./fork-plan"',`from ${JSON.stringify(pathToFileURL(resolve("lib/hub/fork-plan.ts")).href)}`)
   .replace(/(["'])@\/([^"']+)\1/gu,(_,q,p)=>JSON.stringify(pathToFileURL(resolve(`${p}.ts`)).href));
  const compiled=ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  const service=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  const a=await service.forkPublicRelease({ownerSubjectId:"user-a",releaseId:"source-release"});
  assert.deepEqual(await service.forkPublicRelease({ownerSubjectId:"user-a",releaseId:"source-release"}),a);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM package_releases").get()?.n,1);
  const b=await service.forkPublicRelease({ownerSubjectId:"user-b",releaseId:"source-release"});assert.notEqual(a.projectId,b.projectId);
  assert.equal(source.line.visibility,"public");assert.equal(source.result.packages.rolePackage.packageId,result.packages.rolePackage.packageId);
  assert.equal((calls[0].sourceInput as {kind:string}).kind,"hub_fork");
  source.release.snapshotId="mismatched-snapshot";
  await assert.rejects(service.forkPublicRelease({ownerSubjectId:"user-c",releaseId:"source-release"}),/UPSTREAM_ARTIFACT_INVALID/);
  source.release.snapshotId=bundle.manifest.snapshotId;
  source.line.visibility="private";
  await assert.rejects(service.forkPublicRelease({ownerSubjectId:"user-c",releaseId:"source-release"}),/PUBLIC_RELEASE_NOT_FOUND/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects").get()?.n,2);
 }finally{db.close();delete (globalThis as unknown as Record<string,unknown>)[key];}
});
