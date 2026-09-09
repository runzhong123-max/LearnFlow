import { accessErrorResponse, AccessError } from "@/lib/access";
import { requireResearchAdmin } from "@/lib/research-collection/access";
import { collectionDb, adminEvent } from "@/lib/research-collection/store";
import { projects, runs, detail, runKind } from "@/lib/research-collection/query";
import { decodeRow, redact } from "@/lib/research-collection/format";
export async function GET(request:Request) {
 try {
  const actor=await requireResearchAdmin(request), q=new URL(request.url).searchParams;
  const reply=(data:unknown)=>Response.json(redact(data),{headers:{"Cache-Control":"private, no-store"}});
  if(q.get("view")==="access")return reply({admin:true});
  const db=await collectionDb();
  if(q.has("callId")) {
   const row=await db.prepare("SELECT * FROM research_model_calls WHERE id=?").bind(q.get("callId")).first<Record<string,unknown>>();
   if(!row)throw new AccessError(404,"CALL_NOT_FOUND");
   await adminEvent(actor.subjectId,"call.read",{id:row.id});return reply(decodeRow(row));
  }
  if(q.has("runId")) {
   const kind=q.get("kind")||"";
   if(!["intake","cold_start","iteration","workspace","risk","legacy_risk"].includes(kind))throw new AccessError(400,"INVALID_RUN_KIND");
   const data=await detail(runKind(kind),q.get("runId")!);if(!data)throw new AccessError(404,"RUN_NOT_FOUND");
   await adminEvent(actor.subjectId,"run.read",{id:q.get("runId"),kind});return reply(data);
  }
  if(q.has("projectId")) {
   const id=q.get("projectId")!;
   const releases=await db.prepare("SELECT * FROM package_releases WHERE project_id=? ORDER BY created_at DESC").bind(id).all();
   return reply({runs:await runs(id),releases:releases.results});
  }
  const attachments=await db.prepare("SELECT a.id,a.owner_subject_id,a.filename,a.byte_size,a.created_at,json_extract(a.extraction_json,'$.status') extraction_status,(SELECT count(*) FROM research_run_attachments WHERE attachment_id=a.id) run_count FROM research_attachments a ORDER BY a.created_at DESC LIMIT 500").all<Record<string,unknown>>();
  const count=await db.prepare("SELECT count(*) n FROM research_attachments").first<{n:number}>();
  await adminEvent(actor.subjectId,"collection.read",{});
  return reply({projects:await projects(),attachments:attachments.results.map(decodeRow),attachmentCount:count?.n||0,attachmentPreviewLimit:500});
 }catch(error){return accessErrorResponse(error);}
}
