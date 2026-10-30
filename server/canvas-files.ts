import type { AssetStore, AssetUpload } from './assets.ts'
import type { Store } from './state.ts'

/** A browser file becomes a persistent card only after all bytes are committed. */
export async function receiveCanvasFile(store: Store, assets: AssetStore, canvasId: string,
  input: { filename: string; size: number; x: number; y: number }, request: Request, session: string) {
  const controller = new AbortController(), reader = request.body?.getReader()
  const abort = () => { controller.abort(); void reader?.cancel().catch(() => {}) }
  const check = () => {
    if (!store.hasSession(session) || !store.get('canvas', canvasId) || canvasId === 'overview') abort()
  }
  request.signal.addEventListener('abort', abort, { once: true })
  store.on('sessions', check); store.on('change', check); store.once('close', abort)
  let upload: AssetUpload | undefined
  try {
    if (request.signal.aborted) abort()
    check(); controller.signal.throwIfAborted()
    upload = await assets.begin(input)
    while (reader) {
      controller.signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      check(); controller.signal.throwIfAborted()
      await upload.write(chunk.value)
    }
    check(); controller.signal.throwIfAborted()
    const { temporary: _, ...asset } = await upload.complete({ canvasId, position: { x: input.x, y: input.y } }, controller.signal)
    return asset
  } catch (error) {
    await upload?.abort()
    throw error
  } finally {
    request.signal.removeEventListener('abort', abort)
    store.off('sessions', check); store.off('change', check); store.off('close', abort)
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
  }
}
