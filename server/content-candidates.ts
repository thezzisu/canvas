import { posix } from 'node:path'
import type { WindowContentItem, WindowContentPane } from '../shared/window-content.ts'
import type { NativeContentPane } from './herdr/content.ts'

const MAX_ITEMS = 200
const controls = /[\x00-\x1f\x7f-\x9f]/u

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
  // Bare prose is not a filename. Explicit paths and filename extensions are
  // candidates only; discovering them never stats, opens or expands anything.
  if (!/^(?:\/|~\/|\.{1,2}\/)/u.test(value) && !value.includes('/')
      && !/^[^/]+\.[\p{L}\p{N}][\p{L}\p{N}_-]{0,15}$/u.test(value)) return
  if (value === '/' || value === './' || value === '../' || value === '~/') return
  if (value.startsWith('/')) return posix.normalize(value)
  if (value.startsWith('~/')) return value
  return cwd ? posix.resolve(cwd, value) : null
}

/** Parse bounded visible text, never shell syntax or adjacent pane rows. */
export function contentCandidates(panes: NativeContentPane[]): { panes: WindowContentPane[]; truncated: boolean } {
  let count = 0, truncated = false
  const result: WindowContentPane[] = []
  for (const pane of panes) {
    const items: WindowContentItem[] = [], seen = new Set<string>()
    const add = (label: string, exact = false, linkOnly = false) => {
      const value = exact ? label : trimPunctuation(label)
      const url = httpUrl(value), path = url || linkOnly ? undefined : filePath(value, pane.cwd)
      if (!url && path === undefined) return
      const identity = url ? `url:${url}` : `file:${path ?? value}`
      if (seen.has(identity)) return
      seen.add(identity)
      if (count >= MAX_ITEMS) { truncated = true; return }
      const id = String(++count)
      items.push(url ? { id, kind: 'link', label: value, url } : { id, kind: 'file', label: value, path: path! })
    }
    for (const link of pane.links) {
      const url = httpUrl(link.url)
      if (!url) continue
      add(link.url, true, true)
      const added = items.at(-1)
      if (added?.kind === 'link' && added.url === url && link.label.trim()) added.label = link.label.trim()
    }
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
  return { panes: result, truncated }
}
