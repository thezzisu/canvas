import { apiContext } from './api'
import { instances } from './instances'
import { sessionToken } from './instance-session'
import { readReferencedFile, type CanvasFileReference } from './file-reference'
import { copyText } from './clipboard'
import { NOTE_CLIPBOARD_TYPE, type NoteClipboard } from './note-clipboard'
import { beginCopyFeedback } from './copy-feedback'
import type { FileAsset } from './types'

function sourceAccess(id: string) {
  const instance = instances.value.find(value => value.id === id)
  return instance ? { base: instance.base, token: sessionToken(instance) } : undefined
}
export const fileReference = (assetId: string, instance: { id: string; base: string }): CanvasFileReference => ({ instance: instance.id, base: instance.base, assetId })
export function loadCanvasFile(reference: CanvasFileReference, signal: AbortSignal) {
  return readReferencedFile(reference, sourceAccess, signal)
}

/** A file card copies like a note holding only that file; PNG also offers its image to other apps. */
export function copyCanvasFile(asset: FileAsset, instance: { id: string; base: string }): void {
  const reference = fileReference(asset.id, instance), source = sourceAccess(reference.instance)
  if (!source || source.base !== reference.base || !source.token) { beginCopyFeedback()('failed'); return }
  const note: NoteClipboard = { parts: [{ reference, filename: asset.filename }] }
  void copyText(asset.filename, { [NOTE_CLIPBOARD_TYPE]: JSON.stringify(note) })
  if (asset.mime !== 'image/png' || typeof ClipboardItem !== 'function' || !navigator.clipboard?.write) return
  const context = apiContext()
  try {
    // Construct the item during the click gesture. A granted image write replaces
    // the Canvas copy, so other apps receive the image and Canvas pastes it as a
    // new file; a denied write keeps the linked Canvas copy.
    const blob = loadCanvasFile(reference, context.signal)
    void blob.catch(() => {})
    const item = new ClipboardItem({ 'image/png': blob, 'text/plain': new Blob([asset.filename], { type: 'text/plain' }) })
    void navigator.clipboard.write([item]).catch(() => {})
  } catch { /* The Canvas copy remains available. */ }
}
