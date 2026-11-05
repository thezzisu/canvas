import { computed } from 'vue'
import { useStorage } from '@vueuse/core'

export interface ReadingPosition { x: number; y: number }
export interface FileView {
  mode: 'source' | 'rendered'
  wrap: boolean
  formatted: boolean
  highlighted: boolean
  source: ReadingPosition
  rendered: ReadingPosition
}
const prefix = (instance: string) => `canvas:file-view:${instance}:`
export const fileViewKey = (instance: string, canvas: string, node: string) => `${prefix(instance)}${canvas}:${node}`
const position = (value: unknown): ReadingPosition => {
  const point = value as Partial<ReadingPosition> | undefined
  const coordinate = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e8 ? value : 0
  return { x: coordinate(point?.x), y: coordinate(point?.y) }
}
export function fileView(value: unknown, renderable: boolean): FileView {
  const saved = value as Partial<FileView> | undefined
  return { mode: renderable && saved?.mode !== 'source' ? 'rendered' : 'source', wrap: saved?.wrap === true,
    formatted: saved?.formatted === true, highlighted: saved?.highlighted !== false,
    source: position(saved?.source), rendered: position(saved?.rendered) }
}

/** Each mounted view reads once; another browser tab must not move its reader. */
export function useFileView(instance: string, canvas: string, node: string, renderable: boolean, canPersist = () => true, storage?: Storage) {
  const view = useStorage(fileViewKey(instance, canvas, node), fileView(undefined, renderable), storage, {
    listenToStorageChanges: false, writeDefaults: false, flush: 'sync', shallow: true,
    serializer: {
      read(raw) { try { return fileView(JSON.parse(raw), renderable) } catch { return fileView(undefined, renderable) } },
      write(value) { return JSON.stringify(fileView(value, renderable)) },
    },
    onError() { /* A blocked or full browser store must not prevent reading. */ },
  })
  const update = (next: FileView) => { if (canPersist()) view.value = next }
  return {
    rendered: computed({ get: () => view.value.mode === 'rendered', set: (value: boolean) => update({ ...view.value, mode: renderable && value ? 'rendered' : 'source' }) }),
    wrap: computed({ get: () => view.value.wrap, set: (value: boolean) => update({ ...view.value, wrap: value }) }),
    formatted: computed({ get: () => view.value.formatted, set: (value: boolean) => update({ ...view.value, formatted: value }) }),
    highlighted: computed({ get: () => view.value.highlighted, set: (value: boolean) => update({ ...view.value, highlighted: value }) }),
    reading: computed(() => view.value[view.value.mode]),
    remember(value: ReadingPosition) { update({ ...view.value, [view.value.mode]: position(value) }) },
  }
}

export function pruneFileViews(instance: string, canvases: readonly { id: string; nodes: readonly { id: string; type: string }[] }[], storage?: Storage, retained?: ReadonlySet<string>) {
  const valid = new Set(canvases.flatMap(canvas => canvas.nodes.filter(node => node.type === 'file').map(node => fileViewKey(instance, canvas.id, node.id))))
  try {
    storage ||= localStorage
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index)
      if (key?.startsWith(prefix(instance)) && !valid.has(key) && !retained?.has(key)) storage.removeItem(key)
    }
  } catch { /* Storage may be unavailable. */ }
}
export function clearInstanceFileViews(instance: string, storage?: Storage) { pruneFileViews(instance, [], storage) }
