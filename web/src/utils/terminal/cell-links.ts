import { terminalLinkTarget } from './terminal-links'

/** A web address found in a row's text, as UTF-16 offsets. */
export interface DetectedLink {
  start: number
  end: number
  uri: string
}

const candidate = /https?:\/\/[^\s<>"'`\x00-\x1f\x7f-\x9f─-▟]+/giu
const pairs = [
  ['(', ')'],
  ['（', '）'],
  ['[', ']'],
  ['{', '}'],
] as const

/** Sentence punctuation and an unmatched closing bracket belong to the prose, not the address. */
function trimPunctuation(value: string): string {
  for (;;) {
    let next = value.replace(/[.,;:!?。，、；：！？]+$/u, '')
    for (const [open, close] of pairs)
      if (next.endsWith(close) && next.split(close).length > next.split(open).length)
        next = next.slice(0, -1)
    if (next === value) return value
    value = next
  }
}

/** Plain-text web addresses in one row. Only what `terminalLinkTarget` accepts is a link. */
export function detectLinks(text: string): DetectedLink[] {
  const links: DetectedLink[] = []
  for (const match of text.matchAll(candidate)) {
    const uri = trimPunctuation(match[0])
    if (terminalLinkTarget(uri)?.kind === 'web')
      links.push({ start: match.index, end: match.index + uri.length, uri })
  }
  return links
}
