import { shallowReactive, watch } from 'vue'
import { api, apiContext, apiRevision, apiUpload, requireCurrentApi, segment } from './api'
import { reportDownloadError } from './downloads'
import { loadCanvasFile } from './file-transfer'
import { attachmentToken } from './note-document'
import type { NoteRange } from './note-editing'
import { loadNoteClipboard, reusedNoteClipboard, type NoteClipboard } from './note-clipboard'
import { pendingWrites } from './pending-writes'
import type { PastePart } from '../../shared/paste'
import type { FileAsset } from './types'

export interface NoteInsertion extends NoteRange { content: string; assets: FileAsset[] }
/** The server resource owning a note's files: a canvas note or a terminal composer. */
export interface NoteOwner { key: string; path: string }
export const canvasNoteOwner = (canvasId: string, noteId: string): NoteOwner =>
  ({ key: noteId, path: `/api/canvases/${segment(canvasId)}/notes/${segment(noteId)}` })
export interface NoteUpload extends NoteRange {
  controller: AbortController
  uploading: boolean
  name: string
  fileCount: number
  /** Filenames the insertion adds, in document order, shown as placeholders while uploading. */
  files: string[]
  transferred: number
  total?: number
  insert?: (value: NoteInsertion) => boolean
}
const pending = shallowReactive(new Map<string, NoteUpload>())
export function noteUpload(owner: NoteOwner) { return pending.get(owner.key) }
watch(apiRevision, () => {
  for (const upload of pending.values()) upload.controller.abort()
  pending.clear()
})

/** Uploads belong to the note, so changing its canvas representation does not cancel them. */
async function upload(owner: NoteOwner, offset: number, end: number, replaced: string, filenames: string[],
  prepare: (signal: AbortSignal) => Promise<{ files: (File | FileAsset)[]; parts: PastePart[] }>, insert: (value: NoteInsertion) => void, uploading = true) {
  if (pending.has(owner.key)) return
  const context = apiContext(), task = shallowReactive<NoteUpload>({ offset, end, replaced, controller: new AbortController(), uploading,
    name: '', fileCount: 0, files: filenames, transferred: 0 })
  pending.set(owner.key, task); pendingWrites.start(owner.key, 'upload')
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
      assets.push(await apiUpload<FileAsset>(`${owner.path}/files?${query}`,
        file, loaded => { task.transferred = transferred + loaded }, signal, context))
      transferred += file.size; task.transferred = transferred
    }
    requireCurrentApi(context); signal.throwIfAborted()
    if (pending.get(owner.key) !== task) return
    const value: NoteInsertion = { content: parts.map(part => typeof part === 'string' ? part : attachmentToken(assets[part.file]!.id)).join(''),
      assets, offset: task.offset, end: task.end, replaced: task.replaced }
    // Settle before inserting, so the inserting transaction already drops the placeholders.
    const target = task.insert
    pending.delete(owner.key)
    if (!target?.(value)) insert(value)
  } catch (error) { if (!task.controller.signal.aborted && !context.signal.aborted) reportDownloadError(error) }
  finally { if (pending.get(owner.key) === task) { pending.delete(owner.key); pendingWrites.stop(owner.key, 'upload') } }
}
export function uploadNoteAttachment(owner: NoteOwner, file: File, range: NoteRange, insert: (value: NoteInsertion) => void) {
  return upload(owner, range.offset, range.end, range.replaced, [file.name], async () => ({ files: [file], parts: [{ file: 0, format: 'path' }] }), insert)
}
export function pasteNoteAttachments(owner: NoteOwner, note: NoteClipboard, offset: number, end: number, replaced: string,
  insert: (value: NoteInsertion) => void, ownedAssets: readonly FileAsset[] = []) {
  if (pending.has(owner.key)) return
  const context = apiContext(), reused = reusedNoteClipboard(note, context.base, ownedAssets)
  if (reused) { insert({ ...reused, offset, end, replaced }); return }
  const owned = new Map(ownedAssets.map(asset => [asset.id, asset]))
  const localIds = [...new Set(note.parts.flatMap(part => typeof part !== 'string' && part.reference.base === context.base && !owned.has(part.reference.assetId)
    ? [part.reference.assetId] : []))]
  const uploading = note.parts.some(part => typeof part !== 'string' && part.reference.base !== context.base)
  const filenames = note.parts.flatMap(part => typeof part === 'string' ? [] : [part.filename])
  return upload(owner, offset, end, replaced, filenames, async signal => {
    if (localIds.length) {
      const linked = await api<FileAsset[]>(`${owner.path}/file-references`,
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
