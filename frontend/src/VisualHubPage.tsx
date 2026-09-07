import Page from '../../packages/learning-client/src/visuals/VisualHubPage'
async function request(action:string,payload:Record<string,unknown>,signal?:AbortSignal){
 const response=await fetch('/api/visuals/'+action,{credentials:'omit',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal});
 if(!response.ok)throw new Error('读取失败（'+response.status+'），请重试。');return response.json();
}
export default function VisualHubPage(){return <Page request={request}/>}
