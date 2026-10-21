// Restrict outbound requests to browser push providers, never arbitrary URLs from clients.
const suffixes = ['push.services.mozilla.com', 'push.apple.com', 'notify.windows.com']
export function validPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 4096) return false
  try {
    const url = new URL(endpoint)
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443') &&
      (url.hostname === 'fcm.googleapis.com' || suffixes.some(host => url.hostname === host || url.hostname.endsWith('.' + host)))
  } catch { return false }
}
