import { effectScope, watch, type Ref } from 'vue'
import { useStorage } from '@vueuse/core'
import type { Canvas } from './types'

const prefix = 'canvas:window-canvas:'

/** One binding follows the actively used native window, rather than every rendered card. */
export function useWindowCanvasHistory(identity: () => string | undefined, canvas: () => string, activeElement: Readonly<Ref<Element | null | undefined>>) {
  watch([identity, activeElement], ([key], _previous, cleanup) => {
    if (!key) return
    const scope = effectScope()
    scope.run(() => {
      const saved = useStorage(prefix + key, '', undefined, { writeDefaults: false, flush: 'sync', onError() {} })
      saved.value = canvas()
    })
    cleanup(() => scope.stop())
  }, { immediate: true, flush: 'post' })
}

export function lastWindowCanvas(identity: string, sourceId: string, windowId: string, canvases: readonly Canvas[], storage: Pick<Storage, 'getItem'> = localStorage) {
  let saved: string | null
  try { saved = storage.getItem(prefix + identity) } catch { return 'overview' }
  return canvases.find(canvas => canvas.id === saved && canvas.nodes.some(node =>
    node.type === 'terminal' && node.sourceId === sourceId && node.windowId === windowId))?.id || 'overview'
}
