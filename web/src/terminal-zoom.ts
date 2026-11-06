import { contentZoomLimits, normalizeContentZoom, useContentZoom } from './content-zoom'
import { toValue, type MaybeRefOrGetter } from 'vue'

export const terminalZoomLimits = contentZoomLimits
export const normalizeTerminalZoom = normalizeContentZoom
const prefix = 'canvas:terminal-zoom:'
export const terminalZoomStorageKey = (key: string) => prefix + key
export function useTerminalZoom(key: MaybeRefOrGetter<string>, options?: Parameters<typeof useContentZoom>[1]) {
  return useContentZoom(() => terminalZoomStorageKey(toValue(key)), options)
}
