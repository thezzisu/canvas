export function normalizeApiBase(value: string): string {
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Enter an HTTP or HTTPS URL without credentials, a query or a fragment.')
  url.pathname = url.pathname.replace(/\/+$/, '') + '/'
  return url.href
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
