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
      && !/(?:^|\/)[^/]+\.[\p{L}][\p{L}\p{N}_-]{0,15}$/u.test(withoutFileLocation(value))) return
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
      || /^[^\s<>"'`/]+\.[\p{L}\p{N}][\p{L}\p{N}_-]{0,15}$/u.test(value))
    && !/[<>"'`]/u.test(value) && !/\s+[^\s]*\//u.test(value) && !/^[a-z][a-z\d+.-]*:\/\//iu.test(value)
}

interface PathSpan { values: string[] }

/** One bounded reader handles presentation wraps; native soft wraps are already logical lines. */
function* pathSpans(lines: readonly string[], columns: number | undefined, budget: { remaining: number; characters: number }): Generator<PathSpan> {
  const pairs: Record<string, string> = { '(': ')', '（': '）', '[': ']', '{': '}' }
  const pathStart = (line: string, offset: number) => {
    if (line.length - offset > 8192) return false
    if (budget.remaining <= 0 || budget.characters <= 0) return false
    budget.remaining--
    const value = line.slice(offset, offset + Math.min(8192, budget.characters))
    budget.characters -= value.length
    return /^@?(?:\/|~\/|\.{1,2}\/|[^\s<>"'`]+\/)/u.test(value)
  }
  for (let row = 0; row < lines.length && budget.remaining > 0 && budget.characters > 0; row++) {
    const line = lines[row]!, seeds = new Map<number, string | undefined>()
    for (const match of line.matchAll(/(`+|\*\*|__|["'(（])\s*/gu)) {
      const offset = match.index + match[0].length
      if (budget.remaining <= 0 || budget.characters <= 0) break
      if (pathStart(line, offset)) seeds.set(offset, pairs[match[1]!] || match[1])
    }
    for (const match of line.matchAll(/(?:^|\s)(@?(?:\/|~\/|\.{1,2}\/))/gu)) {
      if (budget.remaining <= 0 || budget.characters <= 0) break
      const offset = match.index + match[0].length - match[1]!.length
      if (!seeds.has(offset)) seeds.set(offset, undefined)
    }
    // A version number may end the visible fragment before the real extension.
    // Seed it after a prose label too; final filePath validation stays unchanged.
    const end = line.trimEnd().length
    let start = end
    while (start > 0 && end - start <= 8192 && !/\s/u.test(line[start - 1]!)) start--
    if (end - start <= 8192) {
      const version = line.slice(start, end)
      if (!/[<>"'`|/]/u.test(version) && /\p{L}/u.test(version) && /^\.[\p{N}][\p{L}\p{N}_-]*$/u.test(posix.extname(version))
        && !seeds.has(start)) seeds.set(start, undefined)
    }
    const shown = presentationPath(line)
    if (pathDisplay(shown.value.replace(/^@/u, ''))) {
      const offset = line.indexOf(shown.value)
      if (offset >= 0 && !seeds.has(offset)) seeds.set(offset, shown.closing)
    }
    for (const [offset, closing] of seeds) {
      if (budget.remaining <= 0 || budget.characters <= 0) break
      if (line.length - offset > 8192) continue
      budget.remaining--
      const stack = closing ? [closing] : []
      let value = '', spaced = '', joined = false, finished = false, layoutContinuation = false
      for (let next = row; next < lines.length; next++) {
        const raw = next === row ? line.slice(offset) : lines[next]!.replace(/^\s*(?:>\s*)+/u, '')
        let part = next === row ? raw : raw.trimStart()
        const whitespace = next > row ? raw.slice(0, raw.length - part.length) : ''
        const token = part.match(/^\S+/u)?.[0] || ''
        // A strongly aligned unquoted suffix follows the ordinary token rule:
        // a completed filename ends before a separate prose annotation.
        const annotated = !closing && layoutContinuation && token.length < part.length
          && /\.[\p{L}][\p{L}\p{N}_-]{0,15}$/u.test(withoutFileLocation(trimPunctuation(value + token)))
        if (annotated) part = token
        if (!part || next > row && /^(?:[-+*•]\s|\d{1,4}[.)]\s)/u.test(part)) break
        if (!closing && next > row && (/^(?:[\/@~+*•]|--|\.{1,2}(?:\/|$)|[a-z][a-z\d+.-]*:\/\/)/iu.test(part)
            || /\s/u.test(part) || !/[\p{L}\p{N}_]/u.test(part))) break
        let segment = '', complete = false
        for (let at = 0; at < part.length; at++) {
          if (--budget.characters < 0 || value.length + segment.length >= 8192) break
          const character = part[at]!
          if (closing && stack.length === 1 && part.startsWith(closing, at)) { complete = true; break }
          if (closing && pairs[character]) stack.push(pairs[character]!)
          else if (closing && Object.values(pairs).includes(character)) {
            if (stack.at(-1) !== character) break
            stack.pop()
          }
          if (/[<>\x00-\x1f\x7f-\x9f]/u.test(character) || !closing && /["'`|;&\\]/u.test(character)) break
          segment += character
        }
        if (!segment || value.length + segment.length > 8192 || budget.characters < 0) break
        // Keep observed whitespace as a second complete interpretation, never a combinatorial search.
        value += segment; spaced += whitespace + segment
        joined ||= next > row
        if (complete || annotated) { finished = true; break }
        if (closing) continue
        const following = lines[next + 1]?.trim()
        if (following && !joined && /\.[\p{L}][\p{L}\p{N}_-]{0,15}$/u.test(value) && /^[^./\s]+\.[\p{L}][\p{L}\p{N}_-]*$/u.test(following)) { finished = true; break }
        const width = terminalCellWidth(lines[next]!.trimEnd())
        const indent = lines[next + 1]?.match(/^\s*/u)?.[0] || ''
        // Applications wrap code inside a padded region narrower than the pane.
        // Matching indentation plus an unfinished path/suffix is stronger evidence
        // than widening the terminal-edge tolerance or joining arbitrary filenames.
        const aligned = indent.length > 0 && (indent === line.match(/^\s*/u)?.[0]
          || terminalCellWidth(indent) === terminalCellWidth(line.slice(0, offset)))
        const continuation = aligned && !/\.[\p{L}][\p{L}\p{N}_-]{0,15}$/u.test(withoutFileLocation(trimPunctuation(value)))
          && !!following && /^(?:[-_.][\p{L}\p{N}_]|[^\s/]+\/)/u.test(following)
        layoutContinuation = continuation
        if (!continuation && !/[/-]$/u.test(segment) && (!columns || width < columns - 1 || width > columns)) { finished = true; break }
      }
      if ((!closing || finished) && value && (joined || closing || offset === line.indexOf(shown.value) && pathDisplay(value.replace(/^@/u, ''))))
        yield { values: [...new Set([value, spaced].map(text => closing ? text : trimPunctuation(text)))].filter(value => value.length <= 8192) }
    }
  }
}

/** Read only stable vertical table columns; continuation rows must
 * leave every sibling cell empty so independent records cannot be joined. */
function* tablePathSpans(lines: readonly string[], budget: { remaining: number; characters: number }): Generator<PathSpan> {
  const row = (line: string | undefined) => {
    if (!line || line.length > 8192) return
    const border = /[│┃║]/u.exec(line)?.[0] || (/^\s*\|.*\|\s*$/u.test(line) ? '|' : undefined)
    if (!border) return
    if (budget.characters < line.length) { budget.characters = 0; return }
    budget.characters -= line.length
    const cells = line.split(border), allSeparators = [...line.matchAll(new RegExp(border, 'gu'))]
      .map(match => terminalCellWidth(line.slice(0, match.index)))
    const separators = allSeparators
    if (cells.length < 2) return
    // Last cells may have no closing border. Only observed separators define
    // a width; trailing whitespace or short text never invents a right edge.
    return { cells, shape: `${border}:${separators.join(',')}` }
  }
  for (let start = 0; start < lines.length && budget.remaining > 0 && budget.characters > 0; start++) {
    const first = row(lines[start])
    if (!first) continue
    for (let column = 0; column < first.cells.length && budget.remaining > 0 && budget.characters > 0; column++) {
      const cell = first.cells[column]!
      if (!cell.trim()) continue
      const lane = [cell]
      for (let next = start + 1; next < lines.length; next++) {
        const following = row(lines[next])
        if (!following || following.shape !== first.shape || !following.cells[column]!.trim()
          || following.cells.some((value, index) => index !== column && value.trim())) break
        lane.push(following.cells[column]!)
      }
      const columns = column < first.cells.length - 1 ? terminalCellWidth(cell) - (cell.endsWith(' ') ? 1 : 0) : undefined
      if (lane.length > 1) yield* pathSpans(lane.map(value => value.trimEnd()), columns, budget)
    }
  }
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
export function contentCandidates(panes: NativeContentPane[]): { panes: WindowContentPane[]; truncated: boolean; incomplete?: boolean; fileChoices: Map<string, { paths: string[]; references: string[] }> } {
  let count = 0, truncated = false
  const wrapBudget = { remaining: MAX_ITEMS, characters: 64 * 1024 }
  const fileChoices = new Map<string, { paths: string[]; references: string[] }>()
  const result: WindowContentPane[] = []
  for (const pane of panes) {
    const items: WindowContentItem[] = [], seen = new Set<string>()
    const add = (label: string, exact = false, linkOnly = false, display?: string, alternatives: string[] = []) => {
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
      if (!url) {
        const variants = [value, ...alternatives]
        const paths = variants.flatMap(value => { const path = linkOnly ? linkedFile(value) : filePath(value, pane.cwd, reference !== undefined); return path ? [path] : [] })
        const references = reference === undefined ? [] : variants.flatMap(value => { const path = filePath(value.slice(1), pane.cwd, true); return path ? [path] : [] })
        fileChoices.set(id, { paths: [...new Set(paths)], references: [...new Set(references)] })
      }
      const title = display?.trim() || value
      items.push(url ? { id, kind: 'link', label: title, url } : { id, kind: 'file', label: title, path: path! })
    }
    for (const link of pane.links) add(link.url, true, true, link.label)
    for (const value of pane.coloredText || []) if (pathDisplay(value)) add(value, true)
    const lines = [...(pane.coloredText || []), ...pane.lines]
    for (const line of lines) {
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
    for (const span of pathSpans(pane.lines, pane.columns, wrapBudget))
      add(span.values[0]!, true, false, undefined, span.values.slice(1))
    for (const span of tablePathSpans(pane.lines, wrapBudget))
      add(span.values[0]!, true, false, undefined, span.values.slice(1))
    if (items.length) result.push({ id: pane.id, name: pane.name, ...(pane.cwd ? { cwd: pane.cwd } : {}), items })
  }
  truncated ||= wrapBudget.remaining === 0 || wrapBudget.characters <= 0
  return { panes: result, truncated, fileChoices, ...(panes.some(pane => pane.incomplete) ? { incomplete: true } : {}) }
}
