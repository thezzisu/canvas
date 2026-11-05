import { onBeforeUnmount, watch, type Ref } from 'vue'
import type { Canvas } from './types'

/** Browser-local note scroll positions, keyed by backend, canvas and note. */
const prefix = (instance: string) => `canvas:note-scroll:${instance}:`
export const noteScrollKey = (instance: string, canvas: string, node: string) => `${prefix(instance)}${canvas}:${node}`

function read(key: string): number {
  try { const value = Number(localStorage.getItem(key)); return Number.isFinite(value) && value > 0 && value <= 1e8 ? value : 0 } catch { return 0 }
}
function write(key: string, value: number) {
  try { if (value > 0) localStorage.setItem(key, String(Math.round(value))); else localStorage.removeItem(key) } catch { /* Storage is optional. */ }
}

/** Restores the scroller found under `root` once its content is tall enough; user scrolling owns it afterwards. */
export function useNoteScroll(root: Ref<HTMLElement | undefined>, selector: string, key: () => string) {
  let restored = '', frame = 0, saveTimer: ReturnType<typeof setTimeout> | undefined
  const scroller = () => root.value?.querySelector<HTMLElement>(selector) ?? undefined
  const restore = () => {
    const target = scroller(), storageKey = key()
    if (!target || restored === storageKey) return
    const value = read(storageKey)
    if (value && target.scrollHeight - target.clientHeight < value) return
    target.scrollTop = value; restored = storageKey
  }
  const scrolled = (event: Event) => {
    const target = scroller(), storageKey = key()
    if (!target || event.target !== target || restored !== storageKey) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveTimer = undefined; write(storageKey, target.scrollTop) }, 150)
  }
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(restore) }
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : undefined
  const mutations = typeof MutationObserver === 'function' ? new MutationObserver(() => {
    const target = scroller()
    if (target) { observer?.observe(target); for (const child of target.children) observer?.observe(child) }
    schedule()
  }) : undefined
  watch([root, key], ([element], [previous]) => {
    previous?.removeEventListener('scroll', scrolled, true)
    observer?.disconnect(); mutations?.disconnect(); restored = ''
    if (!element) return
    element.addEventListener('scroll', scrolled, { capture: true, passive: true })
    mutations?.observe(element, { childList: true, subtree: true })
    schedule()
  }, { immediate: true, flush: 'post' })
  onBeforeUnmount(() => {
    const target = scroller()
    if (saveTimer && target && restored === key()) write(key(), target.scrollTop)
    clearTimeout(saveTimer); cancelAnimationFrame(frame); observer?.disconnect(); mutations?.disconnect()
    root.value?.removeEventListener('scroll', scrolled, true)
  })
}

export function pruneNoteScrolls(instance: string, canvases: readonly Canvas[], storage?: Storage) {
  const valid = new Set(canvases.flatMap(canvas => canvas.nodes.filter(node => node.type === 'note').map(node => noteScrollKey(instance, canvas.id, node.id))))
  try {
    storage ||= localStorage
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index)
      if (key?.startsWith(prefix(instance)) && !valid.has(key)) storage.removeItem(key)
    }
  } catch { /* Storage may be unavailable. */ }
}
