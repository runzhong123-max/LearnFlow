/** The browser account desk is separate from the desktop key-only API. */
export function isIpAccountConsole(location: Pick<Location, 'protocol' | 'hostname' | 'pathname'>): boolean {
  return location.protocol === 'https:' && location.hostname === '8.148.28.98'
    && (location.pathname === '/account' || location.pathname === '/account/')
}

export function ipAccountApiUrl(input: string, location: Pick<Location, 'protocol' | 'hostname' | 'pathname'>): string {
  return isIpAccountConsole(location) && input.startsWith('/api/auth/')
    ? '/account-api' + input.slice('/api'.length) : input
}
