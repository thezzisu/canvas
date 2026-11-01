import { computed, effectScope, shallowRef, watch, type Ref } from 'vue'
import { useStorage } from '@vueuse/core'

export const contentZoomLimits = { min: 50, max: 200, step: 10 } as const
export function normalizeContentZoom(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= contentZoomLimits.min && value <= contentZoomLimits.max
    ? Math.round(value) : 100
}

export function useContentZoom(key: () => string, storage?: Storage) {
  const saved = shallowRef<Ref<number | null>>()
  // VueUse 10 binds a storage key once; retire that binding when connection identity changes.
  watch(key, (identity, _, cleanup) => {
    const scope = effectScope()
    saved.value = scope.run(() => useStorage<number | null>(identity, 100, storage, {
      writeDefaults: false, flush: 'sync',
      serializer: {
        read(raw) { try { return normalizeContentZoom(JSON.parse(raw)) } catch { return 100 } },
        write(value) { return String(normalizeContentZoom(value)) },
      },
      onError() { /* An unavailable browser store must not prevent terminal use. */ },
    }))
    cleanup(() => scope.stop())
  }, { immediate: true, flush: 'sync' })
  return computed({
    get: () => normalizeContentZoom(saved.value?.value),
    set: (value: number) => { if (saved.value) saved.value.value = normalizeContentZoom(value) === 100 ? null : normalizeContentZoom(value) },
  })
}

