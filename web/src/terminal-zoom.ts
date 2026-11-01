import { computed, effectScope, shallowRef, watch, type Ref } from 'vue'
import { useStorage } from '@vueuse/core'
import type { Source, SourceResource } from './types'

export const terminalZoomLimits = { min: 50, max: 200, step: 10 } as const
const prefix = 'canvas:terminal-zoom:'
export function normalizeTerminalZoom(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= terminalZoomLimits.min && value <= terminalZoomLimits.max
    ? Math.round(value) : 100
}

/** The native tab, not its name, canvas reference or browser tab, owns the preference. */
export function terminalZoomKey(instance: string, source: Source, windowId: string) {
  return JSON.stringify([instance, source.id, source.transport, source.transport === 'ssh' ? source.target?.trim() || '' : '',
    source.herdrSession?.trim() || '', source.herdrSocket?.trim() || '', windowId])
}
export const terminalZoomStorageKey = (key: string) => prefix + key
export function useTerminalZoom(key: () => string, storage?: Storage) {
  const saved = shallowRef<Ref<number | null>>()
  // VueUse 10 binds a storage key once; retire that binding when connection identity changes.
  watch(key, (identity, _, cleanup) => {
    const scope = effectScope()
    saved.value = scope.run(() => useStorage<number | null>(terminalZoomStorageKey(identity), 100, storage, {
      writeDefaults: false, flush: 'sync',
      serializer: {
        read(raw) { try { return normalizeTerminalZoom(JSON.parse(raw)) } catch { return 100 } },
        write(value) { return String(normalizeTerminalZoom(value)) },
      },
      onError() { /* An unavailable browser store must not prevent terminal use. */ },
    }))
    cleanup(() => scope.stop())
  }, { immediate: true, flush: 'sync' })
  return computed({
    get: () => normalizeTerminalZoom(saved.value?.value),
    set: (value: number) => { if (saved.value) saved.value.value = normalizeTerminalZoom(value) === 100 ? null : normalizeTerminalZoom(value) },
  })
}

/** Remove individual confirmed-closed tabs; unrelated concurrent writes remain untouched. */
export function pruneTerminalZooms(instance: string, sources: readonly Source[], resources: readonly SourceResource[], storage?: Storage) {
  const configured = new Map(sources.map(source => [source.id, source]))
  const online = new Map(resources.filter(source => source.status === 'online' && !source.error)
    .map(source => [source.id, new Set(source.spaces.flatMap(space => space.windows.map(window => window.id)))]))
  try {
    storage ||= localStorage
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index)
      if (!key?.startsWith(prefix)) continue
      let identity: unknown
      try { identity = JSON.parse(key.slice(prefix.length)) } catch { continue }
      if (!Array.isArray(identity) || identity.length !== 7 || identity.some(value => typeof value !== 'string') || identity[0] !== instance) continue
      const source = configured.get(identity[1]), windowId = identity[6]
      if (!source || key !== terminalZoomStorageKey(terminalZoomKey(instance, source, windowId)) || online.has(source.id) && !online.get(source.id)!.has(windowId)) storage.removeItem(key)
    }
  } catch { /* Storage may be unavailable. */ }
}
