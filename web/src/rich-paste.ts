import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { renderPasteParts, type PastePart } from '../../shared/paste'
import { readFileTransfer } from './browser-file-input'

interface Attachment { name: string; file?: File; image: boolean; label: string }
type ContentPart = string | { attachment: number; prefix?: string }

export interface RichPaste {
  markdown: ContentPart[]
  plain: ContentPart[]
  attachments: Attachment[]
  unresolved?: boolean
}
export interface RichPasteOptions {
  text: 'markdown' | 'plain'
  attachments: 'markdown' | 'path' | 'skip'
}

/** Snapshot the original event synchronously; later clipboard reads may belong to another paste. */
export function captureRichPaste(data: DataTransfer): RichPaste | undefined {
  const html = cleanText(data.getData('text/html'))
  const plain = cleanText(data.getData('text/plain'))
  const selection = readFileTransfer(data)
  if (selection.error === 'folders') return // The existing file handler rejects folders.
  const unreadable = selection.error === 'unreadable'
  const files = selection.files
  const attachments: Attachment[] = []
  const add = (attachment: Attachment, prefix?: string): ContentPart => ({ attachment: attachments.push(attachment) - 1, prefix })

  if (!html) {
    if (!files.length && !unreadable || !substantiveText(plain, files.map(file => file.name))) return
    const content: ContentPart[] = [plain]
    for (const file of files) {
      content.push(add({ name: file.name, file, image: file.type.startsWith('image/'), label: file.name }, content.length === 1 ? '\n\n' : '\n'))
    }
    if (unreadable) content.push(add({ name: 'file', image: false, label: 'file' }, '\n\n'))
    return { markdown: content, plain: content, attachments, unresolved: unreadable }
  }

  // Template contents are inert. Never mount clipboard HTML or fetch its resource URLs.
  const template = document.createElement('template')
  template.innerHTML = html
  const fragment = template.content
  fragment.querySelectorAll('script, style, meta, link, iframe, object, embed, title').forEach(node => node.remove())
  fragment.querySelectorAll('table').forEach(table => { if (!table.rows.length) table.remove() })
  const marker = `CANVASPASTE${Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('')}X`
  const used = new Set<File>()
  const embedded = new Map<string, File | undefined>()
  const token = (attachment: Attachment) => {
    const part = add(attachment) as { attachment: number }
    return `${marker}${part.attachment}END`
  }
  const references = new Map<string, Set<string>>()
  for (const node of fragment.querySelectorAll('*')) {
    const source = node.getAttribute('src') || node.getAttribute('href') || node.getAttribute('xlink:href') || ''
    const name = node.getAttribute('download') || sourceName(source)
    if (!name) continue
    const targets = references.get(name) || new Set<string>()
    targets.add(source); references.set(name, targets)
  }
  const resolve = (source: string, fallback: string) => {
    const name = fallback || sourceName(source)
    const matches = files.filter(file => file.name === name)
    if (matches.length === 1 && (references.get(name)?.size || 0) <= 1) return matches[0]
    if (/^data:/iu.test(source)) {
      if (!embedded.has(source)) embedded.set(source, dataImage(source))
      return embedded.get(source)
    }
  }
  let imageReferences = 0
  for (const node of fragment.querySelectorAll('*')) {
    if (!fragment.contains(node)) continue
    const tag = node.localName.toLowerCase()
    const image = tag === 'img' || tag === 'image' || tag === 'v:imagedata' || tag === 'imagedata'
      || tag === 'input' && node.getAttribute('type')?.toLowerCase() === 'image'
    const href = node.getAttribute('href') || ''
    const fileLink = tag === 'a' && (node.hasAttribute('download') || /^(?:file|cid|blob):/iu.test(href))
    if (!image && !fileLink) continue
    if (image) imageReferences++
    const source = image ? node.getAttribute('src') || href || node.getAttribute('xlink:href') || '' : href
    const filename = node.getAttribute('download') || sourceName(source)
    const file = resolve(source, filename)
    if (file) used.add(file)
    const name = file?.name || filename || (image ? 'image' : 'file')
    const label = image ? node.getAttribute('alt') || name : node.textContent?.trim() || name
    node.replaceWith(fragment.ownerDocument.createTextNode(token({ name, file, image, label })))
  }
  // Word can expose only VML in conditional comments. Do not silently discard that image.
  if (!imageReferences && /<(?:v:)?imagedata\b/iu.test(html)) {
    fragment.append(fragment.ownerDocument.createTextNode(`\n${token({ name: 'image', image: true, label: 'image' })}`))
    imageReferences++
  }
  const withoutTokens = (value: string) => value.replaceAll(new RegExp(`${marker}\\d+END`, 'gu'), '')
  if (!substantiveText(withoutTokens(fragment.textContent || ''), files.map(file => file.name))) {
    // Some applications supply text/plain alongside image-only HTML.
    if (!substantiveText(plain, files.map(file => file.name))) return
    fragment.prepend(fragment.ownerDocument.createTextNode(`${plain}\n\n`))
  }
  let unresolved = unreadable
  const appended: ContentPart[] = []
  for (const file of files) {
    if (used.has(file)) continue
    // An unassociated image may be another representation of an HTML image.
    // Without byte identity, neither duplicate it nor silently discard it.
    if (imageReferences && file.type.startsWith('image/')) { unresolved = true; continue }
    appended.push(add({ name: file.name, file, image: file.type.startsWith('image/'), label: file.name }, '\n\n'))
  }
  if (unreadable && !attachments.length) {
    appended.push(add({ name: 'file', image: false, label: 'file' }, '\n\n'))
  }
  if (!attachments.length) return

  const split = (text: string): ContentPart[] => text.split(new RegExp(`(${marker}\\d+END)`, 'u')).filter(Boolean).map(value =>
    value.startsWith(marker) ? { attachment: Number(value.slice(marker.length, -3)) } : value)
  return {
    markdown: [...split(converter(false).turndown(fragment)), ...appended],
    plain: [...split(converter(true).turndown(fragment)), ...appended],
    attachments,
    unresolved,
  }
}

/** Select references before uploading, retaining their positions and sharing repeated file bytes. */
export function buildRichPaste(model: RichPaste, options: RichPasteOptions) {
  const parts: PastePart[] = [], previewParts: PastePart[] = []
  const files: File[] = [], previewPaths: string[] = []
  let missing = options.attachments !== 'skip' && !!model.unresolved
  for (const part of model[options.text]) {
    if (typeof part === 'string') { append(parts, part); append(previewParts, part); continue }
    if (options.attachments === 'skip') continue
    if (part.prefix) { append(parts, part.prefix); append(previewParts, part.prefix) }
    const attachment = model.attachments[part.attachment]!
    const format = options.text === 'markdown' && options.attachments === 'markdown' ? 'markdown' : 'path'
    const reference = { format, image: attachment.image, label: cleanText(attachment.label) } as const
    previewParts.push({ ...reference, file: previewPaths.push(`/uploaded/${attachment.name}`) - 1 })
    if (!attachment.file) { missing = true; continue }
    let index = files.indexOf(attachment.file)
    if (index < 0) index = files.push(attachment.file) - 1
    parts.push({ ...reference, file: index })
  }
  return { parts, files, preview: renderPasteParts(previewParts, previewPaths), missing }
}

function append(parts: PastePart[], text: string) {
  text = cleanText(text)
  const last = parts.at(-1)
  if (typeof last === 'string') parts[parts.length - 1] = last + text
  else parts.push(text)
}

function cleanText(value: string) { return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '') }

function sourceName(source: string): string {
  if (!source || /^(?:data|blob):/iu.test(source)) return ''
  try {
    const path = new URL(source, 'https://clipboard.invalid/').pathname
    return decodeURIComponent(path.replaceAll('\\', '/').split('/').at(-1) || '')
  } catch { return '' }
}

function substantiveText(text: string, filenames: string[]) {
  const lines = text.trim().split(/[\r\n]+/u).map(line => line.trim()).filter(Boolean)
  return lines.some(line => !filenames.includes(line))
}

function dataImage(source: string): File | undefined {
  const match = /^data:(image\/[a-z0-9.+-]+)(;base64)?,([\s\S]*)$/iu.exec(source)
  if (!match) return
  try {
    const type = match[1]!.toLowerCase()
    const extension = ({ 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/x-icon': 'ico' } as Record<string, string>)[type] || type.slice(6)
    const bytes = match[2] ? Uint8Array.from(atob(match[3]!), char => char.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(match[3]!))
    if (!bytes.length) return
    return new File([bytes], `clipboard.${extension}`, { type })
  } catch { return }
}

function converter(plain: boolean) {
  const service = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced',
    keepReplacement: content => `\n\n${content}\n\n` })
  if (!plain) { service.use(gfm); return service }
  service.escape = text => text
  service.addRule('plainFormatting', { filter: ['strong', 'b', 'em', 'i', 'u', 'del', 's', 'code', 'a'], replacement: content => content })
  service.addRule('plainHeading', { filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote'], replacement: content => `\n\n${content}\n\n` })
  service.addRule('plainCode', { filter: 'pre', replacement: (_content, node) => `\n\n${node.textContent}\n\n` })
  service.addRule('plainDivider', { filter: 'hr', replacement: () => '\n\n' })
  service.addRule('plainCell', { filter: ['td', 'th'], replacement: (content, node) => `${content}${node.nextElementSibling ? '\t' : ''}` })
  service.addRule('plainRow', { filter: 'tr', replacement: content => `${content}\n` })
  service.addRule('plainTable', { filter: 'table', replacement: content => `\n\n${content.trim()}\n\n` })
  service.addRule('plainTableSection', { filter: ['thead', 'tbody', 'tfoot'], replacement: content => content })
  return service
}
