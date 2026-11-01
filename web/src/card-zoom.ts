import type { Canvas } from './types'

const prefix = (instance: string) => `canvas:card-zoom:${instance}:`
export const cardZoomKey = (instance: string, node: string) => prefix(instance) + node

export function pruneCardZooms(instance: string, canvases: readonly Canvas[], storage?: Storage) {
  const valid = new Set(canvases.flatMap(canvas => canvas.nodes.filter(node => node.type !== 'terminal').map(node => cardZoomKey(instance, node.id))))
  try {
    storage ||= localStorage
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index)
      if (key?.startsWith(prefix(instance)) && !valid.has(key)) storage.removeItem(key)
    }
  } catch { /* Local preference storage must not prevent reading or editing. */ }
}
