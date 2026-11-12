/** A document view may read only paths inside its current capture's resource root. */
export function documentLocation(href: string) {
  try {
    const current = new URL(href),
      path = current.searchParams.get('path') || ''
    if (
      !/\/api\/document\/[A-Za-z0-9_-]{43}\/$/u.test(current.pathname) ||
      !path ||
      path.length > 16384
    )
      return
    const root = new URL(current.pathname.replace(/\/api\/document\//u, '/api/capture/'), current)
    const source = new URL(path.replace(/^\//u, ''), root)
    if (
      source.origin !== root.origin ||
      !source.pathname.startsWith(root.pathname) ||
      source.username ||
      source.password
    )
      return
    const filename = decodeURIComponent(source.pathname.split('/').at(-1) || '')
    const raw = new URL(source)
    raw.searchParams.set('canvas', 'raw')
    const download = new URL(source)
    download.searchParams.set('canvas', 'download')
    return {
      source,
      raw,
      download,
      filename,
      resources: { root: root.href, document: source.href },
    }
  } catch {
    return
  }
}
