import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { JSONContent } from '@tiptap/core'
import type { FileAsset } from './types'

const attachmentPattern = /\uFFFC([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})\uFFFC/giu
export const attachmentToken = (id: string) => `\uFFFC${id}\uFFFC`

/** Plain paragraphs and atomic references keep note storage independent of editor internals. */
export function noteDocument(content: string): JSONContent {
  return {
    type: 'doc',
    content: content.split('\n').map((line) => {
      const nodes: JSONContent[] = []
      let position = 0
      for (const match of line.matchAll(attachmentPattern)) {
        if (match.index > position)
          nodes.push({ type: 'text', text: line.slice(position, match.index) })
        nodes.push({ type: 'noteAttachment', attrs: { id: match[1] } })
        position = match.index + match[0].length
      }
      if (position < line.length) nodes.push({ type: 'text', text: line.slice(position) })
      return { type: 'paragraph', ...(nodes.length ? { content: nodes } : {}) }
    }),
  }
}

export function serializeNote(document: JSONContent): string {
  const inline = (node: JSONContent): string =>
    node.type === 'noteAttachment'
      ? attachmentToken(node.attrs!.id)
      : node.type === 'hardBreak'
        ? '\n'
        : (node.text ?? node.content?.map(inline).join('') ?? '')
  return document.content?.map(inline).join('\n') ?? ''
}

export function noteText(content: string, attachments: FileAsset[] = []): string {
  const assets = new Map(attachments.map((asset) => [asset.id, asset]))
  return content.replace(attachmentPattern, (_, id) => assets.get(id)?.filename ?? '[file]')
}

/** Map the plain storage offset to an editor position, including atomic references. */
export function notePosition(document: ProseMirrorNode, target: number): number {
  let offset = 0,
    result: number | undefined
  target = Math.max(0, target)
  document.forEach((paragraph, position, index) => {
    if (result !== undefined) return
    if (index) offset++
    paragraph.forEach((node, inlinePosition) => {
      if (result !== undefined) return
      const length =
        node.type.name === 'noteAttachment'
          ? attachmentToken(node.attrs.id).length
          : (node.text?.length ?? 1)
      if (target <= offset + length)
        result =
          position +
          1 +
          inlinePosition +
          (node.isText ? Math.max(0, target - offset) : target > offset ? 1 : 0)
      offset += length
    })
    if (target <= offset && result === undefined) result = position + paragraph.nodeSize - 1
  })
  return result ?? Math.max(1, document.content.size - 1)
}
export function noteOffset(document: ProseMirrorNode, position: number): number {
  return document.textBetween(0, position, '\n', (node) =>
    node.type.name === 'noteAttachment' ? attachmentToken(node.attrs.id) : '\n',
  ).length
}

/** Replace only a still-matching selection if an upload outlives its editor. */
export function insertNoteContent(
  content: string,
  value: { content: string; offset: number; end: number; replaced: string },
): string {
  let start = Math.max(0, Math.min(value.offset, content.length))
  for (const match of content.matchAll(attachmentPattern))
    if (start > match.index && start < match.index + match[0].length) {
      start = match.index + match[0].length
      break
    }
  const end =
    start === value.offset && content.slice(start, value.end) === value.replaced ? value.end : start
  return content.slice(0, start) + value.content + content.slice(end)
}
