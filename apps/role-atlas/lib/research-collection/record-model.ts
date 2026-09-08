import type { ModelInvoker } from "@/lib/agent/model";
import { bounded, COLLECTION_VERSION, sha256 } from "./format";
export type CallStore={start(row:{id:string;runId:string;projectId:string;provider:string;model:string;request:unknown}):Promise<void>;finish(id:string,status:string,response:unknown,error?:string):Promise<void>};
export function recordModel(base: ModelInvoker, context: {projectId:string;runId:string;provider:string;model:string}, store: CallStore): ModelInvoker {
  return async function* (input) {
    const id=crypto.randomUUID(), started=Date.now();
    await store.start({...context,id,request:{collectorVersion:COLLECTION_VERSION,system:bounded(input.system),user:bounded(input.user),promptHash:await sha256(new TextEncoder().encode(input.system+'\n'+input.user)),thinking:input.thinking||"enabled",stream:true,reasoningEffort:context.provider==="deepseek"?"high":undefined,maxCompletionTokens:input.maxCompletionTokens,timeoutMs:input.timeoutMs,totalTimeoutMs:input.totalTimeoutMs,buildRevision:process.env.ROLE_ATLAS_BUILD_REVISION||null}});
    let text="",reasoning="",textLength=0,reasoningLength=0,status="cancelled",error:string|undefined;
    try {
      for await(const part of base(input)) {
        if(part.type==="text") { textLength+=part.delta.length; text=(text+part.delta).slice(0,160_000); }
        else { reasoningLength+=part.delta.length; reasoning=(reasoning+part.delta).slice(0,160_000); }
        yield part;
      }
      status="completed";
    } catch(cause) { status=input.signal?.aborted?"cancelled":"failed";error=cause instanceof Error?cause.message:"MODEL_CALL_FAILED";throw cause; }
    finally { await store.finish(id,status,{text,reasoning,textOriginalCharacters:textLength,reasoningOriginalCharacters:reasoningLength,elapsedMs:Date.now()-started,textTruncated:textLength>text.length,reasoningTruncated:reasoningLength>reasoning.length,usage:null,usageAvailability:"not_reported_by_current_adapter"},error); }
  };
}
