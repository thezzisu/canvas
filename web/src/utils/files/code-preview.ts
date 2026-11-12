import {
  textCapabilities,
  type CodePreviewRequest,
  type CodePreviewResult,
} from './code-preview-language'
export { textCapabilities } from './code-preview-language'
export type { CodePreviewRequest, CodePreviewResult } from './code-preview-language'

let worker: Worker | undefined,
  sequence = 0
const pending = new Map<
  number,
  { resolve(value: CodePreviewResult): void; reject(error: Error): void; cleanup(): void }
>()

/** One lazy worker shares parsers and grammars across all mounted file readers. */
export async function processCodePreview(
  request: CodePreviewRequest,
  signal?: AbortSignal,
): Promise<CodePreviewResult> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  const capabilities = textCapabilities(request.filename)
  if (!((request.format && capabilities.format) || (request.highlight && capabilities.highlight)))
    return Promise.resolve({ text: request.text })
  if (!worker) {
    const created = new Worker(new URL('./code-preview.worker.ts', import.meta.url), {
      type: 'module',
      name: 'Canvas code preview',
    })
    worker = created
    created.onmessage = (event: MessageEvent<{ id: number; result?: CodePreviewResult }>) => {
      const operation = pending.get(event.data.id)
      if (!operation) return
      pending.delete(event.data.id)
      operation.cleanup()
      if (event.data.result) operation.resolve(event.data.result)
      else operation.reject(new Error('Code preview processing failed'))
    }
    created.onerror = (event) => {
      event.preventDefault()
      if (worker !== created) return
      created.terminate()
      worker = undefined
      for (const operation of pending.values()) {
        operation.cleanup()
        operation.reject(new Error('Code preview processing failed'))
      }
      pending.clear()
    }
  }
  const current = worker,
    id = ++sequence
  return new Promise((resolve, reject) => {
    const abort = () => {
      pending.delete(id)
      reject(signal?.reason)
    }
    const cleanup = () => signal?.removeEventListener('abort', abort)
    pending.set(id, { resolve, reject, cleanup })
    signal?.addEventListener('abort', abort, { once: true })
    try {
      current.postMessage({ id, request })
    } catch (error) {
      pending.delete(id)
      cleanup()
      reject(error)
    }
  })
}
