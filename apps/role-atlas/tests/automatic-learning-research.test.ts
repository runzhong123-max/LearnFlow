import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { snapshotIterationRequestSchema } from '@/lib/iteration/types';
import { automaticMountSchema, automaticRepairSchema, eligibleAutomaticRepair } from '@/lib/learning-path/automatic-schema';
import { AUTOMATIC_MOUNT_POLICY, type AutomaticMountResult } from '@/lib/learning-path/automatic-contract';
import { automaticRepairJobId, automaticRepairPlan, repairableMount } from '@/lib/learning-path/automatic-research-plan';
import { AutomaticMountError } from '@/lib/learning-path/automatic-client';
import { roleJobClaimStatements } from '@/lib/jobs/claim-transaction';
import { dispatchSchema } from '@/lib/jobs/dispatch-schema';
import { sealJobEnvelope, openJobEnvelope } from '@/lib/jobs/dispatch-protocol';
import { canonicalStringify } from '@/lib/versioning/canonical';
import type { ColdStartBuildResult } from '@/lib/build/types';

const secret = 'test-only-automatic-research-secret-32';
const packageRef = {packageId:'role:one',packageVersion:'1',snapshotId:'snap-one',rootHash:'a'.repeat(64)};
const mountResult: AutomaticMountResult = {status:'needs_research',packageRef,points:[{roleNodeId:'point-one',status:'needs_research',reason:'needs_definition'}],receipts:[],unresolved:[{roleNodeId:'point-one',reason:'needs_definition'}]};
const result = {snapshot:{id:'snap-one',asOf:'2026-09-09'},packages:{rolePackage:{packageVersion:'candidate:one'}},semantic:{nodes:[{id:'point-one',type:'knowledge_skill'}]},sources:{assets:[{id:'source-one',kind:'public_document',title:'部署手册'}],segments:[{sourceId:'source-one',ordinal:0,text:'现场核对实际部署日志与数据库记录。'}]}} as unknown as ColdStartBuildResult;

test('automatic repair preserves offline consent, evidence text and full research budgets', async () => {
  const jobId = await automaticRepairJobId('mount-one');
  assert.equal(jobId, await automaticRepairJobId('mount-one')); assert.ok(jobId.length <= 100);
  const body = automaticRepairPlan({mountId:'mount-one',jobId,projectId:'project-one',versionId:'version-one',conversationId:'conversation-one',result,mount:mountResult,sourcePayload:{build:{},webResearch:false}})!;
  assert.equal(body.iteration.webResearch,false); assert.equal(body.iteration.maxRounds,2); assert.equal(body.iteration.sourceLimit,12); assert.equal(body.iteration.maxWorkItems,8);
  assert.deepEqual(body.iteration.targetIds,['point-one']); assert.equal(body.iteration.supplementalSources[0].content,result.sources.segments[0].text);
  assert.equal('providerConfig' in body,false); assert.equal('mastery' in body,false);
  const noPoints = {...mountResult,unresolved:[],reason:'no_learning_points'};
  assert.equal(repairableMount(noPoints),true);
  assert.deepEqual(automaticRepairPlan({mountId:'mount-one',jobId,projectId:'project-one',versionId:'version-one',conversationId:'conversation-one',result,mount:noPoints,sourcePayload:{webResearch:true}})!.iteration.targetIds,[]);
  assert.equal(automaticRepairPlan({mountId:'mount-one',jobId,projectId:'project-one',versionId:'version-one',conversationId:'conversation-one',result,mount:noPoints,sourcePayload:{webResearch:true}})!.iteration.initiativeProfile,'autonomous');
  const tasksResult = {...result,semantic:{...result.semantic,nodes:[{id:'task-deploy',type:'task'},{id:'task-diagnose',type:'task'}]}} as ColdStartBuildResult;
  const fromTasks=automaticRepairPlan({mountId:'mount-one',jobId,projectId:'project-one',versionId:'version-one',conversationId:'conversation-one',result:tasksResult,mount:noPoints,sourcePayload:{webResearch:true}})!;
  assert.deepEqual(fromTasks.iteration.targetIds,['task-deploy','task-diagnose']);assert.equal(fromTasks.iteration.initiativeProfile,'user_directed');
  assert.equal(repairableMount({...mountResult,unresolved:[{roleNodeId:'point-one',reason:'ambiguous_definition'}]}),false);
  assert.equal(repairableMount({...mountResult,unresolved:[{roleNodeId:'point-one',reason:'missing_resolution'}]}),false);
});

async function harness() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,owner_subject_id TEXT,deleted_at TEXT);
    CREATE TABLE conversations(id TEXT PRIMARY KEY,project_id TEXT,version_id TEXT,mode TEXT);
    CREATE TABLE project_versions(id TEXT PRIMARY KEY);
    CREATE TABLE role_jobs(id TEXT PRIMARY KEY,kind TEXT,thread_id TEXT,project_id TEXT,conversation_id TEXT,base_snapshot_id TEXT,base_version_id TEXT,status TEXT,phase TEXT,attempt INTEGER,input_json TEXT,result_json TEXT,created_at TEXT,updated_at TEXT,lease_owner TEXT,lease_expires_at TEXT,error TEXT,completed_at TEXT);
    ${automaticMountSchema};${automaticRepairSchema};${dispatchSchema};
    INSERT INTO projects VALUES('project-one','learnflow:learner:1',NULL);
    INSERT INTO conversations VALUES('conversation-one','project-one','version-one','iteration');
    INSERT INTO project_versions VALUES('version-one');
    INSERT INTO role_jobs(id,project_id,conversation_id,status,input_json,result_json,updated_at) VALUES('source-job','project-one','conversation-one','completed','{"build":{},"webResearch":false}','{"projectVersionId":"version-one"}','2026-09-09');`);
  db.prepare(`INSERT INTO role_job_dispatch(job_id,endpoint,actor_json,state,available_at,created_at,updated_at) VALUES('source-job','/api/build-runs/enrich',?,'done','2026-09-09','2026-09-09','2026-09-09')`).run(JSON.stringify({issuer:'learnflow',subjectId:'learnflow:learner:1',accountId:7,learnerId:1,username:'test',displayName:'Test',role:'user'}));
  db.prepare(`INSERT INTO role_learning_mounts(id,project_id,project_version_id,conversation_id,snapshot_id,owner_subject_id,source_run_id,policy_version,status,package_ref_json,result_json,available_at,created_at,updated_at) VALUES('mount-one','project-one','version-one','conversation-one','snap-one','learnflow:learner:1','nested-final-risk',?,'needs_research',?,?,'2026-09-09','2026-09-09','2026-09-09')`).run(AUTOMATIC_MOUNT_POLICY,JSON.stringify(packageRef),JSON.stringify(mountResult));
  const d1 = {prepare(sql:string) { return {bind(...bindings:unknown[]) { const statement = db.prepare(sql); return {
    async first(){ return statement.get(...bindings as never[]) || null; },async all(){return {results:statement.all(...bindings as never[])};},async run(){return {meta:statement.run(...bindings as never[])};},
  };}};},async batch(statements:Array<{run:()=>Promise<unknown>}>){db.exec('BEGIN');try {const out=[];for(const statement of statements)out.push(await statement.run());db.exec('COMMIT');return out;}catch(error){db.exec('ROLLBACK');throw error;}}};
  const state = {db,d1,centralCalls:0,deny:false,transientFailure:false,race:undefined as undefined|(()=>void),captures:[] as Request[],version:{id:'version-one',snapshotId:'snap-one',result}};
  const key = `__researchHarness${Math.random().toString(36).slice(2)}`;
  (globalThis as unknown as Record<string,unknown>)[key]={state,secret,roleJobClaimStatements,sealJobEnvelope,openJobEnvelope,canonicalStringify,automaticRepairJobId,automaticRepairPlan,repairableMount,eligibleAutomaticRepair,AUTOMATIC_MOUNT_POLICY,AutomaticMountError};
  const dispatch = await readFile('lib/jobs/dispatch.ts','utf8');
  const enqueue = dispatch.slice(dispatch.indexOf('export async function enqueueRoleJob('),dispatch.indexOf('export async function listDispatchableJobs('));
  const executeRequest = dispatch.slice(dispatch.indexOf('export async function dispatchRequest('),dispatch.indexOf('export async function settleDispatch('));
  const research = (await readFile('lib/learning-path/automatic-research.ts','utf8')).replace(/^import[\s\S]*?;\n/gmu,'');
  const code = `const {state,secret,roleJobClaimStatements,sealJobEnvelope,openJobEnvelope,canonicalStringify,automaticRepairJobId,automaticRepairPlan,repairableMount,eligibleAutomaticRepair,AUTOMATIC_MOUNT_POLICY,AutomaticMountError}=globalThis[${JSON.stringify(key)}];
    const getD1=()=>state.d1,ensureAppSchema=async()=>{},ensureJobDispatch=async()=>{},jobWorkerSecret=()=>secret;
    const actors=new WeakMap(),executing=new WeakSet();
    const bindJobActor=(request,actor)=>{state.captures.push(request);actors.set(request,actor);};
    const requestActor=async request=>{state.race?.();const actor=actors.get(request);if(!actor)throw new Error('UNTRUSTED_REQUEST');return actor;};
    const getRoleJob=async id=>state.db.prepare('SELECT * FROM role_jobs WHERE id=?').get(id);
    const getProjectVersionRecord=async(project,version)=>project==='project-one'&&version==='version-one'?state.version:null;
    const requestAutomaticMount=async(input,config)=>{state.centralCalls++;if(state.deny)throw new AutomaticMountError('central account disabled');if(state.transientFailure)throw new AutomaticMountError('temporary central failure',true);if(config.subject!=='learnflow:learner:1'||input.projectVersionId!=='version-one')throw new Error('BAD_SCOPE');return {};};
    ${enqueue}\n${executeRequest}\n${research}
    export const isTrusted=request=>executing.has(request);`;
  const compiled = ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  const service = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`) as typeof import('@/lib/learning-path/automatic-research') & {dispatchRequest:(id:string,row:{endpoint:string;actor_json:string;envelope:string})=>Promise<Request>;isTrusted:(request:Request)=>boolean};
  return {state,service,close(){db.close();delete (globalThis as unknown as Record<string,unknown>)[key];}};
}

test('real dispatcher queues one scoped repair, replay survives restart, and child versions never loop', async () => {
  const h=await harness();try {
    assert.deepEqual(await h.service.listPendingAutomaticMountResearch(),['mount-one']);
    await Promise.all([h.service.enqueueLearningMountResearch('mount-one'),h.service.enqueueLearningMountResearch('mount-one')]);
    const child=h.state.db.prepare("SELECT * FROM role_jobs WHERE id!='source-job'").get()!;
    assert.equal(h.state.db.prepare("SELECT COUNT(*) AS n FROM role_jobs WHERE id!='source-job'").get()?.n,1);
    assert.equal(child.base_version_id,'version-one'); assert.equal(child.conversation_id,'conversation-one');
    assert.equal(h.state.db.prepare('SELECT status FROM role_learning_repairs').get()?.status,'queued');
    assert.equal(h.state.centralCalls,1); assert.equal(h.state.captures[0].headers.has('authorization'),false); assert.equal(h.state.captures[0].headers.has('cookie'),false);
    const dispatch=h.state.db.prepare('SELECT * FROM role_job_dispatch WHERE job_id=?').get(child.id)!;
    const request=await h.service.dispatchRequest(String(child.id),dispatch as never);
    assert.equal(h.service.isTrusted(request),true);assert.equal(h.service.isTrusted(new Request('http://localhost',{headers:{'x-role-worker':'true'}})),false);
    const body=await request.json() as {iteration:ReturnType<typeof snapshotIterationRequestSchema.parse>};assert.equal(body.iteration.maxRounds,2);assert.equal(body.iteration.sourceLimit,12);assert.equal(body.iteration.webResearch,false);
    const route = await readFile('app/api/snapshot-iterations/route.ts','utf8');
    const normalization = route.slice(route.indexOf('  const iterationRequest = {'),route.indexOf('  const mayRebuild ='));
    const normalize = new Function('parsed','resolved','projectId','learningMountFeedback',normalization+'return iterationRequest;');
    const parsed = snapshotIterationRequestSchema.parse(body.iteration);
    const reference = {snapshotId:'snap-one',packageVersion:'candidate:one',projectId:'project-one',versionId:'version-one'};
    const normalized = normalize({iteration:parsed},{reference},'project-one',(parsed as {learningMountFeedback?:unknown}).learningMountFeedback);
    assert.equal(canonicalStringify({iteration:normalized}),child.input_json,'the actual execution route must be able to claim the identical queued payload');
    await h.service.enqueueLearningMountResearch('mount-one');assert.equal(h.state.centralCalls,1);
    h.state.db.prepare("UPDATE role_jobs SET status='completed',result_json=? WHERE id=?").run('{"projectVersionId":"version-two"}',child.id);
    h.state.db.exec("INSERT INTO project_versions VALUES('version-two'); UPDATE conversations SET version_id='version-two'");
    h.state.db.prepare(`INSERT INTO role_learning_mounts(id,project_id,project_version_id,conversation_id,snapshot_id,owner_subject_id,source_run_id,policy_version,status,package_ref_json,result_json,available_at,created_at,updated_at) VALUES('mount-two','project-one','version-two','conversation-one','snap-two','learnflow:learner:1',?,?,'needs_research',?,?,'2026-09-09','2026-09-09','2026-09-09')`).run(child.id,AUTOMATIC_MOUNT_POLICY,JSON.stringify(packageRef),JSON.stringify(mountResult));
    assert.deepEqual(await h.service.listPendingAutomaticMountResearch(),[]);assert.equal(h.state.db.prepare('SELECT COUNT(*) AS n FROM role_learning_repairs').get()?.n,1);
    assert.equal(h.state.db.prepare('SELECT status FROM role_learning_repairs').get()?.status,'completed');
  }finally{h.close();}
});

test('enqueue CAS stops ownership, version, mode, active-job changes and revoked central identity', async () => {
  for(const mutation of ["UPDATE projects SET owner_subject_id='learnflow:learner:2'","UPDATE projects SET deleted_at='now'","UPDATE conversations SET version_id='version-other'","UPDATE conversations SET mode='explanation'","INSERT INTO role_jobs(id,conversation_id,status) VALUES('parallel','conversation-one','queued')"]) {
    const h=await harness();try {h.state.race=()=>h.state.db.exec(mutation);await h.service.enqueueLearningMountResearch('mount-one');assert.equal(h.state.db.prepare("SELECT COUNT(*) AS n FROM role_jobs WHERE id LIKE 'learning-repair:%'").get()?.n,0,mutation);assert.equal(h.state.db.prepare('SELECT status FROM role_learning_repairs').get()?.status,'stopped');}finally{h.close();}
  }
  const h=await harness();try {h.state.deny=true;await h.service.enqueueLearningMountResearch('mount-one');assert.equal(h.state.db.prepare("SELECT COUNT(*) AS n FROM role_jobs WHERE id LIKE 'learning-repair:%'").get()?.n,0);assert.equal(h.state.db.prepare('SELECT status FROM role_learning_repairs').get()?.status,'stopped');}finally{h.close();}
});

test('missing original authorization cannot be replaced by an invented identity', async () => {
  const h=await harness();try {h.state.db.exec('DELETE FROM role_job_dispatch');await h.service.enqueueLearningMountResearch('mount-one');assert.equal(h.state.centralCalls,0);assert.equal(h.state.db.prepare("SELECT COUNT(*) AS n FROM role_jobs WHERE id LIKE 'learning-repair:%'").get()?.n,0);assert.match(String(h.state.db.prepare('SELECT error FROM role_learning_repairs').get()?.error),/授权记录/u);}finally{h.close();}
});

test('only a failed producer with an exact persisted partial version can authorize repair', async () => {
  for(const record of [
    {snapshotId:'snap-one',projectVersionId:'version-one'},
    {partial:true,snapshotId:'snap-one',projectVersionId:'another-version'},
    {partial:true,snapshotId:'another-snapshot',projectVersionId:'version-one'},
    {partial:'true',snapshotId:'snap-one',projectVersionId:'version-one'},
  ]) {
    const h=await harness();try {
      h.state.db.prepare("UPDATE role_jobs SET status='failed',result_json=? WHERE id='source-job'").run(JSON.stringify(record));
      await h.service.enqueueLearningMountResearch('mount-one');
      assert.equal(h.state.centralCalls,0,JSON.stringify(record));
      assert.equal(h.state.db.prepare("SELECT COUNT(*) AS n FROM role_jobs WHERE id LIKE 'learning-repair:%'").get()?.n,0);
      assert.equal(h.state.db.prepare('SELECT status FROM role_learning_repairs').get()?.status,'stopped');
    }finally{h.close();}
  }
  const h=await harness();try {
    h.state.db.prepare("UPDATE role_jobs SET status='failed',result_json=? WHERE id='source-job'")
      .run(JSON.stringify({partial:true,snapshotId:'snap-one',candidateSnapshotId:'snap-one',projectVersionId:'version-one'}));
    await h.service.enqueueLearningMountResearch('mount-one');
    assert.equal(h.state.centralCalls,1);
    assert.equal(h.state.db.prepare("SELECT COUNT(*) AS n FROM role_jobs WHERE id LIKE 'learning-repair:%'").get()?.n,1);
    assert.equal(h.state.db.prepare('SELECT source_job_id FROM role_learning_repairs').get()?.source_job_id,'source-job');
    assert.equal(h.state.db.prepare("SELECT status FROM role_jobs WHERE id='source-job'").get()?.status,'failed');
  }finally{h.close();}
});

test('older non-researchable and malformed receipts cannot starve later repairable mounts', async () => {
  const h=await harness();try {
    h.state.db.exec("UPDATE role_learning_mounts SET created_at='2026-09-09'");
    for(let index=0;index<5;index++) {
      const versionId=`old-version-${index}`,conversationId=`old-conversation-${index}`;
      h.state.db.prepare('INSERT INTO project_versions VALUES(?)').run(versionId);
      h.state.db.prepare("INSERT INTO conversations VALUES(?,'project-one',?,'iteration')").run(conversationId,versionId);
      const receipt=index===4 ? '{invalid json' : JSON.stringify({...mountResult,unresolved:[{roleNodeId:'point-one',reason:index%2 ? 'missing_resolution' : 'ambiguous_definition'}]});
      h.state.db.prepare(`INSERT INTO role_learning_mounts(id,project_id,project_version_id,conversation_id,snapshot_id,owner_subject_id,source_run_id,policy_version,status,result_json,available_at,created_at,updated_at)
        VALUES(?,'project-one',?,?,'old-snapshot','learnflow:learner:1','old-run',?,'needs_research',?,'2000-01-01','2000-01-01','2000-01-01')`)
        .run(`old-mount-${index}`,versionId,conversationId,AUTOMATIC_MOUNT_POLICY,receipt);
    }
    assert.deepEqual(await h.service.listPendingAutomaticMountResearch(),['mount-one']);
    await h.service.enqueueLearningMountResearch('mount-one');
    assert.equal(h.state.db.prepare("SELECT COUNT(*) AS n FROM role_jobs WHERE id LIKE 'learning-repair:%'").get()?.n,1);
    assert.equal(h.state.db.prepare('SELECT COUNT(*) AS n FROM role_learning_repairs').get()?.n,1);
  }finally{h.close();}
});

test('expired preparation recovers original sealed providers without exposing credentials in job input', async () => {
  const h=await harness();try {
    const jobId=await automaticRepairJobId('mount-one');
    const providerConfig={provider:'mock',apiKey:'test-provider-secret'},searchConfig={provider:'mock-search',apiKey:'test-search-secret'};
    const envelope=await sealJobEnvelope({providerConfig,searchConfig},secret,'source-job');
    h.state.db.prepare('UPDATE role_job_dispatch SET envelope=? WHERE job_id=?').run(envelope,'source-job');
    h.state.db.prepare("INSERT INTO role_learning_repairs(origin_mount_id,job_id,status,attempt,lease_owner,lease_expires_at,created_at,updated_at) VALUES('mount-one',?,'preparing',1,'lost-worker','2000-01-01','2000-01-01','2000-01-01')").run(jobId);
    assert.deepEqual(await h.service.listPendingAutomaticMountResearch(),['mount-one']);
    await h.service.enqueueLearningMountResearch('mount-one');
    const child=h.state.db.prepare('SELECT * FROM role_jobs WHERE id=?').get(jobId)!;
    assert.equal(h.state.db.prepare('SELECT attempt FROM role_learning_repairs').get()?.attempt,2);
    assert.doesNotMatch(String(child.input_json),/test-provider-secret|test-search-secret/u);
    const queued=h.state.db.prepare('SELECT * FROM role_job_dispatch WHERE job_id=?').get(jobId)!;
    const payload=await openJobEnvelope<Record<string,unknown>>(String(queued.envelope),secret,jobId);
    assert.deepEqual(payload.providerConfig,providerConfig);assert.deepEqual(payload.searchConfig,searchConfig);
    assert.equal(h.state.captures[0].headers.has('x-role-atlas-delegation'),false);
  }finally{h.close();}
});

test('transient preparation retries are bounded and a spent crashed lease cannot restart research', async () => {
  const h=await harness();try {
    h.state.transientFailure=true;
    for(let attempt=1;attempt<=3;attempt++) {
      await h.service.enqueueLearningMountResearch('mount-one');
      assert.equal(h.state.db.prepare('SELECT attempt FROM role_learning_repairs').get()?.attempt,attempt);
    }
    assert.equal(h.state.db.prepare('SELECT status FROM role_learning_repairs').get()?.status,'stopped');
    assert.deepEqual(await h.service.listPendingAutomaticMountResearch(),[]);
    await h.service.enqueueLearningMountResearch('mount-one');assert.equal(h.state.centralCalls,3);
    h.state.db.exec("UPDATE role_learning_repairs SET status='preparing',lease_owner='lost-worker',lease_expires_at='2000-01-01'");
    assert.deepEqual(await h.service.listPendingAutomaticMountResearch(),[]);
    assert.equal(h.state.db.prepare('SELECT status FROM role_learning_repairs').get()?.status,'stopped');
    assert.equal(h.state.db.prepare("SELECT COUNT(*) AS n FROM role_jobs WHERE id LIKE 'learning-repair:%'").get()?.n,0);
  }finally{h.close();}
});
