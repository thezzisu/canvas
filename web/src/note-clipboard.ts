import { parseFileReference, type CanvasFileReference } from './file-reference'
import type { FileAsset } from './types'
import type { PastePart } from '../../shared/paste'

export const NOTE_CLIPBOARD_TYPE = 'application/x-canvas-note'
export interface NoteClipboard { parts: Array<string | { reference: CanvasFileReference; filename: string }> }
const tokens = /\uFFFC([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})\uFFFC/giu

/** Preserve exactly the selected text and files; never put account tokens in the clipboard. */
export function noteClipboard(content: string, assets: FileAsset[], instance: { id: string; base: string }): NoteClipboard {
  const byId = new Map(assets.map(asset => [asset.id, asset])), parts: NoteClipboard['parts'] = []
  let offset = 0
  for (const match of content.matchAll(tokens)) {
    if (match.index > offset) parts.push(content.slice(offset, match.index))
    const asset = byId.get(match[1]!)
    if (!asset) throw new Error('fileTransfer.fileMissing')
    parts.push({ reference: { instance: instance.id, base: instance.base, assetId: asset.id }, filename: asset.filename })
    offset = match.index + match[0].length
  }
  if (offset < content.length) parts.push(content.slice(offset))
  const copied = { parts }
  if (!parseNoteClipboard(JSON.stringify(copied))) throw new Error('terminal.richPaste.tooLarge')
  return copied
}
export function clipboardText(note: NoteClipboard): string {
  return note.parts.map(part => typeof part === 'string' ? part : part.filename).join('')
}
export function parseNoteClipboard(value: string): NoteClipboard | undefined {
  if (value.length > 1024 * 1024) return
  try {
    const data = JSON.parse(value)
    if (!Array.isArray(data?.parts) || !data.parts.length || data.parts.length > 2048) return
    const parts: NoteClipboard['parts'] = []
    const files = new Set<string>()
    for (const part of data.parts) {
      if (typeof part === 'string') parts.push(part)
      else {
        const reference = parseFileReference(JSON.stringify(part?.reference))
        if (!reference || typeof part.filename !== 'string' || !part.filename || part.filename.length > 255) return
        files.add(JSON.stringify(reference))
        if (files.size > 64) return
        parts.push({ reference, filename: part.filename })
      }
    }
    return { parts }
  } catch { /* Other clipboard formats remain ordinary text. */ }
}
export function readNoteClipboard(data: DataTransfer | null): NoteClipboard | undefined {
  return data?.types.includes(NOTE_CLIPBOARD_TYPE) ? parseNoteClipboard(data.getData(NOTE_CLIPBOARD_TYPE)) : undefined
}

/** Resolve every asset before starting any target write; preserve repeated references and order. */
export async function loadNoteClipboard(note: NoteClipboard, load: (reference: CanvasFileReference) => Promise<File>) {
  const files: File[] = [], parts: PastePart[] = []
  const indices = new Map<string, number>()
  for (const part of note.parts) {
    if (typeof part === 'string') { parts.push(part); continue }
    const key = JSON.stringify(part.reference)
    let index = indices.get(key)
    if (index === undefined) {
      index = files.length; indices.set(key, index)
      files.push(await load(part.reference))
    }
    parts.push({ file: index, format: 'path' })
  }
  return { files, parts }
}

export function terminalNoteClipboard(value: { files: File[]; parts: PastePart[] }): { files: File[]; parts?: PastePart[] } {
  return value.parts.every(part => typeof part !== 'string' || !part.trim())
    ? { files: value.parts.flatMap(part => typeof part === 'string' ? [] : [value.files[part.file]!]) }
    : value
}
