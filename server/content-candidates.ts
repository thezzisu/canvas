import { posix } from 'node:path'
import type { WindowContentItem, WindowContentPane } from '../shared/window-content.ts'
import type { NativeContentPane } from './herdr/content.ts'

const MAX_ITEMS = 200
const controls = /[\x00-\x1f\x7f-\x9f]/u
export const withoutFileLocation = (value: string): string => value.replace(/(?::[1-9]\d*(?::[1-9]\d*)?|#L[1-9]\d*)$/u, '')

function httpUrl(value: string): string | undefined {
  if (!/^https?:\/\//iu.test(value) || value.length > 8192 || controls.test(value)) return
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url.href : undefined
  } catch { return }
}

function trimPunctuation(value: string): string {
  value = value.replace(/[.,;:!?]+$/u, '')
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
    while (value.endsWith(close) && value.split(close).length > value.split(open).length) value = value.slice(0, -1)
  }
  return value
}

function filePath(value: string, cwd?: string): string | null | undefined {
  if (!value || value.length > 8192 || controls.test(value) || /^[a-z][a-z\d+.-]*:\/\//iu.test(value)) return
  // A slash alone also describes prose and ratios. Require an explicit path
  // or a filename extension; the source later confirms each regular file.
  if (value.startsWith('@') || value.includes('<') || value.includes('>')) return
  if (!/^(?:\/|~\/|\.{1,2}\/)/u.test(value)
      && !/[^/]+\.[\p{L}][\p{L}\p{N}_-]{0,15}$/u.test(withoutFileLocation(value))) return
  if (value === '/' || value === './' || value === '../' || value === '~/') return
  if (value.startsWith('/')) return posix.normalize(value)
  if (value.startsWith('~/')) return value
  return cwd ? posix.resolve(cwd, value) : null
}

function linkedFile(value: string): string | undefined {
  if (value.length > 8192 || controls.test(value)) return
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:' || url.username || url.password || url.port) return
    // The terminal's source owns the path. OSC 8 hostnames never create a
    // separate connection; SSH aliases need not match a machine's own name.
    const path = decodeURIComponent(url.pathname)
    if (!path.startsWith('/') || path.startsWith('//') || path.length > 8192 || controls.test(path)) return
    return posix.normalize(path)
  } catch { return }
}

/** Parse bounded visible text, never shell syntax or adjacent pane rows. */
export function contentCandidates(panes: NativeContentPane[]): { panes: WindowContentPane[]; truncated: boolean; incomplete?: boolean } {
  let count = 0, truncated = false
  const result: WindowContentPane[] = []
  for (const pane of panes) {
    const items: WindowContentItem[] = [], seen = new Set<string>()
    const add = (label: string, exact = false, linkOnly = false, display?: string) => {
      const value = exact ? label : trimPunctuation(label)
      const url = httpUrl(value), path = url ? undefined : linkOnly ? linkedFile(value) : filePath(value, pane.cwd)
      if (!url && path === undefined) return
      const identity = url ? `url:${url}` : `file:${path ?? value}`
      if (seen.has(identity)) return
      seen.add(identity)
      if (count >= MAX_ITEMS) { truncated = true; return }
      const id = String(++count)
      const title = display?.trim() || value
      items.push(url ? { id, kind: 'link', label: title, url } : { id, kind: 'file', label: title, path: path! })
    }
    for (const link of pane.links) add(link.url, true, true, link.label)
    for (const line of pane.lines) {
      const occupied: Array<[number, number]> = []
      for (const match of line.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
        add(match[0]); occupied.push([match.index, match.index + match[0].length])
      }
      for (const match of line.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\r\n])+)\1/gu)) {
        if (occupied.some(([start, end]) => match.index >= start && match.index < end)) continue
        const value = match[2]!.replace(/\\([\\ "'`])/gu, '$1')
        add(value, true); occupied.push([match.index, match.index + match[0].length])
      }
      for (const match of line.matchAll(/(?:\\[^\r\n]|[^\s<>"'`()\[\]{}])+/gu)) {
        if (occupied.some(([start, end]) => match.index >= start && match.index < end)) continue
        add(match[0].replace(/\\([\\ "'`])/gu, '$1'))
      }
    }
    if (items.length) result.push({ id: pane.id, name: pane.name, ...(pane.cwd ? { cwd: pane.cwd } : {}), items })
  }
  return { panes: result, truncated, ...(panes.some(pane => pane.incomplete) ? { incomplete: true } : {}) }
}
