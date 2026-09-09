import { backendWriteHeaders } from './backend-identity.ts'
import { artifactHostRequest, type ArtifactHost } from '../../packages/learning-client/src/visuals/plugin-host.ts'

export function serverArtifactHost(options: {pluginId:string;backendBase?:string;cookie?:string;authorization?:string;desktopToken?:string;projectId?:number;sessionId?:number;signal:AbortSignal;generate:ArtifactHost['generate'];context:string;onStage?:ArtifactHost['onStage']}): ArtifactHost {
  return {generate:options.generate, context:options.context, onStage:options.onStage, request:async(operation,payload={}) => {
    const route = artifactHostRequest(options.pluginId,operation,payload,options)
    if (!options.backendBase) throw new Error('visual_host_required')
    const cleanup = operation === 'checkpoint' || operation === 'cancel_job'
    const signal = cleanup ? AbortSignal.timeout(5000) : AbortSignal.any([options.signal,AbortSignal.timeout(30000)])
    const headers = await backendWriteHeaders({backendBase:options.backendBase,requestCookie:options.cookie,requestAuthorization:options.authorization,requestDesktopToken:options.desktopToken}, signal)
    const response=await fetch(`${options.backendBase}${route.path}`, {method:'POST',headers,body:JSON.stringify(route.body),signal})
    const result=await response.json()
    if (!response.ok) throw new Error(`${response.status===401||response.status===403?'visual_auth_required:':''}${typeof result.detail==='string'?result.detail:'visual_workspace_request_failed'}`)
    return result
  }}
}
