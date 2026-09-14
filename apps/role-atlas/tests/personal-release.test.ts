import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function harness() {
  const state = { stored: false, eventProject: "project-1", eventSnapshot: "snapshot-1", commits: [] as any[], prepared: [] as any[], queries: [] as any[] };
  const key = `personal${Math.random()}`;
  (globalThis as any)[key] = state;
  const source = (await readFile("lib/releases/personal.ts", "utf8")).replace(/^import[\s\S]*?;\n/gmu, "");
  const code = `const state=globalThis[${JSON.stringify(key)}];
    const ensureAppSchema=async()=>{};
    const getD1=()=>({prepare: sql=>({bind:(...args)=>({first:async()=>{
      state.queries.push({sql,args});
      if(sql.includes('project_versions')) return state.stored?{id:'version-1'}:null;
      return {event_json:JSON.stringify({payload:{result:{projectId:state.eventProject,snapshot:{id:state.eventSnapshot}}}})};
    }})})});
    const sha256Hex=async value=>value;
    const commitStaticSnapshot=async()=>{};
    const commitProjectVersion=async input=>{state.commits.push(input);state.stored=true;return {id:'version-1'}};
    const getProjectVersionRecord=async(project,id)=> id==='version-1'?{id,snapshotId:'snapshot-1'}:null;
    const prepareRelease=async input=>{state.prepared.push(input);return {id:'release-1'}};
    ${source}`;
  const js = ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  const service = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  return { state, prepare: service.preparePersonalRelease, cleanup:()=>{delete (globalThis as any)[key];} };
}

test("durable preview is privately pinned without adopting a head or changing the running research; retry reuses it", async()=>{
  const h=await harness();
  try {
    const input={projectId:'project-1',snapshotId:'snapshot-1'};
    await h.prepare(input); await h.prepare(input);
    assert.equal(h.state.commits.length,1);
    assert.equal(h.state.commits[0].adopt,false);
    assert.equal(h.state.commits[0].conversationId,undefined);
    assert.equal(h.state.commits[0].reuseSnapshotId,input.snapshotId);
    assert.match(h.state.commits[0].sourceRunId,/^personal:/);
    assert.deepEqual(h.state.prepared[0],h.state.prepared[1]);
    assert.equal(h.state.prepared[0].visibility,'private');
    assert.equal(h.state.prepared[0].sourceUse,'personal_reference');
    assert.ok(h.state.queries.every(q=>q.args[0]===input.projectId && q.args[1]===input.snapshotId));
  } finally { h.cleanup(); }
});

test("wrong snapshot, project, or explicit version cannot be substituted",async()=>{
  for(const field of ['eventProject','eventSnapshot','version'] as const){
    const h=await harness();
    try {
      if(field!=='version') h.state[field]='other';
      await assert.rejects(h.prepare({projectId:'project-1',snapshotId:'snapshot-1',...(field==='version'?{projectVersionId:'other'}:{})}));
      assert.equal(h.state.prepared.length,0);assert.equal(h.state.commits.length,0);
    } finally {h.cleanup();}
  }
});
