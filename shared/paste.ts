export type PastePart =
  | string
  | {
      file: number
      format: 'path' | 'markdown'
      label?: string
      image?: boolean
    }

// Keep the complete begin message comfortably below the 128 KiB socket limit.
export const MAX_UPLOAD_BEGIN_BYTES = 120 * 1024
export const MAX_PASTE_PARTS = 2048
export const MAX_TERMINAL_PASTE_BYTES = 1024 * 1024

function quotePath(path: string): string {
  if (path.includes('\0')) throw new Error('Invalid paste path')
  return `'${path.replaceAll("'", "'\\''")}'`
}

function markdownPath(path: string): string {
  return path.replace(/[%\s"'<>\\[\]?#&()`]/gu, (character) =>
    encodeURIComponent(character).replace(
      /[!'()*]/gu,
      (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
    ),
  )
}

const PASTE_END = '\x1b[201~'
/**
 * Text as one bracketed paste. The end marker is removed until none is left: removing it
 * once can join the pieces around it into another, which would end the paste early and let the
 * rest of the text be read as keys.
 */
export function bracketedPaste(text: string): string {
  while (text.includes(PASTE_END)) text = text.replaceAll(PASTE_END, '')
  return `\x1b[200~${text}${PASTE_END}`
}
export interface PasteSegment {
  text: string
  file: boolean
}

/** Keep each file occurrence a separate terminal paste event. */
export function renderPasteSegments(
  parts: readonly PastePart[],
  paths: readonly string[],
): PasteSegment[] {
  return parts
    .map((part) => {
      if (typeof part === 'string') return { text: part, file: false }
      const path = paths[part.file]
      if (path === undefined || path.includes('\0')) throw new Error('Invalid paste file reference')
      if (part.format === 'path') return { text: quotePath(path), file: true }
      const label = (part.label ?? '').replace(/[\r\n]+/gu, ' ').replace(/[\\[\]*_`<>&]/gu, '\\$&')
      return { text: `${part.image ? '!' : ''}[${label}](${markdownPath(path)})`, file: true }
    })
    .filter((segment) => segment.text.length > 0)
}

/** Uploaded files without surrounding text are separated like a native multi-file drop. */
export function filePasteParts(count: number): PastePart[] {
  return Array.from({ length: count }, (_, file): PastePart[] =>
    file ? [' ', { file, format: 'path' }] : [{ file, format: 'path' }],
  ).flat()
}

/** Preview text and delivered segments concatenate to exactly the same content. */
export function renderPasteParts(parts: readonly PastePart[], paths: readonly string[]): string {
  return renderPasteSegments(parts, paths)
    .map((segment) => segment.text)
    .join('')
}

const attachmentTokens = /￼([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})￼/giu
/**
 * Note content becomes terminal paste parts: repeated files are delivered once,
 * and attachments without surrounding text are separated like a native drop.
 */
export function noteContentPaste(content: string): { files: string[]; parts: PastePart[] } {
  const files: string[] = [],
    parts: PastePart[] = []
  let offset = 0
  const text = (value: string) => {
    if (value) parts.push(value)
  }
  for (const match of content.matchAll(attachmentTokens)) {
    text(content.slice(offset, match.index))
    const id = match[1]!.toLowerCase()
    let file = files.indexOf(id)
    if (file < 0) file = files.push(id) - 1
    parts.push({ file, format: 'path' })
    offset = match.index + match[0].length
  }
  text(content.slice(offset))
  if (files.length && parts.every((part) => typeof part !== 'string' || !part.trim()))
    return {
      files,
      parts: parts
        .filter((part) => typeof part !== 'string')
        .flatMap((part, index): PastePart[] => (index ? [' ', part] : [part])),
    }
  return { files, parts }
}
