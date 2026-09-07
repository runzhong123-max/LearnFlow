import { artifactHostRequest } from '../../../../packages/learning-client/src/visuals/plugin-host.ts'
import { runtimeFetch } from './runtime-client.ts'

export function browserArtifactHost(pluginId: string, options: {projectId?: number; sessionId?: number; renderer?: boolean; signal?: AbortSignal} = {}) {
  return { request: async (operation: string, payload: Record<string, any> = {}) => {
    const route = artifactHostRequest(pluginId, operation, payload, options, options.renderer ?? true)
    const response = await runtimeFetch(route.path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(route.body), signal:operation === 'checkpoint' || operation === 'cancel_job' ? AbortSignal.timeout(5000) : options.signal})
    const result = await response.json()
    if (!response.ok) throw new Error(`${response.status === 401 || response.status === 403 ? 'visual_auth_required:' : ''}${typeof result.detail === 'string' ? result.detail : 'visual_workspace_request_failed'}`)
    return result
  }}
}
