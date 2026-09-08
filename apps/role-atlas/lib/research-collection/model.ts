import { createModelInvoker } from "@/lib/agent/model";
import type { ProviderConfig } from "@/lib/providers";
import { callStore } from "./store";
import { removeCredential } from "./format";
import { recordModel } from "./record-model";
export function createRecordedModelInvoker(config:ProviderConfig,context:{projectId:string;runId:string}) { return recordModel(createModelInvoker(config),{...context,provider:config.provider,model:config.model},{start:row=>callStore.start({...row,request:removeCredential(row.request,config.apiKey)}),finish:(id,status,response,error)=>callStore.finish(id,status,removeCredential(response,config.apiKey),error?String(removeCredential(error,config.apiKey)):undefined)}); }
