/** Remote platform pages inside Tauri use their own web session, never local IPC. */
export function usesLocalDesktopRuntime(hasTauri: boolean, protocol: string, hostname: string): boolean {
  if (!hasTauri) return false
  if (protocol === 'tauri:') return hostname === 'localhost'
  if ((protocol === 'http:' || protocol === 'https:') && hostname === 'tauri.localhost') return true
  return protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')
}
