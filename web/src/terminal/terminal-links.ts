import type { ILinkHandler } from '@xterm/xterm'
import type { WindowContentItem, WindowContentScan } from '../../../shared/window-content'

export type TerminalLinkTarget =
  { kind: 'web'; url: string; loopback: boolean } | { kind: 'file'; path: string }

const controls = /[\x00-\x1f\x7f-\x9f]/u

function loopback(url: URL) {
  const host = url.hostname.toLowerCase().replace(/\.$/u, '')
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/u.test(host) ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    host === '[::]' ||
    /^\[::ffff:(?:7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)\]$/u.test(host)
  )
}

/** A public web address the browser can open directly; source-local services need forwarding. */
export function publicWebUrl(value: string): string | undefined {
  const target = terminalLinkTarget(value)
  return target?.kind === 'web' && !target.loopback ? target.url : undefined
}

function absolutePath(path: string) {
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  // Match the server's posix.normalize, including a trailing slash.
  return `/${segments.join('/')}${segments.length && path.endsWith('/') ? '/' : ''}`
}

/**
 * Hyperlink URIs follow the window-content scan rules: http(s) opens on the
 * web, while a file URI names a path on the terminal's own source. The OSC 8
 * hostname never selects another machine.
 */
export function terminalLinkTarget(uri: string): TerminalLinkTarget | undefined {
  if (uri.length > 8192 || controls.test(uri)) return
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return
  }
  if (url.username || url.password) return
  if (url.protocol === 'http:' || url.protocol === 'https:')
    return { kind: 'web', url: url.href, loopback: loopback(url) }
  if (url.protocol !== 'file:' || url.port) return
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return
  }
  if (!path.startsWith('/') || path.startsWith('//') || path.length > 8192 || controls.test(path))
    return
  return { kind: 'file', path: absolutePath(path) }
}

/** The scan parses the same on-screen OSC 8 URI, so a visible link verifies as an exact file item. */
export function scannedFile(
  scan: WindowContentScan,
  path: string,
): Extract<WindowContentItem, { kind: 'file' }> | undefined {
  return scan.panes
    .flatMap((pane) => pane.items)
    .find(
      (item): item is Extract<WindowContentItem, { kind: 'file' }> =>
        item.kind === 'file' && item.path === path,
    )
}

export interface TerminalLinkActions {
  openWeb(url: string): void
  forwardWeb(url: string): void
  openFile(path: string): void
}

export function activateTerminalLink(uri: string, actions: TerminalLinkActions): boolean {
  const target = terminalLinkTarget(uri)
  if (!target) return false
  if (target.kind === 'file') actions.openFile(target.path)
  else if (target.loopback) actions.forwardWeb(target.url)
  else actions.openWeb(target.url)
  return true
}

/** xterm draws the hover underline and pointer; Canvas only decides what a primary click opens. */
export function terminalLinkHandler(
  actions: TerminalLinkActions,
  allowed: (event: MouseEvent) => boolean = () => true,
): ILinkHandler {
  return {
    allowNonHttpProtocols: true,
    activate(event, uri) {
      if (event.button !== 0 || !allowed(event)) return
      activateTerminalLink(uri, actions)
    },
  }
}
