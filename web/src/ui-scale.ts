import { computed, watch } from 'vue'
import { useStorage } from '@vueuse/core'

export function normalizeUiScale(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 75 && value <= 150 ? value : 100
}

export function readUiScale(value: string): number {
  try { return normalizeUiScale(JSON.parse(value)) } catch { return 100 }
}

export const uiScale = useStorage<number>('canvas:ui-scale', 100, undefined, {
  serializer: { read: readUiScale, write: value => String(normalizeUiScale(value)) },
})
export const uiZoom = computed(() => normalizeUiScale(uiScale.value) / 100)

let initialized = false
export function initializeUiScale() {
  if (initialized) return
  initialized = true
  watch(uiScale, value => {
    const normalized = normalizeUiScale(value)
    if (normalized !== value) { uiScale.value = normalized; return }
    document.documentElement.style.setProperty('--ui-zoom', String(normalized / 100))
  }, { immediate: true, flush: 'sync' })
}
