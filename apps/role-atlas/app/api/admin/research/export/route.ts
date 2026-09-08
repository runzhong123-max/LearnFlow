import { AccessError, accessErrorResponse } from "@/lib/access";
import { requireResearchAdmin } from "@/lib/research-collection/access";
import { collectionDb, adminEvent, attachmentBytes } from "@/lib/research-collection/store";
import { exportArchive, type ExportScope } from "@/lib/research-collection/export";
import { runKind, runTables } from "@/lib/research-collection/query";
export async function GET(request:Request) {
 try {
  const actor=await requireResearchAdmin(request),q=new URL(request.url).searchParams,db=await collectionDb();
  const headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"};
  if(q.has("attachmentId")) {
   const id=q.get("attachmentId")!;
   const row=await db.prepare("SELECT filename,sha256,byte_size FROM research_attachments WHERE id=?").bind(id).first<{filename:string;sha256:string;byte_size:number}>();
   if(!row)throw new AccessError(404,"ATTACHMENT_NOT_FOUND");
   const bytes=await attachmentBytes(row.sha256);
   await adminEvent(actor.subjectId,"attachment.export",{id,sha256:row.sha256});
   return new Response(bytes,{headers:{...headers,"Content-Type":"application/octet-stream","Content-Disposition":`attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(row.filename).replace(/'/g,"%27")}`}});
  }
  const section=q.get("section")||"all";
  if(!["all","inputs","calls","results","releases"].includes(section))throw new AccessError(400,"INVALID_SECTION");
  const scope:ExportScope={section:section as ExportScope["section"],projectId:q.get("projectId")||undefined,runId:q.get("runId")||undefined};
  if(scope.runId) {
   if(!["cold_start","iteration","workspace","risk","legacy_risk"].includes(q.get("kind")||""))throw new AccessError(400,"INVALID_RUN_KIND");
   scope.kind=runKind(q.get("kind")!);
   const row=await db.prepare(`SELECT project_id FROM ${runTables[scope.kind]} WHERE id=?`).bind(scope.runId).first<{project_id:string}>();
   if(!row||(scope.projectId&&scope.projectId!==row.project_id))throw new AccessError(404,"RUN_NOT_FOUND");scope.projectId=row.project_id;
  }
  if(scope.projectId&&!await db.prepare("SELECT id FROM projects WHERE id=?").bind(scope.projectId).first())throw new AccessError(404,"PROJECT_NOT_FOUND");
  await adminEvent(actor.subjectId,"archive.started",scope);
  return new Response(exportArchive(scope,data=>adminEvent(actor.subjectId,"archive.completed",data)),{headers:{...headers,"Content-Type":"application/zip","Content-Disposition":`attachment; filename="role-research-${section}-${new Date().toISOString().slice(0,10)}.zip"`}});
 }catch(error){return accessErrorResponse(error);}
}
