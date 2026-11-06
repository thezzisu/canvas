import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { useLocalStorage, type UseStorageOptions } from '@vueuse/core'

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
export function useTerminalSettings(key: MaybeRefOrGetter<string>, options: Pick<UseStorageOptions<TerminalSettings | null>, 'window'> = {}) {
  const saved = useLocalStorage<TerminalSettings | null>(() => terminalSettingsKey(toValue(key)), null, {
    ...options, writeDefaults: false, flush: 'sync',
    serializer: {
      read: raw => { try { return normalizeTerminalSettings(JSON.parse(raw)) } catch { return null } },
      write: value => JSON.stringify(normalizeTerminalSettings(value)),
    },
    onError() { /* Browser storage must not block terminal input. */ },
  })
  return computed({
    get: () => normalizeTerminalSettings(saved.value),
    set: (value: TerminalSettings) => {
      const next = normalizeTerminalSettings(value)
      saved.value = next.rightClick === defaultTerminalSettings.rightClick && next.shiftPaste === defaultTerminalSettings.shiftPaste ? null : next
    },
  })
}
