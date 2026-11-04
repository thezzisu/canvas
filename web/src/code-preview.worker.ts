import { processCode } from './code-preview-process'
import type { CodePreviewRequest, CodePreviewResult } from './code-preview-language'

declare const self: {
  onmessage: ((event: MessageEvent<{ id: number; request: CodePreviewRequest }>) => void) | null
  postMessage(value: { id: number; result?: CodePreviewResult }): void
}
self.onmessage = async ({ data: { id, request } }) => {
  try { self.postMessage({ id, result: await processCode(request) }) }
  catch { self.postMessage({ id }) }
}
