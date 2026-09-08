export const SITE_ORIGINS = ['https://learnflow.club', 'https://learn.learnflow.club', 'https://roles.learnflow.club', 'https://graphs.learnflow.club', 'https://w2ltask.learnflow.club']
export function isUnifiedSite(hostname: string) {
  return SITE_ORIGINS.some(origin => new URL(origin).hostname === hostname)
}
export function safeReturnTo(value: string | null) {
  try {
    const url = new URL(value || '')
    if (SITE_ORIGINS.includes(url.origin) && !url.username && !url.password && !['/login', '/logout'].includes(url.pathname)) return url.href
  } catch { /* Invalid or untrusted destinations return to the exhibition. */ }
  return SITE_ORIGINS[0] + '/'
}
export function loginDestination(returnTo: string) {
  const destination = new URL(safeReturnTo(returnTo))
  const token = conversionLaunchFragment(destination.hash)
  if (token) destination.hash = ''
  return SITE_ORIGINS[1] + '/login?return_to=' + encodeURIComponent(destination.href) + (token ? '#' + token : '')
}

function conversionLaunchFragment(hash: string) {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('role_token') || ''
  return token.length <= 8192 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ? new URLSearchParams({role_token:token}).toString() : ''
}

export function afterLoginDestination(returnTo: string | null, fragment: string) {
  const destination = new URL(safeReturnTo(returnTo))
  const token = conversionLaunchFragment(fragment)
  if (token && (destination.origin === 'https://w2ltask.learnflow.club' || destination.origin === 'https://learn.learnflow.club' && destination.pathname === '/convert')) destination.hash = token
  return destination.href
}

export function returnToFromSearch(search: string) {
  // The reverse proxy preserves the original URI; JS links use URL encoding.
  const prefix = '?return_to='
  return search.startsWith(prefix + 'https://')
    ? search.slice(prefix.length)
    : new URLSearchParams(search).get('return_to')
}
