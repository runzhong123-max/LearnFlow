import {maintainedDocumentUrl} from '../../../../packages/learning-client/src/visuals/maintained-document'
import Page from '../../../../packages/learning-client/src/visuals/VisualHubPage'
import {runtimeFetch,getRuntimeClientState} from './runtime-client'
async function request(action:string,payload:Record<string,unknown>,signal?:AbortSignal){
 const response=await runtimeFetch('/api/visuals/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal});
 if(!response.ok){const failure=await response.json().catch(()=>({}));throw new Error((failure.code ? failure.code+': ' : '')+(typeof failure.detail==='string' ? failure.detail : '请求失败（'+response.status+'），请重试。'))}return response.json();
}
function documentUrl(path:unknown){
 const runtime=getRuntimeClientState();
 return runtime.kind==='desktop' ? maintainedDocumentUrl(path,runtime.apiBaseUrl) : undefined;
}
export default function VisualHubPage(){return <Page request={request} documentUrl={documentUrl}/>}
