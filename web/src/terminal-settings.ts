import { computed, effectScope, shallowRef, watch, type Ref } from 'vue'
import { useStorage } from '@vueuse/core'

export type RightClickMode = 'menu' | 'terminal'
export const normalizeRightClickMode = (value: unknown): RightClickMode => value === 'terminal' ? 'terminal' : 'menu'
export const terminalSettingsKey = (identity: string) => 'canvas:terminal-right-click:' + identity

export function useTerminalSettings(key: () => string, storage?: Storage) {
  const saved = shallowRef<Ref<RightClickMode | null>>()
  // VueUse 10 fixes the storage key at creation; changing native identity retires it.
  watch(key, (identity, _, cleanup) => {
    const scope = effectScope()
    saved.value = scope.run(() => useStorage<RightClickMode | null>(terminalSettingsKey(identity), 'menu', storage, {
      writeDefaults: false, flush: 'sync',
      serializer: { read: normalizeRightClickMode, write: normalizeRightClickMode },
      onError() { /* Browser storage must not block terminal input. */ },
    }))
    cleanup(() => scope.stop())
  }, { immediate: true, flush: 'sync' })
  return computed({
    get: () => normalizeRightClickMode(saved.value?.value),
    set: (value: RightClickMode) => { if (saved.value) saved.value.value = normalizeRightClickMode(value) === 'menu' ? null : 'terminal' },
  })
}
