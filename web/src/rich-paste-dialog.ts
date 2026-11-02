import { shallowRef } from 'vue'
import type { RichPaste, buildRichPaste } from './rich-paste'

export type RichPasteResult = ReturnType<typeof buildRichPaste>
interface PasteRequest {
  model: RichPaste
  submit(result: RichPasteResult): void
  dismiss(): void
}
export const richPasteRequest = shallowRef<PasteRequest>()

export function previewRichPaste(model: RichPaste, signal: AbortSignal, submit: PasteRequest['submit'], onDismiss: () => void) {
  richPasteRequest.value?.dismiss()
  const request: PasteRequest = { model, submit, dismiss() {
    signal.removeEventListener('abort', request.dismiss)
    if (richPasteRequest.value === request) richPasteRequest.value = undefined
    onDismiss()
  } }
  if (!signal.aborted) {
    richPasteRequest.value = request
    signal.addEventListener('abort', request.dismiss, { once: true })
  }
  return request.dismiss
}
