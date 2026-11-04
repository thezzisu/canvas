import { apiContext } from './api'
import { instances } from './instances'
import { sessionToken } from './instance-session'
import { readReferencedFile, type CanvasFileReference } from './file-reference'
import { rememberCopiedFile } from './file-clipboard'
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

/** Internal copy is always explicit. PNG additionally uses the browser's native clipboard. */
export function copyCanvasFile(asset: FileAsset, instance: { id: string; base: string }): void {
  const feedback = beginCopyFeedback()
  const reference = fileReference(asset.id, instance), source = sourceAccess(reference.instance)
  if (!source || source.base !== reference.base || !source.token) { feedback('failed'); return }
  rememberCopiedFile({ reference, filename: asset.filename, mime: asset.mime })
  feedback('canvas')
  if (asset.mime !== 'image/png' || typeof ClipboardItem !== 'function' || !navigator.clipboard?.write) return
  const context = apiContext()
  try {
    // Construct the item during the click gesture. A denied system write never
    // invalidates the already successful Canvas copy.
    const blob = loadCanvasFile(reference, context.signal)
    void blob.catch(() => {})
    const item = new ClipboardItem({ 'image/png': blob })
    void navigator.clipboard.write([item]).catch(() => {})
  } catch { /* This browser can still use the explicit Paste file action. */ }
}
