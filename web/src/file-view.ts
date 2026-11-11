import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { useLocalStorage, type UseStorageOptions } from '@vueuse/core'

export interface ReadingPosition {
  x: number
  y: number
}
export interface FileMode {
  mode: 'source' | 'rendered'
  wrap: boolean
  formatted: boolean
  highlighted: boolean
}
export interface FileReading {
  source: ReadingPosition
  rendered: ReadingPosition
}
const modePrefix = (instance: string) => `canvas:file-mode:${instance}:`
const readingPrefix = (instance: string) => `canvas:file-view:${instance}:`
export const fileModeKey = (instance: string, node: string) => modePrefix(instance) + node
export const fileReadingKey = (instance: string, canvas: string, node: string) =>
  `${readingPrefix(instance)}${canvas}:${node}`
export const filePreferenceKeys = (instance: string, canvas: string, node: string) => [
  fileModeKey(instance, node),
  fileReadingKey(instance, canvas, node),
]
const position = (value: unknown): ReadingPosition => {
  const point = value as Partial<ReadingPosition> | undefined
  const coordinate = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e8 ? value : 0
  return { x: coordinate(point?.x), y: coordinate(point?.y) }
}
export function fileMode(value: unknown, renderable: boolean): FileMode {
  const saved = value as Partial<FileMode> | undefined
  return {
    mode: renderable && saved?.mode !== 'source' ? 'rendered' : 'source',
    wrap: saved?.wrap === true,
    formatted: saved?.formatted === true,
    highlighted: saved?.highlighted !== false,
  }
}
export function fileReading(value: unknown): FileReading {
  const saved = value as Partial<FileReading> | undefined
  return { source: position(saved?.source), rendered: position(saved?.rendered) }
}

/** Preferences follow the file card; each canvas reference retains its own position.
 * Already open readers remain independent of another browser page's writes. */
export function useFileView(
  instance: MaybeRefOrGetter<string>,
  canvas: MaybeRefOrGetter<string>,
  node: MaybeRefOrGetter<string>,
  renderable: MaybeRefOrGetter<boolean>,
  canPersist = () => true,
  options: Pick<UseStorageOptions<unknown>, 'window'> = {},
) {
  const mode = useLocalStorage<FileMode | null>(
    () => fileModeKey(toValue(instance), toValue(node)),
    null,
    {
      ...options,
      listenToStorageChanges: false,
      writeDefaults: false,
      flush: 'sync',
      shallow: true,
      serializer: {
        read(raw) {
          try {
            return fileMode(JSON.parse(raw), toValue(renderable))
          } catch {
            return null
          }
        },
        write(value) {
          return JSON.stringify(fileMode(value, toValue(renderable)))
        },
      },
      onError() {
        /* A blocked or full browser store must not prevent reading. */
      },
    },
  )
  const positions = useLocalStorage<FileReading | null>(
    () => fileReadingKey(toValue(instance), toValue(canvas), toValue(node)),
    null,
    {
      ...options,
      listenToStorageChanges: false,
      writeDefaults: false,
      flush: 'sync',
      shallow: true,
      serializer: {
        read(raw) {
          try {
            return fileReading(JSON.parse(raw))
          } catch {
            return null
          }
        },
        write(value) {
          return JSON.stringify(fileReading(value))
        },
      },
      onError() {
        /* Reading works when storage is unavailable. */
      },
    },
  )
  const view = computed(() => fileMode(mode.value, toValue(renderable)))
  const update = (patch: Partial<FileMode>) => {
    if (!canPersist()) return
    const next = fileMode({ ...view.value, ...patch }, toValue(renderable))
    mode.value =
      JSON.stringify(next) === JSON.stringify(fileMode(undefined, toValue(renderable)))
        ? null
        : next
  }
  return {
    rendered: computed({
      get: () => view.value.mode === 'rendered',
      set: (value: boolean) => update({ mode: value ? 'rendered' : 'source' }),
    }),
    wrap: computed({
      get: () => view.value.wrap,
      set: (value: boolean) => update({ wrap: value }),
    }),
    formatted: computed({
      get: () => view.value.formatted,
      set: (value: boolean) => update({ formatted: value }),
    }),
    highlighted: computed({
      get: () => view.value.highlighted,
      set: (value: boolean) => update({ highlighted: value }),
    }),
    reading: computed(() => fileReading(positions.value)[view.value.mode]),
    remember(value: ReadingPosition) {
      if (!canPersist()) return
      const next = { ...fileReading(positions.value), [view.value.mode]: position(value) }
      positions.value =
        next.source.x || next.source.y || next.rendered.x || next.rendered.y ? next : null
    },
  }
}

export function pruneFileViews(
  instance: string,
  canvases: readonly { id: string; nodes: readonly { id: string; type: string }[] }[],
  storage?: Storage,
  retained?: ReadonlySet<string>,
) {
  const valid = new Set(
    canvases.flatMap((canvas) =>
      canvas.nodes
        .filter((node) => node.type === 'file')
        .flatMap((node) => filePreferenceKeys(instance, canvas.id, node.id)),
    ),
  )
  try {
    storage ||= localStorage
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index)
      if (
        key &&
        (key.startsWith(modePrefix(instance)) || key.startsWith(readingPrefix(instance))) &&
        !valid.has(key) &&
        !retained?.has(key)
      )
        storage.removeItem(key)
    }
  } catch {
    /* Storage may be unavailable. */
  }
}
