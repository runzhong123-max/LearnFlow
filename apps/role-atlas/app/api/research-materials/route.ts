import { accessErrorResponse, AccessError } from "@/lib/access";
import { saveAttachment, rememberResearchRequester } from "@/lib/research-collection/store";
import { sourceInputSchema } from "@/lib/build/types";
export async function POST(request:Request) {
 try {
  const actor=await rememberResearchRequester(request);
  // Bound the streamed body before multipart parsing; Content-Length alone is untrusted.
  const reader=request.body?.getReader();if(!reader)throw new AccessError(400,"FILE_REQUIRED");
  const parts:Uint8Array[]=[];let size=0;
  try { while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>6*1024*1024){await reader.cancel();throw new AccessError(413,"FILE_TOO_LARGE");}parts.push(value);} }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  const form=await new Response(bytes,{headers:{"content-type":request.headers.get("content-type")||""}}).formData();
  const file=form.get("file");
  if(!file||typeof file==="string"||!file.size||file.size>5*1024*1024||file.name.length>240||! /\.(pdf|docx|txt|md|csv|json)$/i.test(file.name))throw new AccessError(400,"INVALID_ATTACHMENT");
  let extraction:unknown;
  const source=form.get("source");
  if(typeof source==="string"){
   const parsed=sourceInputSchema.safeParse(JSON.parse(source));if(!parsed.success)throw new AccessError(400,"INVALID_EXTRACTION");extraction={status:"ready",source:parsed.data};
  }else extraction={status:"failed",error:String(form.get("error")||"EXTRACTION_FAILED").slice(0,2000)};
  const saved=await saveAttachment(actor.subjectId,file,new Uint8Array(await file.arrayBuffer()),extraction);
  return Response.json(saved,{status:201,headers:{"Cache-Control":"private, no-store"}});
 }catch(error){if(error instanceof SyntaxError)return Response.json({error:"INVALID_FORM"},{status:400});return accessErrorResponse(error);}
}
