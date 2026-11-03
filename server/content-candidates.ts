import { posix } from 'node:path'
import type { WindowContentItem, WindowContentPane } from '../shared/window-content.ts'
import type { NativeContentPane } from './herdr/content.ts'
import { terminalCellWidth } from '../shared/terminal-unicode.ts'

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

function filePath(value: string, cwd?: string, reference = false): string | null | undefined {
  if (!value || value.length > 8192 || controls.test(value) || /^[a-z][a-z\d+.-]*:\/\//iu.test(value)) return
  // A slash alone also describes prose and ratios. Require an explicit path
  // or a filename extension; the source later confirms each regular file.
  if (!reference && value.startsWith('@') || value.includes('<') || value.includes('>')) return
  if (!reference && !/^(?:\/|~\/|\.{1,2}\/)/u.test(value)
      && !/[^/]+\.[\p{L}][\p{L}\p{N}_-]{0,15}$/u.test(withoutFileLocation(value))) return
  if (value === '/' || value === './' || value === '../' || value === '~/') return
  if (value.startsWith('/')) return posix.normalize(value)
  if (value.startsWith('~/')) return value
  return cwd ? posix.resolve(cwd, value) : null
}

function presentationPath(line: string): { value: string; closing?: string } {
  let value = line.trim().replace(/^(?:>\s*)+/u, '').replace(/^(?:[-*+]\s+|\d{1,4}[.)]\s+)/u, '')
  const wrapper = /^(`+|\*\*|__|["'])/u.exec(value)?.[0]
  if (wrapper && value.length > wrapper.length) {
    if (value.endsWith(wrapper) && value.length > wrapper.length * 2) value = value.slice(wrapper.length, -wrapper.length)
    else return { value: value.slice(wrapper.length), closing: wrapper }
  }
  return { value }
}

/** Whole path displays only; ordinary prose and shell command lines stay tokenized. */
function pathDisplay(value: string): boolean {
  return (/^(?:\/|~\/|\.{1,2}\/|[^\s<>"'`]+\/)/u.test(value)
      || /^[^\s<>"'`/]+\.[\p{L}][\p{L}\p{N}_-]{0,15}$/u.test(value))
    && !/[<>"'`]/u.test(value) && !/\s+[^\s]*\//u.test(value) && !/^[a-z][a-z\d+.-]*:\/\//iu.test(value)
}

/** TUI word wrapping can break a path at a slash or literal hyphen before the
 * pane edge. Accept only a trailing path and consecutive single-token parts. */
function wrappedPathTokens(lines: readonly string[], index: number, budget: { remaining: number; characters: number }): string | undefined {
  const line = presentationPath(lines[index]!).value
  const token = (value: string) => !!value && !/[\s<>"'`|;&\\\x00-\x1f\x7f-\x9f]/u.test(value)
  let value = /(?:^|\s)(@?(?:\/|~\/|\.{1,2}\/)[^\s<>"'`|;&\\]+)$/u.exec(line)?.[1]
    || (token(line) && pathDisplay(line) ? line : '')
  if (!value || value.length > 8192 || !/[/-]$/u.test(value) || budget.remaining <= 0 || budget.characters <= 0) return
  if (value.length > budget.characters) { budget.characters = 0; return }
  budget.remaining--
  budget.characters -= value.length
  let joined = false
  for (let row = index + 1; row < lines.length && /[/-]$/u.test(value); row++) {
    const part = lines[row]!.trim().replace(/^(?:>\s*)+/u, '')
    if (!token(part) || !/[\p{L}\p{N}_]/u.test(part) || /^(?:[\/@~+*•-]|\.{1,2}(?:\/|$)|[a-z][a-z\d+.-]*:\/\/)/iu.test(part)) break
    if (value.length + part.length > 8192) break
    if (budget.characters < part.length) { budget.characters = 0; break }
    budget.characters -= part.length
    value += part
    joined = true
  }
  return joined && !/[/-]$/u.test(value) ? value : undefined
}

/** Balanced wrappers distinguish inline paths from the prose around them. */
function wrappedParenthesizedPaths(lines: readonly string[], index: number, budget: { remaining: number; characters: number }): string[] {
  const pairs: Record<string, string> = { '(': ')', '（': '）' }
  const results: string[] = [], line = lines[index]!
  for (let start = 0; start < line.length && budget.remaining > 0 && budget.characters > 0; start++) {
    const closing = pairs[line[start]!]
    if (!closing) continue
    budget.remaining--
    const first = line.slice(start + 1, start + 8194).trimStart()
    if (!/^@?(?:\/|~\/|\.{1,2}\/|[^\s()（）<>"'`]+\/)/u.test(first)) continue
    const stack = [closing]
    let value = '', valid = true
    for (let offset = 0; index + offset < lines.length && valid && stack.length && budget.characters > 0; offset++) {
      const part = (offset ? lines[index + offset]!.slice(0, 8193).trim().replace(/^(?:>\s*)+/u, '') : first).trimEnd()
      if (!part || offset && /^(?:[-+*•]\s|\d{1,4}[.)]\s)/u.test(part)) break
      for (const character of part) {
        if (--budget.characters < 0) { valid = false; break }
        if (pairs[character]) stack.push(pairs[character]!)
        else if (character === ')' || character === '）') {
          if (stack.pop() !== character) { valid = false; break }
          if (!stack.length) { if (value) results.push(value); break }
        }
        if (/[<>"'`\[\]{}]/u.test(character) || value.length >= 8192) { valid = false; break }
        value += character
      }
    }
  }
  return results
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
export function contentCandidates(panes: NativeContentPane[]): { panes: WindowContentPane[]; truncated: boolean; incomplete?: boolean; references: Map<string, string> } {
  let count = 0, truncated = false
  const wrapBudget = { remaining: MAX_ITEMS, characters: 64 * 1024 }
  const references = new Map<string, string>()
  const result: WindowContentPane[] = []
  for (const pane of panes) {
    const items: WindowContentItem[] = [], seen = new Set<string>()
    const add = (label: string, exact = false, linkOnly = false, display?: string) => {
      const value = exact ? label : trimPunctuation(label)
      const reference = !linkOnly && value.startsWith('@') && value.length > 1 && !value.startsWith('@@')
        && !/[@<>]/u.test(value.slice(1)) && (exact || !/\s/u.test(value)) ? filePath(value.slice(1), pane.cwd, true) : undefined
      const url = httpUrl(value), path = url ? undefined : linkOnly ? linkedFile(value) : filePath(value, pane.cwd, reference !== undefined)
      if (!url && path === undefined) return
      const identity = url ? `url:${url}` : `file:${path ?? value}`
      if (seen.has(identity)) return
      seen.add(identity)
      if (count >= MAX_ITEMS) { truncated = true; return }
      const id = String(++count)
      if (reference) references.set(id, reference)
      const title = display?.trim() || value
      items.push(url ? { id, kind: 'link', label: title, url } : { id, kind: 'file', label: title, path: path! })
    }
    for (const link of pane.links) add(link.url, true, true, link.label)
    for (const value of pane.coloredText || []) if (pathDisplay(value)) add(value, true)
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
    const display = (value: string) => {
      if (pathDisplay(value)) add(value, true)
    }
    for (const [index, line] of pane.lines.entries()) {
      const wrapped = wrappedPathTokens(pane.lines, index, wrapBudget)
      if (wrapped) add(wrapped, true)
      for (const wrapped of wrappedParenthesizedPaths(pane.lines, index, wrapBudget)) add(wrapped, true)
      const { value, closing } = presentationPath(line)
      const width = pane.columns
      const occupied = terminalCellWidth(line.trimEnd())
      if (value !== line.trim()) display(value)
      // Native soft wrapping is already handled by herdr. Join a short TUI
      // continuation only at the measured pane edge; file existence is checked later.
      const tail = pane.lines[index + 1]
      if (!width || width < 2 || tail === undefined || !pathDisplay(value)) continue
      const parsedTail = presentationPath(tail).value
      const continuation = closing && parsedTail.endsWith(closing) ? parsedTail.slice(0, -closing.length) : parsedTail
      if (occupied < width - 1 || occupied > width || terminalCellWidth(continuation) > 32
          || !/^[\p{L}\p{N}_.-]+$/u.test(continuation)
          || /^[^.]+\.[\p{L}][\p{L}\p{N}_-]*$/u.test(continuation)) continue
      display(value + continuation)
    }
    if (items.length) result.push({ id: pane.id, name: pane.name, ...(pane.cwd ? { cwd: pane.cwd } : {}), items })
  }
  truncated ||= wrapBudget.remaining === 0 || wrapBudget.characters <= 0
  return { panes: result, truncated, references, ...(panes.some(pane => pane.incomplete) ? { incomplete: true } : {}) }
}
