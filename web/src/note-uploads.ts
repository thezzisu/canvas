import { shallowReactive, watch } from 'vue'
import { api, apiContext, apiRevision, apiUpload, requireCurrentApi, segment } from './api'
import { reportDownloadError } from './downloads'
import { loadCanvasFile } from './file-transfer'
import { attachmentToken } from './note-document'
import type { NoteRange } from './note-editing'
import { loadNoteClipboard, reusedNoteClipboard, type NoteClipboard } from './note-clipboard'
import type { PastePart } from '../../shared/paste'
import type { FileAsset } from './types'

export interface NoteInsertion extends NoteRange { content: string; assets: FileAsset[] }
export interface NoteUpload extends NoteRange {
  controller: AbortController
  uploading: boolean
  name: string
  fileCount: number
  transferred: number
  total?: number
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
  prepare: (signal: AbortSignal) => Promise<{ files: (File | FileAsset)[]; parts: PastePart[] }>, insert: (value: NoteInsertion) => void, uploading = true) {
  if (pending.has(noteId)) return
  const context = apiContext(), task = shallowReactive<NoteUpload>({ offset, end, replaced, controller: new AbortController(), uploading,
    name: '', fileCount: 0, transferred: 0 })
  pending.set(noteId, task)
  try {
    const signal = AbortSignal.any([context.signal, task.controller.signal])
    const { files, parts } = await prepare(signal), assets: FileAsset[] = []
    const incoming = files.filter(file => file instanceof File)
    task.name = incoming.length === 1 ? incoming[0]!.name : ''
    task.fileCount = incoming.length; task.total = incoming.reduce((total, file) => total + file.size, 0)
    let transferred = 0
    for (const file of files) {
      requireCurrentApi(context); signal.throwIfAborted()
      if (!(file instanceof File)) { assets.push(file); continue }
      const query = new URLSearchParams({ filename: file.name, size: String(file.size) })
      assets.push(await apiUpload<FileAsset>(`/api/canvases/${segment(canvasId)}/notes/${segment(noteId)}/files?${query}`,
        file, loaded => { task.transferred = transferred + loaded }, signal, context))
      transferred += file.size; task.transferred = transferred
    }
    requireCurrentApi(context); signal.throwIfAborted()
    if (pending.get(noteId) !== task) return
    const value: NoteInsertion = { content: parts.map(part => typeof part === 'string' ? part : attachmentToken(assets[part.file]!.id)).join(''),
      assets, offset: task.offset, end: task.end, replaced: task.replaced }
    if (!task.insert?.(value)) insert(value)
  } catch (error) { if (!task.controller.signal.aborted && !context.signal.aborted) reportDownloadError(error) }
  finally { if (pending.get(noteId) === task) pending.delete(noteId) }
}
export function uploadNoteAttachment(canvasId: string, noteId: string, file: File, range: NoteRange, insert: (value: NoteInsertion) => void) {
  return upload(canvasId, noteId, range.offset, range.end, range.replaced, async () => ({ files: [file], parts: [{ file: 0, format: 'path' }] }), insert)
}
export function pasteNoteAttachments(canvasId: string, noteId: string, note: NoteClipboard, offset: number, end: number, replaced: string,
  insert: (value: NoteInsertion) => void, ownedAssets: readonly FileAsset[] = []) {
  if (pending.has(noteId)) return
  const context = apiContext(), reused = reusedNoteClipboard(note, context.base, ownedAssets)
  if (reused) { insert({ ...reused, offset, end, replaced }); return }
  const owned = new Map(ownedAssets.map(asset => [asset.id, asset]))
  const localIds = [...new Set(note.parts.flatMap(part => typeof part !== 'string' && part.reference.base === context.base && !owned.has(part.reference.assetId)
    ? [part.reference.assetId] : []))]
  const uploading = note.parts.some(part => typeof part !== 'string' && part.reference.base !== context.base)
  return upload(canvasId, noteId, offset, end, replaced, async signal => {
    if (localIds.length) {
      const linked = await api<FileAsset[]>(`/api/canvases/${segment(canvasId)}/notes/${segment(noteId)}/file-references`,
        { method: 'POST', body: JSON.stringify({ assetIds: localIds }), signal }, context)
      for (const asset of linked) owned.set(asset.id, asset)
    }
    return loadNoteClipboard<File | FileAsset>(note, reference => {
      if (reference.base !== context.base) return loadCanvasFile(reference, signal)
      const asset = owned.get(reference.assetId)
      if (!asset) throw new Error('fileTransfer.fileMissing')
      return Promise.resolve(asset)
    })
  }, insert, uploading)
}
