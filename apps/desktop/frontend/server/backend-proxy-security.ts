type IncomingHeaderValue = string | string[] | undefined

export type BackendProxyHeadersInput = Record<string, IncomingHeaderValue>

function firstHeader(value: IncomingHeaderValue) {
  if (Array.isArray(value)) return value[0] || ''
  return value || ''
}

function includeHeader(
  target: Record<string, string>,
  incoming: BackendProxyHeadersInput,
  sourceName: string,
  targetName: string,
) {
  const value = firstHeader(incoming[sourceName]).trim()
  if (value) target[targetName] = value
}

/**
 * Build the narrow browser-to-backend header allow-list.
 *
 * Security headers are part of the authentication protocol, not incidental
 * transport metadata.  The proxy must preserve them while still refusing to
 * forward client-controlled hop-by-hop and forwarding headers wholesale.
 */
export function buildBackendProxyHeaders(
  incoming: BackendProxyHeadersInput,
  options: { bodyPresent: boolean; multipart: boolean; contentType: string },
) {
  const headers: Record<string, string> = {}
  if (options.bodyPresent) {
    headers['Content-Type'] = options.multipart
      ? options.contentType
      : 'application/json'
  }
  includeHeader(headers, incoming, 'cookie', 'Cookie')
  includeHeader(headers, incoming, 'authorization', 'Authorization')
  includeHeader(headers, incoming, 'origin', 'Origin')
  includeHeader(headers, incoming, 'referer', 'Referer')
  includeHeader(headers, incoming, 'sec-fetch-site', 'Sec-Fetch-Site')
  includeHeader(headers, incoming, 'x-csrf-token', 'X-CSRF-Token')
  includeHeader(headers, incoming, 'x-learnflow-desktop-token', 'X-LearnFlow-Desktop-Token')
  return headers
}
