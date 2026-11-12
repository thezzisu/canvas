import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { createSharedComposable, useLocalStorage, type UseStorageOptions } from '@vueuse/core'
import { contentZoomLimits } from '../canvas/content-zoom'

export type RightClickMode = 'menu' | 'terminal'
export type ShiftPasteMode = 'paste' | 'terminal'
export interface TerminalSettings {
  rightClick: RightClickMode
  shiftPaste: ShiftPasteMode
  mouseHover: boolean
  maximizedZoom: number
}
export type TerminalOverrides = Partial<TerminalSettings>
export const defaultTerminalSettings: TerminalSettings = Object.freeze({
  rightClick: 'menu',
  shiftPaste: 'paste',
  mouseHover: true,
  maximizedZoom: 100,
})
export const terminalSettingsKey = (identity: string) => 'canvas:terminal-settings:' + identity
export const terminalDefaultsKey = 'canvas:terminal-defaults'
type StorageOptions = Pick<UseStorageOptions<TerminalOverrides | null>, 'window'>

/** Missing fields inherit. An explicit value is retained even if it equals the default. */
export function normalizeTerminalOverrides(value: unknown): TerminalOverrides {
  const input = value && typeof value === 'object' ? (value as TerminalOverrides) : {}
  const result: TerminalOverrides = {}
  if (input.rightClick === 'menu' || input.rightClick === 'terminal')
    result.rightClick = input.rightClick
  if (input.shiftPaste === 'paste' || input.shiftPaste === 'terminal')
    result.shiftPaste = input.shiftPaste
  if (typeof input.mouseHover === 'boolean') result.mouseHover = input.mouseHover
  if (
    typeof input.maximizedZoom === 'number' &&
    Number.isFinite(input.maximizedZoom) &&
    input.maximizedZoom >= contentZoomLimits.min &&
    input.maximizedZoom <= contentZoomLimits.max
  )
    result.maximizedZoom = Math.round(input.maximizedZoom)
  return result
}
function useOverrides(key: MaybeRefOrGetter<string>, options: StorageOptions) {
  const saved = useLocalStorage<TerminalOverrides | null>(key, null, {
    ...options,
    writeDefaults: false,
    flush: 'sync',
    serializer: {
      read: (raw) => {
        try {
          return normalizeTerminalOverrides(JSON.parse(raw))
        } catch {
          return {}
        }
      },
      write: JSON.stringify,
    },
    onError() {
      /* Optional browser preferences must not prevent terminal use. */
    },
  })
  return computed({
    get: () => saved.value || {},
    set: (value: TerminalOverrides) => {
      const next = normalizeTerminalOverrides(value)
      saved.value = Object.keys(next).length ? next : null
    },
  })
}
export const useTerminalDefaults = createSharedComposable((options: StorageOptions = {}) => {
  const saved = useOverrides(terminalDefaultsKey, options)
  return computed({
    get: () => ({ ...defaultTerminalSettings, ...saved.value }),
    set: (value: TerminalSettings) => {
      saved.value = value
    },
  })
})

/** One browser preference per native tab, shared by all of its canvas references. */
export function useTerminalSettings(key: MaybeRefOrGetter<string>, options: StorageOptions = {}) {
  const defaults = useTerminalDefaults(options)
  const overrides = useOverrides(() => terminalSettingsKey(toValue(key)), options)
  const effective = computed(() => ({ ...defaults.value, ...overrides.value }))
  const zoom = computed({
    get: () => effective.value.maximizedZoom,
    set: (value: number) => {
      overrides.value = { ...overrides.value, maximizedZoom: value }
    },
  })
  function resetZoom() {
    const { maximizedZoom: _, ...rest } = overrides.value
    overrides.value = rest
  }
  return { overrides, effective, zoom, resetZoom }
}
