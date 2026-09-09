import { decodeRow } from "./format";
export type CollectionDatabase = () => Promise<D1Database>;
const collectionDb: CollectionDatabase = async () => (await import("./store")).collectionDb();
/** Intake was added after the original archive; reading an old database must not create it. */
export async function hasCollectionTable(db: D1Database, table: string) {
 return Boolean(await db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").bind(table).first());
}
export const runTables = { intake:"role_intake_revisions", cold_start:"build_runs", iteration:"snapshot_iteration_runs", workspace:"workspace_ingestion_runs", risk:"snapshot_risk_runs", legacy_risk:"risk_runs" } as const;
export type RunKind=keyof typeof runTables;
export function runKind(value:string):RunKind { if(!Object.hasOwn(runTables,value)) throw new Error("INVALID_RUN_KIND");return value as RunKind; }
export async function projects(database: CollectionDatabase = collectionDb) {
 const db=await database(), intakeCount=await hasCollectionTable(db,runTables.intake) ? "(SELECT count(*) FROM role_intake_revisions WHERE project_id=p.id)" : "0";
 return (await db.prepare(`SELECT p.id,p.title,p.owner_subject_id,t.display_name owner_name,t.username owner_username,p.created_at,p.updated_at,p.deleted_at,p.head_version_id,
 (SELECT count(*) FROM build_runs WHERE project_id=p.id)+(SELECT count(*) FROM snapshot_iteration_runs WHERE project_id=p.id)+(SELECT count(*) FROM workspace_ingestion_runs WHERE project_id=p.id)+(SELECT count(*) FROM snapshot_risk_runs WHERE project_id=p.id)+(SELECT count(*) FROM risk_runs WHERE project_id=p.id)+${intakeCount} run_count
 FROM projects p LEFT JOIN research_testers t ON t.subject_id=p.owner_subject_id ORDER BY p.updated_at DESC`).all()).results;
}
export async function runs(projectId:string,database: CollectionDatabase = collectionDb) {
 const db=await database();const out:Record<string,unknown>[]=[];
 for(const [kind,table] of Object.entries(runTables)) {
  if(kind==="intake"&&!await hasCollectionTable(db,table))continue;
  const fields=kind==="intake" ? "id,CASE state WHEN 'ready' THEN 'completed' ELSE state END status,state,created_at started_at,CASE WHEN state!='running' THEN updated_at END completed_at,error,conversation_id,base_revision_id,confirmed_at,confirmed_by,build_run_id,CASE WHEN json_valid(input_json) THEN json_extract(input_json,'$.action') END action" : "id,status,started_at,completed_at,error";
  const rows=await db.prepare(`SELECT ${fields} FROM ${table} WHERE project_id=? ORDER BY started_at DESC`).bind(projectId).all<Record<string,unknown>>();
  out.push(...rows.results.map(r=>({...r,kind})));
 }
 return out.sort((a,b)=>String(b.started_at).localeCompare(String(a.started_at)));
}
export async function* rows(table:string,where:string,values:unknown[],database: CollectionDatabase = collectionDb) {
 const db=await database();let offset=0;
 while(true) { const result=await db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid LIMIT 30 OFFSET ?`).bind(...values,offset).all<Record<string,unknown>>();
  for(const row of result.results) yield decodeRow(row);
  if(result.results.length<30)break;offset+=30;
 }
}
/** Later intake turns may inherit materials without creating another attachment link. */
export async function runAttachmentIds(kind:RunKind,id:string,database:CollectionDatabase=collectionDb) {
 const db=await database();
 const linked=await db.prepare("SELECT attachment_id FROM research_run_attachments WHERE run_id=?").bind(id).all<{attachment_id:string}>();
 const ids=new Set(linked.results.map(row=>row.attachment_id));
 if(kind!=="intake"||!await hasCollectionTable(db,runTables.intake))return [...ids];
 const row=await db.prepare("SELECT project_id,input_json,result_json FROM role_intake_revisions WHERE id=?").bind(id).first<Record<string,unknown>>();
 if(!row)return [...ids];
 const decoded=decodeRow(row), references=new Set<string>();
 for(const value of [decoded.input,decoded.result]) {
  const sources=value&&typeof value==="object"?(value as Record<string,unknown>).sources:undefined;
  if(Array.isArray(sources))for(const source of sources)if(source&&typeof source.attachmentId==="string")references.add(source.attachmentId);
 }
 // Ownership still applies to inherited or malformed historical references.
 for(const attachmentId of references)if(!ids.has(attachmentId)&&await db.prepare("SELECT a.id FROM research_attachments a JOIN projects p ON p.owner_subject_id=a.owner_subject_id WHERE p.id=? AND a.id=?").bind(row.project_id,attachmentId).first())ids.add(attachmentId);
 return [...ids];
}
export async function detail(kind:RunKind,id:string,database: CollectionDatabase = collectionDb) {
 const db=await database();if(kind==="intake"&&!await hasCollectionTable(db,runTables.intake))return null;const row=await db.prepare(`SELECT * FROM ${runTables[kind]} WHERE id=?`).bind(id).first<Record<string,unknown>>();
 if(!row)return null;
 const events:Record<string,unknown>[]=[];
 const eventTable=eventTables[kind];
 const count=eventTable?await db.prepare(`SELECT count(*) n FROM ${eventTable} WHERE run_id=?`).bind(id).first<{n:number}>():null;
 // UI is a bounded preview. Full exports use the paged iterator.
 if(eventTable){const eventRows=await db.prepare(`SELECT seq,kind,created_at FROM ${eventTable} WHERE run_id=? ORDER BY seq LIMIT 200`).bind(id).all();events.push(...eventRows.results);}
 const calls=await db.prepare("SELECT id,provider,model,status,started_at,completed_at,error FROM research_model_calls WHERE run_id=? ORDER BY started_at").bind(id).all();
 const attachmentIds=await runAttachmentIds(kind,id,database);
 const attachments=attachmentIds.length?await db.prepare(`SELECT id,filename,byte_size,sha256,created_at FROM research_attachments WHERE id IN (${attachmentIds.map(()=>"?").join(",")})`).bind(...attachmentIds).all():{results:[]};
 const attempts=await db.prepare("SELECT attempt,status,phase,input_json,base_version_id,base_snapshot_id,created_at,completed_at,error FROM research_run_attempts WHERE run_id=? AND project_id=? ORDER BY attempt").bind(id,row.project_id).all<Record<string,unknown>>();
 const data=decodeRow(row);
 const intakeState=kind==="intake"&&await hasCollectionTable(db,"role_intakes") ? await db.prepare("SELECT * FROM role_intakes WHERE project_id=? AND conversation_id=?").bind(row.project_id,row.conversation_id).first() : undefined;
 return {...data,kind,...(kind==="intake"?{status:row.state==="ready"?"completed":row.state,started_at:row.created_at,completed_at:row.state==="running"?null:row.updated_at,intakeState}:{}),attempts:attempts.results.map(decodeRow),events,eventCount:count?.n||0,eventsPreviewLimit:200,calls:calls.results,attachments:attachments.results,collection:{modelCallsCaptured:calls.results.length>0,originalAttachmentsCaptured:attachments.results.length>0,legacyNotice:"历史未采集的原件与模型请求无法补回；无调用也可能是缓存命中或确定性检查。"}};
}
export const eventTables={intake:null,cold_start:"build_events",iteration:"snapshot_iteration_events",workspace:"workspace_ingestion_events",risk:"snapshot_risk_events",legacy_risk:"risk_events"} as const;
