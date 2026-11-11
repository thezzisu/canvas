import { computed, type MaybeRefOrGetter } from 'vue'
import { useLocalStorage, type UseStorageOptions } from '@vueuse/core'

export const contentZoomLimits = { min: 50, max: 200, step: 10 } as const
export function normalizeContentZoom(value: unknown): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= contentZoomLimits.min &&
    value <= contentZoomLimits.max
    ? Math.round(value)
    : 100
}

export function useContentZoom(
  key: MaybeRefOrGetter<string>,
  options: Pick<UseStorageOptions<number | null>, 'window'> = {},
) {
  const saved = useLocalStorage<number | null>(key, null, {
    ...options,
    writeDefaults: false,
    listenToStorageChanges: false,
    flush: 'sync',
    serializer: {
      read(raw) {
        try {
          return normalizeContentZoom(JSON.parse(raw))
        } catch {
          return null
        }
      },
      write(value) {
        return String(normalizeContentZoom(value))
      },
    },
    onError() {
      /* An unavailable browser store must not prevent terminal use. */
    },
  })
  return computed({
    get: () => normalizeContentZoom(saved.value),
    set: (value: number) => {
      saved.value = normalizeContentZoom(value) === 100 ? null : normalizeContentZoom(value)
    },
  })
}
