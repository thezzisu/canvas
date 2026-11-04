import { shallowReactive, watch } from 'vue'
import { api, apiContext, apiRevision, requireCurrentApi, segment } from './api'
import { reportDownloadError } from './downloads'
import type { FileAsset } from './types'

export interface NoteUpload {
  offset: number
  controller: AbortController
  insert?: (asset: FileAsset, offset: number) => boolean
}
const pending = shallowReactive(new Map<string, NoteUpload>())
export function noteUpload(noteId: string) { return pending.get(noteId) }
watch(apiRevision, () => {
  for (const upload of pending.values()) upload.controller.abort()
  pending.clear()
})

/** Uploads belong to the note, so changing its canvas representation does not cancel them. */
export async function uploadNoteAttachment(canvasId: string, noteId: string, file: File, offset: number,
  insert: (asset: FileAsset, offset: number) => void) {
  if (pending.has(noteId)) return
  const context = apiContext(), task: NoteUpload = { offset, controller: new AbortController() }
  pending.set(noteId, task)
  try {
    const query = new URLSearchParams({ filename: file.name, size: String(file.size) })
    const asset = await api<FileAsset>(`/api/canvases/${segment(canvasId)}/notes/${segment(noteId)}/files?${query}`,
      { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' }, signal: task.controller.signal }, context)
    requireCurrentApi(context)
    if (pending.get(noteId) !== task) return
    if (!task.insert?.(asset, task.offset)) insert(asset, task.offset)
  } catch (error) { if (!task.controller.signal.aborted && !context.signal.aborted) reportDownloadError(error) }
  finally { if (pending.get(noteId) === task) pending.delete(noteId) }
}
