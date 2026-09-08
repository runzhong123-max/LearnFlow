import { collectionDb } from "./store";
import { decodeRow } from "./format";
export const runTables = { cold_start:"build_runs", iteration:"snapshot_iteration_runs", workspace:"workspace_ingestion_runs", risk:"snapshot_risk_runs", legacy_risk:"risk_runs" } as const;
export type RunKind=keyof typeof runTables;
export function runKind(value:string):RunKind { if(!Object.hasOwn(runTables,value)) throw new Error("INVALID_RUN_KIND");return value as RunKind; }
export async function projects() {
 const db=await collectionDb();
 return (await db.prepare(`SELECT p.id,p.title,p.owner_subject_id,t.display_name owner_name,t.username owner_username,p.created_at,p.updated_at,p.deleted_at,p.head_version_id,
 (SELECT count(*) FROM build_runs WHERE project_id=p.id)+(SELECT count(*) FROM snapshot_iteration_runs WHERE project_id=p.id)+(SELECT count(*) FROM workspace_ingestion_runs WHERE project_id=p.id)+(SELECT count(*) FROM snapshot_risk_runs WHERE project_id=p.id)+(SELECT count(*) FROM risk_runs WHERE project_id=p.id) run_count
 FROM projects p LEFT JOIN research_testers t ON t.subject_id=p.owner_subject_id ORDER BY p.updated_at DESC`).all()).results;
}
export async function runs(projectId:string) {
 const db=await collectionDb();const out:Record<string,unknown>[]=[];
 for(const [kind,table] of Object.entries(runTables)) {
  const rows=await db.prepare(`SELECT id,status,started_at,completed_at,error FROM ${table} WHERE project_id=? ORDER BY started_at DESC`).bind(projectId).all<Record<string,unknown>>();
  out.push(...rows.results.map(r=>({...r,kind})));
 }
 return out.sort((a,b)=>String(b.started_at).localeCompare(String(a.started_at)));
}
export async function* rows(table:string,where:string,values:unknown[]) {
 const db=await collectionDb();let offset=0;
 while(true) { const result=await db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid LIMIT 30 OFFSET ?`).bind(...values,offset).all<Record<string,unknown>>();
  for(const row of result.results) yield decodeRow(row);
  if(result.results.length<30)break;offset+=30;
 }
}
export async function detail(kind:RunKind,id:string) {
 const db=await collectionDb();const row=await db.prepare(`SELECT * FROM ${runTables[kind]} WHERE id=?`).bind(id).first<Record<string,unknown>>();
 if(!row)return null;
 const events:Record<string,unknown>[]=[];
 const eventTable={cold_start:"build_events",iteration:"snapshot_iteration_events",workspace:"workspace_ingestion_events",risk:"snapshot_risk_events",legacy_risk:"risk_events"}[kind];
 const count=await db.prepare(`SELECT count(*) n FROM ${eventTable} WHERE run_id=?`).bind(id).first<{n:number}>();
 // UI is a bounded preview. Full exports use the paged iterator.
 const eventRows=await db.prepare(`SELECT seq,kind,created_at FROM ${eventTable} WHERE run_id=? ORDER BY seq LIMIT 200`).bind(id).all();events.push(...eventRows.results);
 const calls=await db.prepare("SELECT id,provider,model,status,started_at,completed_at,error FROM research_model_calls WHERE run_id=? ORDER BY started_at").bind(id).all();
 const attachments=await db.prepare("SELECT a.id,a.filename,a.byte_size,a.sha256,a.created_at FROM research_attachments a JOIN research_run_attachments l ON l.attachment_id=a.id WHERE l.run_id=?").bind(id).all();
 const attempts=await db.prepare("SELECT attempt,status,phase,input_json,base_version_id,base_snapshot_id,created_at,completed_at,error FROM research_run_attempts WHERE run_id=? AND project_id=? ORDER BY attempt").bind(id,row.project_id).all<Record<string,unknown>>();
 const data=decodeRow(row);
 return {...data,kind,attempts:attempts.results.map(decodeRow),events,eventCount:count?.n||0,eventsPreviewLimit:200,calls:calls.results,attachments:attachments.results,collection:{modelCallsCaptured:calls.results.length>0,originalAttachmentsCaptured:attachments.results.length>0,legacyNotice:"历史未采集的原件与模型请求无法补回；无调用也可能是缓存命中或确定性检查。"}};
}
export const eventTables={cold_start:"build_events",iteration:"snapshot_iteration_events",workspace:"workspace_ingestion_events",risk:"snapshot_risk_events",legacy_risk:"risk_events"} as const;
