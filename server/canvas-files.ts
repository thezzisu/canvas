import type { AssetStore, AssetUpload } from './assets.ts'
import type { FileAssetContext, Store } from './state.ts'

/** A browser file becomes persistent only after all bytes are committed to a still-valid owner. */
export async function receiveFile(
  store: Store,
  assets: AssetStore,
  input: { filename: string; size: number },
  context: FileAssetContext,
  valid: () => boolean,
  request: Request,
  session: string,
) {
  const controller = new AbortController(),
    reader = request.body?.getReader()
  const abort = () => {
    controller.abort()
    void reader?.cancel().catch(() => {})
  }
  const check = () => {
    if (!store.hasSession(session) || !valid()) abort()
  }
  request.signal.addEventListener('abort', abort, { once: true })
  store.on('sessions', check)
  store.on('change', check)
  store.once('close', abort)
  let upload: AssetUpload | undefined
  try {
    if (request.signal.aborted) abort()
    check()
    controller.signal.throwIfAborted()
    upload = await assets.begin(input)
    while (reader) {
      controller.signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      check()
      controller.signal.throwIfAborted()
      await upload.write(chunk.value)
    }
    check()
    controller.signal.throwIfAborted()
    const { temporary: _, ...asset } = await upload.complete(context, controller.signal)
    return asset
  } catch (error) {
    await upload?.abort()
    throw error
  } finally {
    request.signal.removeEventListener('abort', abort)
    store.off('sessions', check)
    store.off('change', check)
    store.off('close', abort)
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
  }
}

export function receiveCanvasFile(
  store: Store,
  assets: AssetStore,
  canvasId: string,
  input: { filename: string; size: number } & ({ x: number; y: number } | { noteId: string }),
  request: Request,
  session: string,
) {
  const { filename, size } = input
  return receiveFile(
    store,
    assets,
    { filename, size },
    {
      canvasId,
      ...('noteId' in input ? { noteId: input.noteId } : { position: { x: input.x, y: input.y } }),
    },
    () =>
      !!store.get('canvas', canvasId) &&
      canvasId !== 'overview' &&
      (!('noteId' in input) || store.hasNote(canvasId, input.noteId)),
    request,
    session,
  )
}
