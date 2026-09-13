import { backendWriteHeaders, type BackendIdentity } from './backend-identity.ts'
import { checkedRolePackageRef, sameRolePackageRef, type RolePackageHost } from '../../packages/learning-client/src/role-packages/reference.ts'

/** Only the Tutor host owns transport/credentials. Nothing is cached across requests or accounts. */
export function serverRolePackageHost(input: BackendIdentity & { backendBase?: string }, signal: AbortSignal): RolePackageHost {
  return { resolve: async reference => {
    const packageRef = checkedRolePackageRef(reference)
    if (!input.backendBase) throw new Error('role_package_gateway_unavailable:正式岗位服务未连接')
    const requestId = `role-read:${crypto.randomUUID()}`
    const headers = await backendWriteHeaders(input, signal)
    const response = await fetch(`${input.backendBase}/api/ecosystem/dispatch`, {
      method: 'POST', headers, redirect: 'error', cache: 'no-store', signal,
      body: JSON.stringify({ protocol: 'learnflow-ecosystem/v1', requestId, operation: 'package.resolve', payload: { packageRef, format: 'bundle' } }),
    })
    if (!response.body) throw new Error('role_package_gateway_invalid_response')
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let bytes = 0, text = ''
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('role_package_gateway_response_too_large') }
        text += decoder.decode(chunk.value, { stream: true })
      }
      text += decoder.decode()
    } finally { reader.releaseLock() }
    let envelope: any
    try { envelope = JSON.parse(text) } catch { throw new Error('role_package_gateway_invalid_response') }
    if (!response.ok || !envelope.ok) {
      const code = /^[a-zA-Z0-9_]{1,80}$/.test(envelope?.error?.code) ? envelope.error.code : `HTTP_${response.status}`
      throw new Error(`role_package_gateway_denied:${code}:岗位包不可用或当前账号无权读取，请检查发布状态与登录账号`)
    }
    if (envelope.protocol !== 'learnflow-ecosystem/v1' || envelope.requestId !== requestId
      || !sameRolePackageRef(packageRef, checkedRolePackageRef(envelope.data?.packageRef))) throw new Error('role_package_gateway_identity_mismatch')
    return envelope.data.bundle
  } }
}
export function rolePackageToolContext(pluginId: string, input: BackendIdentity & { backendBase?: string }, signal: AbortSignal) {
  return pluginId === 'role_capability_graph' ? { rolePackageHost: serverRolePackageHost(input, signal) } : {}
}
