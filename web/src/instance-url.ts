export function normalizeApiBase(value: string): string {
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Enter an HTTP or HTTPS URL without credentials, a query or a fragment.')
  url.pathname = url.pathname.replace(/\/+$/, '') + '/'
  return url.href
}

export interface InstanceLink { base: string; name: string; username?: string }

/** Share connection details, never the current page's session or navigation state. */
export function formatInstanceLink(frontendHref: string, server: InstanceLink): string {
  const url = new URL(normalizeApiBase(frontendHref.split(/[?#]/, 1)[0]!))
  url.searchParams.set('server', normalizeApiBase(server.base))
  url.searchParams.set('name', server.name)
  if (server.username) url.searchParams.set('username', server.username)
  return url.href
}

/** Import only connection details; query parameters never supply a session. */
export function parseInstanceLink(href: string): { url: URL; server?: InstanceLink; invalid: boolean } | undefined {
  const url = new URL(href)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return { url, invalid: true }
  if (!['server', 'name', 'username'].some(key => url.searchParams.has(key))) return
  const servers = url.searchParams.getAll('server'), names = url.searchParams.getAll('name'), usernames = url.searchParams.getAll('username')
  url.searchParams.delete('server'); url.searchParams.delete('name'); url.searchParams.delete('username')
  if (!servers.length) return { url, invalid: false }
  try {
    if (servers.length !== 1 || names.length > 1 || usernames.length > 1) throw new Error('Ambiguous connection')
    const base = normalizeApiBase(servers[0]!)
    const username = usernames[0]?.trim()
    if (username && (username.length > 200 || /[\u0000-\u001f\u007f]/.test(username))) throw new Error('Invalid username')
    return { url, server: { base, name: (names[0] || '').trim().replace(/\s+/g, ' ').slice(0, 80) || new URL(base).host,
      ...(username ? { username } : {}) }, invalid: false }
  } catch { return { url, invalid: true } }
}

export function isCanvasSession(value: unknown): value is { authenticated: boolean; username?: string } {
  if (!value || typeof value !== 'object') return false
  const session = value as { authenticated?: unknown; username?: unknown }
  return typeof session.authenticated === 'boolean' && (session.username === undefined || typeof session.username === 'string')
}

/** API paths are relative to the selected application, including its deployment prefix. */
export function resolveApiUrl(base: string, value: string): URL {
  const root = new URL(base)
  const url = value.startsWith('/api/') ? new URL(value.slice(1), root) : new URL(value, root)
  if (url.origin !== root.origin || url.username || url.password || url.hash || !url.pathname.startsWith(`${root.pathname}api/`))
    throw new Error('Invalid Canvas API URL')
  return url
}

export function instanceToken(serialized: string | null, base: string): string {
  try {
    const value = JSON.parse(serialized || 'null')
    return value?.base === base && typeof value.token === 'string' ? value.token : ''
  } catch { return '' }
}
