import { shallowRef } from 'vue'
import type { CanvasFileReference } from './file-reference'

export interface CopiedCanvasFile { reference: CanvasFileReference; filename: string; mime: string }
/** Browser memory only; account credentials and file bytes stay out of clipboard state. */
export const copiedFile = shallowRef<CopiedCanvasFile>()
export function clearCopiedFile() { copiedFile.value = undefined }
export function rememberCopiedFile(value: CopiedCanvasFile) {
  copiedFile.value = { reference: { instance: value.reference.instance, base: value.reference.base, assetId: value.reference.assetId }, filename: value.filename, mime: value.mime }
}
