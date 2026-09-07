import { artifactHostRequest, type ArtifactHost } from '../../packages/learning-client/src/visuals/plugin-host.ts'

export function serverArtifactHost(options: {pluginId:string;backendBase?:string;cookie?:string;projectId?:number;sessionId?:number;signal:AbortSignal;generate:ArtifactHost['generate'];context:string;onStage?:ArtifactHost['onStage']}): ArtifactHost {
  let csrf: string | undefined
  return {generate:options.generate, context:options.context, onStage:options.onStage, request:async(operation,payload={}) => {
    const route = artifactHostRequest(options.pluginId,operation,payload,options)
    if (!options.backendBase) throw new Error('visual_host_required')
    const cleanup = operation === 'checkpoint' || operation === 'cancel_job'
    const signal = cleanup ? AbortSignal.timeout(5000) : AbortSignal.any([options.signal,AbortSignal.timeout(30000)])
    if (!csrf) {
      const response=await fetch(`${options.backendBase}/api/auth/csrf`, {headers:options.cookie?{Cookie:options.cookie}:{},signal})
      const result=await response.json()
      if (!response.ok || typeof result.csrf_token !== 'string') throw new Error('visual_auth_required')
      csrf=result.csrf_token
    }
    const response=await fetch(`${options.backendBase}${route.path}`, {method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,...(options.cookie?{Cookie:options.cookie}:{})},body:JSON.stringify(route.body),signal})
    const result=await response.json()
    if (!response.ok) throw new Error(`${response.status===401||response.status===403?'visual_auth_required:':''}${typeof result.detail==='string'?result.detail:'visual_workspace_request_failed'}`)
    return result
  }}
}
