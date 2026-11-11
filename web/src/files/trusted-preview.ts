import { shallowRef } from 'vue'

/** The confirm button runs the action synchronously, preserving browser user activation. */
export const trustedPreviewRequest = shallowRef<{ title: string; run(): void }>()
export function requestTrustedPreview(title: string, run: () => void) {
  trustedPreviewRequest.value = { title, run }
}
export function closeTrustedPreview(confirmed = false) {
  const request = trustedPreviewRequest.value
  trustedPreviewRequest.value = undefined
  if (confirmed) request?.run()
}
