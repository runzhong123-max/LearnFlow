import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { canonicalStringify } from "@/lib/versioning/canonical";
import type { StaticRolePackageBundle } from "@/lib/packages/types";
import { selectedLaunchTask, conversionLaunchUrl, validateLaunchBundle, MAX_LAUNCH_TOKEN_LENGTH } from "../deploy/cohost/task-launch-core.mjs";
import { signRolePackageLaunch, verifyRolePackageLaunch } from "@/lib/integrations/learnflow/launch-token";

const secret = "test-only-work-task-launch-secret-at-least-32-bytes";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture(nodes: object[] = [{id:"task:import",type:"task",label:"导入库存数据",summary:"处理重复输入并保留可重放依据"}]): StaticRolePackageBundle {
  const components = {"semantic.json": JSON.stringify({nodes}), "snapshot.json": JSON.stringify({snapshot:{id:"snapshot:1"}})};
  const manifest: StaticRolePackageBundle["manifest"] = {
    packageProtocol:"static-role-package", protocolVersion:"3.0.0", packageId:"role.example", packageVersion:"1.2.0",
    snapshotId:"snapshot:1", snapshotAsOf:"2026-09-08", roleTitle:"实施工程师", visibility:"public", evidencePolicy:"metadata",
    entrypoints:{semanticGraph:"semantic.json",snapshot:"snapshot.json"}, hashes:Object.fromEntries(Object.entries(components).map(([path,body])=>[path,sha(body)])), rootHash:"",
  };
  manifest.rootHash=sha(canonicalStringify(manifest));
  return {manifest,components};
}
const ref = (bundle: StaticRolePackageBundle) => ({packageId:bundle.manifest.packageId,packageVersion:bundle.manifest.packageVersion,snapshotId:bundle.manifest.snapshotId,rootHash:bundle.manifest.rootHash});

test("selected task comes from the exact release and accepts both task kinds",()=>{
  for(const type of ["task","typical_task"]){
    const bundle=fixture([{id:"task:import",type,label:"导入库存数据",summary:"固定版本原文"}]);
    validateLaunchBundle(bundle,ref(bundle));
    assert.deepEqual(selectedLaunchTask(bundle,"task:import",ref(bundle)),{nodeId:"task:import",label:"导入库存数据",summary:"固定版本原文"});
  }
});

test("task selection rejects missing, duplicate, non-task and unpinned identities",()=>{
  const bundle=fixture();
  assert.throws(()=>selectedLaunchTask(bundle,"task:other",ref(bundle)),/TASK_NOT_IN_PINNED_RELEASE/);
  assert.throws(()=>selectedLaunchTask(bundle,"task:import",{...ref(bundle),snapshotId:"snapshot:2"}),/IDENTITY_MISMATCH/);
  for(const nodes of [[{id:"n",type:"knowledge",label:"概念"}],[{id:"n",type:"task",label:"A"},{id:"n",type:"task",label:"B"}]]){
    const invalid=fixture(nodes);
    assert.throws(()=>selectedLaunchTask(invalid,"n",ref(invalid)),/TASK_NOT_IN_PINNED_RELEASE/);
  }
});

test("hash verification rejects content drift even when advertised root is unchanged",()=>{
  const bundle=fixture();
  const tampered=structuredClone(bundle);
  tampered.components["semantic.json"]=JSON.stringify({nodes:[{id:"task:import",type:"task",label:"被换入的任务"}]});
  assert.throws(()=>selectedLaunchTask(tampered,"task:import",ref(bundle)),/COMPONENT_HASH_MISMATCH/);
  const changedManifest=structuredClone(bundle);
  changedManifest.manifest.roleTitle="伪造岗位";
  assert.throws(()=>selectedLaunchTask(changedManifest,"task:import",ref(bundle)),/ARTIFACT_HASH_MISMATCH/);
  const unpinned=structuredClone(bundle);
  delete unpinned.manifest.hashes["semantic.json"];
  unpinned.manifest.rootHash=sha(canonicalStringify({...unpinned.manifest,rootHash:""}));
  assert.throws(()=>selectedLaunchTask(unpinned,"task:import",ref(unpinned)),/ENTRYPOINT_UNPINNED/);
});

test("canonical validation follows the existing Unicode and object ordering contract",()=>{
  const bundle=fixture([{id:"task:import",type:"task",label:"Cafe\u0301 数据导入",summary:"Unicode 原文"}]);
  bundle.manifest.roleTitle="Cafe\u0301 工程师";
  bundle.manifest.rootHash=sha(canonicalStringify({...bundle.manifest,rootHash:""}));
  assert.doesNotThrow(()=>validateLaunchBundle(bundle,ref(bundle)));
});

test("Chinese summaries are visibly truncated before signing and stay inside Python receiver budget",()=>{
  const bundle=fixture([{id:"task:import",type:"task",label:"中".repeat(300),summary:"文".repeat(2000)}]);
  const taskRef=selectedLaunchTask(bundle,"task:import",ref(bundle));
  assert.equal(taskRef.summary.length,400);
  assert.equal(taskRef.summaryTruncated,true);
  const token=signRolePackageLaunch({secret,subject:"learnflow:learner:7",source:"graph_hub",roleTitle:"岗".repeat(255),packageRef:ref(bundle),intent:"work_task_conversion",taskRef,now:1000});
  assert.ok(token.length <= MAX_LAUNCH_TOKEN_LENGTH);
  const payload=verifyRolePackageLaunch(token,secret,1010);
  assert.equal(payload.taskRef?.summaryTruncated,true);
  assert.equal(payload.taskRef?.summary,"文".repeat(400));
  const python=spawnSync("python3",["-c",`
import importlib.util,json,sys
value=json.load(sys.stdin)
for path in sys.argv[1:]:
    spec=importlib.util.spec_from_file_location("launch_verifier",path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    result=module.verify_role_package_launch(value["token"],value["secret"],now=1010)
    assert result["taskRef"]["summaryTruncated"] is True
    assert len(result["taskRef"]["summary"])==400
`,resolve("../../backend/app/services/role_package_launch.py"),resolve("../desktop/backend/app/services/role_package_launch.py")],{input:JSON.stringify({token,secret}),encoding:"utf8"});
  assert.equal(python.status,0,python.stderr);
  assert.throws(()=>signRolePackageLaunch({secret,subject:"learnflow:learner:7",source:"graph_hub",roleTitle:"too large".repeat(2000),packageRef:ref(bundle),now:1000}),/TOO_LARGE/);
});

test("conversion URL uses fragment and rejects unsafe public origins",()=>{
  const token="body.signature";
  const url=new URL(conversionLaunchUrl("https://w2ltask.example.com/old?x=1#old",token));
  assert.equal(url.pathname,"/convert"); assert.equal(url.search,"");
  assert.equal(new URLSearchParams(url.hash.slice(1)).get("role_token"),token);
  for(const base of ["javascript:alert(1)","http://example.com","https://user:password@example.com"]){
    assert.throws(()=>conversionLaunchUrl(base,token),/PUBLIC_URL_INVALID/);
  }
});

test("signed task coupling, signature and expiry reject malformed tokens",()=>{
  const bundle=fixture();
  const token=signRolePackageLaunch({secret,subject:"learnflow:learner:7",source:"role_atlas",roleTitle:"实施",packageRef:ref(bundle),intent:"work_task_conversion",taskRef:selectedLaunchTask(bundle,"task:import",ref(bundle)),now:1000,ttlSeconds:60});
  const [body,signature]=token.split(".");
  assert.throws(()=>verifyRolePackageLaunch(`${body}.${signature[0]==="A"?"B":"A"}${signature.slice(1)}`,secret,1010),/TOKEN_INVALID/);
  assert.throws(()=>verifyRolePackageLaunch(token,secret,1061),/TOKEN_INVALID/);
  const invalid={...verifyRolePackageLaunch(token,secret,1010),intent:undefined};
  const invalidBody=Buffer.from(JSON.stringify(invalid)).toString("base64url");
  const invalidToken=`${invalidBody}.${createHmac("sha256",secret).update(invalidBody).digest("base64url")}`;
  assert.throws(()=>verifyRolePackageLaunch(invalidToken,secret,1010),/TASK_INVALID/);
});

async function listen(server:http.Server){ server.listen(0,"127.0.0.1"); await once(server,"listening"); return (server.address() as {port:number}).port; }

test("deployed cohost signs the fetched task and rejects drift, hidden releases and foreign origins",async(t)=>{
  let authStatus=200, exported=0;
  let artifact=fixture();
  const bundle=structuredClone(artifact);
  const auth=http.createServer((req,res)=>{
    assert.equal(req.headers.cookie,"session=test-only");
    res.writeHead(authStatus,{"content-type":"application/json"});res.end(JSON.stringify({learner_id:7}));
  });
  const atlas=http.createServer((req,res)=>{
    assert.equal(req.headers.host,"localhost");
    res.writeHead(200,{"content-type":"application/json"});
    if(req.url?.includes("/export?format=json")){
      exported++;assert.equal(req.headers.cookie,"session=test-only");res.end(JSON.stringify(artifact));return;
    }
    res.end(JSON.stringify({packages:[{title:"实施工程师",packageId:bundle.manifest.packageId,visibility:"public",releases:[{id:"release:1",status:"published",packageVersion:bundle.manifest.packageVersion,snapshotId:bundle.manifest.snapshotId,artifactRootHash:bundle.manifest.rootHash}]}]}));
  });
  t.after(()=>{auth.close();atlas.close();});
  const authPort=await listen(auth),atlasPort=await listen(atlas),reservation=http.createServer(),port=await listen(reservation);
  await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  const proxy=spawn(process.execPath,["deploy/cohost/launch-proxy.mjs"],{env:{...process.env,PORT:String(port),LEARNFLOW_INTERNAL_URL:`http://127.0.0.1:${authPort}`,ROLE_ATLAS_INTERNAL_URL:`http://127.0.0.1:${atlasPort}`,LEARNFLOW_PUBLIC_URL:"https://learn.example.com",WORK_TASK_PUBLIC_URL:"https://w2ltask.example.com",ROLE_ATLAS_PUBLIC_URL:"https://roles.example.com",ROLE_PACKAGE_LAUNCH_SECRET:secret},stdio:["ignore","pipe","pipe"]});
  t.after(()=>proxy.kill());
  await Promise.race([once(proxy.stdout!,"data"),once(proxy,"exit").then(()=>{throw new Error("proxy exited before listening");})]);
  const launch=(extra:object={},origin="https://roles.example.com")=>fetch(`http://127.0.0.1:${port}/api/integrations/learnflow/launch`,{method:"POST",headers:{cookie:"session=test-only",origin,"content-type":"application/json"},body:JSON.stringify({releaseId:"release:1",source:"role_atlas",intent:"work_task_conversion",taskNodeId:"task:import",label:"browser forged task",summary:"browser forged summary",...extra})});
  const success=await launch();assert.equal(success.status,200);
  const {launchUrl}=await success.json() as {launchUrl:string};
  const url=new URL(launchUrl);assert.equal(url.origin,"https://w2ltask.example.com");
  const token=new URLSearchParams(url.hash.slice(1)).get("role_token")!;
  const payload=verifyRolePackageLaunch(token,secret);assert.equal(payload.taskRef?.label,"导入库存数据");assert.deepEqual(payload.packageRef,ref(bundle));
  assert.equal((await launch({releaseId:"release:hidden"})).status,404);
  assert.equal((await launch({taskNodeId:"task:other"})).status,422);
  assert.equal((await launch({},"https://foreign.example.com")).status,403);
  artifact=structuredClone(bundle);artifact.components["semantic.json"]="{}";
  const drift=await launch();assert.equal(drift.status,422);assert.deepEqual(await drift.json(),{error:"RELEASE_COMPONENT_HASH_MISMATCH"});
  authStatus=401;const before=exported;assert.equal((await launch()).status,401);assert.equal(exported,before);
});
