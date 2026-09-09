import { Zip, ZipPassThrough, strToU8 } from "fflate";
import { COLLECTION_VERSION, redact, safeName, pathToken, sha256 } from "./format";
import { projects, runs, rows, runTables, eventTables, hasCollectionTable, runAttachmentIds, type CollectionDatabase, type RunKind } from "./query";
export type ExportScope={projectId?:string;runId?:string;kind?:RunKind;section:"all"|"inputs"|"calls"|"results"|"releases"};
export function exportArchive(scope:ExportScope, onComplete:(detail:unknown)=>Promise<void>, dependencies?: { database: CollectionDatabase; attachmentBytes?: (hash:string)=>Promise<Uint8Array> }) {
 const collectionDb=dependencies?.database||(async()=> (await import("./store")).collectionDb());
 const attachmentBytes=dependencies?.attachmentBytes||(async(hash:string)=>(await import("./store")).attachmentBytes(hash));
 let cancelled=false;
 let wake:(()=>void)|undefined;
 return new ReadableStream<Uint8Array>({
  start(controller) {
   const manifest:{path:string;bytes:number;sha256:string}[]=[],errors:string[]=[];
   const zip=new Zip((error,data,final)=>{if(cancelled)return;if(error){controller.error(error);cancelled=true;return;}controller.enqueue(data);if(final)controller.close();});
   let total=0;
   const add=async(path:string,data:Uint8Array,record=true)=>{
    while(!cancelled&&(controller.desiredSize??1)<=0)await new Promise<void>(resolve=>{wake=resolve;});
    if(cancelled)throw new Error("EXPORT_CANCELLED");total+=data.byteLength;if(total>512*1024*1024)throw new Error("EXPORT_EXCEEDS_512_MB_SELECT_A_PROJECT");
    if(record)manifest.push({path,bytes:data.byteLength,sha256:await sha256(data)});
    const file=new ZipPassThrough(path);zip.add(file);file.push(data,true);
   };
   const json=(path:string,value:unknown)=>add(path,strToU8(JSON.stringify(redact(value??null),null,2)));
   const table=async(path:string,name:string,where:string,values:unknown[])=>{let i=0;for await(const row of rows(name,where,values,collectionDb))await json(`${path}/${String(++i).padStart(6,"0")}.json`,row);};
   void(async()=>{
    try {
     await add("README.txt",strToU8("Role Atlas 测试分析包\n按项目、运行和类别组织；JSON 为分析原始记录，manifest 含文件哈希。\nintake=岗位澄清/说明修订；input=实际提交；result=候选及验收；versions=不可变生效历史。岗位说明确认只是研究范围确认，不是图谱完成。失败、无变化与未采用候选也保留。\n旧记录可能没有附件原件、实际模型请求；缺失不表示未使用。模型文本有长度上限，截断字段会明确标记。usage 未提供时为 null。\n文本导出会移除已识别凭据；附件原件保持原始字节，勿公开转发。\n运行中的记录是导出时观察值，不保证已经完成。\n文件过大或读取失败会在 manifest.errors 标明，请拆分项目重新导出。\n"));
     const selected=(await projects(collectionDb)).filter(p=>!scope.projectId||p.id===scope.projectId);
     if(scope.projectId&&!selected.length)throw new Error("PROJECT_NOT_FOUND");
     for(const p of selected) {
      const root=`projects/${pathToken(String(p.id))}`;await json(`${root}/project.json`,p);
      for(const run of (await runs(String(p.id),collectionDb)).filter(r=>!scope.runId||(r.id===scope.runId&&r.kind===scope.kind))) {
       const kind=run.kind as RunKind,id=String(run.id),base=`${root}/runs/${kind}-${pathToken(id)}`;
       const db=await collectionDb();const raw=await db.prepare(`SELECT * FROM ${runTables[kind]} WHERE id=?`).bind(id).first<Record<string,unknown>>();if(!raw)continue;
       const {input_json,result_json,checkpoint_json,...meta}=raw;
       await json(`${base}/run.json`,{...meta,kind,status:run.status,started_at:run.started_at,completed_at:run.completed_at});
       const parse=(x:unknown)=>{try{return JSON.parse(String(x));}catch{return x;}};
       if(["all","inputs"].includes(scope.section)) {
        await json(`${base}/inputs.json`,parse(input_json));
        const job=await db.prepare("SELECT input_json,conversation_id,base_version_id,base_snapshot_id,kind,attempt FROM role_jobs WHERE id=? AND project_id=?").bind(id,p.id).first<Record<string,unknown>>();
        if(job)await json(`${base}/submitted-job.json`,{...job,input_json:parse(job.input_json)});
        if(kind==="intake") {
         const result=parse(result_json) as Record<string,unknown>|null;
         await json(`${base}/sources.json`,{supplied:(parse(input_json) as Record<string,unknown>|null)?.sources||[],retained:result?.sources||[],independentResearch:result?.researchSources||[]});
        }
       }
       if(["all","results"].includes(scope.section)) {
        await json(`${base}/result.json`,parse(result_json));await json(`${base}/checkpoint.json`,parse(checkpoint_json));
        if(eventTables[kind])await table(`${base}/events`,eventTables[kind],"run_id=?",[id]);
        if(kind==="intake") {
         const result=parse(result_json) as Record<string,unknown>|null;
         await json(`${base}/research-report.json`,result?.researchReport);
         if(await hasCollectionTable(db,"role_intakes"))await table(`${base}/intake-state`,"role_intakes","project_id=? AND conversation_id=?",[p.id,raw.conversation_id]);
        }
        await table(`${base}/job`,"role_jobs","id=?",[id]);
       }
       if(["all","inputs","results"].includes(scope.section))await table(`${base}/attempts`,"research_run_attempts","run_id=? AND project_id=?",[id,p.id]);
       if(["all","calls"].includes(scope.section))await table(`${base}/model-calls`,"research_model_calls","run_id=?",[id]);
      }
      if(["all","results"].includes(scope.section)) {
       const filter=scope.runId?"project_id=? AND source_run_id=?":"project_id=?",values=scope.runId?[p.id,scope.runId]:[p.id];
       await table(`${root}/versions`,"project_versions",filter,values);
       if(scope.runId)await table(`${root}/base-versions`,"project_versions","project_id=? AND (id IN (SELECT base_version_id FROM role_jobs WHERE id=?) OR snapshot_id IN (SELECT base_snapshot_id FROM snapshot_iteration_runs WHERE id=?) OR id IN (SELECT parent_version_id FROM project_versions WHERE source_run_id=?))",[p.id,scope.runId,scope.runId,scope.runId]);
       if(!scope.runId){await table(`${root}/diffs`,"semantic_diffs","project_id=?",[p.id]);await table(`${root}/version-events`,"project_version_events","project_id=?",[p.id]);await table(`${root}/conversations`,"conversations","project_id=?",[p.id]);await table(`${root}/messages`,"messages","conversation_id IN (SELECT id FROM conversations WHERE project_id=?)",[p.id]);}
      }
      if(["all","releases"].includes(scope.section))await table(`${root}/releases`,"package_releases",scope.runId?"project_id=? AND source_project_version_id IN (SELECT id FROM project_versions WHERE source_run_id=?)":"project_id=?",scope.runId?[p.id,scope.runId]:[p.id]);
      if(["all","releases"].includes(scope.section))await table(`${root}/release-events`,"release_events",scope.runId?"project_id=? AND release_id IN (SELECT id FROM package_releases WHERE source_project_version_id IN (SELECT id FROM project_versions WHERE source_run_id=?))":"project_id=?",scope.runId?[p.id,scope.runId]:[p.id]);
     }
     if(["all","inputs"].includes(scope.section)) {
      const inherited=scope.runId&&scope.kind==="intake"?await runAttachmentIds(scope.kind,scope.runId,collectionDb):null;
      const where=inherited?(inherited.length?`id IN (${inherited.map(()=>"?").join(",")})`:"0=1"):scope.runId?"id IN (SELECT attachment_id FROM research_run_attachments WHERE run_id=?)":scope.projectId?"id IN (SELECT attachment_id FROM research_run_attachments WHERE project_id=?)":"1=1";
      for await(const a of rows("research_attachments",where,inherited|| (scope.runId?[scope.runId]:scope.projectId?[scope.projectId]:[]),collectionDb)) {
       const root=`attachments/${pathToken(String(a.id))}`;await json(`${root}/metadata.json`,a);
       await add(`${root}/original-${safeName(String(a.filename))}`,await attachmentBytes(String(a.sha256)));
      }
      await table("attachment-links","research_run_attachments",scope.runId?"run_id=?":scope.projectId?"project_id=?":"1=1",scope.runId?[scope.runId]:scope.projectId?[scope.projectId]:[]);
     }
    }catch(error){if(cancelled)return;errors.push(error instanceof Error?error.message:"EXPORT_FAILED");}
    if(cancelled)return;
    try{await onComplete({scope,fileCount:manifest.length,bytes:total,errors});}catch{errors.push("EXPORT_AUDIT_WRITE_FAILED");}
    const end={schemaVersion:COLLECTION_VERSION,exportedAt:new Date().toISOString(),scope,complete:!errors.length,errors,files:manifest};
    // Always close a readable archive, even when the export cap was reached.
    const file=new ZipPassThrough("manifest.json");zip.add(file);file.push(strToU8(JSON.stringify(end,null,2)),true);zip.end();
   })().catch(error=>{if(!cancelled)controller.error(error);});
  },pull(){wake?.();wake=undefined;},cancel(){cancelled=true;wake?.();},
 });
}
