import { watch, type Ref } from 'vue'
import { useLocalStorage } from '@vueuse/core'
import type { Canvas } from '../api/types'

const prefix = 'canvas:window-canvas:'

/** One binding follows the actively used native window, rather than every rendered card. */
export function useWindowCanvasHistory(
  identity: () => string | undefined,
  canvas: () => string,
  activeElement: Readonly<Ref<Element | null | undefined>>,
) {
  const saved = useLocalStorage<string | null>(() => prefix + (identity() || ''), null, {
    writeDefaults: false,
    listenToStorageChanges: false,
    flush: 'sync',
    onError() {},
  })
  watch(
    [identity, activeElement],
    ([key]) => {
      if (key) saved.value = canvas()
    },
    { immediate: true, flush: 'post' },
  )
}

export function lastWindowCanvas(
  identity: string,
  sourceId: string,
  windowId: string,
  canvases: readonly Canvas[],
  storage: Pick<Storage, 'getItem'> = localStorage,
) {
  let saved: string | null
  try {
    saved = storage.getItem(prefix + identity)
  } catch {
    return 'overview'
  }
  return (
    canvases.find(
      (canvas) =>
        canvas.id === saved &&
        canvas.nodes.some(
          (node) =>
            node.type === 'terminal' && node.sourceId === sourceId && node.windowId === windowId,
        ),
    )?.id || 'overview'
  )
}
