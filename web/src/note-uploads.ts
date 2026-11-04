import { shallowReactive, watch } from 'vue'
import { api, apiContext, apiRevision, requireCurrentApi, segment } from './api'
import { reportDownloadError } from './downloads'
import { loadCanvasFile } from './file-transfer'
import { attachmentToken } from './note-document'
import { loadNoteClipboard, type NoteClipboard } from './note-clipboard'
import type { PastePart } from '../../shared/paste'
import type { FileAsset } from './types'

export interface NoteInsertion { content: string; assets: FileAsset[]; offset: number; end: number; replaced: string }
export interface NoteUpload {
  offset: number
  end: number
  replaced: string
  controller: AbortController
  insert?: (value: NoteInsertion) => boolean
}
const pending = shallowReactive(new Map<string, NoteUpload>())
export function noteUpload(noteId: string) { return pending.get(noteId) }
watch(apiRevision, () => {
  for (const upload of pending.values()) upload.controller.abort()
  pending.clear()
})

/** Uploads belong to the note, so changing its canvas representation does not cancel them. */
async function upload(canvasId: string, noteId: string, offset: number, end: number, replaced: string,
  prepare: (signal: AbortSignal) => Promise<{ files: File[]; parts: PastePart[] }>, insert: (value: NoteInsertion) => void) {
  if (pending.has(noteId)) return
  const context = apiContext(), task: NoteUpload = { offset, end, replaced, controller: new AbortController() }
  pending.set(noteId, task)
  try {
    const signal = AbortSignal.any([context.signal, task.controller.signal])
    const { files, parts } = await prepare(signal), assets: FileAsset[] = []
    for (const file of files) {
      requireCurrentApi(context); signal.throwIfAborted()
      const query = new URLSearchParams({ filename: file.name, size: String(file.size) })
      assets.push(await api<FileAsset>(`/api/canvases/${segment(canvasId)}/notes/${segment(noteId)}/files?${query}`,
        { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' }, signal }, context))
    }
    requireCurrentApi(context)
    if (pending.get(noteId) !== task) return
    const value: NoteInsertion = { content: parts.map(part => typeof part === 'string' ? part : attachmentToken(assets[part.file]!.id)).join(''),
      assets, offset: task.offset, end: task.end, replaced: task.replaced }
    if (!task.insert?.(value)) insert(value)
  } catch (error) { if (!task.controller.signal.aborted && !context.signal.aborted) reportDownloadError(error) }
  finally { if (pending.get(noteId) === task) pending.delete(noteId) }
}
export function uploadNoteAttachment(canvasId: string, noteId: string, file: File, offset: number, insert: (value: NoteInsertion) => void) {
  return upload(canvasId, noteId, offset, offset, '', async () => ({ files: [file], parts: [{ file: 0, format: 'path' }] }), insert)
}
export function pasteNoteAttachments(canvasId: string, noteId: string, note: NoteClipboard, offset: number, end: number, replaced: string,
  insert: (value: NoteInsertion) => void) {
  return upload(canvasId, noteId, offset, end, replaced, signal => loadNoteClipboard(note, reference => loadCanvasFile(reference, signal)), insert)
}
