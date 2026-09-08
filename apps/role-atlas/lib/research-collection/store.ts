import { requestActor } from "@/lib/access";
import { ensureAppSchema, getD1 } from "@/db";
import { collectionSchema } from "./schema";
import { redact, sha256 } from "./format";
let ready: Promise<unknown> | undefined;
export async function collectionDb() {
  await ensureAppSchema();
  ready ||= getD1().batch(collectionSchema.map(sql=>getD1().prepare(sql))).catch(error=>{ ready=undefined; throw error; });
  await ready; return getD1();
}
export async function adminEvent(actor: string, action: string, detail: unknown) {
  const db=await collectionDb();
  await db.prepare("INSERT INTO research_admin_events VALUES (?,?,?,?,?)").bind(crypto.randomUUID(),actor,action,JSON.stringify(redact(detail)),new Date().toISOString()).run();
}
export async function saveAttachment(owner: string, file: {name:string; type:string}, bytes: Uint8Array, extraction: unknown) {
  const db=await collectionDb(), hash=await sha256(bytes), id=await sha256(new TextEncoder().encode(`${owner}\n${file.name}\n${hash}`));
  const old=await db.prepare("SELECT id FROM research_attachments WHERE id=?").bind(id).first();
  if (!old) {
    const quota=await db.prepare("SELECT coalesce(sum(byte_size),0) total FROM research_attachments WHERE owner_subject_id=?").bind(owner).first<{total:number}>();
    if ((quota?.total||0)+bytes.length>200*1024*1024) throw new Error("附件存档已达到 200 MB，请联系管理员导出整理。");
    const statements=[];
    for(let start=0,part=0;start<bytes.length;start+=200_000,part++) statements.push(db.prepare("INSERT OR IGNORE INTO research_attachment_chunks VALUES (?,?,?)").bind(hash,part,bytes.slice(start,start+200_000).buffer));
    statements.push(db.prepare("INSERT OR IGNORE INTO research_attachments VALUES (?,?,?,?,?,?,?,?)").bind(id,owner,file.name,file.type||"application/octet-stream",bytes.length,hash,JSON.stringify(redact(extraction)),new Date().toISOString()));
    await db.batch(statements);
  }
  return { attachmentId:id, sha256:hash };
}
export async function linkRunAttachments(projectId: string, runId: string, payload: unknown, validateOnly=false) {
  const ids=new Set<string>();
  function visit(value:unknown) { if(Array.isArray(value)) value.forEach(visit); else if(value&&typeof value==="object") for(const [k,v] of Object.entries(value)) { if(k==="attachmentId"&&typeof v==="string") ids.add(v); else visit(v); } }
  visit(payload); if(!ids.size) return;
  const db=await collectionDb();
  for(const id of ids) {
    const row=await db.prepare("SELECT a.id FROM research_attachments a JOIN projects p ON p.owner_subject_id=a.owner_subject_id WHERE p.id=? AND a.id=?").bind(projectId,id).first();
    if(!row) throw new Error("ATTACHMENT_OWNERSHIP_MISMATCH");
  }
  if(validateOnly)return;
  await db.batch([...ids].map(id=>db.prepare("INSERT OR IGNORE INTO research_run_attachments VALUES (?,?,?)").bind(runId,projectId,id)));
}
export const callStore = {
  async start(row: {id:string; runId:string; projectId:string; provider:string; model:string; request:unknown}) {
    const db=await collectionDb();
    const job=await db.prepare("SELECT attempt FROM role_jobs WHERE id=? AND project_id=?").bind(row.runId,row.projectId).first<{attempt:number}>();
    await db.prepare("INSERT INTO research_model_calls(id,run_id,project_id,provider,model,request_json,status,started_at) VALUES(?,?,?,?,?,?,?,?)").bind(row.id,row.runId,row.projectId,row.provider,row.model,JSON.stringify(redact({...row.request as Record<string,unknown>,jobAttempt:job?.attempt||null})),"running",new Date().toISOString()).run();
  },
  async finish(id:string, status:string, response:unknown, error?:string) {
    const db=await collectionDb();
    await db.prepare("UPDATE research_model_calls SET status=?,response_json=?,error=?,completed_at=? WHERE id=?").bind(status,JSON.stringify(redact(response)),error?String(redact(error)):null,new Date().toISOString(),id).run();
  },
};

export async function attachmentBytes(hash:string) {
 const db=await collectionDb();
 const chunks=await db.prepare("SELECT data FROM research_attachment_chunks WHERE sha256=? ORDER BY part").bind(hash).all<{data:number[]|ArrayBuffer}>();
 const parts=chunks.results.map(c=>new Uint8Array(c.data as ArrayBuffer));
 const bytes=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
 if(await sha256(bytes)!==hash)throw new Error("ATTACHMENT_HASH_MISMATCH");return bytes;
}

/** Preserve the submitted input for every lease attempt, without relaxing the job input immutability fence. */
export async function archiveJobAttempt(jobId:string,projectId?:string) {
 const db=await collectionDb();
 await db.prepare(`INSERT INTO research_run_attempts(run_id,attempt,project_id,kind,input_json,base_version_id,base_snapshot_id,status,phase,checkpoint_json,result_json,error,created_at,updated_at,completed_at)
  SELECT id,attempt,project_id,kind,input_json,base_version_id,base_snapshot_id,status,phase,checkpoint_json,result_json,error,updated_at,updated_at,completed_at FROM role_jobs
  WHERE id=? AND project_id IS NOT NULL AND (? IS NULL OR project_id=?)
  ON CONFLICT(run_id,attempt) DO UPDATE SET status=excluded.status,phase=excluded.phase,checkpoint_json=excluded.checkpoint_json,result_json=excluded.result_json,error=excluded.error,updated_at=excluded.updated_at,completed_at=excluded.completed_at`).bind(jobId,projectId||null,projectId||null).run();
}

export async function rememberResearchRequester(request:Request) {
 const actor=await requestActor(request), db=await collectionDb();
 await db.prepare("INSERT INTO research_testers VALUES(?,?,?,?) ON CONFLICT(subject_id) DO UPDATE SET username=excluded.username,display_name=excluded.display_name,updated_at=excluded.updated_at").bind(actor.subjectId,actor.username,actor.displayName,new Date().toISOString()).run();
 return actor;
}
