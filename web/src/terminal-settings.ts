import { computed, effectScope, shallowRef, watch, type Ref } from 'vue'
import { useStorage } from '@vueuse/core'

export type RightClickMode = 'menu' | 'terminal'
/** Ctrl+Shift+V either pastes the browser clipboard or reaches the terminal application. */
export type ShiftPasteMode = 'paste' | 'terminal'
export interface TerminalSettings { rightClick: RightClickMode; shiftPaste: ShiftPasteMode }
export const defaultTerminalSettings: TerminalSettings = Object.freeze({ rightClick: 'menu', shiftPaste: 'paste' })

export function normalizeTerminalSettings(value: unknown): TerminalSettings {
  const saved = value && typeof value === 'object' ? value as Partial<TerminalSettings> : {}
  return { rightClick: saved.rightClick === 'terminal' ? 'terminal' : 'menu', shiftPaste: saved.shiftPaste === 'terminal' ? 'terminal' : 'paste' }
}
export const terminalSettingsKey = (identity: string) => 'canvas:terminal-settings:' + identity

/** Browser-local preferences for one native window, shared by all its canvas references. */
export function useTerminalSettings(key: () => string, storage?: Storage) {
  const saved = shallowRef<Ref<TerminalSettings | null>>()
  // VueUse fixes the storage key at creation; changing native identity retires it.
  watch(key, (identity, _, cleanup) => {
    const scope = effectScope()
    saved.value = scope.run(() => useStorage<TerminalSettings | null>(terminalSettingsKey(identity), null, storage, {
      writeDefaults: false, flush: 'sync',
      serializer: {
        read: raw => { try { return normalizeTerminalSettings(JSON.parse(raw)) } catch { return null } },
        write: value => JSON.stringify(normalizeTerminalSettings(value)),
      },
      onError() { /* Browser storage must not block terminal input. */ },
    }))
    cleanup(() => scope.stop())
  }, { immediate: true, flush: 'sync' })
  return computed({
    get: () => normalizeTerminalSettings(saved.value?.value),
    set: (value: TerminalSettings) => {
      if (!saved.value) return
      const next = normalizeTerminalSettings(value)
      saved.value.value = next.rightClick === defaultTerminalSettings.rightClick && next.shiftPaste === defaultTerminalSettings.shiftPaste ? null : next
    },
  })
}
