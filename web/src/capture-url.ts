/** A capture descriptor carries only a path within its lease, never another viewer's ingress. */
export function captureUrl(base: URL, path: string): URL | undefined {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\x00-\x20\x7f]/u.test(path)) return
  const url = new URL(`.${path}`, base)
  if (url.origin === base.origin && url.pathname.startsWith(base.pathname)) return url
}
