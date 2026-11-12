import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useEventListener, useLocalStorage, useResizeObserver, useTimeoutFn } from '@vueuse/core'
import type { Canvas } from '../../api/types'

/** Browser-local note scroll positions, keyed by stable instance, canvas and note. */
const prefix = (instance: string) => `canvas:note-scroll:${instance}:`
export const noteScrollKey = (instance: string, canvas: string, node: string) =>
  `${prefix(instance)}${canvas}:${node}`
const scrollPosition = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1e8
    ? Math.round(value)
    : 0

/** The editor supplies its mounted DOM. Wait for a measurable viewport once;
 * later user scrolling belongs to this reader, including a now-shorter note. */
export function useNoteScroll(
  scroller: Ref<HTMLElement | undefined>,
  key: () => string,
  canPersist = () => true,
) {
  const saved = useLocalStorage<number | null>(key, null, {
    listenToStorageChanges: false,
    writeDefaults: false,
    flush: 'sync',
    serializer: {
      read: (raw) => scrollPosition(Number(raw)) || null,
      write: (value) => String(scrollPosition(value)),
    },
    onError() {
      /* Reading works when storage is unavailable. */
    },
  })
  const restored = ref(false)
  const restore = () => {
    const target = scroller.value
    if (!target?.clientHeight || restored.value) return
    target.scrollTop = Math.min(
      scrollPosition(saved.value),
      Math.max(0, target.scrollHeight - target.clientHeight),
    )
    restored.value = true
  }
  const persist = () => {
    if (scroller.value && restored.value && canPersist())
      saved.value = scrollPosition(scroller.value.scrollTop) || null
  }
  const {
    start: save,
    stop: cancelSave,
    isPending,
  } = useTimeoutFn(persist, 150, { immediate: false })
  useResizeObserver(
    computed(() => (restored.value ? undefined : scroller.value)),
    restore,
  )
  useEventListener(
    scroller,
    'scroll',
    () => {
      if (restored.value) save()
    },
    { passive: true },
  )
  watch(
    [scroller, key],
    () => {
      cancelSave()
      restored.value = false
      restore()
    },
    { immediate: true, flush: 'post' },
  )
  onBeforeUnmount(() => {
    if (isPending.value) persist()
  })
}

export function pruneNoteScrolls(
  instance: string,
  canvases: readonly Canvas[],
  storage?: Storage,
  retained?: ReadonlySet<string>,
) {
  const valid = new Set(
    canvases.flatMap((canvas) =>
      canvas.nodes
        .filter((node) => node.type === 'note')
        .map((node) => noteScrollKey(instance, canvas.id, node.id)),
    ),
  )
  try {
    storage ||= localStorage
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index)
      if (key?.startsWith(prefix(instance)) && !valid.has(key) && !retained?.has(key))
        storage.removeItem(key)
    }
  } catch {
    /* Storage may be unavailable. */
  }
}
